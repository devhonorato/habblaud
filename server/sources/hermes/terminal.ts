// Terminal dos agentes do Hermes. A conversa não está num arquivo JSONL (o terminal do Habblaud segue arquivos): está
// no state.db (sessions + messages) e nas saídas do cron (cron/output/<job>/*.md). Aqui ficam:
// - HermesConversation: mensagens do state.db em TerminalEntry (pedido, raciocínio, ferramentas com argumentos e
//   resultado sem o envelope <untrusted_tool_result>, resposta final), com um cabeçalho por sessão;
// - cronOutputEntries: uma saída do cron em TerminalEntry (para as rodadas que não estão mais no banco);
// - MainFeed: o terminal do agente principal de um perfil (o banco e, antes dele, as saídas do cron) ou de um agente
//   adicional (HABBLAUD_HERMES_AGENTES: só as sessões da rotina dele);
// - SessionFeed: uma sessão só (histórico do terminal);
// - VigiaFeed: o terminal do Vigia (cada checagem do monitor e a última leitura completa).
// Todos implementam TerminalFeed (sources/source.ts): init com a conversa recente e, depois, só o que é novo.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { formatDuration, maskSecrets } from '../../../shared/activity';
import { tr } from '../../../shared/i18n';
import type { TerminalEntry } from '../../../shared/types';
import type { TerminalFeed, TerminalFeedInit } from '../source';
import { marked, oneLine, prepare, RESULT_MAX, RESULT_MAX_LINES, TEXT_MAX, THINKING_MAX, toolView } from '../terminal';
import { describeMonitorLine, outputTimeOf, parseCronOutput, stripCronPreamble, wakeReason } from './cron';
import { isCronPrompt, parseToolCalls, splitToolName, toolResultError, unwrapToolResult } from './describe';
import { jobIdOfSession, type CronJob } from './profiles';
import { readingDiff, type StoredReading } from './readings';
import type { ReadOnlyDb, SqliteDatabase } from './sqlite';

/** Mensagens lidas para o init do terminal do principal (as mais recentes). */
export const FEED_INIT_MESSAGES = 1_200;
/** Saídas do cron lidas por rotina (as mais recentes). */
export const FEED_OUTPUTS = 60;
/** Mensagens por consulta no polling. */
const FEED_BATCH = 400;

/** Colunas lidas para o terminal (mais longas que as do polling de atividades). */
const COLUMNS: Record<string, string> = {
  id: 'id',
  session_id: 'session_id',
  role: 'role',
  content: 'substr(content, 1, 40000) AS content',
  tool_call_id: 'tool_call_id',
  tool_calls: 'substr(tool_calls, 1, 40000) AS tool_calls',
  tool_name: 'tool_name',
  timestamp: 'timestamp',
  finish_reason: 'finish_reason',
  reasoning: 'substr(reasoning, 1, 16000) AS reasoning',
};
const SESSION_COLUMNS = ['id', 'source', 'title', 'model', 'parent_session_id', 'started_at', 'ended_at', 'end_reason'];

export interface ConvMessage {
  id: number;
  session_id: string;
  role: string;
  content?: string | null;
  tool_call_id?: string | null;
  tool_calls?: string | null;
  tool_name?: string | null;
  timestamp: number;
  finish_reason?: string | null;
  reasoning?: string | null;
}

export interface ConvSession {
  id: string;
  source?: string | null;
  title?: string | null;
  model?: string | null;
  parent_session_id?: string | null;
  started_at?: number | null;
  ended_at?: number | null;
  end_reason?: string | null;
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {};
}

function parseArgs(raw: unknown): Rec {
  if (raw && typeof raw === 'object') return rec(raw);
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    return rec(JSON.parse(raw));
  } catch {
    return { argumentos: raw };
  }
}

