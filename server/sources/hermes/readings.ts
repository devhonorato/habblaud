// Histórico das leituras do monitor do Vigia. O Hermes só guarda a última (cron/output/<job>/monitor_last_output.txt,
// sobrescrita a cada checagem); o Habblaud guarda uma cópia de cada checagem que viu, NO DIRETÓRIO DE DADOS DELE
// (<dataDir>/hermes-leituras/<perfil>/<id da rotina>/<AAAA-MM-DD>.jsonl, dia UTC), nunca no do Hermes.
//
// Uma linha por checagem: {"at": <mtime da leitura, ms>, "sig": <sha1 das linhas>, "lines": [...]}. Leitura igual à
// anterior grava só {"at", "sig", "same": true} (a hora da checagem fica, o conteúdo não se repete); a primeira linha
// de cada arquivo traz sempre o conteúdo, então cada dia se lê sozinho. Os arquivos mais velhos que `days` dias são
// apagados ao subir e a cada hora.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { tr } from '../../../shared/i18n';
import { errMsg, log } from '../../log';
import { PROFILE_NAME } from './profiles';

/** Uma checagem guardada, já com o conteúdo (as "iguais" herdam as linhas da anterior). */
export interface StoredReading {
  at: number;
  sig: string;
  lines: string[];
  /** Igual à leitura anterior. */
  same: boolean;
}

interface Row {
  at: number;
  sig: string;
  lines?: string[];
  same?: true;
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
/** Arquivo de um dia passou disto: para de gravar nele (proteção contra um monitor que muda a cada segundo). */
const DAY_MAX_BYTES = 32 * 1024 * 1024;
const PRUNE_EVERY_MS = 3_600_000;
const DAY_MS = 86_400_000;

function utcDayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Pasta segura para o id da rotina (os do Hermes são hex; o resto vira hash). */
function jobDirName(jobId: string): string {
  return PROFILE_NAME.test(jobId) ? jobId : `job-${createHash('sha1').update(jobId).digest('hex').slice(0, 12)}`;
}

export function readingSig(lines: readonly string[]): string {
  return createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 16);
}

function parseRow(line: string): Row | undefined {
  try {
    const v = JSON.parse(line) as Partial<Row>;
    if (typeof v.at !== 'number' || !Number.isFinite(v.at) || typeof v.sig !== 'string') return undefined;
    const lines = Array.isArray(v.lines) ? v.lines.filter((l): l is string => typeof l === 'string') : undefined;
    return { at: v.at, sig: v.sig, ...(lines ? { lines } : {}), ...(v.same ? { same: true as const } : {}) };
  } catch {
    return undefined;
  }
}

export interface ReadingStoreOptions {
  /** <dataDir>/hermes-leituras. */
  dir: string;
  /** Dias guardados (0 = desligado). */
  days: number;
  /** Diretório do Hermes: o histórico nunca vai para dentro dele. */
  hermesDir?: string;
  now?: () => number;
}

export class ReadingStore {
  readonly enabled: boolean;
  private readonly now: () => number;
  /** Última checagem gravada por rotina ("perfil/job"): sig, dia e hora. */
  private last = new Map<string, { sig: string; day: string; at: number }>();
  private lastPrune = -Infinity;
  private full = new Set<string>();

