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
// Terminal e histórico de sessões: não há (transcriptPathOf devolve undefined). O terminal do Habblaud segue um
// arquivo JSONL; a conversa do Hermes está no SQLite. Ver README.md desta pasta.
import { join } from 'node:path';
import { maskSecrets, truncate } from '../../../shared/activity';
import type { AgentStats, AgentStatus, SourceInfo } from '../../../shared/types';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office, TranscriptSummary } from '../../model/office';
import type { AgentSource } from '../source';
import { describeMessage, parseToolCalls, type HermesMessage } from './describe';
import { discoverProfiles, jobIdOfSession, parseGateway, parseHeartbeat, parseJobs, parseProfileDescription, SmallFile, type CronJob, type HermesProfile } from './profiles';
import { loadSqlite, ReadOnlyDb, type ReadMode, type SqliteDatabase, type SqliteModule } from './sqlite';
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
const MAIN_ROLE = tr('Agente Hermes');
const SUB_ROLE = tr('Subagente (Hermes)');
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
  /** Última mensagem vista (de qualquer sessão principal). */
  last?: { at: number; sessionId: string; role: string; finish?: string | null; clarify: boolean };
  /** Sessões recentes (as 12 mais novas e as das mensagens lidas), por id. */
  sessions: Map<string, SessionRow>;
  /** Sessão principal mais recente. */
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

  constructor(private readonly opts: HermesSourceOptions) {
    this.now = opts.now ?? Date.now;
    this.entries = opts.accounts.setProviderAccounts('hermes', [
      { dir: opts.dir, detected: { id: ACCOUNT_ID, configDir: opts.dir, short: 'H', name: 'Hermes', color: ACCOUNT_COLOR } },
    ]);
    this.accountId = this.entries[0]?.id ?? ACCOUNT_ID;
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

  /** A conversa do Hermes está no SQLite, não num arquivo JSONL: sem terminal (ver README.md). */
  transcriptPathOf(): string | undefined {
    return undefined;
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
      if (!this.trackers.has(key)) this.trackers.set(key, this.newTracker(p, key));
    }
    for (const [key, t] of [...this.trackers]) {
      if (seen.has(key)) continue;
      if (t.inOffice) this.opts.office.closeMain(t.key);
      t.state?.close();
      t.execs?.close();
      this.trackers.delete(key);
    }
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
      status: 'idle',
      inOffice: false,
    };
  }

  private pollProfile(t: ProfileTracker, now: number, boot: boolean): void {
    const office = this.opts.office;
    if (t.inOffice && !office.has(t.key)) t.inOffice = false;
    const jobs = t.jobs.read() ?? [];
    if (!t.inOffice) this.enter(t, now);
    const errors: string[] = [];

    // Execuções do cron (relidas só quando o banco muda; o filtro por tempo roda sempre).
    if (t.execs?.exists()) {
      const sig = t.execs.signature();
      if (sig !== t.execSig) {
        const rows = t.execs.read((db) => db.prepare("SELECT job_id, status, claimed_at, started_at FROM executions WHERE status IN ('claimed', 'running') ORDER BY claimed_at DESC LIMIT 8").all() as unknown as ExecRow[]);
        if (rows) {
          t.execRows = rows;
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
    this.syncSubs(t, now);
    const status = this.statusOf(t, now);
    if (status !== t.status) {
      t.status = status;
      office.setStatus(t.key, status, status === 'waiting' ? tr('responder uma pergunta') : undefined);
    }
    if (status === 'working') office.fillWorkingActivity(t.key);
    this.applySummary(t, jobs);
  }

  private enter(t: ProfileTracker, now: number): void {
    this.opts.office.addMain({
      id: t.key,
      provider: 'hermes',
      account: this.accountId,
      // Fixo por perfil: o personagem (nome, aparência) é o mesmo em todas as execuções.
      sessionId: `hermes-${t.profile.name}`,
      cwd: t.profile.name === 'default' && t.profile.dir === this.opts.dir ? join(this.opts.dir, 'profiles', 'default') : t.profile.dir,
      role: MAIN_ROLE,
      startedAt: now,
      status: t.status,
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
    t.current = recent.find((s) => !s.parent_session_id);

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

    let target = t.key;
    if (isSub) {
      t.subLast.set(m.session_id, at);
      const sub = t.subs.get(m.session_id);
      // Subagente ainda fora do escritório (entra no syncSubs deste ciclo): as atividades vão para o principal.
      if (sub?.inOffice && !sub.done) target = sub.key;
    } else {
      const calls = m.role === 'assistant' ? parseToolCalls(m.tool_calls) : [];
      t.last = { at, sessionId: m.session_id, role: m.role, finish: m.finish_reason, clarify: calls.some((c) => c.name === 'clarify') };
    }
    for (const a of acts) {
      const { key, ...desc } = a;
      office.addActivity(target, { id: `${t.key}#${m.id}:${key}`, at, ...desc }, true, { feed: !boot });
    }
  }

  /** Rotina que terminou com erro desde a última leitura: atividade de erro (fora do boot). */
  private checkJobs(t: ProfileTracker, jobs: readonly CronJob[], boot: boolean): void {
    for (const j of jobs) {
      const prev = t.jobRuns.get(j.id);
      const seen = t.jobRuns.has(j.id);
      t.jobRuns.set(j.id, j.lastRunAt);
      if (boot || !seen || j.lastRunAt === undefined || j.lastRunAt === prev) continue;
      if (!j.lastStatus || /^(ok|success|completed|no_change|silent)$/i.test(j.lastStatus)) continue;
      this.opts.office.addActivity(
        t.key,
        { id: `${t.key}#job:${j.id}:${j.lastRunAt}`, at: j.lastRunAt, kind: 'error', icon: '⚠️', text: truncate(tr('Rotina falhou: {0}', [j.name]), 46), ...(j.lastError ? { detail: truncate(maskSecrets(j.lastError.slice(0, 1_200)), 300) } : {}), tool: 'cron', error: true },
        true,
      );
    }
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
      const added = office.addSub({
        id: sub.key,
        parentId: t.key,
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

  /** Job em execução agora (o mais recente), pelo executions.db. */
  private runningJob(t: ProfileTracker, now: number): ExecRow | undefined {
    return t.execRows.find((r) => {
      const since = isoMs(r.started_at ?? undefined) ?? isoMs(r.claimed_at);
      return since !== undefined && now - since >= EXEC_SETTLE_MS && now - since < EXEC_STALE_MS;
    });
  }

  private statusOf(t: ProfileTracker, now: number): AgentStatus {
    const running = this.runningJob(t, now);
    const last = t.last;
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
    const running = this.runningJob(t, now);
    const cur = t.current;
    const jobOf = (id: string | undefined) => (id ? jobs.find((j) => j.id === id) : undefined);
    const job = jobOf(running?.job_id) ?? jobOf(cur ? jobIdOfSession(cur.id) : undefined);
    const description = t.yaml.read();
    const title = job ? tr('Rotina: {0}', [job.name]) : (cur?.title ?? description);
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
    if (t.last) summary.lastAt = t.last.at;
    this.opts.office.applyTranscript(t.key, summary);
  }
}
