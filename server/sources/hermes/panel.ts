// Peças do painel do Hermes (GET /api/hermes/painel; tipos em shared/hermes.ts), tudo SOMENTE LEITURA:
// - SystemReader: o computador (CPU, RAM, disco, temperatura, ligado há). No container do Habblaud o /proc é do
//   container, mas carga (/proc/loadavg), memória (/proc/meminfo, MemAvailable) e núcleos são os do host; o disco é o
//   da pasta do Hermes montada (statfs); a temperatura vem de /sys/class/thermal (visível no container);
// - readAgentLogs: chamadas de IA por modelo/provedor e avisos de limite (429, RateLimitError, cota) do dia, lidos do
//   fim (3 MB) de logs/agent.log da raiz e de cada perfil;
// - readUsageAudit: tokens e rodadas das rotinas no dia (cron/usage_audit.jsonl, últimos 4 MB);
// - OutputIndex: as saídas das rotinas (cron/output/<job>/*.md), com cache por arquivo (são imutáveis);
// - WeatherService: o tempo lá fora (open-meteo, cache de 10 min; desligado com HABBLAUD_CLIMA=0).
import { closeSync, openSync, readdirSync, readFileSync, readSync, statfsSync, statSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { maskSecrets, truncate } from '../../../shared/activity';
import type { HermesLimitEvent, HermesModelCalls, HermesRunOutput, HermesSystem, HermesWeather } from '../../../shared/hermes';
import { parseCronOutput } from './cron';
import { listOutputs } from './terminal';

/** Dia UTC (AAAA-MM-DD) de um instante. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Lê o fim de um arquivo (até `max` bytes), sem a primeira linha cortada. */
export function readTail(path: string, max: number): string | undefined {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - max);
    const buf = Buffer.alloc(size - start);
    fd = openSync(path, 'r');
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// ------------------------------------------------------------------ computador

export interface SystemReaderOptions {
  /** Pasta cujo disco é medido (a do Hermes). */
  dir: string;
  procRoot?: string;
  sysRoot?: string;
  /** Módulo os (testes). */
  os?: Pick<typeof os, 'cpus' | 'loadavg' | 'totalmem' | 'freemem' | 'uptime' | 'hostname'>;
  statfs?: (path: string) => { bavail: number | bigint; blocks: number | bigint; bsize: number | bigint };
}

function n(v: number | bigint): number {
  return typeof v === 'bigint' ? Number(v) : v;
}

function pct(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

export class SystemReader {
  private prev?: { idle: number; total: number };
  private readonly os: NonNullable<SystemReaderOptions['os']>;

  constructor(private readonly o: SystemReaderOptions) {
    this.os = o.os ?? os;
  }

  private cpuTimes(): { idle: number; total: number } | undefined {
    const cpus = this.os.cpus();
    if (!cpus?.length) return undefined;
    let idle = 0;
    let total = 0;
    for (const c of cpus) {
      const t = c.times;
      idle += t.idle;
      total += t.user + t.nice + t.sys + t.idle + t.irq;
    }
    return { idle, total };
  }

  read(): HermesSystem {
    const out: HermesSystem = {};
    const proc = this.o.procRoot ?? '/proc';
    try {
      out.host = this.os.hostname();
    } catch {
      // sem nome
    }
    const cpus = this.os.cpus()?.length || undefined;
    if (cpus) out.cpus = cpus;
    // Carga: /proc/loadavg (no container, a do host); sem ele, a do os (zero no Windows).
    let load: [number, number, number] | undefined;
    try {
      const parts = readFileSync(join(proc, 'loadavg'), 'utf8').trim().split(/\s+/).slice(0, 3).map(Number);
      if (parts.length === 3 && parts.every(Number.isFinite)) load = parts as [number, number, number];
    } catch {
      const l = this.os.loadavg();
      if (l.some((x) => x > 0)) load = [l[0], l[1], l[2]];
    }
    if (load) out.load = load.map((x) => Math.round(x * 100) / 100) as [number, number, number];
    const times = this.cpuTimes();
    if (times && this.prev && times.total > this.prev.total) {
      out.cpuPct = pct(100 * (1 - (times.idle - this.prev.idle) / (times.total - this.prev.total)));
    } else if (load && cpus) out.cpuPct = pct((load[0] / cpus) * 100);
    if (times) this.prev = times;
    // Memória: MemAvailable (o que dá para usar sem tirar ninguém), senão o os.
    try {
      const info: Record<string, number> = {};
      for (const line of readFileSync(join(proc, 'meminfo'), 'utf8').split('\n')) {
        const m = /^(\w+):\s+(\d+)/.exec(line);
        if (m) info[m[1]] = Number(m[2]) * 1024;
      }
      if (info.MemTotal && info.MemAvailable !== undefined) {
        out.memTotal = info.MemTotal;
        out.memUsed = info.MemTotal - info.MemAvailable;
      }
    } catch {
      // sem /proc
    }
    if (out.memTotal === undefined) {
      const total = this.os.totalmem();
      if (total > 0) {
        out.memTotal = total;
        out.memUsed = total - this.os.freemem();
      }
    }
    if (out.memTotal && out.memUsed !== undefined) out.memPct = pct((out.memUsed / out.memTotal) * 100);
    try {
      const st = (this.o.statfs ?? statfsSync)(this.o.dir);
      const total = n(st.blocks) * n(st.bsize);
      const free = n(st.bavail) * n(st.bsize);
      if (total > 0) {
        out.diskTotal = total;
        out.diskFree = free;
        out.diskPct = pct(100 * (1 - free / total));
      }
    } catch {
      // statfs indisponível
    }
    const temp = readTemperature(this.o.sysRoot ?? '/sys');
    if (temp !== undefined) out.tempC = temp;
    try {
      const up = Number.parseFloat(readFileSync(join(proc, 'uptime'), 'utf8').split(/\s+/)[0]);
      if (Number.isFinite(up)) out.uptimeSec = Math.round(up);
    } catch {
      const up = this.os.uptime();
      if (up > 0) out.uptimeSec = Math.round(up);
    }
    return out;
  }
}

/** Maior temperatura entre /sys/class/thermal/thermal_zone*\/temp (milésimos de °C). */
export function readTemperature(sysRoot: string): number | undefined {
  const base = join(sysRoot, 'class', 'thermal');
  let best: number | undefined;
  try {
    for (const name of readdirSync(base)) {
      if (!name.startsWith('thermal_zone')) continue;
      try {
        const v = Number.parseInt(readFileSync(join(base, name, 'temp'), 'utf8').trim(), 10) / 1000;
        // Zonas desligadas dão valores absurdos (negativos ou acima de 150 °C).
        if (Number.isFinite(v) && v > 0 && v < 150) best = best === undefined ? v : Math.max(best, v);
      } catch {
        // zona sem leitura
      }
    }
  } catch {
    return undefined;
  }
  return best === undefined ? undefined : Math.round(best);
}

// ------------------------------------------------------------------ logs de IA

/** Quanto do fim de cada agent.log é lido. */
export const LOG_TAIL = 3 * 1024 * 1024;
const LOG_LINE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;
const API_CALL = /API call #\d+:.*?\bmodel=(\S+)(?:.*?\bprovider=(\S+))?/;
const LIMIT = /RateLimitError|(?:HTTP|status|code|error)\D{0,12}429\b|Too Many Requests|rate[ _-]?limit(?:ed| exceeded)|quota (?:exceeded|exhausted)|resource[_ ]exhausted/i;
/** O provedor real atrás do roteador (OmniRoute), se o log disser. */
const UPSTREAM = /\b(?:upstream|routed_to|actual_provider|served_by|x-omniroute-provider)[=:]\s*"?([\w./-]+)/i;

export interface AgentLogSummary {
  calls: HermesModelCalls[];
  limits: HermesLimitEvent[];
  found: boolean;
}

function clean(v: string | undefined): string | undefined {
  const s = v?.replace(/[,;)"']+$/, '');
  return s || undefined;
}

/** Chamadas por modelo e avisos de limite do dia `day` (UTC) nos logs/agent.log da raiz e dos perfis. */
export function readAgentLogs(dir: string, profiles: readonly string[], day: string, tail = LOG_TAIL): AgentLogSummary {
  const files: Array<{ profile: string; path: string }> = [{ profile: 'default', path: join(dir, 'logs', 'agent.log') }];
  for (const p of profiles) if (p !== 'default') files.push({ profile: p, path: join(dir, 'profiles', p, 'logs', 'agent.log') });
  const models = new Map<string, HermesModelCalls>();
  const limits: HermesLimitEvent[] = [];
  let found = false;
  const entry = (model: string, provider: string) => {
    const key = `${model}\u0000${provider}`;
    let e = models.get(key);
    if (!e) models.set(key, (e = { model, provider, calls: 0, limits: 0 }));
    return e;
  };
  for (const f of files) {
    const text = readTail(f.path, tail);
    if (text === undefined) continue;
    found = true;
    for (const line of text.split('\n')) {
      const t = LOG_LINE.exec(line);
      if (!t || t[1] !== day) continue;
      const at = Date.parse(`${t[1]}T${t[2]}:${t[3]}:${t[4]}Z`);
      const call = API_CALL.exec(line);
      if (call) {
        const upstream = clean(UPSTREAM.exec(line)?.[1]);
        entry(clean(call[1]) ?? '?', upstream ?? clean(call[2]) ?? '?').calls++;
        continue;
      }
      const msg = line.slice(t[0].length).replace(/^[.,]\d+/, '');
      if (!/WARNING|ERROR|CRITICAL/.test(msg.slice(0, 40))) continue;
      if (!LIMIT.test(msg)) continue;
      const model = clean(/\bmodel=(\S+)/.exec(line)?.[1]);
      const provider = clean(UPSTREAM.exec(line)?.[1] ?? /\bprovider=(\S+)/.exec(line)?.[1]);
      const ev: HermesLimitEvent = { at, profile: f.profile, text: truncate(maskSecrets(msg.trim()), 240) };
      if (model) ev.model = model;
      if (provider) ev.provider = provider;
      limits.push(ev);
      if (model) {
        const e = entry(model, provider ?? '?');
        e.limits++;
        e.limitedAt = Math.max(e.limitedAt ?? 0, at);
      }
    }
  }
  // Os de limite sem provedor conhecido entram no do mesmo modelo que teve chamadas.
  for (const [key, e] of [...models]) {
    if (e.provider !== '?' || e.calls) continue;
    const twin = [...models.values()].find((x) => x !== e && x.model === e.model);
    if (!twin) continue;
    twin.limits += e.limits;
    twin.limitedAt = Math.max(twin.limitedAt ?? 0, e.limitedAt ?? 0) || undefined;
    models.delete(key);
  }
  limits.sort((a, b) => b.at - a.at);
  return { calls: [...models.values()].sort((a, b) => b.calls - a.calls), limits: limits.slice(0, 40), found };
}

// ------------------------------------------------------------------ usage_audit.jsonl

export interface UsageAuditSummary {
  tokens: number;
  runs: number;
  /** Rodadas do dia que terminaram com erro (o texto do erro). */
  errors: HermesLimitEvent[];
}

/** Tokens e rodadas do dia `day` (UTC) em cron/usage_audit.jsonl de um perfil. */
export function readUsageAudit(profileDir: string, profile: string, day: string, tail = 4 * 1024 * 1024): UsageAuditSummary {
  const out: UsageAuditSummary = { tokens: 0, runs: 0, errors: [] };
  const text = readTail(join(profileDir, 'cron', 'usage_audit.jsonl'), tail);
  if (!text) return out;
  for (const line of text.split('\n')) {
    if (!line.includes(day)) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof o.ts !== 'string' || !o.ts.startsWith(day)) continue;
    out.runs++;
    if (typeof o.total_tokens === 'number') out.tokens += o.total_tokens;
    if (o.error) {
      const ev: HermesLimitEvent = { at: Date.parse(o.ts) || 0, profile, text: truncate(maskSecrets(typeof o.error === 'string' ? o.error : JSON.stringify(o.error)), 240) };
      if (typeof o.model === 'string') ev.model = o.model;
      out.errors.push(ev);
    }
  }
  return out;
}

// ------------------------------------------------------------------ saídas das rotinas

/** Resposta guardada por saída (caracteres). */
export const OUTPUT_TEXT_MAX = 12_000;

/** Saídas das rotinas de um perfil, com o arquivo já lido em cache (as saídas não mudam depois de gravadas). */
export class OutputIndex {
  private cache = new Map<string, HermesRunOutput>();

  list(profileDir: string, jobs: ReadonlyArray<{ id: string; name: string }>, limit = 30): HermesRunOutput[] {
    const all: HermesRunOutput[] = [];
    const seen = new Set<string>();
    for (const job of jobs) {
      for (const f of listOutputs(join(profileDir, 'cron', 'output', job.id), limit)) {
        seen.add(f.path);
        let o = this.cache.get(f.path);
        if (!o) {
          let text: string;
          try {
            text = readFileSync(f.path, 'utf8').slice(0, 256 * 1024);
          } catch {
            continue;
          }
          const p = parseCronOutput(text);
          o = { jobId: job.id, jobName: p.jobName ?? job.name, at: f.at, kind: p.noChange ? 'no_change' : p.silent || !p.response ? 'silent' : 'agent' };
          if (o.kind === 'agent' && p.response) o.text = maskSecrets(p.response.slice(0, OUTPUT_TEXT_MAX));
          this.cache.set(f.path, o);
        }
        all.push(o);
      }
    }
    if (this.cache.size > 2_000) for (const k of this.cache.keys()) if (!seen.has(k)) this.cache.delete(k);
    return all.sort((a, b) => b.at - a.at).slice(0, limit);
  }
}

// ------------------------------------------------------------------ tempo lá fora

export interface WeatherOptions {
  lat: string;
  lon: string;
  place?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

const WEATHER_TTL_MS = 10 * 60_000;
const WEATHER_RETRY_MS = 2 * 60_000;

/** Tempo lá fora pelo open-meteo (sem chave), em cache. Nunca lança: sem rede, fica o último valor. */
export class WeatherService {
  private value?: HermesWeather;
  private at = -Infinity;
  private pending?: Promise<void>;

  constructor(private readonly o: WeatherOptions) {}

  /** O valor em cache; dispara a atualização quando venceu (o painel seguinte já vem com ela). */
  current(): HermesWeather | undefined {
    const now = (this.o.now ?? Date.now)();
    if (now - this.at >= WEATHER_TTL_MS && !this.pending) this.pending = this.refresh(now).finally(() => (this.pending = undefined));
    return this.value;
  }

  async refresh(now = (this.o.now ?? Date.now)()): Promise<void> {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(this.o.lat)}&longitude=${encodeURIComponent(this.o.lon)}&current=temperature_2m,weather_code,is_day&timezone=auto`;
    try {
      const res = await (this.o.fetch ?? fetch)(url, { signal: AbortSignal.timeout(8_000) });
      const body = (await res.json()) as { current?: { temperature_2m?: unknown; weather_code?: unknown; is_day?: unknown } };
      const c = body.current;
      if (typeof c?.temperature_2m !== 'number' || typeof c.weather_code !== 'number') throw new Error('resposta sem current');
      this.value = { tempC: c.temperature_2m, code: c.weather_code, day: !!c.is_day, ...(this.o.place ? { place: this.o.place } : {}) };
      this.at = now;
    } catch {
      // tenta de novo em 2 min
      this.at = now - WEATHER_TTL_MS + WEATHER_RETRY_MS;
    }
  }
}
