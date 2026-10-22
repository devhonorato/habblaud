// GET /api/hermes/painel e o terminal de um agente com TerminalFeed (o caminho do Hermes, sem arquivo).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { HermesPanel } from '../../shared/hermes';
import { AccountsService } from '../accounts/service';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import type { TerminalFeed } from '../sources/source';
import { createApiHandler, type ApiDeps } from './app';
import { Hub } from './sse';
import { TerminalStreams } from './terminal';

setQuiet(true);

const PANEL: HermesPanel = {
  generatedAt: 1,
  system: { cpuPct: 10 },
  quotas: { day: '2026-10-22', calls: [], usage: [], limits: [], tokensToday: 5, runsToday: 1, logFound: false },
  profiles: [{ name: 'crypto', agentId: 'hermes:crypto', tokensToday: 5, runsToday: 1, jobs: [], monitors: [], outputs: [{ jobId: 'j', jobName: 'r', at: 1, kind: 'agent', text: 'resposta privada' }] }],
};

let stops: Array<() => void> = [];
afterEach(() => {
  for (const s of stops) s();
  stops = [];
});

async function start(extra: Partial<ApiDeps>, withTerminal: boolean) {
  const accounts = new AccountsService({ dirs: [], home: '/nada', env: {}, onChange: () => {} });
  const office = new Office({ names: new NameStore(null), version: 't', startedAt: Date.now(), accounts: (s) => accounts.list(s), sources: () => [], accountName: () => undefined });
  const hub = new Hub(office, { throttleMs: 10 });
  const feed: TerminalFeed = { load: () => ({ entries: [{ kind: 'user', id: 'u1', at: 1, text: 'Revise' }], truncated: false }), poll: () => [] };
  const terminals = withTerminal ? new TerminalStreams({ office, transcriptPathOf: () => undefined, feedFor: (id) => (id === 'hermes:crypto' ? feed : undefined), pollMs: 20 }) : undefined;
  office.addMain({ id: 'hermes:crypto', provider: 'hermes', account: 'hermes', sessionId: 'hermes-crypto', cwd: '/h/crypto', role: 'Agente Hermes', startedAt: Date.now(), status: 'idle' });
  const api = createApiHandler({ office, hub, accounts, sources: () => [], version: 't', inDocker: false, terminal: withTerminal, terminals, ...extra });
  const server = http.createServer((req, res) => {
    if (!api(req, res, new URL(req.url ?? '/', 'http://x'))) res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stops.push(() => {
    terminals?.stop();
    server.closeAllConnections();
    server.close();
  });
  return base;
}

describe('GET /api/hermes/painel', () => {
  it('sem a fonte do Hermes: 404', async () => {
    const base = await start({}, true);
    expect((await fetch(`${base}/api/hermes/painel`)).status).toBe(404);
  });

  it('com o terminal: o painel inteiro; sem ele, as respostas das rotinas ficam de fora', async () => {
    const open = await start({ hermesPanel: () => PANEL }, true);
    const full = (await (await fetch(`${open}/api/hermes/painel`)).json()) as HermesPanel;
    expect(full.profiles[0].outputs[0].text).toBe('resposta privada');
    const closed = await start({ hermesPanel: () => PANEL }, false);
    const res = await fetch(`${closed}/api/hermes/painel`);
    expect(res.status).toBe(200);
    const lean = (await res.json()) as HermesPanel;
    expect(lean.profiles[0].outputs[0]).toEqual({ jobId: 'j', jobName: 'r', at: 1, kind: 'agent' });
    expect((await fetch(`${open}/api/hermes/painel`, { method: 'POST' })).status).toBe(405);
  });

  it('terminal de um agente com TerminalFeed: init vem do feed, sem transcript', async () => {
    const base = await start({}, true);
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/agents/${encodeURIComponent('hermes:crypto')}/terminal`, { signal: ctrl.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes('event: init')) text += new TextDecoder().decode((await reader.read()).value);
    while (!text.includes('Revise')) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain('"agentId":"hermes:crypto"');
    ctrl.abort();
  });
});
