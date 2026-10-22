// Painel do Hermes no cliente: busca de GET /api/hermes/painel e as contas de apresentação (código puro, testado em
// hermes-model.test.ts). A janela fica em ui/hermes.ts.
import type { HermesModelCalls, HermesPanel, HermesProfilePanel, HermesQuotas, HermesSystem } from '../../../shared/hermes';
import { tr } from '../../../shared/i18n';

export type Level = 'ok' | 'warn' | 'crit';

/** Faixa de um valor: abaixo de `warn` tranquilo, a partir de `crit` ruim (os limites do escritório antigo). */
export function levelOf(v: number | undefined, warn: number, crit: number): Level | undefined {
  if (v === undefined) return undefined;
  return v >= crit ? 'crit' : v >= warn ? 'warn' : 'ok';
}

const RANK: Record<Level, number> = { ok: 0, warn: 1, crit: 2 };

/** Como está o computador no geral (o pior entre CPU, RAM, disco e temperatura). */
export function systemLevel(s: HermesSystem): Level {
  const levels = [levelOf(s.cpuPct, 70, 90), levelOf(s.memPct, 75, 90), levelOf(s.diskPct, 80, 90), levelOf(s.tempC, 75, 85)].filter((x): x is Level => !!x);
  return levels.reduce<Level>((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok');
}

export function systemLabel(level: Level): string {
  return level === 'crit' ? tr('sobrecarregado') : level === 'warn' ? tr('puxado') : tr('tranquilo');
}

/** "3 d 4 h", "5 h 12 min", "8 min". */
export function formatUptime(sec: number | undefined): string {
  if (sec === undefined) return '—';
  const m = Math.floor(sec / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d) return tr('{0} d {1} h', [d, h % 24]);
  if (h) return tr('{0} h {1} min', [h, m % 60]);
  return tr('{0} min', [m]);
}

/** "12,3 GB" (base 1024). */
export function formatBytes(n: number | undefined): string {
  if (n === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString(undefined, { maximumFractionDigits: v < 10 && i > 0 ? 1 : 0 })} ${units[i]}`;
}

/** "1,2 mi", "45 mil", "830". */
export function formatTokens(n: number): string {
  if (n >= 1e6) return tr('{0} mi', [(n / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })]);
  if (n >= 1e4) return tr('{0} mil', [Math.round(n / 1e3).toLocaleString()]);
  return n.toLocaleString();
}

/** Nome curto do modelo: o combo "kairo" é o OmniRoute (roteia entre provedores). */
export function modelLabel(model: string): string {
  if (model === 'kairo') return tr('OmniRoute (combo kairo)');
  return model.replace(/:free$/, '').replace(/^.*\//, '');
}

/** Resumo do dia para o cartão da conta Hermes na barra superior. */
export interface QuotaSummary {
  calls: number;
  tokens: number;
  /** Último limite/429 do dia (epoch ms). */
  limitedAt?: number;
  limits: number;
  /** Modelo/provedor que mais chamou hoje. */
  top?: { model: string; provider: string; calls: number };
  level: Level;
  line: string;
}

/** Chamadas por modelo: as do agent.log; sem log, as do state.db (session_model_usage). */
export function callsByModel(q: HermesQuotas): HermesModelCalls[] {
  if (q.calls.length) return q.calls;
  const map = new Map<string, HermesModelCalls>();
  for (const u of q.usage) {
    const key = `${u.model}\u0000${u.provider}`;
    const e = map.get(key) ?? { model: u.model, provider: u.provider, calls: 0, limits: 0 };
    e.calls += u.calls;
    map.set(key, e);
  }
  for (const l of q.limits) {
    const e = [...map.values()].find((x) => x.model === l.model);
    if (e) {
      e.limits++;
      e.limitedAt = Math.max(e.limitedAt ?? 0, l.at);
    }
  }
  return [...map.values()].sort((a, b) => b.calls - a.calls);
}

export function quotaSummary(q: HermesQuotas, now: number): QuotaSummary {
  const list = callsByModel(q);
  const calls = list.reduce((s, c) => s + c.calls, 0);
  const tokens = q.tokensToday || q.usage.reduce((s, u) => s + u.tokensIn + u.tokensOut, 0);
  const limitedAt = q.limits.length ? Math.max(...q.limits.map((l) => l.at)) : undefined;
  const top = list[0] ? { model: list[0].model, provider: list[0].provider, calls: list[0].calls } : undefined;
  // Limite na última hora: vermelho; antes, hoje: amarelo.
  const level: Level = limitedAt !== undefined && now - limitedAt < 3_600_000 ? 'crit' : limitedAt !== undefined ? 'warn' : 'ok';
  const line =
    level === 'crit'
      ? tr('limite (429) há pouco')
      : level === 'warn'
        ? tr('{0} limites hoje', [q.limits.length])
        : top?.model === 'kairo'
          ? tr('OmniRoute ativo')
          : tr('sem limites hoje');
  return { calls, tokens, limits: q.limits.length, level, line, ...(limitedAt !== undefined ? { limitedAt } : {}), ...(top ? { top } : {}) };
}

/** Rodadas do dia, todos os perfis. */
export function teamTotals(p: HermesPanel): { profiles: number; jobs: number; running: number; tokens: number } {
  return {
    profiles: p.profiles.length,
    jobs: p.profiles.reduce((s, x) => s + x.jobs.length, 0),
    running: p.profiles.reduce((s, x) => s + x.jobs.filter((j) => j.running).length, 0),
    tokens: p.profiles.reduce((s, x) => s + x.tokensToday, 0),
  };
}

/** Perfil dono de um agente (o principal ou um Vigia). */
export function profileOfAgent(p: HermesPanel | null, agentId: string): HermesProfilePanel | undefined {
  return p?.profiles.find((x) => x.agentId === agentId || x.jobs.some((j) => j.vigiaId === agentId));
}

/** Nome da sala do perfil no escritório (HABBLAUD_HERMES_SALAS ou o "Renomear"), ou o do perfil. */
export function roomOf(p: Pick<HermesProfilePanel, 'name' | 'room'>): string {
  return p.room || p.name;
}

/** A sala de um perfil pelo nome dele (nas cotas, que vêm por perfil). */
export function roomOfProfile(d: HermesPanel, profile: string): string {
  const p = d.profiles.find((x) => x.name === profile);
  return p ? roomOf(p) : profile;
}

/** "em 4 min", "agora", "há 2 h" (relativo a `now`). */
export function relTime(at: number | undefined, now: number): string {
  if (!at) return '—';
  const min = Math.round((at - now) / 60_000);
  if (min === 0) return tr('agora');
  const abs = Math.abs(min);
  const txt = abs < 60 ? tr('{0} min', [abs]) : abs < 1440 ? tr('{0} h {1} min', [Math.floor(abs / 60), abs % 60]) : tr('{0} d', [Math.floor(abs / 1440)]);
  return min > 0 ? tr('em {0}', [txt]) : tr('há {0}', [txt]);
}

/** Lê o painel; null se a fonte do Hermes estiver desligada (404) ou a rede falhar. */
export async function fetchHermesPanel(fetcher: typeof fetch = fetch): Promise<HermesPanel | null> {
  try {
    const res = await fetcher('/api/hermes/painel', { cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as HermesPanel;
    return body && typeof body === 'object' && Array.isArray(body.profiles) ? body : null;
  } catch {
    return null;
  }
}
