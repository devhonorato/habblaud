// Saídas do cron do Hermes e a leitura do monitor. Código puro (testado em cron.test.ts).
//
// cron/output/<job>/<AAAA-MM-DD_HH-MM-SS>.md (hora UTC do fim da execução) tem duas formas:
// - checagem do monitor sem mudança: cabeçalho com "**Status:** no_change (agent run suppressed)" e nada mais;
// - rodada com o modelo: "## Prompt" (o prompt montado pelo Hermes), "## Run Context" (no monitor: a diferença da
//   saída e a saída atual) e "## Response" (a resposta final; "[SILENT]" = nada a relatar).
// cron/output/<job>/monitor_last_output.txt: a última saída do script do monitor, uma informação por linha (no Kairo:
// "mandato ativo=True disponivel~31 aberto~0.0 perda~0.0", "instancia WLDUSDT 4h status=ATIVA posicao=nao
// resultado~None%", "radar PEPEUSDT nota~90 1h", "evento 921 VENDA" e avisos em texto livre).
import type { HermesMarket } from '../../../shared/hermes';
import { truncate } from '../../../shared/activity';
import { tr } from '../../../shared/i18n';

/** Nome de arquivo de saída do cron: "2026-10-22_18-29-49.md". */
export const OUTPUT_FILE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.md$/;

/** Hora (epoch ms, UTC) do nome de um arquivo de saída; undefined se o nome não tem o formato. */
export function outputTimeOf(name: string): number | undefined {
  const m = OUTPUT_FILE.exec(name);
  if (!m) return undefined;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isFinite(t) ? t : undefined;
}

export interface CronOutput {
  jobName?: string;
  jobId?: string;
  /** Checagem do monitor sem mudança: o modelo não rodou. */
  noChange: boolean;
  /** O pedido da rotina, sem o aviso padrão do Hermes ("[IMPORTANT: ...]"). */
  prompt?: string;
  /** Diferença da saída do monitor (só as linhas, sem a cerca ```diff). */
  diff?: string;
  /** Resposta final; ausente se o arquivo não tem "## Response". */
  response?: string;
  /** A resposta é "[SILENT]". */
  silent: boolean;
}

function section(text: string, title: string): string | undefined {
  const re = new RegExp(`^## ${title}[ \\t]*$`, 'm');
  const m = re.exec(text);
  if (!m) return undefined;
  const rest = text.slice(m.index + m[0].length);
  // "## Run Context" começa com "## MONITOR CHANGE DETECTED": só os títulos conhecidos encerram uma seção.
  const next = /^## (?:Prompt|Run Context|Response)[ \t]*$/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

/** Tira o aviso que o Hermes põe no começo do prompt de toda rotina. */
export function stripCronPreamble(text: string): string {
  const t = text.trimStart();
  if (!t.startsWith('[IMPORTANT:')) return text.trim();
  // O aviso é um bloco entre colchetes no primeiro parágrafo.
  const end = t.indexOf(']\n');
  return end >= 0 ? t.slice(end + 1).trim() : t.trim();
}

/** Linhas da diferença ("+"/"-") do bloco ```diff de um "Run Context" ou de um prompt de rotina com monitor. */
export function diffOf(text: string): string | undefined {
  const m = /```diff\s*\n([\s\S]*?)```/.exec(text);
  if (!m) return undefined;
  const lines = m[1].split('\n').filter((l) => l && !l.startsWith('---') && !l.startsWith('+++') && !l.startsWith('@@'));
  return lines.length ? lines.join('\n') : undefined;
}

export function parseCronOutput(text: string): CronOutput {
  const head = text.slice(0, 600);
  const jobName = /^# Cron Job:\s*(.+)$/m.exec(head)?.[1]?.trim();
  const jobId = /\*\*Job ID:\*\*\s*(\S+)/.exec(head)?.[1];
  const noChange = /\*\*Status:\*\*\s*no_change/i.test(head);
  const out: CronOutput = { noChange, silent: false };
  if (jobName) out.jobName = jobName;
  if (jobId) out.jobId = jobId;
  if (noChange) return out;
  const prompt = section(text, 'Prompt');
  if (prompt) out.prompt = stripCronPreamble(prompt);
  const ctx = section(text, 'Run Context');
  const diff = ctx ? diffOf(ctx) : undefined;
  if (diff) out.diff = diff;
  const response = section(text, 'Response');
  if (response !== undefined) {
    out.silent = response.trim() === '[SILENT]';
    out.response = response;
  }
  return out;
}

// ------------------------------------------------------------------ monitor do Kairo

function field(parts: string[], key: string): string | undefined {
  for (const p of parts) {
    const m = new RegExp(`^${key}[=~](.*)$`).exec(p);
    if (m) return m[1];
  }
  return undefined;
}

function cleanResult(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.replace(/%$/, '');
  return s && s !== 'None' && s !== 'null' ? s : undefined;
}

/** Mercado das linhas do monitor do Kairo; undefined se as linhas não parecem do Kairo. */
export function parseMarket(lines: readonly string[]): HermesMarket | undefined {
  if (!lines.length) return undefined;
  // O script escreve "KAIRO fora do ar..." quando não consegue falar com o Kairo.
  if (/^KAIRO\b/.test(lines[0])) return { online: false, instances: [], radar: [], events: [], warnings: lines.slice(0, 5) };
  const m: HermesMarket = { online: true, instances: [], radar: [], events: [], warnings: [] };
  let known = false;
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    switch (parts[0]) {
      case 'mandato': {
        known = true;
        const active = field(parts, 'ativo');
        if (active) m.active = /^true$/i.test(active);
        const available = field(parts, 'disponivel');
        if (available) m.available = available;
        const open = field(parts, 'aberto');
        if (open) m.open = open;
        const loss = field(parts, 'perda');
        if (loss) m.loss = loss;
        break;
      }
      case 'instancia': {
        known = true;
        if (!parts[1]) break;
        const status = field(parts, 'status');
        // Linhas extras da mesma instância ("instancia X 1h pullback-atr parada ha 3h") viram aviso.
        if (!status) {
          m.warnings.push(line.trim());
          break;
        }
        const inst: HermesMarket['instances'][number] = { pair: parts[1], position: field(parts, 'posicao') === 'sim', status };
        if (parts[2] && !parts[2].includes('=')) inst.interval = parts[2];
        const result = cleanResult(field(parts, 'resultado'));
        if (result) inst.result = result;
        m.instances.push(inst);
        break;
      }
      case 'radar': {
        known = true;
        if (!parts[1]) break;
        const item: HermesMarket['radar'][number] = { pair: parts[1] };
        const score = field(parts, 'nota');
        if (score) item.score = score;
        const interval = parts.slice(2).find((p) => !p.includes('~') && !p.includes('='));
        if (interval) item.interval = interval;
        m.radar.push(item);
        break;
      }
      case 'evento':
        known = true;
        if (parts[1] && parts[2]) m.events.push({ id: parts[1], type: parts.slice(2).join(' ') });
        break;
      default:
        if (line.trim()) m.warnings.push(line.trim());
    }
  }
  return known ? m : undefined;
}

