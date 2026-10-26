// Fonte de agentes do Hermes Agent (NousResearch) — AgentSource 'hermes', ver sources/source.ts. Lê, SOMENTE LEITURA,
// o diretório de dados do Hermes (HABBLAUD_HERMES_DIR; no container do Hermes, /opt/data) e alimenta o Office.
//
// Cada perfil (profiles/<perfil>, ou a raiz como "default") é uma SALA com um agente principal PERMANENTE, o
// "funcionário" do perfil: ele não sai entre uma execução e outra (as rotinas do cron rodam a cada poucos minutos e
// a sala sumiria e voltaria a cada uma). Status:
// - working: uma execução do cron rodando (cron/executions.db, status 'claimed'/'running' há mais de EXEC_SETTLE_MS:
//   as checagens do monitor que não acham mudança terminam antes disso e não acordam ninguém) ou mensagens novas nos
//   últimos WORKING_RECENT_MS numa sessão que ainda não terminou o turno;
// - waiting: a última chamada é um `clarify` (pergunta a você) ainda sem resposta;
// - offline: o gateway do perfil não está rodando (gateway_state.json; sem ele, o batimento do agendador em
//   cron/ticker_heartbeat parado há mais de HEARTBEAT_STALE_MS). O personagem sai pelo elevador e volta quando o
//   gateway voltar (ou quando aparecer uma mensagem nova: alguém está usando o perfil pela CLI);
// - idle: o resto.
// Atividades: as mensagens novas do state.db (cursor pelo id da mensagem, polling de ~1 s; ver describe.ts). No boot,
// as últimas BOOT_MESSAGES de cada perfil entram como histórico (sem feed ao vivo). Sessões filhas
// (`parent_session_id`, ex.: delegate_task) viram subagentes enquanto não terminam.
//
// Vigia: cada rotina com monitor (monitor_script / monitor_url, ex.: vigia-mercado) ganha um segundo agente
// permanente na sala, o "Vigia". Cada checagem do monitor (execução curta no executions.db) vira uma atividade só no
// histórico dele; quando a checagem acorda o principal (sessão nova do cron daquela rotina), o feed mostra "Chamou
// <principal>: <motivo>" (a primeira linha nova da diferença). Uma leitura nova do monitor do Kairo pode acender a
// sala: venda com lucro = festa, pausa por risco = alarme (cron.ts, marketEffect).
//
// Agentes adicionais (HABBLAUD_HERMES_AGENTES, ex.: crypto/analista-mercado=Analista): um personagem permanente a mais
// na sala do perfil por rotina configurada, dono das sessões do cron dela (atividades, status, título, números e
// terminal saem do principal e vão para ele). Mesma regra de status do principal, só com a rotina dele. Rotina que não
// está no jobs.json: o agente não entra (aviso no log).
//
// Nomes: HABBLAUD_HERMES_SALAS dá o nome exibido da sala de cada perfil (o apelido padrão da pasta: o "Renomear" do
// menu continua valendo por cima) e HABBLAUD_HERMES_NOMES o do principal e de cada Vigia (o personagem do editor
// continua valendo por cima; ver Office.addMain). Cada leitura nova do monitor também vai para o histórico das leituras
// (readings.ts), no diretório de dados do Habblaud.
//
// Terminal e histórico de sessões: a conversa está no SQLite, não num JSONL (transcriptPathOf devolve undefined).
// terminalFeed() monta o terminal pelo banco e pelas saídas do cron (terminal.ts); history() lista as sessões
// recentes de todos os perfis para o histórico do terminal. panel() monta o painel (GET /api/hermes/painel). Ver
// README.md desta pasta.
import { join } from 'node:path';
import { maskSecrets, truncate } from '../../../shared/activity';
import type { HermesMarket, HermesModelUsage, HermesPanel, HermesProfilePanel } from '../../../shared/hermes';
import type { AgentStats, AgentStatus, RecentSession, SourceInfo } from '../../../shared/types';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office, TranscriptSummary } from '../../model/office';
import { HISTORY_DAYS } from '../history';
import type { AgentSource, HistoryProvider, HistoryResolveResult, TerminalFeed } from '../source';
import type { HermesAgentName, HermesExtraAgent } from './config';
import { diffOf, marketEffect, parseMarket, wakeReason } from './cron';
import { describeMessage, parseToolCalls, type HermesMessage } from './describe';
import { OutputIndex, readAgentLogs, readUsageAudit, SystemReader, utcDay, WeatherService, type SystemReaderOptions, type WeatherOptions } from './panel';
import { discoverProfiles, jobIdOfSession, parseGateway, parseHeartbeat, parseJobs, parseProfileDescription, SmallFile, type CronJob, type HermesProfile } from './profiles';
import { loadSqlite, ReadOnlyDb, type ReadMode, type SqliteDatabase, type SqliteModule } from './sqlite';
import type { ReadingStore } from './readings';
import { MainFeed, readMonitorLines, SessionFeed, VigiaFeed } from './terminal';
import { normalizeCwd } from '../../model/rooms';
import { tr } from '../../../shared/i18n';

/** Mensagem nos últimos 60 s (turno ainda aberto) = trabalhando. */
export const WORKING_RECENT_MS = 60_000;
/** Execução do cron precisa estar rodando há este tempo para contar (checagens do monitor duram menos de 1 s). */
export const EXEC_SETTLE_MS = 3_000;
/** Execução marcada como rodando há mais que isto: sobra de um crash, não conta. */
export const EXEC_STALE_MS = 3 * 3600_000;
/** Sem gateway_state.json: batimento do agendador parado há mais que isto = gateway parado. */
export const HEARTBEAT_STALE_MS = 10 * 60_000;
/** Subagente (sessão filha) sem mensagem nova há mais que isto: entregou. */
export const SUB_QUIET_MS = 5 * 60_000;
/** Mensagens lidas de cada perfil no boot (histórico). */
export const BOOT_MESSAGES = 80;
/** Mensagens por consulta (e até 5 consultas por ciclo). */
const BATCH = 400;
/** Releitura da lista de perfis. */
const RESCAN_MS = 10_000;
/** Execuções do monitor lidas por ciclo (as mais recentes): viram as checagens do Vigia. */
const VIGIA_EXECS = 30;
/** Painel do Hermes: refeito no máximo a cada 5 s. */
const PANEL_TTL_MS = 5_000;
/** Duração da festa (venda com lucro) e do alarme (pausa por risco) na sala. */
const PARTY_MS = 15_000;
const ALARM_MS = 10 * 60_000;
const MAIN_ROLE = tr('Agente Hermes');
const SUB_ROLE = tr('Subagente (Hermes)');
const ANALYST_ROLE = tr('Analista');
/** Conta única da fonte (uma pasta de dados do Hermes). */
const ACCOUNT_ID = 'hermes';
const ACCOUNT_COLOR = '#d9a441';

/** Colunas de `messages` que lemos (as que faltarem numa versão do Hermes ficam de fora). */
const MESSAGE_COLUMNS: Record<string, string> = {
  id: 'id',
  session_id: 'session_id',
  role: 'role',
  content: 'substr(content, 1, 8000) AS content',
  tool_call_id: 'tool_call_id',
  tool_calls: 'substr(tool_calls, 1, 20000) AS tool_calls',
  tool_name: 'tool_name',
  timestamp: 'timestamp',
  finish_reason: 'finish_reason',
  reasoning: 'substr(reasoning, 1, 2000) AS reasoning',
};
const SESSION_COLUMNS = [
  'id',
  'source',
  'title',
  'model',
  'parent_session_id',
  'started_at',
  'ended_at',
  'end_reason',
  'tool_call_count',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'estimated_cost_usd',
  'actual_cost_usd',
  'last_activity_at',
];

