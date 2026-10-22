// Leitura SOMENTE LEITURA dos bancos SQLite do Hermes (state.db, cron/executions.db) com o `node:sqlite` do próprio
// Node: o servidor continua sem dependências de runtime (nada de better-sqlite3 nem do binário sqlite3).
//
// O Hermes grava em modo WAL enquanto lemos, e no Docker a pasta dele chega montada só para leitura. Cada leitura abre
// o banco, consulta e fecha (abrir custa ~1 ms; nada de conexão velha presa a um arquivo trocado), escolhendo o jeito
// pelo que existe ao lado do banco:
// - `-wal` e `-shm` presentes (Hermes rodando, ou parado sem fechar direito): abre direto com `readOnly`. Enxerga o
//   que ainda está só no WAL; num sistema de arquivos só leitura o SQLite lê o índice do WAL na memória (testado no
//   node:24-alpine com a pasta montada `:ro`). Nada é criado: os dois arquivos já existem;
// - sem o `-wal` (Hermes fechou e fez o checkpoint): `file:...?immutable=1`, que não cria `-wal`/`-shm` nem trava
//   nada. Abrir direto aqui CRIARIA os dois arquivos na pasta do Hermes (ou falharia, se ela for só leitura);
// - se nada disso der (Node sem URI no SQLite, como o 22.14; banco ocupado; erro de E/S): copia o banco e o `-wal`
//   para uma pasta temporária do Habblaud e lê a cópia. A cópia só é refeita quando o tamanho ou a hora dos arquivos
//   mudam.
// Um erro numa leitura (banco ocupado, arquivo no meio de uma troca) só devolve undefined: o próximo ciclo tenta de novo.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { errMsg } from '../../log';

/** O pedaço do `node:sqlite` que usamos (tipado à mão: o módulo é carregado em tempo de execução). */
export interface SqliteStatement {
  all(...params: Array<string | number | null>): unknown[];
  get(...params: Array<string | number | null>): unknown;
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean; timeout?: number }) => SqliteDatabase;
}

/** Como a última leitura abriu o banco (para o /api/health e os testes). */
export type ReadMode = 'direct' | 'immutable' | 'snapshot';

let cached: { mod?: SqliteModule; error?: string } | undefined;

/**
 * Carrega o `node:sqlite` (Node 22.13+ sem flag; no Node 24 do Dockerfile, estável o bastante). O aviso
 * "ExperimentalWarning: SQLite is an experimental feature" é engolido só durante o carregamento (o resto dos avisos do
 * processo segue igual). Sem o módulo, devolve o motivo: a fonte do Hermes fica desligada com um aviso no log.
 */
export function loadSqlite(): { mod?: SqliteModule; error?: string } {
  if (cached) return cached;
  const original = process.emitWarning;
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    const text = typeof warning === 'string' ? warning : warning?.message;
    if (/sqlite/i.test(text ?? '')) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    const req = createRequire(import.meta.url);
    const mod = req('node:sqlite') as SqliteModule;
    cached = typeof mod?.DatabaseSync === 'function' ? { mod } : { error: 'node:sqlite sem DatabaseSync' };
  } catch (err) {
    cached = { error: errMsg(err) };
  } finally {
    process.emitWarning = original;
  }
  return cached;
}

/** Tamanho e hora de um arquivo ('' se não existe): assinatura barata para saber se algo mudou. */
function fileSig(path: string): string {
  try {
    const st = statSync(path);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return '';
  }
}

export interface ReadOnlyDbOptions {
  /** Pasta onde ficam as cópias do modo 'snapshot' (é do Habblaud; apagada em close()). */
  tmpDir?: string;
  /** Força um modo (testes). */
  force?: ReadMode;
}

