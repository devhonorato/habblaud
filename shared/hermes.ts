// Painel do Hermes (GET /api/hermes/painel): o computador onde o Hermes roda, as cotas de IA do dia, as rotinas de
// cada perfil, as saídas das rotinas e a última leitura de cada monitor (o "Vigia"). Montado pelo servidor só com a
// fonte do Hermes ligada (server/sources/hermes/panel.ts) e mostrado pelo cliente (client/src/ui/hermes.ts).
//
// Regra de evolução: como shared/types.ts, mudanças só ADITIVAS (campos opcionais novos).

/** Estado do computador. Ausente = não deu para ler (ex.: sem /proc fora do Linux). */
export interface HermesSystem {
  /** Uso de CPU (0–100): amostra entre duas leituras; na primeira, a carga de 1 min dividida pelos núcleos. */
  cpuPct?: number;
  /** Carga média de 1, 5 e 15 min (/proc/loadavg; zero no Windows). */
  load?: [number, number, number];
  cpus?: number;
  memPct?: number;
  memUsed?: number;
  memTotal?: number;
  /** Disco da pasta do Hermes (statfs). */
  diskPct?: number;
  diskFree?: number;
  diskTotal?: number;
  /** Maior temperatura entre as zonas térmicas (°C). */
  tempC?: number;
  /** Ligado há (segundos). */
  uptimeSec?: number;
  host?: string;
}

/** Chamadas a um modelo hoje, lidas do logs/agent.log (raiz e perfis). */
export interface HermesModelCalls {
  model: string;
  provider: string;
  calls: number;
  /** Limites/429 vistos hoje para este modelo. */
  limits: number;
  /** Último limite visto (epoch ms). */
  limitedAt?: number;
}

/** Uso por modelo e provedor hoje (tabela session_model_usage do state.db de cada perfil). */
export interface HermesModelUsage {
  profile: string;
  model: string;
  provider: string;
  /** Para que (vazio = a conversa; "title_generation", "compression"...). */
  task?: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
}

/** Um aviso de limite (429, RateLimitError, cota) visto hoje. */
export interface HermesLimitEvent {
  at: number;
  profile: string;
  model?: string;
  provider?: string;
  text: string;
}

export interface HermesQuotas {
  /** Dia contado (UTC, AAAA-MM-DD): o Hermes grava os logs em UTC. */
  day: string;
  calls: HermesModelCalls[];
  usage: HermesModelUsage[];
  limits: HermesLimitEvent[];
  /** Tokens das rotinas hoje (cron/usage_audit.jsonl). */
  tokensToday: number;
  runsToday: number;
  /** Algum logs/agent.log foi encontrado (sem ele, só o uso do state.db). */
  logFound: boolean;
}

export interface HermesJob {
  id: string;
  name: string;
  schedule?: string;
  enabled: boolean;
  /** Rodando agora (executions.db). */
  running: boolean;
  /** Só acorda o agente se o monitor achar mudança (monitor_script / monitor_url). */
  monitor: boolean;
  lastRunAt?: number;
  nextRunAt?: number;
  lastStatus?: string;
  lastError?: string;
  /** Agente "Vigia" desta rotina no escritório. */
  vigiaId?: string;
}

/** Saída de uma rotina (cron/output/<job>/<data>.md). */
export interface HermesRunOutput {
  jobId: string;
  jobName: string;
  at: number;
  /** agent = o modelo respondeu; silent = "[SILENT]"; no_change = o monitor não achou mudança (o modelo nem rodou). */
  kind: 'agent' | 'silent' | 'no_change';
  /** Resposta completa (markdown, mascarada), só em 'agent'. */
  text?: string;
}

export interface HermesInstance {
  pair: string;
  interval?: string;
  status?: string;
  position: boolean;
  /** Resultado em % ("1.2", "-0.5"), quando o monitor diz. */
  result?: string;
}

export interface HermesRadarItem {
  pair: string;
  score?: string;
  interval?: string;
}

/** Mercado lido das linhas do monitor do Kairo (mandato, instâncias, radar, eventos, avisos). */
export interface HermesMarket {
  online: boolean;
  active?: boolean;
  available?: string;
  open?: string;
  loss?: string;
  instances: HermesInstance[];
  radar: HermesRadarItem[];
  events: Array<{ id: string; type: string }>;
  warnings: string[];
}

export interface HermesMonitor {
  jobId: string;
  jobName: string;
  /** Agente "Vigia" no escritório. */
  agentId?: string;
  /** Hora da leitura (mtime do monitor_last_output.txt). */
  at: number;
  lines: string[];
  market?: HermesMarket;
}

export interface HermesProfilePanel {
  name: string;
  /** Agente principal do perfil no escritório. */
  agentId: string;
  description?: string;
  tokensToday: number;
  runsToday: number;
  jobs: HermesJob[];
  /** Saídas mais recentes (da mais nova para a mais antiga). */
  outputs: HermesRunOutput[];
  monitors: HermesMonitor[];
}

export interface HermesWeather {
  tempC: number;
  /** Código WMO do open-meteo. */
  code: number;
  day: boolean;
  place?: string;
}

export interface HermesPanel {
  generatedAt: number;
  system: HermesSystem;
  quotas: HermesQuotas;
  profiles: HermesProfilePanel[];
  weather?: HermesWeather;
  /** Links configurados (HABBLAUD_OMNIROUTE_URL, HABBLAUD_BESZEL_URL). */
  links?: { omniroute?: string; beszel?: string };
}

/** Códigos WMO de chuva/garoa/trovoada e de céu encoberto/neblina. */
const RAIN = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
const CLOUD = new Set([2, 3, 45, 48]);

export function weatherKind(w: Pick<HermesWeather, 'code' | 'day'>): 'rain' | 'cloud' | 'night' | 'sun' {
  if (RAIN.has(w.code)) return 'rain';
  if (CLOUD.has(w.code)) return 'cloud';
  return w.day ? 'sun' : 'night';
}