function msOf(sec: number | null | undefined): number | undefined {
  return typeof sec === 'number' && Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : undefined;
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

/**
 * Título e argumentos de uma chamada do Hermes no estilo do terminal: as ferramentas próprias dele com o rótulo da
 * equivalente do Claude Code (terminal -> Bash, read_file -> Read...), MCP como "kairo - kairo_radar (MCP)".
 */
export function hermesToolView(rawName: string, rawArgs: unknown): { tool: string; title: string; input?: string; inputKind?: Extract<TerminalEntry, { kind: 'tool' }>['inputKind'] } {
  let name = rawName;
  let args = parseArgs(rawArgs);
  if (name === 'tool_call' && typeof args.name === 'string') {
    name = args.name;
    args = parseArgs(args.arguments);
  }
  const s = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : undefined);
  let view: ReturnType<typeof toolView>;
  switch (name) {
    case 'terminal':
      view = toolView('Bash', { command: s('command') ?? '' });
      break;
    case 'read_file':
      view = toolView('Read', { file_path: s('path') ?? s('file_path') ?? '' });
      break;
    case 'write_file':
      view = toolView('Write', { file_path: s('path') ?? s('file_path') ?? '', content: s('content') ?? '' });
      break;
    case 'search_files':
      view = toolView('Grep', { ...args, pattern: s('pattern') ?? s('query') ?? '' });
      break;
    default: {
      const { server, tool } = splitToolName(name);
      view = toolView(server ? `mcp__${server}__${tool}` : name, args);
    }
  }
  const out: ReturnType<typeof hermesToolView> = { tool: name, title: maskSecrets(view.title) };
  if (view.input) {
    out.input = view.input;
    out.inputKind = view.inputKind;
  }
  return out;
}

/**
 * Texto do resultado de uma ferramenta para o terminal: sem o envelope de dados de fora e, quando o MCP devolve
 * `{"result": "<json>"}`, o JSON de dentro indentado (lê-se melhor que uma linha com aspas escapadas).
 */
export function resultText(content: string): string {
  const body = unwrapToolResult(content);
  if (!body.startsWith('{')) return body;
  // Avisos que o Hermes acrescenta depois do JSON ("[Tool loop warning: ...]").
  const tail = /\n\n(\[[^\n]+\])\s*$/.exec(body);
  const json = tail ? body.slice(0, tail.index) : body;
  let obj: Rec;
  try {
    obj = rec(JSON.parse(json));
  } catch {
    return body;
  }
  let pretty: string | undefined;
  if (typeof obj.result === 'string' && Object.keys(obj).length === 1) {
    try {
      pretty = JSON.stringify(JSON.parse(obj.result), null, 2);
    } catch {
      pretty = obj.result;
    }
  } else if (typeof obj.error === 'string' && Object.keys(obj).length === 1) {
    pretty = obj.error;
  } else {
    pretty = JSON.stringify(obj, null, 2);
  }
  return tail ? `${pretty}\n\n${tail[1]}` : pretty;
}

/** Converte mensagens do state.db em entradas do terminal (com estado: os ids das chamadas para ligar os resultados). */
export class HermesConversation {
  private readonly headed = new Set<string>();
  /** tool_call_id -> id da entrada 'tool' (o mesmo id de chamada pode se repetir entre sessões). */
  private readonly calls = new Map<string, string>();

  constructor(
    /** Nome da rotina dona de uma sessão do cron. */
    private readonly jobName: (jobId: string) => string | undefined = () => undefined,
    /** Prefixo dos ids (um terminal pode juntar perfis no futuro). */
    private readonly prefix = 'h',
  ) {}

  /** Cabeçalho da sessão (uma vez por sessão): rotina ou conversa, título e modelo. */
  private header(m: ConvMessage, s: ConvSession | undefined, out: TerminalEntry[]): void {
    if (this.headed.has(m.session_id)) return;
    this.headed.add(m.session_id);
    if (this.headed.size > 5_000) this.headed.delete(this.headed.values().next().value as string);
    const at = msOf(s?.started_at) ?? msOf(m.timestamp) ?? Date.now();
    const jobId = jobIdOfSession(m.session_id);
    const job = jobId ? (this.jobName(jobId) ?? jobId) : undefined;
    const kind = s?.parent_session_id ? tr('Subagente') : job ? tr('Rotina: {0}', [job]) : s?.source === 'cron' ? tr('Rotina agendada') : tr('Conversa ({0})', [s?.source ?? '?']);
    const title = s?.title && !job ? ` · ${oneLine(s.title, 80)}` : '';
    const details = [
      tr('Sessão {0}', [m.session_id]),
      s?.model ? tr('Modelo: {0}', [s.model]) : '',
      tr('Início: {0}', [hhmm(at)]),
      s?.ended_at && s.started_at ? tr('Duração: {0}', [formatDuration(Math.max(0, (s.ended_at - s.started_at) * 1000))]) : '',
    ].filter(Boolean);
    out.push({ kind: 'system', id: `${this.prefix}s:${m.session_id}`, at, text: maskSecrets(`${kind}${title} · ${hhmm(at)}`), detail: details.join('\n'), level: 'info' });
  }

