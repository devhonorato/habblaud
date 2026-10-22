import { describe, expect, it } from 'vitest';
import { TILE } from '../art/api';
import { layoutLounge, layoutReception, RECEPTION_ID, LOUNGE_ID } from './layout/core';
import { propAt } from './props';

describe('móveis clicáveis', () => {
  const areas = [layoutReception(), layoutLounge()];

  it('o balcão da recepção é o servidor; a TV do lounge é o mercado', () => {
    const desk = areas[0].furniture.find((f) => f.kind === 'reception_desk')!;
    expect(propAt(areas, (desk.tx + 1.5) * TILE, (desk.ty + 0.5) * TILE)).toEqual({ kind: 'server', areaId: RECEPTION_ID });
    const tv = areas[1].wallItems.find((w) => w.kind === 'tv')!;
    expect(propAt(areas, tv.cx, tv.baseY - TILE)).toEqual({ kind: 'tv', areaId: LOUNGE_ID });
    const clock = areas[0].wallItems.find((w) => w.kind === 'clock')!;
    expect(propAt(areas, clock.cx, clock.baseY - 4)?.kind).toBe('clock');
  });

  it('chão vazio não é móvel', () => {
    const r = areas[0].rect;
    expect(propAt(areas, (r.x + 7) * TILE, (r.y + 9) * TILE)).toBeNull();
  });
});
