// Perfis do Hermes e os arquivos pequenos de cada um (só leitura): a lista de rotinas (cron/jobs.json), o estado do
// gateway (gateway_state.json ou, sem ele, o batimento do agendador em cron/ticker_heartbeat) e a descrição do perfil
// (profile.yaml).
//
// Estrutura do diretório de dados (no container do Hermes, /opt/data):
//   <dir>/profiles/<perfil>/state.db, cron/, gateway_state.json, profile.yaml   (um por perfil)
//   <dir>/state.db, cron/...                                                    (perfil "default", se existir)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface HermesProfile {
  /** Nome do perfil ("crypto", "finance"; a raiz do diretório é "default"). */
  name: string;
  /** Pasta do perfil. */
  dir: string;
}

/** Nome de perfil aceito (é a pasta em profiles/: nada de caminhos). */
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A pasta parece um perfil do Hermes (tem o banco ou o cron). */
function looksLikeProfile(dir: string): boolean {
  return existsSync(join(dir, 'state.db')) || existsSync(join(dir, 'cron', 'jobs.json')) || existsSync(join(dir, 'cron', 'executions.db'));
}

/** Perfis do diretório de dados, em ordem alfabética ("default", se houver, primeiro). */
export function discoverProfiles(root: string): HermesProfile[] {
  const out: HermesProfile[] = [];
  const base = join(root, 'profiles');
  let names: string[] = [];
  try {
    names = readdirSync(base, { withFileTypes: true })
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && PROFILE_NAME.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    // sem profiles/: só o default (se houver)
  }
  if (looksLikeProfile(root) && !names.includes('default')) out.push({ name: 'default', dir: root });
  for (const name of names) {
    const dir = join(base, name);
    if (looksLikeProfile(dir)) out.push({ name, dir });
  }
  return out;
}

/** Uma rotina do cron (cron/jobs.json), só os campos que usamos. */
export interface CronJob {
  id: string;
  name: string;
  prompt?: string;
  schedule?: string;
  enabled: boolean;
  lastRunAt?: number;
  lastStatus?: string;
  lastError?: string;
  nextRunAt?: number;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function isoMs(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

/** Lê um arquivo pequeno só se mudou desde a última vez (cache por tamanho+hora). */
export class SmallFile<T> {
  private sig = '';
  private value: T | undefined;

  constructor(
    readonly path: string,
    private readonly parse: (text: string) => T | undefined,
    private readonly maxBytes = 1024 * 1024,
  ) {}

  read(): T | undefined {
    let sig: string;
    try {
      const st = statSync(this.path);
      if (st.size > this.maxBytes) return this.value;
      sig = `${st.size}:${st.mtimeMs}`;
    } catch {
      this.sig = '';
      this.value = undefined;
      return undefined;
    }
    if (sig === this.sig) return this.value;
    try {
      this.value = this.parse(readFileSync(this.path, 'utf8'));
      this.sig = sig;
    } catch {
      // gravado pela metade agora: fica o valor anterior até o próximo ciclo
    }
    return this.value;
  }
}

/** cron/jobs.json -> rotinas. */
export function parseJobs(text: string): CronJob[] {
  const raw = JSON.parse(text) as { jobs?: unknown };
  const list = Array.isArray(raw?.jobs) ? raw.jobs : Array.isArray(raw) ? (raw as unknown[]) : [];
  const out: CronJob[] = [];
  for (const j of list) {
    if (!j || typeof j !== 'object') continue;
    const o = j as Record<string, unknown>;
    const id = str(o.id);
    if (!id) continue;
    const sched = o.schedule && typeof o.schedule === 'object' ? str((o.schedule as Record<string, unknown>).display) : undefined;
    out.push({
      id,
      name: str(o.name) ?? id,
      prompt: str(o.prompt),
      schedule: str(o.schedule_display) ?? sched,
      enabled: o.enabled !== false,
      lastRunAt: isoMs(o.last_run_at),
      lastStatus: str(o.last_status),
      lastError: str(o.last_error),
      nextRunAt: isoMs(o.next_run_at),
    });
  }
  return out;
}

/** Estado do gateway: 'running', 'stopped' ou outro valor do arquivo. */
export function parseGateway(text: string): { state?: string; desired?: string } {
  const o = JSON.parse(text) as Record<string, unknown>;
  return { state: str(o.gateway_state) ?? str(o.state), desired: str(o.desired_state) };
}

/** cron/ticker_heartbeat: epoch em segundos (texto) -> ms. */
export function parseHeartbeat(text: string): number | undefined {
  const n = Number.parseFloat(text.trim());
  return Number.isFinite(n) && n > 0 ? n * 1000 : undefined;
}

/** `description:` de um profile.yaml (só esse campo, numa linha; sem parser de YAML). */
export function parseProfileDescription(text: string): string | undefined {
  const m = /^description:\s*(.+)$/m.exec(text);
  if (!m) return undefined;
  const v = m[1].trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  return v && v !== '|' && v !== '>' ? v : undefined;
}

/** Id da rotina dona de uma sessão do cron ("cron_<jobId>_<data>_<hora>"). */
export function jobIdOfSession(sessionId: string): string | undefined {
  return /^cron_([0-9a-f]{6,32})_/i.exec(sessionId)?.[1];
}