/** Uma linha do monitor em português curto (o motivo do "Vigia chamou"). */
export function describeMonitorLine(line: string): string {
  const parts = line.trim().split(/\s+/);
  switch (parts[0]) {
    case 'instancia': {
      const status = field(parts, 'status');
      if (!status) return line.trim();
      const pos = field(parts, 'posicao') === 'sim';
      const result = cleanResult(field(parts, 'resultado'));
      const tf = parts[2] && !parts[2].includes('=') ? ` ${parts[2]}` : '';
      if (pos) return result ? tr('{0}{1} com posição ({2}%)', [parts[1], tf, result]) : tr('{0}{1} com posição', [parts[1], tf]);
      return status !== 'ATIVA' ? `${parts[1]}${tf} ${status.toLowerCase()}` : tr('{0}{1} sem posição', [parts[1], tf]);
    }
    case 'evento':
      return parts[2] ? tr('evento {0}', [parts.slice(2).join(' ')]) : line.trim();
    case 'radar':
      return tr('radar: {0} nota {1}', [parts[1] ?? '?', field(parts, 'nota') ?? '?']);
    case 'mandato': {
      const active = field(parts, 'ativo');
      if (active && !/^true$/i.test(active)) return tr('mandato desligado');
      const available = field(parts, 'disponivel');
      return available ? tr('mandato: {0} USDT livres', [available]) : tr('mandato mudou');
    }
    default:
      return line.trim();
  }
}

/**
 * Motivo curto da mudança que acordou o agente: a primeira linha nova da diferença, em português, e quantas outras
 * mudaram. undefined se não há diferença.
 */
export function wakeReason(diff: string | undefined, max = 60): string | undefined {
  if (!diff) return undefined;
  const added = diff
    .split('\n')
    .filter((l) => l.startsWith('+'))
    .map((l) => l.slice(1).trim())
    .filter(Boolean);
  const changed = added.length ? added : diff.split('\n').filter((l) => l.startsWith('-')).map((l) => l.slice(1).trim()).filter(Boolean);
  if (!changed.length) return undefined;
  // Eventos novos dizem mais que uma nota de radar que oscilou.
  const order = (l: string) => (l.startsWith('evento') ? 0 : l.startsWith('instancia') ? 1 : l.startsWith('mandato') ? 2 : l.startsWith('radar') ? 4 : 3);
  const first = [...changed].sort((a, b) => order(a) - order(b))[0];
  const more = changed.length - 1;
  return truncate(`${describeMonitorLine(first)}${more > 0 ? ` (+${more})` : ''}`, max);
}

/** Efeito na sala por uma leitura nova do monitor: venda com lucro (festa) ou pausa por risco (alarme). */
export interface MarketEffect {
  kind: 'party' | 'alarm';
  text: string;
}

/** Compara duas leituras do mercado. Só o que mudou de uma para a outra dispara efeito. */
export function marketEffect(prev: HermesMarket | undefined, cur: HermesMarket | undefined): MarketEffect | undefined {
  if (!prev || !cur || !prev.online || !cur.online) return undefined;
  // Pausa por risco: o mandato desligou, ou um evento novo de pausa/perda máxima.
  const seen = new Set(prev.events.map((e) => e.id));
  const risky = cur.events.find((e) => !seen.has(e.id) && /PAUSA|PAUSAD|RISCO|PERDA|LIMITE|STOP_?LOSS/i.test(e.type));
  if ((prev.active === true && cur.active === false) || risky) {
    return { kind: 'alarm', text: risky ? tr('Kairo: {0}', [risky.type.toLowerCase().replace(/_/g, ' ')]) : tr('Kairo: mandato pausado') };
  }
  // Venda com lucro: posição que estava aberta com resultado positivo e fechou.
  for (const before of prev.instances) {
    if (!before.position) continue;
    const r = Number.parseFloat((before.result ?? '').replace(',', '.'));
    if (!(r > 0)) continue;
    const after = cur.instances.find((i) => i.pair === before.pair && i.interval === before.interval);
    if (!after || !after.position) return { kind: 'party', text: tr('Venda com lucro: {0} +{1}%', [before.pair, String(r)]) };
  }
  return undefined;
}
