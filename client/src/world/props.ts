// Móveis que respondem ao clique (código puro, testado em props.test.ts): o computador da recepção (o servidor onde
// os agentes rodam), a TV do lounge (o painel do mercado), o quadro branco de uma sala (a equipe dela), as janelas (o
// tempo lá fora) e os relógios. Quem decide o que cada um abre é a interface (WorldApi.setPropHandler).
import { FURNITURE, TILE, type FurnitureKind } from '../art/api';
import type { AreaLayout } from './layout/types';

export type PropKind = 'server' | 'tv' | 'whiteboard' | 'window' | 'clock';

export interface PropHit {
  kind: PropKind;
  /** Área (sala de projeto ou do núcleo) onde fica o móvel. */
  areaId: string;
}

const FLOOR_PROPS: Partial<Record<FurnitureKind, PropKind>> = { reception_desk: 'server' };
const WALL_PROPS: Partial<Record<FurnitureKind, PropKind>> = { tv: 'tv', whiteboard: 'whiteboard', window: 'window', clock: 'clock' };
/** Altura (px) acima do rodapé que conta como o item de parede. */
const WALL_REACH = 2 * TILE;

/** Móvel clicável em (wx, wy) px de mundo, ou null. As áreas da frente (desenhadas depois) ganham. */
export function propAt(areas: readonly AreaLayout[], wx: number, wy: number): PropHit | null {
  for (let i = areas.length - 1; i >= 0; i--) {
    const a = areas[i];
    for (const f of a.furniture) {
      const kind = FLOOR_PROPS[f.kind];
      if (!kind) continue;
      const { w, h } = FURNITURE[f.kind].footprint;
      const x0 = f.tx * TILE + (f.dx ?? 0);
      // O desenho sobe um tile acima do footprint (o tampo e o monitor).
      if (wx >= x0 && wx < x0 + w * TILE && wy >= (f.ty - 1) * TILE && wy < (f.ty + h) * TILE) return { kind, areaId: a.id };
    }
    for (const it of a.wallItems) {
      const kind = WALL_PROPS[it.kind];
      if (!kind || it.on !== 'face') continue;
      const half = (FURNITURE[it.kind].footprint.w * TILE) / 2;
      if (wx >= it.cx - half && wx < it.cx + half && wy >= it.baseY - WALL_REACH && wy < it.baseY) return { kind, areaId: a.id };
    }
  }
  return null;
}
