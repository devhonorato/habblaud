// Mensagens do Hermes (tabela `messages` do state.db) em atividades do escritório. Código puro: testado em
// describe.test.ts.
//
// Uma linha de `messages` vira zero ou mais atividades:
// - user: o pedido. Numa rotina do cron o texto é o prompt montado pelo Hermes ("[IMPORTANT: You are running a
//   scheduled cron job..."), então o balão diz o nome da rotina; numa conversa, "Nova tarefa: …";
// - assistant: o raciocínio (`reasoning`) vira 'think'; cada item de `tool_calls` vira uma atividade pela ferramenta
//   (o `tool_call` do Hermes, que chama uma ferramenta MCP carregada sob demanda, é aberto e descrito pela de dentro);
//   texto com `finish_reason` "stop" é a resposta ('respond') e o fim do turno ('done');
// - tool: só o resultado com erro aparece ('error'); os outros não dizem nada novo (a chamada já apareceu).
// Tudo mascarado (maskSecrets) e cortado: texto até 46 caracteres, detalhe até 300.
import { basename, describeCommand, describePrompt, describeTool, maskSecrets, SPECIAL, truncate, type ActivityDescription } from '../../../shared/activity';
import type { ActivityKind } from '../../../shared/types';
import { tr } from '../../../shared/i18n';

const MAX_TEXT = 46;
const MAX_DETAIL = 300;

/** Uma linha da tabela `messages` (só as colunas que usamos; as outras podem faltar em versões antigas). */
export interface HermesMessage {
  id: number;
  session_id: string;
  role: string;
  content?: string | null;
  tool_call_id?: string | null;
  tool_calls?: string | null;
  tool_name?: string | null;
  /** Epoch em segundos (REAL). */
  timestamp: number;
  finish_reason?: string | null;
  reasoning?: string | null;
}

/** Atividade sem id nem horário (quem chama acrescenta). */
export interface HermesActivity extends ActivityDescription {
  /** Sufixo do id (único dentro da mensagem). */
  key: string;
  tool?: string;
  error?: boolean;
}

/** O que o descritor precisa saber da sessão. */
export interface MessageContext {
  /** Rotina do cron dona da sessão (nome do job), quando é uma. */
  jobName?: string;
  /** Início do turno (epoch ms), para o "Concluiu em X". */
  turnStartMs?: number;
}