export interface HermesSourceOptions {
  office: Office;
  accounts: AccountsService;
  /** Diretório de dados do Hermes lido por este processo (no Docker, o montado). */
  dir: string;
  /** Onde ficam as cópias do modo 'snapshot' (sqlite.ts). Padrão: a pasta temporária do sistema. */
  tmpDir?: string;
  now?: () => number;
  pollMs?: number;
  /** `node:sqlite` (testes podem trocar). */
  sqlite?: SqliteModule;
  /** Força o modo de leitura dos bancos (testes). */
  readMode?: ReadMode;
  /** Tempo lá fora no painel (open-meteo); ausente ou false = desligado. */
  weather?: WeatherOptions | false;
  /** Links do painel (OmniRoute, Beszel). */
  links?: HermesPanel['links'];
  /** Leitura do computador (testes trocam /proc, /sys e o os). */
  system?: Partial<SystemReaderOptions>;
  /** HABBLAUD_HERMES_SALAS: perfil -> nome exibido da sala (aplicado por `setRoomName`). */
  roomNames?: ReadonlyMap<string, string>;
  /** Dá o nome padrão da sala de uma pasta (RoomAliases.setDefault: o nome escolhido no menu vale por cima). */
  setRoomName?: (path: string, name: string) => void;
  /** HABBLAUD_HERMES_NOMES: "perfil" ou "perfil/rotina" -> nome do agente. */
  agentNames?: ReadonlyMap<string, HermesAgentName>;
  /** Histórico das leituras do monitor (HABBLAUD_HERMES_LEITURAS_DIAS); ausente = desligado. */
  readings?: ReadingStore;
  /** HABBLAUD_HERMES_AGENTES: agentes adicionais, donos das sessões do cron de uma rotina. */
  extraAgents?: readonly HermesExtraAgent[];
}

/** Uma linha de `sessions` (só o que usamos). */
interface SessionRow {
  id: string;
  source?: string;
  title?: string;
  model?: string;
  parent_session_id?: string | null;
  started_at?: number;
  ended_at?: number | null;
  end_reason?: string | null;
  tool_call_count?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  estimated_cost_usd?: number | null;
  actual_cost_usd?: number | null;
  last_activity_at?: number | null;
}

interface ExecRow {
  job_id: string;
  status: string;
  claimed_at?: string;
  started_at?: string | null;
}

/** Execução terminada do cron (as checagens do monitor). */
interface DoneExecRow {
  id: string;
  job_id: string;
  status: string;
  started_at?: string | null;
  claimed_at?: string;
  finished_at?: string | null;
}

/** O Vigia de uma rotina com monitor. */
interface VigiaTracker {
  key: string;
  job: CronJob;
  inOffice: boolean;
  status: AgentStatus;
  /** Execuções já vistas (por id). */
  seen: Set<string>;
  /** Assinatura da última leitura do monitor vista e o mercado dela. */
  readSig: string;
  market?: HermesMarket;
  lastAt?: number;
}

/** A última mensagem de um agente (principal ou adicional): o estado do turno. */
interface LastMessage {
  at: number;
  sessionId: string;
  role: string;
  finish?: string | null;
  clarify: boolean;
}

/** Um agente adicional (HABBLAUD_HERMES_AGENTES): dono das sessões do cron de uma rotina. */
interface ExtraTracker {
  key: string;
  job: CronJob;
  config: HermesExtraAgent;
  inOffice: boolean;
  status: AgentStatus;
  /** Última mensagem das sessões dele. */
  last?: LastMessage;
  /** Sessão mais recente dele. */
  current?: SessionRow;
}

interface SubTracker {
  key: string;
  sessionId: string;
  inOffice: boolean;
  done: boolean;
  lastAt: number;
}

interface ProfileTracker {
  profile: HermesProfile;
  /** Id do agente principal: "<conta>:<perfil>". */
  key: string;
  state: ReadOnlyDb | null;
  execs: ReadOnlyDb | null;
  jobs: SmallFile<CronJob[]>;
  gateway: SmallFile<{ state?: string; desired?: string }>;
  heartbeat: SmallFile<number | undefined>;
  yaml: SmallFile<string | undefined>;
  /** Maior id de mensagem já processado (-1 = ainda não leu). */
  cursor: number;
  stateSig: string;
  execSig: string;
  execRows: ExecRow[];
  columns?: { messages: string[]; sessions: string[] };
  /** Última mensagem vista (de qualquer sessão principal que não é de um agente adicional). */
  last?: LastMessage;
  /** Sessões recentes (as 12 mais novas e as das mensagens lidas), por id. */
  sessions: Map<string, SessionRow>;
  /** Sessão principal mais recente (fora as dos agentes adicionais). */
  current?: SessionRow;
  /** Início do turno por sessão (epoch ms). */
  turnStart: Map<string, number>;
  /** tool_call_id -> nome (para o rótulo do erro de um resultado); só os últimos. */
  toolNames: Map<string, string>;
  /** Hora da última mensagem por sessão filha. */
  subLast: Map<string, number>;
  subs: Map<string, SubTracker>;
  /** last_run_at por rotina (para avisar uma rotina que falhou). */
  jobRuns: Map<string, number | undefined>;
  /** Vigias (um por rotina com monitor), pelo id da rotina. */
  vigias: Map<string, VigiaTracker>;
  /** Agentes adicionais, pelo id da rotina. */
  extras: Map<string, ExtraTracker>;
  /** Rotinas configuradas em HABBLAUD_HERMES_AGENTES que não estão no jobs.json (já avisadas no log). */
  missingExtras: Set<string>;
  /** Execuções terminadas das rotinas com monitor (as mais recentes). */
  doneExecs: DoneExecRow[];
  execCols?: Set<string>;
  /** Uso por modelo hoje (session_model_usage), refeito quando o banco muda. */
  usage?: { sig: string; day: string; rows: HermesModelUsage[] };
  status: AgentStatus;
  inOffice: boolean;
  error?: string;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'bigint' ? Number(v) : undefined;
}

