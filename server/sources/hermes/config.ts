// Variáveis de ambiente do painel do Hermes (GET /api/hermes/painel):
// - HABBLAUD_CLIMA=0 desliga o tempo lá fora; HABBLAUD_CLIMA_LAT, HABBLAUD_CLIMA_LON e HABBLAUD_CLIMA_LOCAL escolhem
//   o lugar (padrão: São Paulo). A consulta vai ao open-meteo (sem chave), no máximo a cada 10 min;
// - HABBLAUD_OMNIROUTE_URL e HABBLAUD_BESZEL_URL: links "Abrir o OmniRoute" (cotas) e "Abrir o Beszel" (servidor).
// Nomes (README.md desta pasta, "Nomes da sala e dos agentes"):
// - HABBLAUD_HERMES_SALAS="crypto=Kairo,finance=Finanças": nome exibido da sala de cada perfil (o id da sala continua
//   sendo a pasta do perfil);
// - HABBLAUD_HERMES_NOMES="crypto=Hermes,crypto/vigia-mercado=Sentinela:f": nome do agente principal (`perfil`) e do
//   Vigia de uma rotina (`perfil/<nome ou id da rotina>`), com `:f`/`:m` opcional para o visual.
// Agentes adicionais: HABBLAUD_HERMES_AGENTES="crypto/analista-mercado=Analista:f" = um personagem permanente a mais na
//   sala do perfil, dono das sessões do cron daquela rotina (no lugar do principal).
// Leituras do Vigia: HABBLAUD_HERMES_LEITURAS_DIAS (padrão 7; 0 desliga) = dias guardados em <dataDir>/hermes-leituras.
import type { HermesPanel } from '../../../shared/hermes';
import { nameKey, parseCharacterName } from '../../../shared/appearance';
import { tr } from '../../../shared/i18n';
import { NAME_POOL } from '../../../shared/names';
import { log } from '../../log';
import { ROOM_NAME_MAX } from '../../model/room-aliases';
import { PROFILE_NAME } from './profiles';
import type { WeatherOptions } from './panel';

const COORD = /^-?\d{1,3}(?:\.\d{1,6})?$/;

/** Nome fixo de um agente do Hermes (HABBLAUD_HERMES_NOMES). Sem `look`: o do nome no pool, senão 'm'. */
export interface HermesAgentName {
  name: string;
  look: 'f' | 'm';
}

/** Pares "chave=valor" separados por vírgula (ou ponto e vírgula); os fora do formato vão para `bad`. */
function pairs(raw: string | undefined, bad: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const part of (raw ?? '').split(/[,;]/)) {
    const s = part.trim();
    if (!s) continue;
    const i = s.indexOf('=');
    const k = i > 0 ? s.slice(0, i).trim() : '';
    const v = i > 0 ? s.slice(i + 1).trim() : '';
    if (!k || !v) bad.push(s);
    else out.push([k, v]);
  }
  return out;
}

function warnBad(variable: string, bad: string[]): void {
  if (bad.length) log.warn(tr('{0}: ignorando {1}', [variable, bad.map((b) => `"${b}"`).join(', ')]));
}

/** HABBLAUD_HERMES_SALAS: perfil -> nome exibido da sala. */
export function hermesRoomNames(env: NodeJS.ProcessEnv): Map<string, string> {
  const bad: string[] = [];
  const out = new Map<string, string>();
  for (const [profile, value] of pairs(env.HABBLAUD_HERMES_SALAS, bad)) {
    const name = value.replace(/\s+/g, ' ').trim().slice(0, ROOM_NAME_MAX);
    if (!PROFILE_NAME.test(profile) || !name || out.has(profile)) bad.push(`${profile}=${value}`);
    else out.set(profile, name);
  }
  warnBad('HABBLAUD_HERMES_SALAS', bad);
  return out;
}

/**
 * HABBLAUD_HERMES_NOMES: "perfil" (agente principal) ou "perfil/rotina" (Vigia da rotina, pelo nome ou id dela) ->
 * nome. Nome repetido (sem diferenciar caixa) fica só no primeiro: os nomes do escritório são únicos.
 */