  push(m: ConvMessage, session?: ConvSession): TerminalEntry[] {
    const out: TerminalEntry[] = [];
    try {
      this.message(m, session, out);
    } catch {
      // linha estranha demais: fica o que já saiu dela
    }
    return out;
  }

  private message(m: ConvMessage, s: ConvSession | undefined, out: TerminalEntry[]): void {
    const at = msOf(m.timestamp) ?? Date.now();
    const id = `${this.prefix}${m.id}`;
    const content = typeof m.content === 'string' ? m.content : '';
    this.header(m, s, out);
    switch (m.role) {
      case 'user': {
        if (!content.trim()) return;
        const raw = isCronPrompt(content) ? stripCronPreamble(content) : content;
        const text = marked(prepare(raw, TEXT_MAX));
        if (text) out.push({ kind: 'user', id: `${id}:u`, at, text });
        return;
      }
      case 'assistant': {
        const reasoning = typeof m.reasoning === 'string' ? m.reasoning : '';
        if (reasoning.trim()) {
          const text = marked(prepare(reasoning, THINKING_MAX));
          out.push(text ? { kind: 'thinking', id: `${id}:k`, at, text } : { kind: 'thinking', id: `${id}:k`, at });
        }
        for (const call of parseToolCalls(m.tool_calls)) {
          const v = hermesToolView(call.name, call.args);
          const entryId = `${id}:t:${call.id}`;
          this.calls.set(call.id, entryId);
          if (this.calls.size > 2_000) this.calls.delete(this.calls.keys().next().value as string);
          const e: Extract<TerminalEntry, { kind: 'tool' }> = { kind: 'tool', id: entryId, at, tool: v.tool, title: v.title };
          if (v.input) {
            e.input = v.input;
            e.inputKind = v.inputKind;
          }
          out.push(e);
        }
        const text = content.trim();
        if (text === '[SILENT]') out.push({ kind: 'system', id: `${id}:s`, at, text: tr('Nada a relatar ([SILENT])'), level: 'info' });
        else if (text) {
          const shown = marked(prepare(content, TEXT_MAX));
          if (shown) out.push({ kind: 'assistant', id: `${id}:a`, at, text: shown });
        }
        if (m.finish_reason === 'stop' && s?.started_at && s.ended_at) {
          out.push({ kind: 'system', id: `${id}:d`, at, text: tr('Rotina concluída em {0}', [formatDuration(Math.max(0, (s.ended_at - s.started_at) * 1000))]), level: 'info' });
        }
        return;
      }
      case 'tool': {
        const callId = m.tool_call_id ?? '';
        const toolUseId = this.calls.get(callId) ?? `${id}:orphan`;
        const error = toolResultError(content);
        const p = prepare(resultText(content), RESULT_MAX, RESULT_MAX_LINES);
        const e: Extract<TerminalEntry, { kind: 'result' }> = { kind: 'result', id: `${id}:r`, at, toolUseId, text: p.text || tr('(sem saída)') };
        if (error) e.error = true;
        if (p.truncated) e.truncated = true;
        // Resultado sem a chamada à vista (a janela do init cortou): mostra a chamada pelo nome.
        if (!this.calls.has(callId) && m.tool_name) out.push({ kind: 'tool', id: toolUseId, at, tool: m.tool_name, title: hermesToolView(m.tool_name, {}).title });
        out.push(e);
        return;
      }
      default:
        return;
    }
  }
}

