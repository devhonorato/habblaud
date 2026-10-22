// Integração da fonte do Hermes: um diretório de dados sintético (perfis, state.db e executions.db em WAL com uma
// conexão de escrita aberta, como o Hermes rodando), o AccountsService e o Office. Nada da amostra real entra aqui.
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../../shared/types';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { tempDir } from '../../test/fixtures';
import { HermesSource, HEARTBEAT_STALE_MS, WORKING_RECENT_MS } from './source';
import { loadSqlite, ReadOnlyDb, type SqliteDatabase } from './sqlite';

setQuiet(true);

const sqlite = loadSqlite().mod!;
const T0 = Date.UTC(2026, 9, 22, 18, 0, 0);

let cleanups: Array<() => void> = [];
// Na ordem inversa (o último registrado roda primeiro): fecha os bancos antes de apagar as pastas.
afterEach(() => {
  for (const c of cleanups.reverse()) {
    try {
      c();
    } catch {
      // limpeza de teste: segue com as outras
    }
  }
  cleanups = [];
});

/** Banco gravável (o "Hermes"): fica aberto até o fim do teste, então o -wal e o -shm existem. */
function writer(path: string, schema: string): SqliteDatabase & { exec(sql: string): void } {
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new sqlite.DatabaseSync(path) as SqliteDatabase & { exec(sql: string): void };
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(schema);
  cleanups.push(() => db.close());
  return db;
}

const STATE_SCHEMA = `
CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT, model TEXT, parent_session_id TEXT,
  started_at REAL NOT NULL, ended_at REAL, end_reason TEXT, tool_call_count INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
  estimated_cost_usd REAL, actual_cost_usd REAL, last_activity_at REAL);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
  tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL, token_count INTEGER, finish_reason TEXT,
  reasoning TEXT);`;
const EXEC_SCHEMA = `
CREATE TABLE executions (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, source TEXT NOT NULL, process_id TEXT NOT NULL,
  pid INTEGER NOT NULL, status TEXT NOT NULL, claimed_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, error TEXT);`;

const JOB = '6099beb48bf4';