  constructor(private readonly opts: ReadingStoreOptions) {
    this.now = opts.now ?? Date.now;
    let enabled = opts.days > 0;
    if (enabled && opts.hermesDir) {
      const rel = relative(resolve(opts.hermesDir), resolve(opts.dir));
      if (!rel || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel))) {
        log.warn(tr('Leituras do Vigia desligadas: {0} fica dentro do diretório do Hermes, que é só leitura.', [opts.dir]));
        enabled = false;
      }
    }
    this.enabled = enabled;
  }

  get days(): number {
    return this.opts.days;
  }

  private jobDir(profile: string, jobId: string): string | undefined {
    if (!PROFILE_NAME.test(profile)) return undefined;
    return join(this.opts.dir, profile, jobDirName(jobId));
  }

  /**
   * Guarda a checagem (leitura com hora `at`). A mesma hora não entra duas vezes; o mesmo conteúdo entra só com a
   * hora. Devolve se gravou.
   */
  record(profile: string, jobId: string, at: number, lines: readonly string[]): boolean {
    if (!this.enabled) return false;
    const dir = this.jobDir(profile, jobId);
    if (!dir) return false;
    this.maybePrune();
    const key = `${profile}/${jobId}`;
    const sig = readingSig(lines);
    const day = utcDayOf(at);
    const prev = this.last.get(key) ?? this.lastOnDisk(dir);
    if (prev && at <= prev.at) return false;
    const file = join(dir, `${day}.jsonl`);
    const row: Row = prev && prev.sig === sig && prev.day === day ? { at, sig, same: true } : { at, sig, lines: [...lines] };
    try {
      mkdirSync(dir, { recursive: true });
      if (this.sizeOf(file) > DAY_MAX_BYTES) {
        if (!this.full.has(file)) log.warn(tr('Leituras do Vigia: {0} passou de 32 MB; o resto do dia não é guardado.', [file]));
        this.full.add(file);
        return false;
      }
      appendFileSync(file, `${JSON.stringify(row)}\n`);
      this.last.set(key, { sig, day, at });
      log.clearOnce('hermes-readings');
      return true;
    } catch (err) {
      log.warnOnce('hermes-readings', tr('Não foi possível guardar a leitura do Vigia em {0} ({1}).', [dir, errMsg(err)]));
      return false;
    }
  }

  private sizeOf(file: string): number {
    try {
      return statSync(file).size;
    } catch {
      return 0;
    }
  }

  /** Dias guardados de uma rotina (do mais antigo ao mais novo). */
  private dayFiles(dir: string): string[] {
    try {
      return readdirSync(dir)
        .filter((f) => DAY_FILE.test(f))
        .sort();
    } catch {
      return [];
    }
  }

  /** A última checagem gravada (depois de um reinício), para não repetir conteúdo. */
  private lastOnDisk(dir: string): { sig: string; day: string; at: number } | undefined {
    const files = this.dayFiles(dir);
    const name = files[files.length - 1];
    if (!name) return undefined;
    const rows = this.readFile(join(dir, name));
    const r = rows[rows.length - 1];
    return r ? { sig: r.sig, day: DAY_FILE.exec(name)![1], at: r.at } : undefined;
  }

  private readFile(path: string): Row[] {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return [];
    }
    const out: Row[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const r = parseRow(line);
      if (r) out.push(r);
    }
    return out;
  }

  /** Checagens guardadas entre `from` e `to` (ms, inclusive), da mais antiga para a mais nova, até `max` (as últimas). */
  list(profile: string, jobId: string, from = 0, to = Infinity, max = 2_000): StoredReading[] {
    const dir = this.jobDir(profile, jobId);
    if (!dir) return [];
    const fromDay = Number.isFinite(from) && from > 0 ? utcDayOf(from) : '';
    const toDay = Number.isFinite(to) ? utcDayOf(to) : '9999-99-99';
    const out: StoredReading[] = [];
    for (const name of this.dayFiles(dir)) {
      const day = DAY_FILE.exec(name)![1];
      if (day < fromDay || day > toDay) continue;
      let lines: string[] = [];
      let sig = '';
      for (const r of this.readFile(join(dir, name))) {
        if (r.lines) {
          lines = r.lines;
          sig = r.sig;
        } else if (r.sig !== sig) continue; // "igual" a algo que não está no arquivo: sem conteúdo para mostrar
        if (r.at < from || r.at > to) continue;
        out.push({ at: r.at, sig: r.sig, lines, same: !!r.same });
      }
    }
    return out.length > max ? out.slice(-max) : out;
  }

  private maybePrune(): void {
    if (this.now() - this.lastPrune >= PRUNE_EVERY_MS) this.prune();
  }

  /** Apaga os dias mais velhos que `days` (e as pastas que ficarem vazias). */
  prune(): number {
    this.lastPrune = this.now();
    if (!this.enabled) return 0;
    const oldest = utcDayOf(this.now() - (this.opts.days - 1) * DAY_MS);
    let removed = 0;
    const list = (d: string) => {
      try {
        return readdirSync(d, { withFileTypes: true });
      } catch {
        return [];
      }
    };
    for (const p of list(this.opts.dir)) {
      if (!p.isDirectory()) continue;
      const pdir = join(this.opts.dir, p.name);
      for (const j of list(pdir)) {
        if (!j.isDirectory()) continue;
        const jdir = join(pdir, j.name);
        for (const name of this.dayFiles(jdir)) {
          if (DAY_FILE.exec(name)![1] >= oldest) continue;
          try {
            unlinkSync(join(jdir, name));
            removed++;
          } catch {
            // some na próxima limpeza
          }
        }
        if (!list(jdir).length) tryRmdir(jdir);
      }
      if (!list(pdir).length) tryRmdir(pdir);
    }
    if (removed) this.last.clear();
    return removed;
  }
}

function tryRmdir(dir: string): void {
  try {
    rmdirSync(dir);
  } catch {
    // não vazia ou ocupada: fica
  }
}

/** Diferença simples entre duas leituras (linhas que saíram com "-" e que entraram com "+", na ordem delas). */
export function readingDiff(prev: readonly string[], cur: readonly string[]): string[] {
  const before = new Set(prev);
  const after = new Set(cur);
  return [...prev.filter((l) => !after.has(l)).map((l) => `-${l}`), ...cur.filter((l) => !before.has(l)).map((l) => `+${l}`)];
}
