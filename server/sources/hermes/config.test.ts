import { describe, expect, it } from 'vitest';
import { setQuiet } from '../../log';
import { hermesAgentNames, hermesReadingDays, hermesRoomNames } from './config';

setQuiet(true);

describe('HABBLAUD_HERMES_SALAS', () => {
  it('perfil=nome, com espaços e acentos; sem a variável, nada', () => {
    expect([...hermesRoomNames({ HABBLAUD_HERMES_SALAS: 'crypto=Kairo, finance = Finanças ;default=Geral' })]).toEqual([
      ['crypto', 'Kairo'],
      ['finance', 'Finanças'],
      ['default', 'Geral'],
    ]);
    expect(hermesRoomNames({}).size).toBe(0);
  });

  it('ignora perfil inválido, nome vazio e perfil repetido; corta o nome em 40', () => {
    const m = hermesRoomNames({ HABBLAUD_HERMES_SALAS: `../x=Y,crypto=,crypto=A,crypto=B,semigual,finance=${'x'.repeat(60)}` });
    expect(m.get('crypto')).toBe('A');
    expect(m.get('finance')).toHaveLength(40);
    expect(m.size).toBe(2);
  });
});

describe('HABBLAUD_HERMES_NOMES', () => {
  it('principal (perfil) e Vigia (perfil/rotina), com o visual opcional', () => {
    const m = hermesAgentNames({ HABBLAUD_HERMES_NOMES: 'crypto=Hermes,crypto/vigia-mercado=Sentinela:f,finance=Ana,finance/abc=Olho:M' });
    expect(m.get('crypto')).toEqual({ name: 'Hermes', look: 'm' });
    expect(m.get('crypto/vigia-mercado')).toEqual({ name: 'Sentinela', look: 'f' });
    // nome do pool: o visual dele
    expect(m.get('finance')).toEqual({ name: 'Ana', look: 'f' });
    expect(m.get('finance/abc')).toEqual({ name: 'Olho', look: 'm' });
  });

  it('nomes únicos: o repetido (sem diferenciar caixa) fica só no primeiro; chaves e nomes inválidos saem', () => {
    const m = hermesAgentNames({ HABBLAUD_HERMES_NOMES: `crypto=Hermes,finance=hermes,a/b/c=X,/x=Y,ok=${'n'.repeat(30)}` });
    expect([...m.keys()]).toEqual(['crypto']);
  });
});

describe('HABBLAUD_HERMES_LEITURAS_DIAS', () => {
  it('padrão 7, 0 desliga, inválido volta ao padrão, no máximo 365', () => {
    expect(hermesReadingDays({})).toBe(7);
    expect(hermesReadingDays({ HABBLAUD_HERMES_LEITURAS_DIAS: '0' })).toBe(0);
    expect(hermesReadingDays({ HABBLAUD_HERMES_LEITURAS_DIAS: '30' })).toBe(30);
    expect(hermesReadingDays({ HABBLAUD_HERMES_LEITURAS_DIAS: 'x' })).toBe(7);
    expect(hermesReadingDays({ HABBLAUD_HERMES_LEITURAS_DIAS: '9999' })).toBe(365);
  });
});