/** Uma saída do cron (rodada com o modelo) em entradas do terminal: cabeçalho, pedido e resposta. */
export function cronOutputEntries(text: string, at: number, key: string, fallbackJob?: string): TerminalEntry[] {
  const o = parseCronOutput(text);
  if (o.noChange) return [];
  const job = o.jobName ?? fallbackJob ?? '?';
  const out: TerminalEntry[] = [{ kind: 'system', id: `o${key}:s`, at, text: tr('Rotina: {0} · {1} (saída do cron)', [job, hhmm(at)]), level: 'info' }];
  const prompt = [o.prompt, o.diff ? `\n\`\`\`diff\n${o.diff}\n\`\`\`` : ''].filter(Boolean).join('\n');
  if (prompt.trim()) {
    const p = marked(prepare(prompt, TEXT_MAX));
    if (p) out.push({ kind: 'user', id: `o${key}:u`, at, text: p });
  }
  if (o.silent) out.push({ kind: 'system', id: `o${key}:r`, at, text: tr('Nada a relatar ([SILENT])'), level: 'info' });
  else if (o.response?.trim()) {
    const r = marked(prepare(o.response, TEXT_MAX));
    if (r) out.push({ kind: 'assistant', id: `o${key}:a`, at, text: r });
  }
  return out;
}

/** Arquivos de saída de uma rotina (os `limit` mais recentes), com a hora do nome. */
export function listOutputs(dir: string, limit = FEED_OUTPUTS): Array<{ name: string; at: number; path: string }> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const list: Array<{ name: string; at: number; path: string }> = [];
  for (const name of names) {
    const at = outputTimeOf(name);
    if (at !== undefined) list.push({ name, at, path: join(dir, name) });
  }
  list.sort((a, b) => a.at - b.at);
  return list.slice(-limit);
}