function isoMs(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  // "2026-10-22T19:00:25.836722+00:00": Date.parse aceita microssegundos.
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

export class HermesSource implements AgentSource {
  readonly provider = 'hermes' as const;
  private trackers = new Map<string, ProfileTracker>();
  private entries: readonly AccountEntry[] = [];
  private accountId = ACCOUNT_ID;
  private sqlite?: SqliteModule;
  private loadError?: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastScan = -Infinity;
  private stopped = false;
  private readonly now: () => number;
  private readonly system: SystemReader;
  private readonly outputs = new OutputIndex();
  private readonly weather?: WeatherService;
  private panelCache?: { at: number; value: HermesPanel };

  constructor(private readonly opts: HermesSourceOptions) {
    this.now = opts.now ?? Date.now;
    this.entries = opts.accounts.setProviderAccounts('hermes', [
      { dir: opts.dir, detected: { id: ACCOUNT_ID, configDir: opts.dir, short: 'H', name: 'Hermes', color: ACCOUNT_COLOR } },
    ]);
    this.accountId = this.entries[0]?.id ?? ACCOUNT_ID;
    this.system = new SystemReader({ dir: opts.dir, ...opts.system });
    if (opts.weather) this.weather = new WeatherService({ now: this.now, ...opts.weather });
  }

  /** Perfis encontrados (salas). */
  profileCount(): number {
    return this.trackers.size;
  }

  /** Conta do Hermes (id final, no AccountsService). */
  accountEntries(): readonly AccountEntry[] {
    return this.entries;
  }

  start(): void {
    this.boot();
    this.timer = setInterval(() => this.safePoll(), this.opts.pollMs ?? 1_000);
    this.timer.unref?.();
  }

  /** Reconstrói os perfis sem avisos. Síncrono e curto. */
  boot(): void {
    this.opts.office.beginBoot();
    try {
      if (this.opts.sqlite) this.sqlite = this.opts.sqlite;
      else {
        const loaded = loadSqlite();
        this.sqlite = loaded.mod;
        if (!loaded.mod) {
          this.loadError = tr('node:sqlite indisponível ({0}); use o Node 22.13 ou mais novo', [loaded.error ?? '?']);
          log.warn(tr('Hermes: {0}.', [this.loadError]));
        }
      }
      this.poll(true);
    } finally {
      this.opts.office.endBoot();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const t of this.trackers.values()) {
      t.state?.close();
      t.execs?.close();
    }
  }

  sources(): SourceInfo[] {
    let sessions = 0;
    const errors: string[] = [];
    for (const t of this.trackers.values()) {
      if (t.inOffice && t.status !== 'offline') sessions++;
      if (t.error) errors.push(`${t.profile.name}: ${t.error}`);
    }
    const error = this.loadError ?? (this.trackers.size ? errors[0] : tr('nenhum perfil do Hermes encontrado'));
    const info: SourceInfo = { label: this.accountId, provider: 'hermes', path: this.opts.dir, sessions, ok: !error };
    if (error) info.error = error;
    return [info];
  }

  /** A conversa do Hermes está no SQLite, não num arquivo JSONL: o terminal vem de terminalFeed (ver README.md). */
  transcriptPathOf(): string | undefined {
    return undefined;
  }

  /** Terminal de um agente do Hermes: o principal (banco + saídas do cron) ou um Vigia (checagens + leitura). */
  terminalFeed(agentId: string): TerminalFeed | undefined {
    for (const t of this.trackers.values()) {
      const jobs = () => t.jobs.read() ?? [];
      if (agentId === t.key) return new MainFeed({ state: t.state, dir: t.profile.dir, jobs, scope: () => ({ exclude: [...t.extras.keys()] }) });
      for (const e of t.extras.values()) {
        if (e.key !== agentId) continue;
        const jobId = e.job.id;
        return new MainFeed({ state: t.state, dir: t.profile.dir, jobs, scope: () => ({ only: jobId }) });
      }
      for (const v of t.vigias.values()) {
        if (v.key !== agentId) continue;
        const store = this.opts.readings?.enabled ? this.opts.readings : undefined;
        return new VigiaFeed(t.profile.dir, v.job, () => this.opts.office.get(this.ownerKeyOfJob(t, v.job.id))?.name ?? t.profile.name, {
          now: this.now,
          ...(store ? { readings: (from: number, to: number) => store.list(t.profile.name, v.job.id, from, to) } : {}),
        });
      }
    }
    return undefined;
  }

  /** Histórico do terminal: as sessões recentes de todos os perfis (a conversa sai pelo SessionFeed). */
  history(): HistoryProvider {
    return {
      provider: 'hermes',
      hasAccount: (account) => account === this.accountId,
      list: async () => this.recentSessions(),
      resolve: (account, sessionId) => this.resolveSession(account, sessionId),
    };
  }

  // ---------------------------------------------------------------- polling

  private safePoll(): void {
    if (this.stopped) return;
    try {
      this.poll(false);
    } catch (err) {
      log.warnOnce(`hermes-poll:${errMsg(err)}`, tr('Hermes: falha no ciclo de leitura: {0}', [errMsg(err)]));
    }
  }

  poll(boot = false): void {
    const now = this.now();
    if (boot || now - this.lastScan >= RESCAN_MS) {
      this.lastScan = now;
      this.rescan();
    }
    for (const t of this.trackers.values()) {
      try {
        this.pollProfile(t, now, boot);
      } catch (err) {
        t.error = errMsg(err);
        log.warnOnce(`hermes-profile:${t.key}:${t.error}`, tr('Hermes: perfil {0}: {1}', [t.profile.name, t.error]));
      }
    }
  }

  /** Perfis novos entram; perfis que sumiram (pasta apagada) saem do escritório. */
  private rescan(): void {
    const found = discoverProfiles(this.opts.dir);
    const seen = new Set<string>();
    for (const p of found) {
      const key = `${this.accountId}:${p.name}`;
      seen.add(key);
      if (this.trackers.has(key)) continue;
      const room = this.opts.roomNames?.get(p.name);
      if (room) this.opts.setRoomName?.(this.roomPathOf(p), room);
      this.trackers.set(key, this.newTracker(p, key));
    }
    for (const [key, t] of [...this.trackers]) {
      if (seen.has(key)) continue;
      if (t.inOffice) this.opts.office.closeMain(t.key);
      for (const v of t.vigias.values()) if (v.inOffice) this.opts.office.closeMain(v.key);
      for (const e of t.extras.values()) if (e.inOffice) this.opts.office.closeMain(e.key);
      t.state?.close();
      t.execs?.close();
      this.trackers.delete(key);
    }
  }

  /** Pasta da sala do perfil (o "default" na raiz ganha uma pasta própria, para não virar a sala do diretório todo). */
  private roomPathOf(profile: HermesProfile): string {
    return profile.name === 'default' && profile.dir === this.opts.dir ? join(this.opts.dir, 'profiles', 'default') : profile.dir;
  }

  /** Nome exibido da sala do perfil (o do escritório: apelido do menu, HABBLAUD_HERMES_SALAS ou a pasta). */
  private roomNameOf(t: ProfileTracker): string {
    const office = this.opts.office;
    return office.roomName(office.get(t.key)?.roomId ?? normalizeCwd(this.roomPathOf(t.profile)));
  }

  private newTracker(profile: HermesProfile, key: string): ProfileTracker {
    const db = (path: string) => (this.sqlite ? new ReadOnlyDb(path, this.sqlite, { tmpDir: this.opts.tmpDir, force: this.opts.readMode }) : null);
    return {
      profile,
      key,
      state: db(join(profile.dir, 'state.db')),
      execs: db(join(profile.dir, 'cron', 'executions.db')),
      jobs: new SmallFile(join(profile.dir, 'cron', 'jobs.json'), parseJobs),
      gateway: new SmallFile(join(profile.dir, 'gateway_state.json'), parseGateway, 64 * 1024),
      heartbeat: new SmallFile(join(profile.dir, 'cron', 'ticker_heartbeat'), parseHeartbeat, 1024),
      yaml: new SmallFile(join(profile.dir, 'profile.yaml'), parseProfileDescription, 64 * 1024),
      cursor: -1,
      stateSig: '',
      execSig: '',
      execRows: [],
      sessions: new Map(),
      turnStart: new Map(),
      toolNames: new Map(),
      subLast: new Map(),
      subs: new Map(),
      jobRuns: new Map(),
      vigias: new Map(),
      extras: new Map(),
      missingExtras: new Set(),
      doneExecs: [],
      status: 'idle',
      inOffice: false,
    };
  }

  private pollProfile(t: ProfileTracker, now: number, boot: boolean): void {
    const office = this.opts.office;
    if (t.inOffice && !office.has(t.key)) t.inOffice = false;
    const jobs = t.jobs.read() ?? [];
    if (!t.inOffice) this.enter(t, now);
    // Antes das mensagens: as sessões da rotina de um agente adicional já vão para ele.
    this.syncExtras(t, jobs, now);
    const errors: string[] = [];

    // Execuções do cron (relidas só quando o banco muda; o filtro por tempo roda sempre).
    if (t.execs?.exists()) {
      const sig = t.execs.signature();
      if (sig !== t.execSig) {
        const monitorJobs = jobs.filter((j) => j.monitor).map((j) => j.id);
        const rows = t.execs.read((db) => {
          const running = db.prepare("SELECT job_id, status, claimed_at, started_at FROM executions WHERE status IN ('claimed', 'running') ORDER BY claimed_at DESC LIMIT 8").all() as unknown as ExecRow[];
          let done: DoneExecRow[] = [];
          if (monitorJobs.length) {
            t.execCols ??= new Set(this.columnsOf(db, 'executions'));
            const fin = t.execCols.has('finished_at') ? 'finished_at' : 'NULL AS finished_at';
            done = db
              .prepare(`SELECT id, job_id, status, claimed_at, started_at, ${fin} FROM executions WHERE job_id IN (${monitorJobs.map(() => '?').join(', ')}) AND status IN ('completed', 'failed') ORDER BY claimed_at DESC LIMIT ${VIGIA_EXECS}`)
              .all(...monitorJobs) as unknown as DoneExecRow[];
          }
          return { running, done };
        });
        if (rows) {
          t.execRows = rows.running;
          t.doneExecs = rows.done;
          t.execSig = sig;
        } else if (t.execs.error) errors.push(`executions.db: ${t.execs.error}`);
      }
    } else t.execRows = [];

    // Mensagens novas (só quando o banco ou o WAL mudaram).
    if (t.state?.exists()) {
      const sig = t.state.signature();
      if (sig !== t.stateSig || boot) {
        const ok = t.state.read((db) => this.readState(t, db, jobs, now, boot));
        if (ok) t.stateSig = sig;
        else if (t.state.error) errors.push(`state.db: ${t.state.error}`);
      }
    }
    if (!t.state && !this.loadError) errors.push('node:sqlite');
    t.error = errors[0];

    this.checkJobs(t, jobs, boot);
    this.syncVigias(t, jobs, now, boot);
    this.syncSubs(t, now);
    const status = this.statusOf(t, t.last, (r) => !t.extras.has(r.job_id), now);
    if (status !== t.status) {
      t.status = status;
      office.setStatus(t.key, status, status === 'waiting' ? tr('responder uma pergunta') : undefined);
    }
    if (status === 'working') office.fillWorkingActivity(t.key);
    this.applySummary(t, jobs);
    this.updateExtras(t, now);
  }

  private enter(t: ProfileTracker, now: number): void {
    const fixed = this.opts.agentNames?.get(t.profile.name);
    this.opts.office.addMain({
      id: t.key,
      provider: 'hermes',
      account: this.accountId,
      // Fixo por perfil: o personagem (nome, aparência) é o mesmo em todas as execuções.
      sessionId: `hermes-${t.profile.name}`,
      cwd: this.roomPathOf(t.profile),
      role: MAIN_ROLE,
      startedAt: now,
      status: t.status,
      ...(fixed ? { name: fixed.name, look: fixed.look } : {}),
    });
    t.inOffice = this.opts.office.has(t.key);
  }

  /** Colunas existentes de uma tabela (PRAGMA table_info). */
  private columnsOf(db: SqliteDatabase, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>).map((r) => String(r.name));
  }

  /** Lê o que é novo no state.db: sessões recentes e mensagens depois do cursor. */
  private readState(t: ProfileTracker, db: SqliteDatabase, jobs: readonly CronJob[], now: number, boot: boolean): true {
    if (!t.columns) {
      const m = new Set(this.columnsOf(db, 'messages'));
      const s = new Set(this.columnsOf(db, 'sessions'));
      t.columns = {
        messages: Object.entries(MESSAGE_COLUMNS)
          .filter(([c]) => m.has(c))
          .map(([, expr]) => expr),
        sessions: SESSION_COLUMNS.filter((c) => s.has(c)),
      };
    }
    const sessionCols = t.columns.sessions.join(', ');
    const order = t.columns.sessions.includes('started_at') ? 'started_at' : 'rowid';
    const recent = db.prepare(`SELECT ${sessionCols} FROM sessions ORDER BY ${order} DESC LIMIT 12`).all() as unknown as SessionRow[];
    t.sessions = new Map(recent.map((s) => [s.id, s]));
    const own = (s: SessionRow) => !s.parent_session_id && !this.extraOf(t, s.id);
    t.current = recent.find(own) ?? (t.current && own(t.current) ? t.current : undefined);
    for (const e of t.extras.values()) {
      const cur = recent.find((s) => !s.parent_session_id && jobIdOfSession(s.id) === e.job.id);
      if (cur) e.current = cur;
    }

    const maxRow = db.prepare('SELECT max(id) AS m FROM messages').get() as { m?: unknown } | undefined;
    const maxId = num(maxRow?.m) ?? 0;
    if (t.cursor < 0) {
      // Primeira leitura: as últimas BOOT_MESSAGES viram histórico.
      t.cursor = Math.max(0, maxId - BOOT_MESSAGES);
      boot = true;
    } else if (maxId < t.cursor) {
      // Banco trocado ou podado: segue do fim, sem repetir nada.
      t.cursor = maxId;
    }
    const select = db.prepare(`SELECT ${t.columns.messages.join(', ')} FROM messages WHERE id > ? ORDER BY id LIMIT ${BATCH}`);
    for (let i = 0; i < 5; i++) {
      const rows = select.all(t.cursor) as unknown as HermesMessage[];
      if (!rows.length) break;
      const missing = [...new Set(rows.map((r) => r.session_id))].filter((id) => !t.sessions.has(id));
      if (missing.length) {
        const q = db.prepare(`SELECT ${sessionCols} FROM sessions WHERE id IN (${missing.map(() => '?').join(', ')})`);
        for (const s of q.all(...missing) as unknown as SessionRow[]) t.sessions.set(s.id, s);
      }
      for (const m of rows) this.applyMessage(t, m, jobs, now, boot);
      t.cursor = num(rows[rows.length - 1].id) ?? t.cursor;
      if (rows.length < BATCH) break;
    }
    return true;
  }

  /** Uma mensagem nova: atividades no agente certo (principal ou subagente) e o estado do turno. */
  private applyMessage(t: ProfileTracker, m: HermesMessage, jobs: readonly CronJob[], now: number, boot: boolean): void {
    const office = this.opts.office;
    const session = t.sessions.get(m.session_id);
    const ts = num(m.timestamp);
    const at = ts !== undefined && ts > 0 ? Math.round(ts * 1000) : now;
    const isSub = !!session?.parent_session_id;
    if (m.role === 'user') t.turnStart.set(m.session_id, at);
    const jobId = jobIdOfSession(m.session_id);
    const jobName = jobId ? (jobs.find((j) => j.id === jobId)?.name ?? jobId) : session?.source === 'cron' ? tr('rotina agendada') : undefined;
    const turnStartMs = t.turnStart.get(m.session_id) ?? (session?.started_at ? Math.round(session.started_at * 1000) : undefined);
    const acts = describeMessage(m, { jobName, turnStartMs }, t.toolNames);
    if (t.toolNames.size > 400) for (const k of [...t.toolNames.keys()].slice(0, 200)) t.toolNames.delete(k);

    // Sessão (ou sessão mãe) de uma rotina com agente adicional: tudo vai para ele, não para o principal.
    const owner = this.extraOf(t, isSub ? (session?.parent_session_id ?? m.session_id) : m.session_id);
    const ownerKey = owner?.key ?? t.key;
    let target = ownerKey;
    if (isSub) {
      t.subLast.set(m.session_id, at);
      const sub = t.subs.get(m.session_id);
      // Subagente ainda fora do escritório (entra no syncSubs deste ciclo): as atividades vão para o dono da sessão mãe.
      if (sub?.inOffice && !sub.done) target = sub.key;
    } else {
      const calls = m.role === 'assistant' ? parseToolCalls(m.tool_calls) : [];
      const last: LastMessage = { at, sessionId: m.session_id, role: m.role, finish: m.finish_reason, clarify: calls.some((c) => c.name === 'clarify') };
      if (owner) {
        owner.last = last;
        if (session) owner.current = session;
      } else t.last = last;
    }
    for (const a of acts) {
      const { key, ...desc } = a;
      office.addActivity(target, { id: `${t.key}#${m.id}:${key}`, at, ...desc }, true, { feed: !boot });
    }
    // O pedido de uma rotina com monitor = o Vigia acordou o principal (a diferença do monitor vem no pedido).
    const vigia = !isSub && m.role === 'user' && jobId ? this.vigiaFor(t, jobId, jobs, now) : undefined;
    if (vigia) this.vigiaWoke(t, vigia, m, at, boot, ownerKey);
  }

  /** Agente adicional (no escritório) dono de uma sessão do cron. */
  private extraOf(t: ProfileTracker, sessionId: string): ExtraTracker | undefined {
    if (!t.extras.size) return undefined;
    const jobId = jobIdOfSession(sessionId);
    const e = jobId ? t.extras.get(jobId) : undefined;
    return e?.inOffice ? e : undefined;
  }

  /** Quem roda as sessões de uma rotina: o agente adicional dela (no escritório) ou o principal. */
  private ownerKeyOfJob(t: ProfileTracker, jobId: string): string {
    const e = t.extras.get(jobId);
    return e?.inOffice ? e.key : t.key;
  }

  /** O Vigia de uma rotina com monitor (criado aqui se a mensagem chegou antes do primeiro syncVigias). */
  private vigiaFor(t: ProfileTracker, jobId: string, jobs: readonly CronJob[], now: number): VigiaTracker | undefined {
    const known = t.vigias.get(jobId);
    if (known) return known;
    const job = jobs.find((j) => j.id === jobId && j.monitor);
    if (!job || !t.inOffice) return undefined;
    const v: VigiaTracker = { key: `${t.key}:vigia:${job.id}`, job, inOffice: false, status: 'idle', seen: new Set(), readSig: '' };
    t.vigias.set(job.id, v);
    this.enterVigia(t, v, now);
    return v;
  }

  /** "Chamou <principal>: <motivo>" no Vigia (no feed, fora do boot). */
  private vigiaWoke(t: ProfileTracker, v: VigiaTracker, m: HermesMessage, at: number, boot: boolean, ownerKey: string): void {
    const office = this.opts.office;
    if (!v.inOffice) return;
    const main = office.get(ownerKey)?.name ?? t.profile.name;
    const diff = typeof m.content === 'string' ? diffOf(m.content) : undefined;
    const reason = wakeReason(diff, 44);
    office.addActivity(
      v.key,
      {
        id: `${v.key}#wake:${m.id}`,
        at,
        kind: 'communicate',
        icon: '📣',
        text: truncate(reason ? tr('Chamou {0}: {1}', [main, reason]) : tr('Chamou {0}: o monitor mudou', [main]), 46),
        ...(diff ? { detail: truncate(maskSecrets(diff.slice(0, 1_200)), 300) } : {}),
        tool: 'cron',
      },
      true,
      { feed: !boot },
    );
    v.lastAt = Math.max(v.lastAt ?? 0, at);
  }

  /** Rotina que terminou com erro desde a última leitura: atividade de erro (fora do boot). */
  private checkJobs(t: ProfileTracker, jobs: readonly CronJob[], boot: boolean): void {
    for (const j of jobs) {
      const prev = t.jobRuns.get(j.id);
      const seen = t.jobRuns.has(j.id);
      t.jobRuns.set(j.id, j.lastRunAt);
      if (boot || !seen || j.lastRunAt === undefined || j.lastRunAt === prev) continue;
      if (!j.lastStatus || /^(ok|success|completed|no_change|silent)$/i.test(j.lastStatus)) continue;
      const target = this.ownerKeyOfJob(t, j.id);
      this.opts.office.addActivity(
        target,
        { id: `${target}#job:${j.id}:${j.lastRunAt}`, at: j.lastRunAt, kind: 'error', icon: '⚠️', text: truncate(tr('Rotina falhou: {0}', [j.name]), 46), ...(j.lastError ? { detail: truncate(maskSecrets(j.lastError.slice(0, 1_200)), 300) } : {}), tool: 'cron', error: true },
        true,
      );
    }
  }

  private enterVigia(t: ProfileTracker, v: VigiaTracker, now: number): void {
    const office = this.opts.office;
    const names = this.opts.agentNames;
    const fixed = names?.get(`${t.profile.name}/${v.job.name}`) ?? names?.get(`${t.profile.name}/${v.job.id}`);
    office.addMain({
      id: v.key,
      provider: 'hermes',
      account: this.accountId,
      sessionId: `hermes-${t.profile.name}-vigia-${v.job.id}`,
      cwd: this.roomPathOf(t.profile),
      role: /mercado|market|kairo/i.test(v.job.name) ? tr('Vigia do mercado') : tr('Vigia da rotina {0}', [v.job.name]),
      startedAt: now,
      status: v.status,
      name: fixed?.name ?? tr('Vigia'),
      ...(fixed ? { look: fixed.look } : {}),
    });
    v.inOffice = office.has(v.key);
  }

  /**
   * Um Vigia por rotina com monitor: entra e sai com a rotina, fica 'idle' (ou 'offline' com o gateway parado) e
   * ganha uma atividade (só no histórico) por checagem e por leitura nova do monitor.
   */
  private syncVigias(t: ProfileTracker, jobs: readonly CronJob[], now: number, boot: boolean): void {
    const office = this.opts.office;
    const want = new Map(jobs.filter((j) => j.monitor && t.inOffice).map((j) => [j.id, j] as const));
    for (const [id, v] of [...t.vigias]) {
      if (want.has(id)) continue;
      if (v.inOffice) office.closeMain(v.key);
      t.vigias.delete(id);
    }
    const offline = this.gatewayOf(t, now) === 'stopped';
    for (const job of want.values()) {
      let v = t.vigias.get(job.id);
      if (!v) {
        v = { key: `${t.key}:vigia:${job.id}`, job, inOffice: false, status: 'idle', seen: new Set(), readSig: '' };
        t.vigias.set(job.id, v);
      }
      v.job = job;
      if (v.inOffice && !office.has(v.key)) v.inOffice = false;
      const status: AgentStatus = offline ? 'offline' : 'idle';
      if (!v.inOffice) {
        v.status = status;
        this.enterVigia(t, v, now);
        if (!v.inOffice) continue;
      } else if (status !== v.status) {
        v.status = status;
        office.setStatus(v.key, status);
      }
      this.vigiaChecks(t, v);
      this.vigiaReading(t, v, boot);
      const summary: TranscriptSummary = {
        tasks: [],
        stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
        title: tr('Rotina: {0}', [job.schedule ? `${job.name} (${job.schedule})` : job.name]).slice(0, 120),
      };
      if (v.lastAt) summary.lastAt = v.lastAt;
      office.applyTranscript(v.key, summary);
    }
  }

  /** Cada execução terminada da rotina: uma checagem no histórico do Vigia (as que acordaram o principal vêm do pedido). */
  private vigiaChecks(t: ProfileTracker, v: VigiaTracker): void {
    const rows = t.doneExecs.filter((r) => r.job_id === v.job.id && !v.seen.has(r.id)).reverse();
    for (const r of rows) {
      v.seen.add(r.id);
      const start = isoMs(r.started_at ?? undefined) ?? isoMs(r.claimed_at);
      const end = isoMs(r.finished_at ?? undefined);
      if (start === undefined) continue;
      const ms = end !== undefined ? Math.max(0, end - start) : undefined;
      const failed = r.status === 'failed';
      // Longa = o modelo rodou (o pedido já virou "Chamou ..."); aqui só o registro da checagem.
      const woke = !failed && ms !== undefined && ms >= EXEC_SETTLE_MS;
      const text = failed ? tr('Checagem falhou') : woke ? tr('Checagem: mudou, chamou o agente') : tr('Checagem: sem mudança');
      this.opts.office.addActivity(
        v.key,
        {
          id: `${v.key}#exec:${r.id}`,
          at: end ?? start,
          kind: failed ? 'error' : 'search',
          icon: failed ? '⚠️' : woke ? '🔔' : '👀',
          text,
          detail: tr('Rotina {0}{1}', [v.job.name, ms !== undefined ? ` · ${(ms / 1000).toFixed(1)} s` : '']),
          tool: 'cron',
          ...(failed ? { error: true } : {}),
        },
        true,
        // Só no histórico do Vigia: nunca no feed (nem no do boot).
        { feed: false, filler: true },
      );
      v.lastAt = Math.max(v.lastAt ?? 0, end ?? start);
    }
    if (v.seen.size > 500) v.seen = new Set([...v.seen].slice(-200));
  }

  /** Leitura nova do monitor: atividade no histórico do Vigia e, no Kairo, festa ou alarme na sala. */
  private vigiaReading(t: ProfileTracker, v: VigiaTracker, boot: boolean): void {
    const r = readMonitorLines(join(t.profile.dir, 'cron', 'output', v.job.id, 'monitor_last_output.txt'));
    if (!r) return;
    const sig = `${r.at}:${r.lines.join('|').length}`;
    if (sig === v.readSig) return;
    const first = !v.readSig;
    v.readSig = sig;
    // Histórico das leituras (cada checagem reescreve o arquivo; o conteúdo igual entra só com a hora).
    this.opts.readings?.record(t.profile.name, v.job.id, r.at, r.lines);
    const prev = v.market;
    v.market = parseMarket(r.lines);
    // A primeira leitura (no boot ou ao entrar) não é novidade: só guarda o mercado para comparar.
    if (first) return;
    this.opts.office.addActivity(
      v.key,
      { id: `${v.key}#read:${Math.round(r.at)}`, at: r.at, kind: 'read', icon: '📡', text: tr('Leitura nova do monitor'), detail: truncate(r.lines.slice(0, 8).join(' · '), 300), tool: 'cron' },
      true,
      { feed: false, filler: true },
    );
    if (boot) return;
    const fx = marketEffect(prev, v.market);
    if (fx) this.opts.office.roomEffect(t.key, fx.kind, fx.text, fx.kind === 'party' ? PARTY_MS : ALARM_MS, fx.kind === 'party' ? `🎉 ${fx.text}` : `🚨 ${fx.text}`);
  }

  /** Sessões filhas abertas = subagentes do principal; terminadas (ou quietas) = entregaram. */
  private syncSubs(t: ProfileTracker, now: number): void {
    const office = this.opts.office;
    const want = new Set<string>();
    if (t.inOffice) {
      for (const s of t.sessions.values()) {
        if (!s.parent_session_id || s.ended_at) continue;
        const last = t.subLast.get(s.id) ?? (s.last_activity_at ? s.last_activity_at * 1000 : (s.started_at ?? 0) * 1000);
        if (now - last < SUB_QUIET_MS) want.add(s.id);
      }
    }
    for (const id of want) {
      let sub = t.subs.get(id);
      if (!sub) {
        sub = { key: `${t.key}:${id}`, sessionId: id, inOffice: false, done: false, lastAt: now };
        t.subs.set(id, sub);
      }
      if (sub.inOffice && !sub.done) continue;
      const s = t.sessions.get(id);
      const parent = s?.parent_session_id ? this.extraOf(t, s.parent_session_id) : undefined;
      const added = office.addSub({
        id: sub.key,
        parentId: parent?.key ?? t.key,
        sessionId: id,
        role: SUB_ROLE,
        ...(s?.title ? { title: s.title } : {}),
        background: false,
        startedAt: s?.started_at ? Math.round(s.started_at * 1000) : now,
      });
      sub.inOffice = added;
      sub.done = false;
    }
    for (const [id, sub] of [...t.subs]) {
      if (want.has(id)) continue;
      if (sub.inOffice && !sub.done) office.completeSub(sub.key);
      t.subs.delete(id);
      t.subLast.delete(id);
    }
  }

  /** Gateway do perfil: 'running', 'stopped' ou 'unknown' (sem arquivo nenhum para dizer). */
  private gatewayOf(t: ProfileTracker, now: number): 'running' | 'stopped' | 'unknown' {
    const gw = t.gateway.read();
    if (gw?.state) return /^running$/i.test(gw.state) ? 'running' : 'stopped';
    const beat = t.heartbeat.read();
    if (beat !== undefined) return now - beat < HEARTBEAT_STALE_MS ? 'running' : 'stopped';
    return 'unknown';
  }

  /** Job em execução agora (o mais recente, entre os de `mine`), pelo executions.db. */
  private runningJob(t: ProfileTracker, now: number, mine: (r: ExecRow) => boolean = () => true): ExecRow | undefined {
    return t.execRows.find((r) => {
      if (!mine(r)) return false;
      const since = isoMs(r.started_at ?? undefined) ?? isoMs(r.claimed_at);
      return since !== undefined && now - since >= EXEC_SETTLE_MS && now - since < EXEC_STALE_MS;
    });
  }

  /** Status de um agente do perfil pela última mensagem dele e pelas execuções das rotinas dele (`mine`). */
  private statusOf(t: ProfileTracker, last: LastMessage | undefined, mine: (r: ExecRow) => boolean, now: number): AgentStatus {
    const running = this.runningJob(t, now, mine);
    const session = last ? t.sessions.get(last.sessionId) : undefined;
    const ended = !!session?.ended_at;
    // Turno fechado: a última mensagem é a resposta final do assistente.
    const closed = last?.role === 'assistant' && last.finish === 'stop';
    if (last && !ended && last.clarify && last.role === 'assistant') return 'waiting';
    const recent = !!last && now - last.at < WORKING_RECENT_MS && !ended && !closed;
    if (running || recent) return 'working';
    return this.gatewayOf(t, now) === 'stopped' ? 'offline' : 'idle';
  }

  /** Título (rotina rodando, a da última sessão, ou o título da sessão), modelo e números da sessão atual. */
  private applySummary(t: ProfileTracker, jobs: readonly CronJob[]): void {
    if (!t.inOffice) return;
    const now = this.now();
    const running = this.runningJob(t, now, (r) => !t.extras.has(r.job_id));
    const cur = t.current;
    const jobOf = (id: string | undefined) => (id ? jobs.find((j) => j.id === id) : undefined);
    const job = jobOf(running?.job_id) ?? jobOf(cur ? jobIdOfSession(cur.id) : undefined);
    const description = t.yaml.read();
    const title = job ? tr('Rotina: {0}', [job.name]) : (cur?.title ?? description);
    this.opts.office.applyTranscript(t.key, this.summaryOf(t, cur, title, t.last));
  }

  /** Números, modelo e título de um agente do perfil pela sessão mais recente dele. */
  private summaryOf(t: ProfileTracker, cur: SessionRow | undefined, title: string | undefined, last: LastMessage | undefined): TranscriptSummary {
    const stats: AgentStats = {
      toolCalls: num(cur?.tool_call_count) ?? 0,
      tokensIn: (num(cur?.input_tokens) ?? 0) + (num(cur?.cache_read_tokens) ?? 0) + (num(cur?.cache_write_tokens) ?? 0),
      tokensOut: num(cur?.output_tokens) ?? 0,
      subagents: [...t.sessions.values()].filter((s) => s.parent_session_id && s.parent_session_id === cur?.id).length,
    };
    const cost = num(cur?.actual_cost_usd) || num(cur?.estimated_cost_usd);
    if (cost) stats.costUSD = cost;
    const summary: TranscriptSummary = { tasks: [], stats };
    if (title) summary.title = title.slice(0, 120);
    if (cur?.model) summary.model = cur.model;
    if (last) summary.lastAt = last.at;
    return summary;
  }

  // ---------------------------------------------------------------- agentes adicionais

  /**
   * Agentes adicionais do perfil (HABBLAUD_HERMES_AGENTES): entram com a rotina no jobs.json (pelo id ou pelo nome) e
   * saem quando ela some. Rotina configurada que não existe: nada entra, com um aviso no log (uma vez).
   */
  private syncExtras(t: ProfileTracker, jobs: readonly CronJob[], now: number): void {
    const configs = this.opts.extraAgents?.filter((c) => c.profile === t.profile.name) ?? [];
    if (!configs.length && !t.extras.size) return;
    const office = this.opts.office;
    const want = new Map<string, { job: CronJob; config: HermesExtraAgent }>();
    if (t.inOffice) {
      for (const config of configs) {
        const job = jobs.find((j) => j.id === config.job) ?? jobs.find((j) => j.name === config.job);
        if (!job) {
          if (!t.missingExtras.has(config.job)) {
            t.missingExtras.add(config.job);
            log.info(tr('Hermes: a rotina {0} do perfil {1} não está no jobs.json; o agente {2} não entra.', [config.job, t.profile.name, config.name]));
          }
          continue;
        }
        t.missingExtras.delete(config.job);
        if (!want.has(job.id)) want.set(job.id, { job, config });
      }
    }
    for (const [id, e] of [...t.extras]) {
      if (want.has(id)) continue;
      if (e.inOffice) office.closeMain(e.key);
      t.extras.delete(id);
    }
    for (const { job, config } of want.values()) {
      let e = t.extras.get(job.id);
      if (!e) {
        e = { key: `${t.key}:agente:${job.id}`, job, config, inOffice: false, status: 'idle' };
        t.extras.set(job.id, e);
      }
      e.job = job;
      e.config = config;
      if (e.inOffice && !office.has(e.key)) e.inOffice = false;
      if (!e.inOffice) this.enterExtra(t, e, now);
    }
  }

  private enterExtra(t: ProfileTracker, e: ExtraTracker, now: number): void {
    const office = this.opts.office;
    const names = this.opts.agentNames;
    // Precedência: o personagem do editor (Office.addMain) > HABBLAUD_HERMES_NOMES > o nome de HABBLAUD_HERMES_AGENTES.
    const fixed = names?.get(`${t.profile.name}/${e.job.name}`) ?? names?.get(`${t.profile.name}/${e.job.id}`) ?? e.config;
    office.addMain({
      id: e.key,
      provider: 'hermes',
      account: this.accountId,
      sessionId: `hermes-${t.profile.name}-agente-${e.job.id}`,
      cwd: this.roomPathOf(t.profile),
      role: /analis|analyst/i.test(e.job.name) ? ANALYST_ROLE : tr('Agente da rotina {0}', [e.job.name]),
      startedAt: now,
      status: e.status,
      name: fixed.name,
      look: fixed.look,
    });
    e.inOffice = office.has(e.key);
  }

  /** Status e resumo de cada agente adicional (mesma regra do principal, só com a rotina e as sessões dele). */
  private updateExtras(t: ProfileTracker, now: number): void {
    const office = this.opts.office;
    for (const e of t.extras.values()) {
      if (!e.inOffice) continue;
      const status = this.statusOf(t, e.last, (r) => r.job_id === e.job.id, now);
      if (status !== e.status) {
        e.status = status;
        office.setStatus(e.key, status, status === 'waiting' ? tr('responder uma pergunta') : undefined);
      }
      if (status === 'working') office.fillWorkingActivity(e.key);
      const title = tr('Rotina: {0}', [e.job.schedule ? `${e.job.name} (${e.job.schedule})` : e.job.name]);
      office.applyTranscript(e.key, this.summaryOf(t, e.current, title, e.last));
    }
  }

  // ---------------------------------------------------------------- histórico do terminal

  private recentSessions(): RecentSession[] {
    const now = this.now();
    const since = (now - HISTORY_DAYS * 86_400_000) / 1000;
    const out: RecentSession[] = [];
    for (const t of this.trackers.values()) {
      const rows = t.state?.read((db) => {
        const have = new Set(this.columnsOf(db, 'sessions'));
        const cols = ['id', 'source', 'title', 'parent_session_id', 'started_at', 'ended_at', 'last_activity_at', 'message_count'].filter((c) => have.has(c));
        return db.prepare(`SELECT ${cols.join(', ')} FROM sessions WHERE started_at >= ? ORDER BY started_at DESC LIMIT 60`).all(since) as unknown as Array<SessionRow & { message_count?: number }>;
      });
      const jobs = t.jobs.read() ?? [];
      const room = this.roomNameOf(t);
      for (const s of rows ?? []) {
        if (s.parent_session_id) continue;
        const firstAt = s.started_at ? Math.round(s.started_at * 1000) : undefined;
        const lastSec = num(s.ended_at) ?? num(s.last_activity_at) ?? num(s.started_at);
        const lastAt = lastSec ? Math.round(lastSec * 1000) : now;
        const jobId = jobIdOfSession(s.id);
        const job = jobId ? (jobs.find((j) => j.id === jobId)?.name ?? jobId) : undefined;
        const open = !s.ended_at && now - lastAt < WORKING_RECENT_MS * 10;
        const r: RecentSession = {
          account: this.accountId,
          provider: 'hermes',
          sessionId: `${t.profile.name}~${s.id}`,
          project: t.profile.dir,
          projectDir: t.profile.name,
          room,
          lastAt,
          size: num(s.message_count) ?? 0,
          open,
        };
        const title = job ? tr('Rotina: {0}', [job]) : s.title;
        if (title) r.title = title.slice(0, 160);
        if (firstAt) r.firstAt = firstAt;
        const owner = this.extraOf(t, s.id);
        if (open && t.inOffice) r.agentId = owner?.key ?? t.key;
        out.push(r);
      }
    }
    return out.sort((a, b) => b.lastAt - a.lastAt);
  }

  private resolveSession(account: string, sessionId: string): HistoryResolveResult {
    if (account !== this.accountId) return { status: 404, error: tr('conta desconhecida') };
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63})~([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/.exec(sessionId);
    if (!m) return { status: 400, error: tr('id de sessão inválido') };
    const t = [...this.trackers.values()].find((x) => x.profile.name === m[1]);
    const db = t?.state;
    if (!t || !db) return { status: 404, error: tr('sessão não encontrada') };
    const found = db.read((d) => !!d.prepare('SELECT 1 AS ok FROM sessions WHERE id = ?').get(m[2]));
    if (!found) return { status: 404, error: tr('sessão não encontrada') };
    return { createFeed: () => new SessionFeed(db, m[2], () => t.jobs.read() ?? []) };
  }

  // ---------------------------------------------------------------- painel

  /** Painel do Hermes (GET /api/hermes/painel), refeito no máximo a cada PANEL_TTL_MS. */
  panel(): HermesPanel {
    const now = this.now();
    if (this.panelCache && now - this.panelCache.at < PANEL_TTL_MS) return this.panelCache.value;
    const day = utcDay(now);
    const trackers = [...this.trackers.values()];
    const logs = readAgentLogs(
      this.opts.dir,
      trackers.map((t) => t.profile.name),
      day,
    );
    const limits = [...logs.limits];
    const usage: HermesModelUsage[] = [];
    let tokensToday = 0;
    let runsToday = 0;
    const profiles: HermesProfilePanel[] = [];
    for (const t of trackers) {
      const jobs = t.jobs.read() ?? [];
      const audit = readUsageAudit(t.profile.dir, t.profile.name, day);
      tokensToday += audit.tokens;
      runsToday += audit.runs;
      limits.push(...audit.errors.filter((e) => /429|rate|limit|quota|exhaust/i.test(e.text)));
      usage.push(...this.modelUsage(t, day));
      const running = new Set(t.execRows.map((r) => r.job_id));
      const p: HermesProfilePanel = {
        name: t.profile.name,
        room: this.roomNameOf(t),
        agentId: t.key,
        tokensToday: audit.tokens,
        runsToday: audit.runs,
        jobs: jobs.map((j) => {
          const v = t.vigias.get(j.id);
          return {
            id: j.id,
            name: j.name,
            enabled: j.enabled,
            running: running.has(j.id),
            monitor: !!j.monitor,
            ...(j.schedule ? { schedule: j.schedule } : {}),
            ...(j.lastRunAt ? { lastRunAt: j.lastRunAt } : {}),
            ...(j.nextRunAt ? { nextRunAt: j.nextRunAt } : {}),
            ...(j.lastStatus ? { lastStatus: j.lastStatus } : {}),
            ...(j.lastError ? { lastError: maskSecrets(j.lastError.slice(0, 1_000)) } : {}),
            ...(v?.inOffice ? { vigiaId: v.key } : {}),
            ...(t.extras.get(j.id)?.inOffice ? { agentId: t.extras.get(j.id)!.key } : {}),
          };
        }),
        outputs: this.outputs.list(t.profile.dir, jobs),
        monitors: [],
      };
      const description = t.yaml.read();
      if (description) p.description = description;
      for (const j of jobs.filter((x) => x.monitor)) {
        const r = readMonitorLines(join(t.profile.dir, 'cron', 'output', j.id, 'monitor_last_output.txt'));
        if (!r) continue;
        const v = t.vigias.get(j.id);
        const market = parseMarket(r.lines);
        p.monitors.push({ jobId: j.id, jobName: j.name, at: r.at, lines: r.lines, ...(v?.inOffice ? { agentId: v.key } : {}), ...(market ? { market } : {}) });
      }
      profiles.push(p);
    }
    limits.sort((a, b) => b.at - a.at);
    const value: HermesPanel = {
      generatedAt: now,
      system: this.system.read(),
      quotas: { day, calls: logs.calls, usage, limits: limits.slice(0, 40), tokensToday, runsToday, logFound: logs.found },
      profiles,
    };
    const weather = this.weather?.current();
    if (weather) value.weather = weather;
    if (this.opts.links && (this.opts.links.omniroute || this.opts.links.beszel)) value.links = { ...this.opts.links };
    this.panelCache = { at: now, value };
    return value;
  }

  /** Uso por modelo e provedor hoje (session_model_usage), relido só quando o banco muda. */
  private modelUsage(t: ProfileTracker, day: string): HermesModelUsage[] {
    if (!t.state?.exists()) return [];
    const sig = t.state.signature();
    if (t.usage && t.usage.sig === sig && t.usage.day === day) return t.usage.rows;
    const since = Date.parse(`${day}T00:00:00Z`) / 1000;
    const rows = t.state.read((db) => {
      const have = new Set(this.columnsOf(db, 'session_model_usage'));
      if (!have.has('model')) return [];
      const col = (c: string, alt = '0') => (have.has(c) ? c : alt);
      const when = have.has('last_seen') ? 'coalesce(last_seen, first_seen, 0)' : '0';
      return db
        .prepare(
          `SELECT model, ${col('billing_provider', "''")} AS provider, ${col('task', "''")} AS task, sum(${col('api_call_count')}) AS calls, sum(${col('input_tokens')} + ${col('cache_read_tokens')} + ${col('cache_write_tokens')}) AS tin, sum(${col('output_tokens')}) AS tout FROM session_model_usage WHERE ${when} >= ? GROUP BY model, provider, task ORDER BY calls DESC LIMIT 40`,
        )
        .all(since) as Array<{ model: string; provider?: string; task?: string; calls?: unknown; tin?: unknown; tout?: unknown }>;
    });
    const list: HermesModelUsage[] = (rows ?? []).map((r) => ({
      profile: t.profile.name,
      model: String(r.model),
      provider: r.provider ? String(r.provider) : '?',
      ...(r.task ? { task: String(r.task) } : {}),
      calls: num(r.calls) ?? 0,
      tokensIn: num(r.tin) ?? 0,
      tokensOut: num(r.tout) ?? 0,
    }));
    t.usage = { sig, day, rows: list };
    return list;
  }
}