export function hermesAgentNames(env: NodeJS.ProcessEnv): Map<string, HermesAgentName> {
  const bad: string[] = [];
  const out = new Map<string, HermesAgentName>();
  const used = new Set<string>();
  for (const [key, value] of pairs(env.HABBLAUD_HERMES_NOMES, bad)) {
    const [profile, job, extra] = key.split('/').map((s) => s.trim());
    const m = /^(.*?):([fm])$/i.exec(value);
    const name = parseCharacterName(m ? m[1] : value);
    const okKey = PROFILE_NAME.test(profile ?? '') && extra === undefined && (job === undefined || !!job);
    if (!okKey || !name || out.has(key) || used.has(nameKey(name))) {
      bad.push(`${key}=${value}`);
      continue;
    }
    used.add(nameKey(name));
    const look = m ? (m[2].toLowerCase() as 'f' | 'm') : (NAME_POOL.find((p) => nameKey(p.name) === nameKey(name))?.look ?? 'm');
    out.set(job === undefined ? profile : `${profile}/${job}`, { name, look });
  }
  warnBad('HABBLAUD_HERMES_NOMES', bad);
  return out;
}

/** Um agente adicional do Hermes (HABBLAUD_HERMES_AGENTES): o dono das sessões do cron de uma rotina. */
export interface HermesExtraAgent {
  profile: string;
  /** Nome ou id da rotina no jobs.json. */
  job: string;
  name: string;
  look: 'f' | 'm';
}

/**
 * HABBLAUD_HERMES_AGENTES: "perfil/rotina" (nome ou id da rotina) -> nome do agente adicional, com `:f`/`:m` opcional.
 * A chave precisa da rotina; chave ou nome repetido (sem diferenciar caixa) fica só no primeiro.
 */
export function hermesExtraAgents(env: NodeJS.ProcessEnv): HermesExtraAgent[] {
  const bad: string[] = [];
  const out: HermesExtraAgent[] = [];
  const keys = new Set<string>();
  const used = new Set<string>();
  for (const [key, value] of pairs(env.HABBLAUD_HERMES_AGENTES, bad)) {
    const [profile, job, extra] = key.split('/').map((s) => s.trim());
    const m = /^(.*?):([fm])$/i.exec(value);
    const name = parseCharacterName(m ? m[1] : value);
    const okKey = PROFILE_NAME.test(profile ?? '') && extra === undefined && !!job;
    const k = `${profile}/${job}`;
    if (!okKey || !name || keys.has(k) || used.has(nameKey(name))) {
      bad.push(`${key}=${value}`);
      continue;
    }
    keys.add(k);
    used.add(nameKey(name));
    const look = m ? (m[2].toLowerCase() as 'f' | 'm') : (NAME_POOL.find((p) => nameKey(p.name) === nameKey(name))?.look ?? 'm');
    out.push({ profile: profile!, job: job!, name, look });
  }
  warnBad('HABBLAUD_HERMES_AGENTES', bad);
  return out;
}

/** HABBLAUD_HERMES_LEITURAS_DIAS: dias de leituras do Vigia guardadas (padrão 7; 0 desliga; no máximo 365). */
export function hermesReadingDays(env: NodeJS.ProcessEnv): number {
  const raw = env.HABBLAUD_HERMES_LEITURAS_DIAS?.trim();
  if (!raw) return 7;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    log.warn(tr('{0}: ignorando {1}', ['HABBLAUD_HERMES_LEITURAS_DIAS', `"${raw}"`]));
    return 7;
  }
  return Math.min(365, Math.floor(n));
}

export function hermesWeather(env: NodeJS.ProcessEnv): WeatherOptions | false {
  const flag = env.HABBLAUD_CLIMA?.trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off' || flag === 'no') return false;
  const lat = env.HABBLAUD_CLIMA_LAT?.trim() || '-23.55';
  const lon = env.HABBLAUD_CLIMA_LON?.trim() || '-46.63';
  if (!COORD.test(lat) || !COORD.test(lon)) return false;
  const place = env.HABBLAUD_CLIMA_LOCAL?.trim().slice(0, 60) || (env.HABBLAUD_CLIMA_LAT ? undefined : 'São Paulo');
  return { lat, lon, ...(place ? { place } : {}) };
}

function url(v: string | undefined): string | undefined {
  const s = v?.trim();
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

export function hermesLinks(env: NodeJS.ProcessEnv): HermesPanel['links'] {
  const omniroute = url(env.HABBLAUD_OMNIROUTE_URL);
  const beszel = url(env.HABBLAUD_BESZEL_URL);
  if (!omniroute && !beszel) return undefined;
  return { ...(omniroute ? { omniroute } : {}), ...(beszel ? { beszel } : {}) };
}
