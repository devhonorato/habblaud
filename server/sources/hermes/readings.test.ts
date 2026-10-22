import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../../log';
import { tempDir } from '../../test/fixtures';
import { readingDiff, ReadingStore } from './readings';

setQuiet(true);

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 22, 18, 0, 0);
let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function store(days = 7) {
  const tmp = tempDir('habblaud-leituras-');
  cleanups.push(tmp.cleanup);
  let clock = T0;
  const dir = join(tmp.dir, 'hermes-leituras');
  const s = new ReadingStore({ dir, days, now: () => clock });
  return { s, dir, tmp, set: (ms: number) => (clock = ms) };
}

const rowsOf = (file: string) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { at: number; same?: boolean; lines?: string[] });

describe('ReadingStore', () => {
  it('grava por perfil/rotina/dia; conteúdo igual só com a hora; a mesma hora não entra de novo', () => {
    const { s, dir } = store();
    expect(s.record('crypto', 'job1', T0, ['a', 'b'])).toBe(true);
    expect(s.record('crypto', 'job1', T0 + 300_000, ['a', 'b'])).toBe(true);
    expect(s.record('crypto', 'job1', T0 + 300_000, ['a', 'b'])).toBe(false);
    expect(s.record('crypto', 'job1', T0 + 600_000, ['a', 'c'])).toBe(true);
    const rows = rowsOf(join(dir, 'crypto', 'job1', '2026-10-22.jsonl'));
    expect(rows.map((r) => [r.at, r.same ?? false, r.lines ?? null])).toEqual([
      [T0, false, ['a', 'b']],
      [T0 + 300_000, true, null],
      [T0 + 600_000, false, ['a', 'c']],
    ]);
    expect(s.list('crypto', 'job1').map((r) => r.lines.join('|'))).toEqual(['a|b', 'a|b', 'a|c']);
    expect(s.list('crypto', 'job1', T0 + 1, T0 + 300_000).map((r) => r.at)).toEqual([T0 + 300_000]);
  });

  it('dia novo começa com o conteúdo inteiro; depois de reiniciar, não repete a última', () => {
    const { s, dir } = store();
    s.record('crypto', 'job1', T0, ['a']);
    s.record('crypto', 'job1', T0 + DAY, ['a']);
    const [next] = rowsOf(join(dir, 'crypto', 'job1', '2026-10-23.jsonl'));
    expect(next).toMatchObject({ lines: ['a'] });
    expect(next.same).toBeUndefined();
    const again = new ReadingStore({ dir, days: 7, now: () => T0 + DAY });
    expect(again.record('crypto', 'job1', T0 + DAY, ['a'])).toBe(false);
    expect(again.record('crypto', 'job1', T0 + DAY + 60_000, ['a'])).toBe(true);
    expect(again.list('crypto', 'job1').at(-1)).toMatchObject({ same: true, lines: ['a'] });
  });

  it('retenção: apaga os dias mais velhos que o configurado e as pastas vazias', () => {
    const { s, dir, set } = store(2);
    s.record('crypto', 'job1', T0 - 3 * DAY, ['velha']);
    s.record('crypto', 'job1', T0 - DAY, ['ontem']);
    s.record('crypto', 'job1', T0, ['hoje']);
    s.record('finance', 'job2', T0 - 5 * DAY, ['só velha']);
    set(T0);
    expect(s.prune()).toBe(2);
    expect(readdirSync(join(dir, 'crypto', 'job1')).sort()).toEqual(['2026-10-21.jsonl', '2026-10-22.jsonl']);
    expect(existsSync(join(dir, 'finance'))).toBe(false);
    expect(s.list('crypto', 'job1').map((r) => r.lines[0])).toEqual(['ontem', 'hoje']);
  });

  it('desligada com 0 dias ou com a pasta dentro do diretório do Hermes; nomes inseguros não viram caminho', () => {
    const { s, tmp } = store(0);
    expect(s.enabled).toBe(false);
    expect(s.record('crypto', 'job1', T0, ['a'])).toBe(false);
    const hermes = join(tmp.dir, 'hermes');
    mkdirSync(hermes);
    const inside = new ReadingStore({ dir: join(hermes, 'leituras'), days: 7, hermesDir: hermes });
    expect(inside.enabled).toBe(false);
    expect(inside.record('crypto', 'job1', T0, ['a'])).toBe(false);
    expect(readdirSync(hermes)).toEqual([]);
    const ok = new ReadingStore({ dir: join(tmp.dir, 'fora'), days: 7, hermesDir: hermes });
    expect(ok.enabled).toBe(true);
    expect(ok.record('../x', 'job1', T0, ['a'])).toBe(false);
    expect(ok.record('crypto', '../../etc', T0, ['a'])).toBe(true);
    expect(readdirSync(join(tmp.dir, 'fora', 'crypto'))[0]).toMatch(/^job-[0-9a-f]{12}$/);
  });

  it('linhas estragadas no arquivo são puladas', () => {
    const { s, dir } = store();
    s.record('crypto', 'job1', T0, ['a']);
    const file = join(dir, 'crypto', 'job1', '2026-10-22.jsonl');
    writeFileSync(file, `${readFileSync(file, 'utf8')}{quebrado\n`);
    expect(s.list('crypto', 'job1')).toHaveLength(1);
  });
});

describe('readingDiff', () => {
  it('linhas que saíram (-) e que entraram (+)', () => {
    expect(readingDiff(['a', 'b'], ['b', 'c'])).toEqual(['-a', '+c']);
    expect(readingDiff(['a'], ['a'])).toEqual([]);
  });
});
