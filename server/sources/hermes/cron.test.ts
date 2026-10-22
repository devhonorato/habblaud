// Saídas do cron e leitura do monitor do Hermes (dados sintéticos).
import { describe, expect, it } from 'vitest';
import { describeMonitorLine, diffOf, marketEffect, outputTimeOf, parseCronOutput, parseMarket, stripCronPreamble, wakeReason } from './cron';

const PREAMBLE = '[IMPORTANT: You are running as a scheduled cron job. SILENT: respond with exactly "[SILENT]" (nothing else) to suppress delivery.]';

const NO_CHANGE = `# Cron Job: vigia-teste

**Job ID:** abc123def456
**Run Time:** 2026-10-22 19:00:26
**Mode:** monitor
**Status:** no_change (agent run suppressed)
`;

const CHANGED = `# Cron Job: vigia-teste

**Job ID:** abc123def456
**Run Time:** 2026-10-22 18:29:49
**Schedule:** every 5m

## Prompt

${PREAMBLE}

Algo mudou. Avalie.

## Run Context
## MONITOR CHANGE DETECTED

### Diff (previous → current)

\`\`\`diff
--- previous
+++ current
@@ -1,2 +1,2 @@
 mandato ativo=True disponivel~20 aberto~0.0 perda~0.0
-instancia AAAUSDT 1h status=ATIVA posicao=sim resultado~1.5%
+instancia AAAUSDT 1h status=ATIVA posicao=nao resultado~None%
\`\`\`

## Response

## Resumo

- Vendi AAA com lucro.
`;

describe('saídas do cron', () => {
  it('hora do nome do arquivo (UTC)', () => {
    expect(outputTimeOf('2026-10-22_18-29-49.md')).toBe(Date.UTC(2026, 9, 22, 18, 29, 49));
    expect(outputTimeOf('monitor_last_output.txt')).toBeUndefined();
  });

  it('checagem sem mudança', () => {
    expect(parseCronOutput(NO_CHANGE)).toEqual({ jobName: 'vigia-teste', jobId: 'abc123def456', noChange: true, silent: false });
  });

  it('rodada com o modelo: pedido sem o aviso, diferença e resposta', () => {
    const o = parseCronOutput(CHANGED);
    expect(o.noChange).toBe(false);
    expect(o.prompt).toBe('Algo mudou. Avalie.');
    expect(o.diff).toBe(' mandato ativo=True disponivel~20 aberto~0.0 perda~0.0\n-instancia AAAUSDT 1h status=ATIVA posicao=sim resultado~1.5%\n+instancia AAAUSDT 1h status=ATIVA posicao=nao resultado~None%');
    expect(o.response).toBe('## Resumo\n\n- Vendi AAA com lucro.');
    expect(o.silent).toBe(false);
  });

  it('[SILENT] = nada a relatar', () => {
    const o = parseCronOutput('# Cron Job: x\n\n## Prompt\n\nfaça\n\n## Response\n\n[SILENT]\n');
    expect(o.silent).toBe(true);
  });

  it('tira o aviso padrão do prompt (mesmo com [SILENT] dentro dele)', () => {
    expect(stripCronPreamble(`${PREAMBLE}\n\nRevise o mandato.`)).toBe('Revise o mandato.');
    expect(stripCronPreamble('Pedido normal')).toBe('Pedido normal');
  });

  it('diffOf ignora cabeçalhos do diff', () => {
    expect(diffOf('x\n```diff\n--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b\n```')).toBe('-a\n+b');
    expect(diffOf('sem diff')).toBeUndefined();
  });
});

const LINES = [
  'mandato ativo=True disponivel~31 aberto~0.0 perda~0.0',
  'instancia AAAUSDT 4h status=ATIVA posicao=sim resultado~2.5%',
  'instancia BBBUSDT 1h status=ATIVA posicao=nao resultado~None%',
  'radar CCCUSDT nota~90 1h',
  'evento 10 VENDA',
  'capital parado ha mais de 1h: procurar oportunidade',
];

describe('monitor do Kairo', () => {
  it('parseMarket: mandato, instâncias, radar, eventos e avisos', () => {
    const m = parseMarket(LINES)!;
    expect(m).toMatchObject({ online: true, active: true, available: '31', open: '0.0', loss: '0.0' });
    expect(m.instances).toEqual([
      { pair: 'AAAUSDT', interval: '4h', status: 'ATIVA', position: true, result: '2.5' },
      { pair: 'BBBUSDT', interval: '1h', status: 'ATIVA', position: false },
    ]);
    expect(m.radar).toEqual([{ pair: 'CCCUSDT', score: '90', interval: '1h' }]);
    expect(m.events).toEqual([{ id: '10', type: 'VENDA' }]);
    expect(m.warnings).toEqual(['capital parado ha mais de 1h: procurar oportunidade']);
  });

  it('parseMarket: Kairo fora do ar e linhas que não são do Kairo', () => {
    expect(parseMarket(['KAIRO fora do ar (timeout)'])).toMatchObject({ online: false });
    expect(parseMarket(['qualquer coisa'])).toBeUndefined();
    expect(parseMarket([])).toBeUndefined();
  });

  it('motivo do "chamou": a linha nova mais importante, em português', () => {
    expect(wakeReason('-instancia AAAUSDT 1h status=ATIVA posicao=sim resultado~1%\n+instancia AAAUSDT 1h status=ATIVA posicao=nao resultado~None%')).toBe('AAAUSDT 1h sem posição');
    expect(wakeReason('+radar X nota~80 1h\n+evento 5 VENDA')).toBe('evento VENDA (+1)');
    expect(wakeReason(undefined)).toBeUndefined();
    expect(describeMonitorLine('instancia AAAUSDT 1h status=ATIVA posicao=sim resultado~2%')).toBe('AAAUSDT 1h com posição (2%)');
    expect(describeMonitorLine('mandato ativo=False disponivel~1')).toBe('mandato desligado');
  });

  it('efeito: venda com lucro = festa; mandato desligado ou evento de risco = alarme', () => {
    const before = parseMarket(LINES)!;
    const sold = parseMarket(LINES.map((l) => l.replace('posicao=sim resultado~2.5%', 'posicao=nao resultado~None%')))!;
    expect(marketEffect(before, sold)).toEqual({ kind: 'party', text: 'Venda com lucro: AAAUSDT +2.5%' });
    const paused = parseMarket(LINES.map((l) => l.replace('ativo=True', 'ativo=False')))!;
    expect(marketEffect(before, paused)?.kind).toBe('alarm');
    const risk = parseMarket([...LINES, 'evento 11 PAUSA_RISCO'])!;
    expect(marketEffect(before, risk)).toEqual({ kind: 'alarm', text: 'Kairo: pausa risco' });
    expect(marketEffect(before, before)).toBeUndefined();
    // venda com prejuízo não é festa
    const loss = parseMarket(LINES.map((l) => l.replace('resultado~2.5%', 'resultado~-1%')))!;
    expect(marketEffect(loss, sold)).toBeUndefined();
  });
});
