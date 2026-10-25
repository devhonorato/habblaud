"""Marca Atrio (fork do Habblaud): símbolo, placa da recepção, ícones e og-image em pixel art desenhada à mão.

Atrio é "o átrio do prédio onde os agentes trabalham": um prédio claro visto de frente, com uma torre central de
vidro verde-água (o átrio, com toldo listrado e porta de entrada no térreo), duas alas creme com janelas acesas em
amarelo e azul (agentes trabalhando), cornijas âmbar, antena com luz coral no alto e um vaso de planta na ala
esquerda. Contorno azul-marinho, como o escritório do jogo.

Os tamanhos pequenos (16, 32 e a placa 64x16) são desenhados pixel a pixel; os grandes são ampliações
NEAREST por inteiro dessas bases. A fonte bitmap é a de `pixelart.py`.

Mapas: O contorno marinho, F parede creme, f sombra da parede, A cornija âmbar, a sombra da cornija, K moldura das
janelas, Y/y janela acesa quente e sombra, B/b janela azul e sombra, T vidro do átrio, t montante e toldo, W brilho
do vidro, r luz da antena, R mastro, G/g folhas, p vaso. O mark da placa (11x11) não tem contorno porque a chapa já é
marinho. Os ícones de app põem o mark sobre o céu do jogo ao entardecer, com estrelas e chão; o logotipo da barra do
topo (WORDMARK_ROWS em client/src/ui/icons.ts) sai de `--wordmark`, e o FALLBACK_MARK de lá repete MARK_16.

Uso (a partir da raiz do projeto; requer Pillow e numpy):
    python3 -E scripts/assets/atrio.py              # grava assets/brand/**, og-image.png e a marca no manifest
    python3 -E scripts/assets/atrio.py --wordmark   # imprime WORDMARK_ROWS de client/src/ui/icons.ts
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

from PIL import Image

import pixelart as art
import pixelops as px

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
PUBLIC = ROOT / "client" / "public" / "assets"

NAME = "atrio"
NAME_HEAD, NAME_TAIL = "atr", "io"

NAVY = "#2b3550"
NAVY_DEEP = "#151c33"
CREAM = "#f4f1ea"
TEAL = "#2DD4BF"
TEAL_DARK = "#0F766E"
TEAL_LIGHT = "#99F6E4"
AMBER = "#fac665"

PALETTE: dict[str, str] = {
    "O": NAVY,
    "F": "#f4efe4",
    "f": "#d6cfc0",
    "A": AMBER,
    "a": "#c27a3a",
    "K": "#3a4566",
    "Y": "#ffd36b",
    "y": "#f2a93b",
    "B": "#7cc8ff",
    "b": "#3f8fd6",
    "T": TEAL,
    "t": TEAL_DARK,
    "W": TEAL_LIGHT,
    "r": "#ff8a5b",
    "R": "#b8c2d6",
    "G": "#67c53d",
    "g": "#198834",
    "p": "#b05b39",
}

MARK_32 = [
    "...............rr...............",
    "...............RR...............",
    "...............OO...............",
    "...........OOOOOOOOOO...........",
    ".....GG....OAAAAAAAAO...........",
    "....GGGG...OaaaaaaaaO...........",
    "...GgGGgG..OFFFFFFFfO...........",
    "....paap...OFTTWWTTfO...........",
    "....pppp...OFTWWTTTfO...........",
    ".OOOOOOOOOOOFWWTTTTfOOOOOOOOOOO.",
    ".OAAAAAAAAAOFWTTTTTfOAAAAAAAAAO.",
    ".OaaaaaaaaaOFTTTTTTfOaaaaaaaaaO.",
    ".OFFFFFFFFfOFttttttfOFFFFFFFFfO.",
    ".OFFFFFFFFfOFTTWWTTfOFFFFFFFFfO.",
    ".OFKKKKKKKfOFTWWTTTfOFKKKKKKKfO.",
    ".OFKYYKYYKfOFWWTTTTfOFKBBKYYKfO.",
    ".OFKYYKYYKfOFWTTTTTfOFKBBKYYKfO.",
    ".OFKyyKyyKfOFTTTTTTfOFKbbKyyKfO.",
    ".OFKKKKKKKfOFttttttfOFKKKKKKKfO.",
    ".OFFFFFFFFfOFTTWWTTfOFFFFFFFFfO.",
    ".OFFFFFFFFfOFTWWTTTfOFFFFFFFFfO.",
    ".OAAAAAAAAAOFWWTTTTfOAAAAAAAAAO.",
    ".OaaaaaaaaaOFWTTTTTfOaaaaaaaaaO.",
    ".OFFFFFFFFfOOOOOOOOOOFFFFFFFFfO.",
    ".OFKKKKKKKfOTWTWTWTWOFKKKKKKKfO.",
    ".OFKBBKYYKfOttttttttOFKYYKYYKfO.",
    ".OFKBBKYYKfOFOOOOOOfOFKYYKYYKfO.",
    ".OFKbbKyyKfOFOFttFOfOFKyyKyyKfO.",
    ".OFKKKKKKKfOFOWttWOfOFKKKKKKKfO.",
    ".OFFFFFFFFfOFOWttWOfOFFFFFFFFfO.",
    ".OFFFFFFFFfOFOWttWOfOFFFFFFFFfO.",
    ".OOOOOOOOOOOOOOOOOOOOOOOOOOOOOO.",
]

MARK_16 = [
    ".......rr.......",
    ".......OO.......",
    ".....OOOOOO.....",
    "..GG.OAAAAO.....",
    "..pp.OTWWTO.....",
    "OOOOOOWWTTOOOOOO",
    "OAAAAOWTTTOAAAAO",
    "OFFFFOttttOFFFFO",
    "OFYYFOTWTTOFBBFO",
    "OFyyFOWTTTOFbbFO",
    "OaaaaOttttOaaaaO",
    "OFFFFOFWWFOFFFFO",
    "OFBBFOFWWFOFYYFO",
    "OFbbFOFWWFOFyyFO",
    "OFFFFOFWWFOFFFFO",
    "OOOOOOOOOOOOOOOO",
]

SIGN_MARK = [
    ".....r.....",
    "...AAAAA...",
    "...WTTTT...",
    "AAAWWTTTAAA",
    "FYFTWTTTFBF",
    "FyFtttttFbF",
    "FFFTTWTTFFF",
    "FBFTWTTTFYF",
    "FbFtttttFyF",
    "FFFFWtWFFFF",
    "aaaaWtWaaaa",
]

SKY = ["#141a33", "#1b2244", "#232a55", "#2e3263", "#3d3a6e", "#523f78", "#6d4680", "#8f4f83", "#b45c7e", "#d97474", "#f3966a"]
GROUND, GROUND_TOP = "#1f2640", "#3a4566"
STAR, STAR_DIM = "#f4f1ea", "#8f9bc0"


def mark(size: int) -> Image.Image:
    if size == 32:
        return art.render_map(MARK_32, PALETTE)
    if size == 16:
        return art.render_map(MARK_16, PALETTE)
    raise ValueError(f"mark desenhado só existe em 16 e 32 px (pedido: {size})")


def _wordmark(img: Image.Image, x: int, y: int, shadow: str = NAVY_DEEP) -> None:
    tail_x = x + art.text_width(NAME_HEAD) + 1
    art.draw_text(img, x + 1, y + 1, NAME, shadow)
    art.draw_text(img, x, y, NAME_HEAD, CREAM)
    art.draw_text(img, tail_x, y, NAME_TAIL, TEAL)


def signage() -> Image.Image:
    w, h = 64, 16
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    p = img.load()
    outline, top, face, bottom = (art.hex_rgba(c) for c in ("#1c2541", "#3a4a70", "#2a3656", "#222b47"))
    for y in range(h):
        for x in range(w):
            if x in (0, w - 1) and y in (0, h - 1):
                continue
            if x in (0, w - 1) or y in (0, h - 1):
                p[x, y] = outline
            elif y == 1:
                p[x, y] = top
            elif y == h - 2:
                p[x, y] = bottom
            else:
                p[x, y] = face
    for sx in (3, w - 4):
        p[sx, 7] = art.hex_rgba("#c9d3e3")
        p[sx, 8] = art.hex_rgba("#7d8aa3")
    sym = art.render_map(SIGN_MARK, PALETTE)
    gap = 4
    x0 = (w - (sym.width + gap + art.text_width(NAME))) // 2
    img.alpha_composite(sym, (x0, 3))
    _wordmark(img, x0 + sym.width + gap, 5)
    return img


def wordmark_rows() -> list[str]:
    w, h = art.text_width(NAME) + 1, art.CAP_HEIGHT + 1
    grid = [["."] * w for _ in range(h)]
    head = len(NAME_HEAD)
    for offset in (1, 0):
        x = offset
        for i, letter in enumerate(NAME):
            glyph = art.FONT[letter]
            ch = "s" if offset else ("c" if i < head else "t")
            for gy in range(art.CAP_HEIGHT):
                for gx, bit in enumerate(glyph[gy]):
                    if bit == "#":
                        grid[gy + offset][x + gx] = ch
            x += len(glyph[0]) + 1
    return ["".join(r) for r in grid]


def sky(w: int, h: int, horizon: int, seed: int = 7) -> Image.Image:
    """Céu do jogo ao entardecer em faixas chapadas (sem degradê), estrelas no alto e chão a partir de `horizon`."""
    img = Image.new("RGBA", (w, h), art.hex_rgba(GROUND))
    p = img.load()
    for y in range(horizon):
        band = min(len(SKY) - 1, y * len(SKY) // horizon)
        color = art.hex_rgba(SKY[band])
        for x in range(w):
            p[x, y] = color
    for x in range(w):
        p[x, horizon] = art.hex_rgba(GROUND_TOP)
    rng = random.Random(seed)
    for _ in range(max(4, w * horizon // 600)):
        x, y = rng.randrange(w), rng.randrange(max(1, horizon * 5 // 11))
        p[x, y] = art.hex_rgba(STAR if rng.random() < 0.4 else STAR_DIM)
    return img


def app_icon(base: int, factor: int, mark_scale: int = 1) -> Image.Image:
    m = px.upscale(mark(32), mark_scale)
    ground = max(4, base // 10)
    scene = sky(base, base, base - ground)
    scene.alpha_composite(m, ((base - m.width) // 2, base - ground - m.height + mark_scale))
    return px.upscale(scene, factor)


def og_image() -> Image.Image:
    w, h = 600, 315
    horizon = h - 34
    og = sky(w, h, horizon, seed=11)
    m = px.upscale(mark(32), 6)
    mx, my = 56, horizon - m.height + 6
    og.alpha_composite(m, (mx, my))
    tx = mx + m.width + 44
    title = Image.new("RGBA", (art.text_width(NAME) + 1, art.CELL_HEIGHT + 1), (0, 0, 0, 0))
    _wordmark(title, 0, 0)
    ty = 56
    og.alpha_composite(px.upscale(title, 8), (tx, ty))
    lines = ["Seus agentes trabalhando,", "ao vivo, num prédio", "em pixel art."]
    for i, line in enumerate(lines):
        img = art.text_image(line, CREAM, 2, NAVY_DEEP)
        if tx + img.width > w - 12:
            raise ValueError(f"linha do og-image larga demais: {line!r}")
        og.alpha_composite(img, (tx, ty + 96 + i * 22))
    return px.upscale(og, 2).convert("RGB")


def build_brand(out_root: Path) -> dict:
    brand = out_root / "brand"
    brand.mkdir(parents=True, exist_ok=True)
    mark32, mark16, sign = mark(32), mark(16), signage()
    mark32.save(brand / "logo-mark.png")
    px.upscale(mark32, 4).save(brand / "logo-mark@4x.png")
    mark16.save(brand / "favicon-16.png")
    mark32.save(brand / "favicon-32.png")
    sign.save(brand / "signage.png")
    px.upscale(sign, 4).save(brand / "signage@4x.png")
    app_icon(45, 4).save(brand / "apple-touch-icon.png")
    app_icon(48, 4).save(brand / "icon-192.png")
    app_icon(128, 4, 3).save(brand / "icon-512.png")
  
    (brand / "logo-detailed.png").unlink(missing_ok=True)
    return {
        "mark": {"file": "brand/logo-mark.png", "w": 32, "h": 32},
        "markLarge": {"file": "brand/logo-mark@4x.png", "w": 128, "h": 128},
        "signage": {"file": "brand/signage.png", "w": sign.width, "h": sign.height},
        "signageLarge": {"file": "brand/signage@4x.png", "w": sign.width * 4, "h": sign.height * 4},
        "favicon16": "brand/favicon-16.png",
        "favicon32": "brand/favicon-32.png",
        "appleTouch": "brand/apple-touch-icon.png",
        "icon192": "brand/icon-192.png",
        "icon512": "brand/icon-512.png",
    }


def build_og(out_root: Path) -> str:
    og_image().save(out_root / "og-image.png", optimize=True)
    return "og-image.png"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default=str(PUBLIC), help="pasta de saída (padrão: client/public/assets)")
    parser.add_argument("--wordmark", action="store_true", help="só imprime as linhas do logotipo para icons.ts")
    args = parser.parse_args()
    if args.wordmark:
        for row in wordmark_rows():
            print(f"  '{row}',")
        return 0
    out_root = Path(args.out)
    out_root.mkdir(parents=True, exist_ok=True)
    brand = build_brand(out_root)
    og = build_og(out_root)
    manifest_path = out_root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {"version": 1}
    manifest["brand"], manifest["og"] = brand, og
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"marca Atrio -> {out_root / 'brand'} e {out_root / og}; manifest atualizado")
    return 0


if __name__ == "__main__":
    sys.exit(main())