function make(kind: ActivityKind, icon: string, text: string, detail?: string): ActivityDescription {
  // Mascara antes de cortar (um segredo cortado ao meio vazaria o começo).
  return {
    kind,
    icon,
    text: truncate(maskSecrets(text.slice(0, MAX_TEXT * 8)), MAX_TEXT),
    ...(detail ? { detail: truncate(maskSecrets(detail.slice(0, MAX_DETAIL * 4)), MAX_DETAIL) } : {}),
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** JSON (objeto) de um texto; {} se não for. */
function parseObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return rec(raw);
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    return rec(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** Argumentos de uma chamada em uma linha (para o detalhe), sem chaves vazias. */
function argsDetail(args: Record<string, unknown>): string | undefined {
  const keys = Object.keys(args);
  if (!keys.length) return undefined;
  try {
    return JSON.stringify(args);
  } catch {
    return undefined;
  }
}

/** Símbolo (par) de uma chamada do Kairo, se houver: "UNIUSDT". */
function symbolOf(args: Record<string, unknown>): string {
  const s = str(args.simbolo) || str(args.par) || str(args.symbol);
  return /^[A-Za-z0-9._-]{2,20}$/.test(s) ? s.toUpperCase() : '';
}

/**
 * Nome da ferramenta sem o prefixo do MCP: "mcp__kairo__kairo_radar" e "mcp_kairo_kairo_radar" -> servidor "kairo",
 * ferramenta "kairo_radar". Ferramentas próprias do Hermes ficam sem servidor.
 */
export function splitToolName(name: string): { server?: string; tool: string } {
  const dbl = /^mcp__([^_].*?)__(.+)$/.exec(name);
  if (dbl) return { server: dbl[1], tool: dbl[2] };
  const single = /^mcp_([a-z0-9-]+)_(.+)$/i.exec(name);
  if (single) return { server: single[1], tool: single[2] };
  return { tool: name };
}

/** Ferramentas do Kairo (robô de trading) com rótulo próprio. */
function describeKairo(tool: string, args: Record<string, unknown>): ActivityDescription {
  const sym = symbolOf(args);
  const detail = argsDetail(args);
  const action = tool.replace(/^kairo_/, '');
  switch (action) {
    case 'estado':
      return make('mcp', '📊', tr('Consultando estado do mandato'), detail);
    case 'radar':
      return make('mcp', '📡', tr('Lendo o radar'), detail);
    case 'eventos':
      return make('mcp', '📰', tr('Lendo os eventos do Kairo'), detail);
    case 'backtest':
      return make('mcp', '🧪', sym ? tr('Rodando backtest de {0}', [sym]) : tr('Rodando backtest'), detail);
    case 'criar_instancia':
      return make('mcp', '🚀', sym ? tr('Criando instância {0}', [sym]) : tr('Criando instância'), detail);
    case 'encerrar_instancia':
      return make('mcp', '🛑', sym ? tr('Encerrando instância {0}', [sym]) : tr('Encerrando instância'), detail);
    case 'sinal':
      return make('mcp', '📶', sym ? tr('Conferindo o sinal de {0}', [sym]) : tr('Conferindo um sinal'), detail);
    default:
      return make('mcp', '🔌', `Kairo: ${action.replace(/[_-]+/g, ' ')}`, detail);
  }
}

/** Ferramentas próprias do Hermes (terminal, arquivos, web, skills, delegação...). */
function describeBuiltin(name: string, args: Record<string, unknown>): ActivityDescription | undefined {
  const path = str(args.path) || str(args.file_path) || str(args.file);
  switch (name) {
    case 'terminal':
      return describeCommand(str(args.command), str(args.description));
    case 'process':
      return make('run', '📟', tr('Conferindo um processo em segundo plano'), str(args.action));
    case 'execute_code':
      return make('run', '🐍', tr('Rodando um script Python'), str(args.code));
    case 'read_file':
      return make('read', '📖', path ? tr('Lendo {0}', [basename(path)]) : tr('Lendo arquivo'), path);
    case 'write_file':
      return make('write', '📝', path ? tr('Escrevendo {0}', [basename(path)]) : tr('Escrevendo arquivo'), path);
    case 'patch':
      return make('edit', '✏️', path ? tr('Editando {0}', [basename(path)]) : tr('Editando arquivo'), path);
    case 'search_files': {
      const pat = str(args.pattern) || str(args.query);
      return make('search', '🔎', pat ? tr('Buscando “{0}”', [truncate(pat, 26)]) : tr('Buscando nos arquivos'), pat);
    }
    case 'vision_analyze':
      return make('read', '🖼️', tr('Analisando uma imagem'), str(args.image_url) || str(args.question));
    case 'web_search': {
      const q = str(args.query);
      return make('web', '🌐', q ? tr('Pesquisando “{0}”', [truncate(q, 28)]) : tr('Pesquisando na web'), q);
    }
    case 'web_extract':
    case 'web_crawl':
      return make('web', '🌐', tr('Lendo páginas da web'), argsDetail(args));
    case 'delegate_task': {
      const goal = str(args.goal) || str(args.task) || str(args.description);
      return make('delegate', '👥', goal ? tr('Delegando: {0}', [goal]) : tr('Chamando um subagente'), goal);
    }
    case 'skill_view':
    case 'skill_manage': {
      const skill = str(args.name) || str(args.skill);
      return make('skill', '🧩', skill ? tr('Usando a skill {0}', [skill]) : tr('Consultando as skills'));
    }
    case 'skills_list':
      return make('skill', '🧩', tr('Consultando as skills'));
    case 'todo':
      return make('plan', '🗒️', tr('Atualizando a lista de tarefas'));
    case 'memory':
      return make('other', '🧠', tr('Atualizando a memória'));
    case 'session_search':
      return make('search', '🗂️', tr('Buscando em conversas antigas'), str(args.query));
    case 'clarify':
      return make('ask', '❓', tr('Fazendo uma pergunta a você'), str(args.question));
    case 'send_message':
      return make('communicate', '📣', tr('Enviando uma mensagem'));
    case 'cronjob':
      return make('plan', '⏰', tr('Agendando uma tarefa'));
    case 'tool_search':
      return make('other', '🧰', tr('Procurando ferramentas'), argsDetail(args));
    case 'tool_describe': {
      const tool = splitToolName(str(args.name) || str(args.tool)).tool;
      return make('other', '🧰', tool ? tr('Lendo as instruções de {0}', [tool]) : tr('Lendo as instruções de uma ferramenta'));
    }
    default:
      if (name.startsWith('browser_')) {
        const url = str(args.url);
        return make('browser', '🧭', name === 'browser_navigate' && url ? tr('Abrindo {0}', [url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]]) : tr('Navegando no navegador'), url);
      }
      return undefined;
  }
}

/**
 * Uma chamada de ferramenta do Hermes em atividade. `tool_call` (a ferramenta que chama uma MCP carregada sob demanda)
 * é descrita pela ferramenta de dentro; o nome bruto que fica em Activity.tool também é o de dentro.
 */
export function describeHermesTool(rawName: string, rawArgs: unknown): ActivityDescription & { tool: string } {
  let name = rawName;
  let args = parseObject(rawArgs);
  if (name === 'tool_call') {
    const inner = str(args.name);
    if (inner) {
      name = inner;
      args = parseObject(args.arguments);
    }
  }
  const { server, tool } = splitToolName(name);
  if (/^kairo_/.test(tool) || server === 'kairo') return { ...describeKairo(tool, args), tool: name };
  if (server) {
    // Outros servidores MCP: o mesmo texto do Claude Code (GitHub, navegador, banco...).
    const desc = describeTool(`mcp__${server}__${tool}`, args);
    return { ...desc, tool: name };
  }
  const builtin = describeBuiltin(name, args);
  if (builtin) return { ...builtin, tool: name };
  return { ...make('other', '🛠️', tr('Usando {0}', [name]), argsDetail(args)), tool: name };
}

/** Lista de `tool_calls` (JSON no formato da OpenAI) -> [id, nome, argumentos]. */
export function parseToolCalls(raw: string | null | undefined): Array<{ id: string; name: string; args: unknown }> {
  if (!raw) return [];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: Array<{ id: string; name: string; args: unknown }> = [];
  list.forEach((c, i) => {
    const call = rec(c);
    const fn = rec(call.function);
    const name = str(fn.name) || str(call.name);
    if (!name) return;
    out.push({ id: str(call.id) || str(call.call_id) || String(i), name, args: fn.arguments ?? call.arguments });
  });
  return out;
}

/**
 * Corpo do resultado de uma ferramenta sem o envelope que o Hermes põe nos dados de fora
 * (`<untrusted_tool_result ...>` + o parágrafo de aviso).
 */
export function unwrapToolResult(content: string): string {
  let s = content.trimStart();
  if (s.startsWith('<untrusted_tool_result')) {
    const close = s.indexOf('>');
    s = close >= 0 ? s.slice(close + 1) : s;
    const blank = s.search(/\n\s*\n/);
    if (blank >= 0 && /Treat it as DATA/i.test(s.slice(0, blank))) s = s.slice(blank);
    s = s.replace(/<\/untrusted_tool_result>\s*$/, '');
  }
  return s.trim();
}

/** Mensagem de erro do resultado de uma ferramenta; undefined se deu certo. */
export function toolResultError(content: string | null | undefined): string | undefined {
  if (!content) return undefined;
  const body = unwrapToolResult(content);
  if (/^Tool '[^']+' does not exist/.test(body)) return body;
  if (/^(Error|Erro|Traceback)\b/.test(body)) return body;
  if (!body.startsWith('{')) return undefined;
  let obj: Record<string, unknown>;
  try {
    obj = rec(JSON.parse(body));
  } catch {
    // JSON grande demais (cortado) ou com lixo: só o começo decide.
    const m = /^\{\s*"error"\s*:\s*"((?:\\.|[^"\\])+)/.exec(body);
    return m ? m[1] : undefined;
  }
  const err = obj.error;
  if (typeof err === 'string' && err.trim()) return err;
  if (err && typeof err === 'object') return JSON.stringify(err);
  if (obj.success === false) return str(obj.message) || body;
  if (typeof obj.exit_code === 'number' && obj.exit_code !== 0) return str(obj.output) || tr('saiu com código {0}', [obj.exit_code]);
  return undefined;
}