function readSmall(path: string, max = 512 * 1024): string | undefined {
  try {
    const st = statSync(path);
    if (st.size > max) return readFileSync(path, 'utf8').slice(0, max);
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function dirSig(path: string): string {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}`;
  } catch {
    return '';
  }
}

/** O que os feeds do Hermes sabem do perfil. */
export interface ProfileFeedDeps {
  /** state.db do perfil (o mesmo ReadOnlyDb da fonte: nada de cópias a mais). */
  state: ReadOnlyDb | null;
  /** Pasta do perfil. */
  dir: string;
  jobs: () => readonly CronJob[];
  /** Que sessões do cron entram (ausente = todas). Relido a cada consulta: os agentes adicionais podem mudar. */
  scope?: () => FeedScope;
}

/**
 * Sessões do terminal por rotina: `only` = só as da rotina (e as filhas delas), o terminal de um agente adicional;
 * `exclude` = todas menos as dessas rotinas, o terminal do principal.
 */
export interface FeedScope {
  only?: string;
  exclude?: readonly string[];
}

/** A rotina entra no terminal (as saídas do cron em arquivo). */
function inScope(scope: FeedScope | undefined, jobId: string): boolean {
  if (scope?.only) return jobId === scope.only;
  return !scope?.exclude?.includes(jobId);
}

/** Filtro SQL (" AND ...") das mensagens pelo escopo; as sessões filhas seguem a sessão mãe. */
export function scopeClause(scope: FeedScope | undefined, withParent: boolean): { sql: string; params: Array<string | number> } {
  const one = (jobId: string) => {
    const prefix = `cron_${jobId}_`;
    return withParent
      ? { sql: '(substr(session_id, 1, ?) = ? OR session_id IN (SELECT id FROM sessions WHERE substr(parent_session_id, 1, ?) = ?))', params: [prefix.length, prefix, prefix.length, prefix] }
      : { sql: 'substr(session_id, 1, ?) = ?', params: [prefix.length, prefix] };
  };
  if (scope?.only) {
    const c = one(scope.only);
    return { sql: ` AND ${c.sql}`, params: c.params };
  }
  const ex = (scope?.exclude ?? []).map(one);
  if (!ex.length) return { sql: '', params: [] };
  return { sql: ` AND NOT (${ex.map((c) => c.sql).join(' OR ')})`, params: ex.flatMap((c) => c.params) };
}

function messageColumns(db: SqliteDatabase): string {
  const have = new Set((db.prepare('PRAGMA table_info(messages)').all() as Array<{ name?: unknown }>).map((r) => String(r.name)));
  return Object.entries(COLUMNS)
    .filter(([c]) => have.has(c))
    .map(([, e]) => e)
    .join(', ');
}

function sessionColumns(db: SqliteDatabase): string {
  const have = new Set((db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name?: unknown }>).map((r) => String(r.name)));
  return SESSION_COLUMNS.filter((c) => have.has(c)).join(', ');
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'bigint' ? Number(v) : undefined;
}

/**
 * Terminal do agente principal de um perfil: no init, as rodadas do cron que já não estão no banco (pelas saídas em
 * cron/output) e as últimas FEED_INIT_MESSAGES mensagens do state.db; depois, as mensagens novas. Com `scope`, só as
 * sessões (e saídas) das rotinas dele: o principal sem as dos agentes adicionais, um agente adicional só com as dele.
 */
export class MainFeed implements TerminalFeed {
  readonly intervalMs = 1_000;
  private conv!: HermesConversation;
  private cursor = -1;
  private sig = '';
  private cols?: { messages: string; sessions: string };
  private sessions = new Map<string, ConvSession>();

  constructor(
    private readonly deps: ProfileFeedDeps,
    private readonly opts: { initMessages?: number; outputs?: number } = {},
  ) {}

  private jobName = (id: string) => this.deps.jobs().find((j) => j.id === id)?.name;

  private clause(scope: FeedScope | undefined): { sql: string; params: Array<string | number> } {
    return scopeClause(scope, !!this.cols?.sessions.split(', ').includes('parent_session_id'));
  }

  load(limit: number): TerminalFeedInit {
    this.conv = new HermesConversation(this.jobName);
    this.cursor = -1;
    this.sessions.clear();
    const fromDb: TerminalEntry[] = [];
    let truncated = false;
    let firstDbAt = Infinity;
    const db = this.deps.state;
    const scope = this.deps.scope?.();
    if (db?.exists()) {
      this.sig = db.signature();
      db.read((d) => {
        this.cols ??= { messages: messageColumns(d), sessions: sessionColumns(d) };
        const max = num((d.prepare('SELECT max(id) AS m FROM messages').get() as { m?: unknown } | undefined)?.m) ?? 0;
        const want = this.opts.initMessages ?? FEED_INIT_MESSAGES;
        const c = this.clause(scope);
        const rows = (d.prepare(`SELECT ${this.cols.messages} FROM messages WHERE 1 = 1${c.sql} ORDER BY id DESC LIMIT ${want}`).all(...c.params) as unknown as ConvMessage[]).reverse();
        const cut = rows.length >= want;
        truncated = cut;
        this.loadSessions(d, rows);
        // Começa no início de uma sessão: a janela não corta uma rotina ao meio (as anteriores ficam com as saídas).
        const firstUser = rows.findIndex((r) => r.role === 'user');
        const start = cut && firstUser > 0 ? firstUser : 0;
        for (const r of rows.slice(start)) {
          const ms = msOf(r.timestamp);
          if (ms !== undefined) firstDbAt = Math.min(firstDbAt, ms);
          fromDb.push(...this.conv.push(r, this.sessions.get(r.session_id)));
        }
        // O cursor vai ao fim do banco: as mensagens de fora do escopo não voltam no poll.
        this.cursor = max;
      });
    }
    // Rodadas mais antigas que a janela do banco (ou todas, se o banco não abriu): as saídas do cron.
    const fromFiles: TerminalEntry[] = [];
    for (const job of this.deps.jobs()) {
      if (!inScope(scope, job.id)) continue;
      for (const f of listOutputs(join(this.deps.dir, 'cron', 'output', job.id), this.opts.outputs ?? FEED_OUTPUTS)) {
        if (f.at >= firstDbAt) continue;
        const text = readSmall(f.path);
        if (text) fromFiles.push(...cronOutputEntries(text, f.at, `${job.id}:${f.name}`, job.name));
      }
    }
    fromFiles.sort((a, b) => a.at - b.at);
    let entries = [...fromFiles, ...fromDb];
    if (entries.length > limit) {
      entries = entries.slice(-limit);
      truncated = true;
    }
    return { entries, truncated };
  }

  private loadSessions(d: SqliteDatabase, rows: readonly ConvMessage[]): void {
    const missing = [...new Set(rows.map((r) => r.session_id))].filter((id) => !this.sessions.has(id));
    for (let i = 0; i < missing.length; i += 200) {
      const part = missing.slice(i, i + 200);
      const q = d.prepare(`SELECT ${this.cols!.sessions} FROM sessions WHERE id IN (${part.map(() => '?').join(', ')})`);
      for (const s of q.all(...part) as unknown as ConvSession[]) this.sessions.set(s.id, s);
    }
    if (this.sessions.size > 500) for (const k of [...this.sessions.keys()].slice(0, 250)) this.sessions.delete(k);
  }

  poll(): TerminalEntry[] {
    const db = this.deps.state;
    if (!db?.exists() || this.cursor < 0) return [];
    const sig = db.signature();
    if (sig === this.sig) return [];
    const out: TerminalEntry[] = [];
    const scope = this.deps.scope?.();
    const ok = db.read((d) => {
      this.cols ??= { messages: messageColumns(d), sessions: sessionColumns(d) };
      const c = this.clause(scope);
      for (let i = 0; i < 5; i++) {
        const rows = d.prepare(`SELECT ${this.cols.messages} FROM messages WHERE id > ?${c.sql} ORDER BY id LIMIT ${FEED_BATCH}`).all(this.cursor, ...c.params) as unknown as ConvMessage[];
        if (!rows.length) break;
        // Sessões novas e as que terminaram (ended_at muda): relidas.
        for (const r of rows) if (r.role === 'assistant' && r.finish_reason === 'stop') this.sessions.delete(r.session_id);
        this.loadSessions(d, rows);
        for (const r of rows) out.push(...this.conv.push(r, this.sessions.get(r.session_id)));
        this.cursor = num(rows[rows.length - 1].id) ?? this.cursor;
        if (rows.length < FEED_BATCH) break;
      }
      return true;
    });
    if (ok) this.sig = sig;
    return out;
  }
}

/** Uma sessão do state.db (histórico do terminal): toda a conversa dela e, se ainda estiver aberta, o que chegar. */
export class SessionFeed implements TerminalFeed {
  readonly intervalMs = 2_000;
  private conv!: HermesConversation;
  private cursor = 0;
  private session?: ConvSession;
  private sig = '';

  constructor(
    private readonly db: ReadOnlyDb,
    private readonly sessionId: string,
    private readonly jobs: () => readonly CronJob[],
  ) {}

  private rows(d: SqliteDatabase, after: number, limit?: number): ConvMessage[] {
    const cols = messageColumns(d);
    if (!this.session) {
      const s = d.prepare(`SELECT ${sessionColumns(d)} FROM sessions WHERE id = ?`).get(this.sessionId) as ConvSession | undefined;
      if (s) this.session = s;
    }
    return d.prepare(`SELECT ${cols} FROM messages WHERE session_id = ? AND id > ? ORDER BY id${limit ? ` LIMIT ${limit}` : ''}`).all(this.sessionId, after) as unknown as ConvMessage[];
  }

  load(limit: number): TerminalFeedInit {
    this.conv = new HermesConversation((id) => this.jobs().find((j) => j.id === id)?.name);
    this.sig = this.db.signature();
    const entries: TerminalEntry[] = [];
    this.db.read((d) => {
      const rows = this.rows(d, 0);
      for (const r of rows) entries.push(...this.conv.push(r, this.session));
      this.cursor = rows.length ? (num(rows[rows.length - 1].id) ?? 0) : 0;
    });
    const truncated = entries.length > limit;
    return { entries: truncated ? entries.slice(-limit) : entries, truncated };
  }

  poll(): TerminalEntry[] {
    if (this.session?.ended_at) return [];
    const sig = this.db.signature();
    if (sig === this.sig) return [];
    const out: TerminalEntry[] = [];
    const ok = this.db.read((d) => {
      this.session = undefined;
      const rows = this.rows(d, this.cursor, FEED_BATCH);
      for (const r of rows) out.push(...this.conv.push(r, this.session));
      if (rows.length) this.cursor = num(rows[rows.length - 1].id) ?? this.cursor;
      return true;
    });
    if (ok) this.sig = sig;
    return out;
  }
}

/** Linhas da última leitura do monitor (sem linhas vazias), até `max`. */
export function readMonitorLines(path: string, max = 60): { lines: string[]; at: number } | undefined {
  try {
    const st = statSync(path);
    const text = readFileSync(path, 'utf8').slice(0, 64 * 1024);
    const lines = text
      .split(/\r?\n/)
      .map((l) => maskSecrets(l.trimEnd()))
      .filter((l) => l.trim())
      .slice(0, max);
    return { lines, at: st.mtimeMs };
  } catch {
    return undefined;
  }
}

/** Uma checagem casa com a leitura guardada mais próxima até esta distância (a saída e o monitor saem juntos). */
const READING_MATCH_MS = 120_000;
/** Checagem nova ainda sem leitura guardada: espera até isto por ela antes de sair sem. */
const READING_WAIT_MS = 20_000;

/** Leituras guardadas de uma rotina (readings.ts), entre duas horas. */
export type ReadingsOf = (from: number, to: number) => StoredReading[];

/** Linhas de uma diferença do monitor com o que cada uma quer dizer ("→ venda", "→ posição aberta"...). */
function explainDiff(lines: readonly string[]): string[] {
  return lines.map((l) => `${l}${l.length > 1 && (l[0] === '+' || l[0] === '-') ? `   → ${describeMonitorLine(l.slice(1))}` : ''}`);
}

/**
 * Terminal do Vigia de uma rotina com monitor: cada checagem (as saídas do cron: "sem mudança" ou "mudou: chamou o
 * principal", com a diferença) e, por último, a leitura completa do monitor (de novo a cada leitura nova). Com o
 * histórico das leituras (readings.ts), cada checagem abre a leitura completa daquela hora e a diferença para a
 * anterior.
 */
export class VigiaFeed implements TerminalFeed {
  readonly intervalMs = 2_000;
  private seen = new Set<string>();
  private dirSig = '';
  private readSig = '';
  /** Checagens novas esperando a leitura guardada (nome do arquivo -> quando apareceu). */
  private waiting = new Map<string, number>();

  constructor(
    private readonly dir: string,
    private readonly job: CronJob,
    /** Nome do agente principal (quem o Vigia chama). */
    private readonly mainName: () => string,
    private readonly opts: { outputs?: number; readings?: ReadingsOf; now?: () => number } = {},
  ) {}

  private get outDir(): string {
    return join(this.dir, 'cron', 'output', this.job.id);
  }

  /** A leitura guardada mais perto de `at` (e a anterior a ela com outro conteúdo, para a diferença). */
  private readingAt(list: readonly StoredReading[], at: number): { cur: StoredReading; prev?: StoredReading } | undefined {
    let best = -1;
    for (let i = 0; i < list.length; i++) {
      const d = Math.abs(list[i].at - at);
      if (d <= READING_MATCH_MS && (best < 0 || d < Math.abs(list[best].at - at))) best = i;
    }
    if (best < 0) return undefined;
    const cur = list[best];
    for (let i = best - 1; i >= 0; i--) if (list[i].sig !== cur.sig) return { cur, prev: list[i] };
    return { cur };
  }

  /** Detalhe de uma checagem: a diferença (a do Hermes ou a calculada) e a leitura completa daquela hora. */
  private checkDetail(diff: string[], r: { cur: StoredReading; prev?: StoredReading } | undefined): string | undefined {
    const parts: string[] = [];
    let lines = diff;
    if (!lines.length && r?.prev && !r.cur.same) lines = explainDiff(readingDiff(r.prev.lines, r.cur.lines));
    if (lines.length) parts.push(tr('Diferença para a leitura anterior:'), ...lines);
    if (r) {
      if (parts.length) parts.push('');
      parts.push(r.cur.same ? tr('Leitura completa ({0}, igual à anterior):', [hhmm(r.cur.at)]) : tr('Leitura completa ({0}):', [hhmm(r.cur.at)]));
      parts.push(...(r.cur.lines.length ? r.cur.lines : [tr('(leitura vazia)')]));
    }
    return parts.length ? maskSecrets(parts.join('\n')) : undefined;
  }

  private checks(live: boolean): TerminalEntry[] {
    const out: TerminalEntry[] = [];
    this.dirSig = dirSig(this.outDir);
    const files = listOutputs(this.outDir, this.opts.outputs ?? 200).filter((f) => !this.seen.has(f.name));
    const readings = files.length && this.opts.readings ? this.opts.readings(files[0].at - READING_MATCH_MS, files[files.length - 1].at + READING_MATCH_MS) : [];
    const now = this.opts.now?.() ?? Date.now();
    for (const f of files) {
      const r = this.readingAt(readings, f.at);
      // Ao vivo, a saída pode aparecer antes de a leitura ser guardada: espera um pouco por ela.
      if (live && !r && this.opts.readings) {
        const since = this.waiting.get(f.name) ?? now;
        this.waiting.set(f.name, since);
        // Em ordem: as seguintes esperam junto.
        if (now - since < READING_WAIT_MS) break;
      }
      this.waiting.delete(f.name);
      this.seen.add(f.name);
      const text = readSmall(f.path, 64 * 1024);
      if (!text) continue;
      const o = parseCronOutput(text);
      if (o.noChange) {
        const detail = this.checkDetail([], r);
        out.push({ kind: 'system', id: `v${f.name}`, at: f.at, text: tr('{0} · checagem: sem mudança (o modelo não rodou)', [hhmm(f.at)]), ...(detail ? { detail } : {}), level: 'info' });
        continue;
      }
      const reason = wakeReason(o.diff, 120);
      const detail = this.checkDetail(o.diff ? explainDiff(o.diff.split('\n')) : [], r);
      out.push({
        kind: 'system',
        id: `v${f.name}`,
        at: f.at,
        text: maskSecrets(tr('{0} · mudou: chamou {1}{2}', [hhmm(f.at), this.mainName(), reason ? ` (${reason})` : ''])),
        ...(detail ? { detail } : {}),
        level: 'warn',
      });
    }
    return out;
  }

  private reading(): TerminalEntry[] {
    const r = readMonitorLines(join(this.outDir, 'monitor_last_output.txt'));
    if (!r) return [];
    const sig = `${r.at}:${r.lines.length}`;
    if (sig === this.readSig) return [];
    this.readSig = sig;
    const body = r.lines.length ? `\`\`\`\n${r.lines.join('\n')}\n\`\`\`` : tr('(leitura vazia)');
    const text = marked(prepare(`${tr('**Última leitura do monitor** ({0})', [hhmm(r.at)])}\n\n${body}`, TEXT_MAX));
    return [{ kind: 'assistant', id: `vr${Math.round(r.at)}`, at: r.at, text }];
  }

  load(limit: number): TerminalFeedInit {
    this.seen.clear();
    this.waiting.clear();
    this.readSig = '';
    const intro: TerminalEntry = {
      kind: 'system',
      id: 'v-intro',
      at: 0,
      text: tr('Vigia da rotina {0}{1}: roda o monitor sem gastar o modelo e só chama {2} quando a leitura muda', [this.job.name, this.job.schedule ? ` (${this.job.schedule})` : '', this.mainName()]),
      level: 'info',
    };
    let entries = [...this.checks(false), ...this.reading()];
    const truncated = entries.length > limit;
    if (truncated) entries = entries.slice(-limit);
    if (entries.length) intro.at = entries[0].at;
    return { entries: [intro, ...entries], truncated };
  }

  poll(): TerminalEntry[] {
    const out: TerminalEntry[] = [];
    if (dirSig(this.outDir) !== this.dirSig || this.waiting.size) out.push(...this.checks(true));
    out.push(...this.reading());
    return out;
  }
}
