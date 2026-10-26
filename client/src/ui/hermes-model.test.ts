import { describe, expect, it } from 'vitest';
import type { HermesPanel, HermesQuotas } from '../../../shared/hermes';
import { weatherKind } from '../../../shared/hermes';
import { callsByModel, fetchHermesPanel, formatBytes, formatTokens, formatUptime, levelOf, modelLabel, profileOfAgent, quotaSummary, relTime, systemLevel } from './hermes-model';

const Q: HermesQuotas = { day: '2026-10-22', calls: [], usage: [], limits: [], tokensToday: 0, runsToday: 0, logFound: false };
const NOW = Date.UTC(2026, 9, 22, 12);

describe('painel do Hermes (cliente)', () => {
  it('faixas do computador como no escritório antigo', () => {
    expect(levelOf(undefined, 70, 90)).toBeUndefined();
    expect(levelOf(69, 70, 90)).toBe('ok');
    expect(levelOf(70, 70, 90)).toBe('warn');
    expect(levelOf(95, 70, 90)).toBe('crit');
    expect(systemLevel({ cpuPct: 10, memPct: 80 })).toBe('warn');
    expect(systemLevel({ tempC: 90 })).toBe('crit');
    expect(systemLevel({})).toBe('ok');
  });

  it('formatos', () => {
    expect(formatUptime(90_000)).toBe('1 d 1 h');
    expect(formatUptime(3_700)).toBe('1 h 1 min');
    expect(formatUptime(undefined)).toBe('—');
    expect(formatBytes(1024 ** 3 * 2)).toMatch(/^2 GB$/);
    expect(formatTokens(2_500_000)).toMatch(/2[.,]5 mi/);
    expect(formatTokens(830)).toBe('830');
    expect(modelLabel('kairo')).toBe('OmniRoute (combo kairo)');
    expect(modelLabel('nvidia/nemotron:free')).toBe('nemotron');
    expect(relTime(NOW + 5 * 60_000, NOW)).toBe('em 5 min');
    expect(relTime(NOW - 2 * 3_600_000, NOW)).toBe('há 2 h 0 min');
    expect(weatherKind({ code: 61, day: true })).toBe('rain');
    expect(weatherKind({ code: 0, day: false })).toBe('night');
  });

  it('cotas: sem log usa o state.db; limite recente = vermelho', () => {
    const q: HermesQuotas = {
      ...Q,
      usage: [
        { profile: 'crypto', model: 'kairo', provider: 'custom', calls: 10, tokensIn: 100, tokensOut: 10 },
        { profile: 'crypto', model: 'kairo', provider: 'custom', task: 'title_generation', calls: 2, tokensIn: 5, tokensOut: 5 },
      ],
      limits: [{ at: NOW - 60_000, profile: 'crypto', model: 'kairo', text: '429' }],
    };
    expect(callsByModel(q)).toEqual([{ model: 'kairo', provider: 'custom', calls: 12, limits: 1, limitedAt: NOW - 60_000 }]);
    expect(quotaSummary(q, NOW)).toMatchObject({ calls: 12, tokens: 120, level: 'crit', limits: 1 });
    expect(quotaSummary({ ...q, limits: [] }, NOW)).toMatchObject({ level: 'ok', line: 'OmniRoute ativo' });
    expect(quotaSummary({ ...q, limits: [{ at: NOW - 5 * 3_600_000, profile: 'x', text: '429' }] }, NOW).level).toBe('warn');
  });

  it('perfil de um agente (principal ou Vigia) e a busca do painel', async () => {
    const panel = { profiles: [{ name: 'crypto', agentId: 'hermes:crypto', jobs: [{ id: 'j', vigiaId: 'hermes:crypto:vigia:j' }, { id: 'k', agentId: 'hermes:crypto:agente:k' }] }] } as unknown as HermesPanel;
    expect(profileOfAgent(panel, 'hermes:crypto:vigia:j')?.name).toBe('crypto');
    expect(profileOfAgent(panel, 'hermes:crypto:agente:k')?.name).toBe('crypto');
    expect(profileOfAgent(null, 'x')).toBeUndefined();
    const ok = (async () => ({ ok: true, json: async () => panel })) as unknown as typeof fetch;
    expect(await fetchHermesPanel(ok)).toBe(panel);
    const missing = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await fetchHermesPanel(missing)).toBeNull();
    const broken = (async () => {
      throw new Error('rede');
    }) as unknown as typeof fetch;
    expect(await fetchHermesPanel(broken)).toBeNull();
  });
});