/** Prompt do cron montado pelo Hermes (não é o texto que alguém digitou). */
export function isCronPrompt(text: string): boolean {
  return /^\[IMPORTANT: You are running (?:as )?a scheduled cron job/i.test(text.trimStart());
}

/**
 * Atividades de uma linha de `messages`. `ctx.jobName` = a sessão é de uma rotina do cron; `toolNames` = chamadas
 * já vistas (tool_call_id -> nome), para o rótulo do erro de um resultado.
 */
export function describeMessage(m: HermesMessage, ctx: MessageContext = {}, toolNames?: Map<string, string>): HermesActivity[] {
  const out: HermesActivity[] = [];
  const content = typeof m.content === 'string' ? m.content : '';
  switch (m.role) {
    case 'user': {
      if (!content.trim()) break;
      if (ctx.jobName || isCronPrompt(content)) {
        const name = ctx.jobName ?? tr('rotina agendada');
        out.push({ key: 'prompt', ...make('prompt', '⏰', tr('Rotina: {0}', [name])), tool: 'cron' });
      } else {
        out.push({ key: 'prompt', ...describePrompt(content) });
      }
      break;
    }
    case 'assistant': {
      const reasoning = typeof m.reasoning === 'string' ? m.reasoning.trim() : '';
      if (reasoning) out.push({ key: 'think', ...make('think', '💭', SPECIAL.think().text, reasoning) });
      for (const call of parseToolCalls(m.tool_calls)) {
        const desc = describeHermesTool(call.name, call.args);
        toolNames?.set(call.id, desc.tool);
        out.push({ key: `tool:${call.id}`, ...desc });
      }
      const text = content.trim();
      const stop = m.finish_reason === 'stop' || (!m.tool_calls && !!text && m.finish_reason !== 'tool_calls');
      if (text) {
        if (text === '[SILENT]') out.push({ key: 'respond', ...make('respond', '🤫', tr('Nada a relatar ([SILENT])')) });
        else out.push({ key: 'respond', ...SPECIAL.respond(maskSecrets(text.slice(0, MAX_DETAIL * 4))) });
      }
      if (stop && (text || reasoning)) {
        const ms = ctx.turnStartMs !== undefined ? Math.max(0, Math.round(m.timestamp * 1000) - ctx.turnStartMs) : undefined;
        const done: HermesActivity = { key: 'done', ...SPECIAL.turnDone(ms && ms >= 1_000 ? ms : undefined) };
        out.push(done);
      }
      break;
    }
    case 'tool': {
      const err = toolResultError(content);
      if (!err) break;
      const raw = m.tool_name || (m.tool_call_id ? toolNames?.get(m.tool_call_id) : undefined) || '';
      const short = raw ? splitToolName(raw).tool : undefined;
      out.push({ key: 'error', ...make('error', '⚠️', SPECIAL.error(short).text, err), ...(raw ? { tool: raw } : {}), error: true });
      break;
    }
    default:
      break;
  }
  return out;
}