/** Um banco SQLite do Hermes, lido sem nunca escrever nada na pasta dele. */
export class ReadOnlyDb {
  /** Modo da última leitura que deu certo. */
  mode?: ReadMode;
  /** Motivo da última falha (limpo na próxima leitura que der certo). */
  error?: string;
  /** O URI `immutable` não funciona neste Node: vai direto para a cópia quando não há `-wal`. */
  private noUri = false;
  private snapDir?: string;
  private snapSig = '';

  constructor(
    readonly path: string,
    private readonly sqlite: SqliteModule,
    private readonly opts: ReadOnlyDbOptions = {},
  ) {}

  /** O banco existe? */
  exists(): boolean {
    return existsSync(this.path);
  }

  /** Assinatura do banco e do WAL: muda quando o Hermes grava algo. */
  signature(): string {
    return `${fileSig(this.path)}|${fileSig(`${this.path}-wal`)}`;
  }

  /**
   * Abre, roda `fn` e fecha. undefined = banco ausente ou ilegível agora (o motivo fica em `error`). Nunca lança.
   */
  read<T>(fn: (db: SqliteDatabase) => T): T | undefined {
    if (!this.exists()) {
      this.error = 'ausente';
      return undefined;
    }
    const order = this.opts.force ? [this.opts.force] : this.order();
    let last: unknown;
    for (const mode of order) {
      try {
        const out = this.readWith(mode, fn);
        this.mode = mode;
        delete this.error;
        return out;
      } catch (err) {
        last = err;
        if (mode === 'immutable' && /unable to open|URI|invalid/i.test(errMsg(err))) this.noUri = true;
      }
    }
    this.error = errMsg(last);
    return undefined;
  }

  /** Apaga a cópia temporária (se houver). */
  close(): void {
    if (this.snapDir) rmSync(this.snapDir, { recursive: true, force: true });
    delete this.snapDir;
    this.snapSig = '';
  }

  private order(): ReadMode[] {
    const wal = existsSync(`${this.path}-wal`);
    const shm = existsSync(`${this.path}-shm`);
    if (wal && shm) return ['direct', 'snapshot'];
    // `-wal` sem `-shm` (ou o contrário): abrir direto criaria o que falta na pasta do Hermes.
    if (wal) return ['snapshot'];
    return this.noUri ? ['snapshot'] : ['immutable', 'snapshot'];
  }

  private readWith<T>(mode: ReadMode, fn: (db: SqliteDatabase) => T): T {
    let target: string;
    if (mode === 'direct') target = this.path;
    else if (mode === 'immutable') target = `${pathToFileURL(this.path).href}?immutable=1`;
    else target = this.snapshot();
    const db = new this.sqlite.DatabaseSync(target, { readOnly: true, timeout: 1_000 });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  /**
   * Cópia do banco e do `-wal` numa pasta do Habblaud, refeita só quando mudam. Se o Hermes gravou durante a cópia,
   * copia de novo (até 3 vezes); um quadro do WAL pela metade é descartado pelo próprio SQLite (checksum).
   */
  private snapshot(): string {
    const base = this.opts.tmpDir ?? tmpdir();
    if (!this.snapDir || !existsSync(this.snapDir)) {
      mkdirSync(base, { recursive: true });
      this.snapDir = mkdtempSync(join(base, 'habblaud-hermes-'));
      this.snapSig = '';
    }
    const dest = join(this.snapDir, 'copy.db');
    let sig = this.signature();
    if (sig === this.snapSig && existsSync(dest)) return dest;
    for (let i = 0; i < 3; i++) {
      // O SQLite da cópia recria o próprio -shm a partir do -wal copiado; um -shm velho confundiria o índice.
      rmSync(`${dest}-shm`, { force: true });
      rmSync(`${dest}-wal`, { force: true });
      copyFileSync(this.path, dest);
      if (existsSync(`${this.path}-wal`)) copyFileSync(`${this.path}-wal`, `${dest}-wal`);
      const after = this.signature();
      if (after === sig) break;
      sig = after;
    }
    this.snapSig = sig;
    return dest;
  }
}