function setup() {
  const tmp = tempDir('habblaud-hermes-');
  cleanups.push(tmp.cleanup);
  const root = tmp.dir;
  const crypto = join(root, 'profiles', 'crypto');
  const finance = join(root, 'profiles', 'finance');
  const state = writer(join(crypto, 'state.db'), STATE_SCHEMA);
  const execs = writer(join(crypto, 'cron', 'executions.db'), EXEC_SCHEMA);
  writer(join(finance, 'state.db'), STATE_SCHEMA);
  writeFileSync(
    join(crypto, 'cron', 'jobs.json'),
    JSON.stringify({ jobs: [{ id: JOB, name: 'vigia-mercado', prompt: 'Avalie o Kairo', enabled: true, schedule_display: 'every 5m', last_status: 'ok', last_run_at: '2026-10-22T17:55:00+00:00' }] }),
  );
  let clock = T0;
  const now = () => clock;
  const beat = (at = clock) => writeFileSync(join(crypto, 'cron', 'ticker_heartbeat'), String(at / 1000));
  beat();
  writeFileSync(join(finance, 'gateway_state.json'), JSON.stringify({ gateway_state: 'running', desired_state: 'running' }));

  const late: { office?: Office } = {};
  const accounts = new AccountsService({ dirs: [], home: root, env: {}, now, onChange: () => late.office?.markDirty() });
  const office = new Office({
    names: new NameStore(null),
    version: 'teste',
    startedAt: clock,
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: (id) => accounts.find(id)?.detected.name,
    now,
  });
  late.office = office;
  const source = new HermesSource({ office, accounts, dir: root, now, sqlite, tmpDir: join(root, '..', `${tmp.dir.split(/[\\/]/).pop()}-cache`) });
  cleanups.push(() => source.stop());

  let seq = 0;
  const sec = (ms: number) => ms / 1000;
  const session = (id: string, p: { parent?: string; ended?: number; source?: string; title?: string } = {}) =>
    state
      .prepare('INSERT INTO sessions (id, source, title, model, parent_session_id, started_at, ended_at, tool_call_count, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, 3, 1000, 50)')
      .all(id, p.source ?? 'cron', p.title ?? null, 'kairo', p.parent ?? null, sec(clock), p.ended ?? null);
  const message = (sid: string, role: string, p: { content?: string; calls?: Array<[string, unknown]>; finish?: string; reasoning?: string; toolName?: string } = {}) => {
    const calls = p.calls ? JSON.stringify(p.calls.map(([name, args]) => ({ id: `c${++seq}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }))) : null;
    state
      .prepare('INSERT INTO messages (session_id, role, content, tool_calls, tool_name, timestamp, finish_reason, reasoning) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .all(sid, role, p.content ?? '', calls, p.toolName ?? null, sec(clock), p.finish ?? null, p.reasoning ?? null);
  };
  const execution = (status: string, claimedAgoMs: number) =>
    execs
      .prepare('INSERT INTO executions (id, job_id, source, process_id, pid, status, claimed_at, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .all(`e${++seq}`, JOB, 'builtin', 'p', 1, status, new Date(clock - claimedAgoMs).toISOString(), new Date(clock - claimedAgoMs).toISOString());

  return {
    root,
    crypto,
    finance,
    state,
    execs,
    office,
    source,
    session,
    message,
    execution,
    beat,
    advance(ms: number) {
      clock += ms;
    },
    poll() {
      source.poll();
      office.tick();
      office.commit();
    },
    agent(id: string): AgentInfo | undefined {
      return office.commit().snapshot.agents.find((a) => a.id === id);
    },
    history(id: string) {
      return office.detail(id)?.history ?? [];
    },
  };
}

describe('fonte do Hermes: perfis e salas', () => {
  it('cada perfil vira uma sala com um agente principal permanente da conta "hermes"', () => {
    const h = setup();
    h.source.boot();
    const snap = h.office.commit().snapshot;
    expect(snap.rooms.map((r) => r.name).sort()).toEqual(['crypto', 'finance']);
    const crypto = h.agent('hermes:crypto')!;
    expect(crypto).toMatchObject({ kind: 'main', provider: 'hermes', account: 'hermes', role: 'Agente Hermes' });
    expect(snap.accounts).toEqual([expect.objectContaining({ id: 'hermes', provider: 'hermes', short: 'H', name: 'Hermes' })]);
    expect(h.source.sources()).toEqual([expect.objectContaining({ label: 'hermes', provider: 'hermes', ok: true })]);
    // sem conversa no terminal (a conversa está no SQLite)
    expect(h.source.transcriptPathOf()).toBeUndefined();
    // a sala não some entre execuções
    h.advance(3600_000);
    h.beat();
    h.poll();
    expect(h.agent('hermes:crypto')).toBeDefined();
  });

  it('perfil "default" na raiz do diretório e perfil sem state.db (só o cron)', () => {
    const h = setup();
    writer(join(h.root, 'state.db'), STATE_SCHEMA);
    mkdirSync(join(h.root, 'profiles', 'vazio', 'cron'), { recursive: true });
    writeFileSync(join(h.root, 'profiles', 'vazio', 'cron', 'jobs.json'), '{"jobs": []}');
    h.source.boot();
    const names = h.office.commit().snapshot.rooms.map((r) => r.name).sort();
    expect(names).toEqual(['crypto', 'default', 'finance', 'vazio']);
    expect(h.agent('hermes:vazio')?.status).toBe('idle');
  });
});

describe('fonte do Hermes: status', () => {
  it('execução do cron rodando = working; terminou = idle (checagem rápida do monitor não acorda)', () => {
    const h = setup();
    h.source.boot();
    expect(h.agent('hermes:crypto')?.status).toBe('idle');
    h.execution('running', 500);
    h.poll();
    expect(h.agent('hermes:crypto')?.status).toBe('idle');
    h.advance(5_000);
    h.poll();
    expect(h.agent('hermes:crypto')?.status).toBe('working');
    expect(h.agent('hermes:crypto')?.title).toBe('Rotina: vigia-mercado');
    h.execs.prepare("UPDATE executions SET status = 'completed'").all();
    h.poll();
    expect(h.agent('hermes:crypto')?.status).toBe('idle');
  });

  it('mensagens recentes num turno aberto = working; resposta final = idle; clarify = waiting', () => {
    const h = setup();
    h.source.boot();
    h.session('20261022_180000_ab12cd', { source: 'cli' });
    h.message('20261022_180000_ab12cd', 'user', { content: 'Qual o saldo do mandato?' });
    h.poll();
    expect(h.agent('hermes:crypto')?.status).toBe('working');
    h.advance(WORKING_RECENT_MS + 1_000);
    h.poll();
    expect(h.agent('hermes:crypto')?.status).toBe('idle');
    h.message('20261022_180000_ab12cd', 'assistant', { calls: [['clarify', { question: 'Qual mandato?' }]], finish: 'tool_calls' });
    h.poll();
    expect(h.agent('hermes:crypto')).toMatchObject({ status: 'waiting', waitingFor: 'responder uma pergunta' });
    h.message('20261022_180000_ab12cd', 'tool', { content: 'o principal', toolName: 'clarify' });
    h.message('20261022_180000_ab12cd', 'assistant', { content: 'Saldo: 50 USDT', finish: 'stop' });
    h.poll();
    expect(h.agent('hermes:crypto')?.status).toBe('idle');
  });

  it('gateway parado = offline (batimento velho ou gateway_state.json); volta com o gateway', () => {
    const h = setup();
    h.source.boot();
    h.advance(HEARTBEAT_STALE_MS + 1_000);
    h.poll();
    expect(h.agent('hermes:crypto')?.status).toBe('offline');
    // finance tem gateway_state.json "running": o arquivo vale mais que o batimento
    expect(h.agent('hermes:finance')?.status).toBe('idle');
    writeFileSync(join(h.finance, 'gateway_state.json'), JSON.stringify({ gateway_state: 'stopped' }));
    h.advance(1_000);
    h.poll();
    expect(h.agent('hermes:finance')?.status).toBe('offline');
    h.beat();
    h.poll();
    expect(h.agent('hermes:crypto')?.status).toBe('idle');
    expect(h.agent('hermes:crypto')).toBeDefined();
  });
});

describe('fonte do Hermes: atividades', () => {
  it('rotina do cron: prompt, raciocínio, ferramentas do Kairo, erro e fim do turno', () => {
    const h = setup();
    h.source.boot();
    const sid = `cron_${JOB}_20261022_180000`;
    h.session(sid);
    h.message(sid, 'user', { content: '[IMPORTANT: You are running a scheduled cron job. DELIVERY: ...' });
    h.advance(2_000);
    h.message(sid, 'assistant', { reasoning: 'ler o estado', calls: [['mcp__kairo__kairo_estado', {}]], finish: 'tool_calls' });
    h.message(sid, 'tool', { content: '{"result": "{}"}', toolName: 'mcp__kairo__kairo_estado' });
    h.message(sid, 'assistant', { calls: [['tool_call', { name: 'mcp__kairo__kairo_backtest', arguments: { simbolo: 'UNIUSDT' } }]], finish: 'tool_calls' });
    h.message(sid, 'tool', { content: '{"error": "Recusado pelo Kairo"}', toolName: 'tool_call' });
    h.poll();
    const a = h.agent('hermes:crypto')!;
    expect(a.status).toBe('working');
    expect(a.recent.map((x) => `${x.kind}:${x.text}`)).toEqual([
      'prompt:Rotina: vigia-mercado',
      'think:Pensando…',
      'mcp:Consultando estado do mandato',
      'mcp:Rodando backtest de UNIUSDT',
      'error:Erro em tool_call',
    ]);
    h.advance(20_000);
    h.message(sid, 'assistant', { content: 'Nada a fazer agora.', finish: 'stop' });
    h.state.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').all((T0 + 22_000) / 1000, sid);
    h.poll();
    const end = h.agent('hermes:crypto')!;
    expect(end.status).toBe('idle');
    expect(end.recent.slice(-2).map((x) => x.kind)).toEqual(['respond', 'done']);
    expect(end.activity?.text).toBe('Concluiu em 22s');
  });

  it('cursor incremental: cada mensagem vira atividade uma vez só', () => {
    const h = setup();
    const sid = `cron_${JOB}_20261022_180000`;
    h.session(sid);
    for (let i = 0; i < 3; i++) h.message(sid, 'assistant', { calls: [['mcp__kairo__kairo_radar', {}]], finish: 'tool_calls' });
    h.source.boot();
    // o que já existia entra como histórico do boot
    expect(h.history('hermes:crypto')).toHaveLength(3);
    h.poll();
    h.poll();
    expect(h.history('hermes:crypto')).toHaveLength(3);
    h.message(sid, 'assistant', { calls: [['mcp__kairo__kairo_eventos', {}]], finish: 'tool_calls' });
    h.poll();
    h.poll();
    const hist = h.history('hermes:crypto');
    expect(hist).toHaveLength(4);
    expect(new Set(hist.map((x) => x.id)).size).toBe(4);
    expect(hist[3].text).toBe('Lendo os eventos do Kairo');
  });

  it('sessão filha aberta = subagente; terminou = entregou', () => {
    const h = setup();
    h.source.boot();
    h.session('pai', { source: 'cli' });
    h.session('filha', { source: 'subagent', parent: 'pai', title: 'Revisar o mandato' });
    h.message('filha', 'assistant', { calls: [['read_file', { path: '/opt/data/SOUL.md' }]], finish: 'tool_calls' });
    h.poll();
    const sub = h.agent('hermes:crypto:filha');
    expect(sub).toMatchObject({ kind: 'sub', parentId: 'hermes:crypto', role: 'Subagente (Hermes)', title: 'Revisar o mandato', status: 'working' });
    h.message('filha', 'assistant', { calls: [['web_search', { query: 'BTC' }]], finish: 'tool_calls' });
    h.poll();
    expect(h.agent('hermes:crypto:filha')?.recent.at(-1)?.kind).toBe('web');
    h.state.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').all(T0 / 1000 + 5, 'filha');
    h.poll();
    expect(h.agent('hermes:crypto:filha')?.status).toBe('done');
  });

  it('rotina que falhou (jobs.json) vira atividade de erro', () => {
    const h = setup();
    h.source.boot();
    writeFileSync(
      join(h.crypto, 'cron', 'jobs.json'),
      JSON.stringify({ jobs: [{ id: JOB, name: 'vigia-mercado', last_status: 'error', last_error: 'RuntimeError: Upstream error', last_run_at: '2026-10-22T18:05:00+00:00' }] }),
    );
    h.advance(1_000);
    h.poll();
    expect(h.agent('hermes:crypto')?.activity).toMatchObject({ kind: 'error', text: 'Rotina falhou: vigia-mercado', detail: 'RuntimeError: Upstream error' });
  });
});

describe('fonte do Hermes: banco ausente, ilegível e somente leitura', () => {
  it('state.db ilegível não derruba nada: o perfil fica, com o erro em sources()', () => {
    const h = setup();
    mkdirSync(join(h.root, 'profiles', 'quebrado'), { recursive: true });
    writeFileSync(join(h.root, 'profiles', 'quebrado', 'state.db'), 'isto não é um banco sqlite'.repeat(100));
    expect(() => h.source.boot()).not.toThrow();
    expect(h.agent('hermes:quebrado')?.status).toBe('idle');
    expect(h.source.sources()[0]).toMatchObject({ ok: false });
    expect(h.source.sources()[0].error).toMatch(/quebrado/);
  });

  it('diretório sem perfis: fonte ligada, sem salas, com o motivo', () => {
    const tmp = tempDir('habblaud-hermes-vazio-');
    cleanups.push(tmp.cleanup);
    const accounts = new AccountsService({ dirs: [], home: tmp.dir, env: {}, onChange: () => {} });
    const office = new Office({ names: new NameStore(null), version: 't', startedAt: 0, accounts: (s) => accounts.list(s), sources: () => [], accountName: () => undefined });
    const source = new HermesSource({ office, accounts, dir: join(tmp.dir, 'nao-existe'), sqlite });
    source.boot();
    source.stop();
    expect(office.commit().snapshot.agents).toEqual([]);
    expect(source.sources()[0]).toMatchObject({ ok: false, sessions: 0 });
  });

  it('start() liga o polling e stop() o desliga', () => {
    const h = setup();
    h.source.start();
    expect(h.agent('hermes:crypto')).toBeDefined();
    h.source.stop();
    expect((h.source as unknown as { timer: unknown }).timer).toBeNull();
  });

  it('ReadOnlyDb: lê o que está só no WAL, com arquivos somente leitura, sem criar nada na pasta', () => {
    const h = setup();
    h.session('s1', { source: 'cli' });
    h.message('s1', 'user', { content: 'oi' });
    const path = join(h.crypto, 'state.db');
    const files = () => readdirSync(h.crypto).sort();
    const before = files();
    expect(before).toEqual(expect.arrayContaining(['state.db', 'state.db-shm', 'state.db-wal']));
    for (const f of ['state.db', 'state.db-wal', 'state.db-shm']) chmodSync(join(h.crypto, f), 0o444);
    cleanups.push(() => {
      for (const f of ['state.db', 'state.db-wal', 'state.db-shm']) chmodSync(join(h.crypto, f), 0o644);
    });
    const count = (db: SqliteDatabase) => (db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n;
    for (const force of ['direct', 'snapshot'] as const) {
      const db = new ReadOnlyDb(path, sqlite, { force, tmpDir: join(h.root, '..', 'hermes-snap-test') });
      cleanups.push(() => db.close());
      expect(db.read(count)).toBe(1);
      expect(db.mode).toBe(force);
    }
    expect(files()).toEqual(before);
  });

  it('ReadOnlyDb: banco sem -wal (Hermes parado) é lido sem criar -wal/-shm; ausente = undefined', () => {
    const tmp = tempDir('habblaud-hermes-ro-');
    cleanups.push(tmp.cleanup);
    const path = join(tmp.dir, 'state.db');
    const w = new sqlite.DatabaseSync(path) as SqliteDatabase & { exec(sql: string): void };
    w.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x); INSERT INTO t VALUES (1), (2);');
    w.close();
    expect(readdirSync(tmp.dir)).toEqual(['state.db']);
    const db = new ReadOnlyDb(path, sqlite, { tmpDir: join(tmp.dir, '..', `${tmp.dir.split(/[\\/]/).pop()}-snap`) });
    cleanups.push(() => db.close());
    expect(db.read((d) => (d.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n)).toBe(2);
    // Node com URI no SQLite: immutable; sem (Node 22): a cópia
    expect(['immutable', 'snapshot']).toContain(db.mode);
    expect(readdirSync(tmp.dir)).toEqual(['state.db']);
    const missing = new ReadOnlyDb(join(tmp.dir, 'nada.db'), sqlite);
    expect(missing.read(() => 1)).toBeUndefined();
    expect(missing.error).toBe('ausente');
  });
});
