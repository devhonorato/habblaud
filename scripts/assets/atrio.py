"""Marca Atrio (fork do Habblaud): símbolo, placa da recepção, ícones e og-image em pixel art desenhada à mão.

Atrio é "o átrio do prédio onde os agentes trabalham": fachada vista de frente num quadrado arredondado
grafite, com a porta em arco verde-água no centro (o átrio) e quatro janelas acesas (agentes trabalhando).
Grafites neutros e uma única cor de destaque, sem degradê; marca irmã do Kairo (grafite e ouro).

Os tamanhos pequenos (16, 32 e a placa 64x16) são desenhados pixel a pixel; os grandes são ampliações
NEAREST por inteiro dessas bases. A fonte bitmap é a de `pixelart.py`.

Mapas: O contorno grafite, F fachada, h bisel do alto, K moldura das janelas, L cornija e degrau, l sombra
deles, W janela acesa e luz do átrio, T porta, t batente e divisão da porta. O mark da placa (11x11) não tem
contorno escuro porque a chapa já é grafite. O ícone de app é o mark sobre grafite chapado (#09090B, o do
Kairo), e o logotipo da barra do topo (WORDMARK_ROWS em client/src/ui/icons.ts) sai de `--wordmark`.

Uso (a partir da raiz do projeto; requer Pillow e numpy):
    python3 -E scripts/assets/atrio.py              # grava assets/brand/**, og-image.png e a marca no manifest
    python3 -E scripts/assets/atrio.py --wordmark   # imprime WORDMARK_ROWS de client/src/ui/icons.ts
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image

import pixelart as art
import pixelops as px

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
PUBLIC = ROOT / "client" / "public" / "assets"

NAME = "atrio"

GRAPHITE = "#18181B"
GRAPHITE_2 = "#27272A"
GRAPHITE_3 = "#3F3F46"
DEEP = "#09090B"
LIGHT = "#E4E4E7"
MUTED = "#71717A"
TEAL = "#2DD4BF"
TEAL_DARK = "#0F766E"
TEAL_LIGHT = "#99F6E4"

PALETTE: dict[str, str] = {
    "O": GRAPHITE,
    "F": GRAPHITE_2,
    "h": GRAPHITE_3,
    "K": GRAPHITE,
    "L": LIGHT,
    "l": MUTED,
    "W": TEAL_LIGHT,
    "T": TEAL,
    "t": TEAL_DARK,
}

MARK_32 = [
    "..OOOOOOOOOOOOOOOOOOOOOOOOOOOO..",
    ".OhhhhhhhhhhhhhhhhhhhhhhhhhhhhO.",
    "OFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFO",
    "OFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFO",
    "OFFLLLLLLLLLLLLLLLLLLLLLLLLLLFFO",
    "OFFllllllllllllllllllllllllllFFO",
    "OFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFO",
    "OFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFO",
    "OFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFO",
    "OFFFKKKKKKFFFFFFFFFFFFKKKKKKFFFO",
    "OFFFKWWWWKFFFttttttFFFKWWWWKFFFO",
    "OFFFKWWWWKFFttttttttFFKWWWWKFFFO",
    "OFFFKTTTTKFttTTTTTTttFKTTTTKFFFO",
    "OFFFKKKKKKFtTWWTTTTTtFKKKKKKFFFO",
    "OFFFFFFFFFFtTWWTTTTTtFFFFFFFFFFO",
    "OFFFFFFFFFFtTWTTTTTTtFFFFFFFFFFO",
    "OFFFFFFFFFFtTTTTTTTTtFFFFFFFFFFO",
    "OFFFKKKKKKFtTTTTTTTTtFKKKKKKFFFO",
    "OFFFKWWWWKFtTTTttTTTtFKWWWWKFFFO",
    "OFFFKWWWWKFtTTTttTTTtFKWWWWKFFFO",
    "OFFFKTTTTKFtTTTttTTTtFKTTTTKFFFO",
    "OFFFKKKKKKFtTTTttTTTtFKKKKKKFFFO",
    "OFFFFFFFFFFtTTTttTTTtFFFFFFFFFFO",
    "OFFFFFFFFFFtTTTttTTTtFFFFFFFFFFO",
    "OFFFFFFFFFFtTTTttTTTtFFFFFFFFFFO",
    "OFFFFFFFFFFtTTTttTTTtFFFFFFFFFFO",
    "OFFFFFFFFFFtTTTttTTTtFFFFFFFFFFO",
    "OFFFFFFFFFFtTTTttTTTtFFFFFFFFFFO",
    "OFFFFFFFLLLLLLLLLLLLLLLLFFFFFFFO",
    "OFFFFFFFllllllllllllllllFFFFFFFO",
    ".OFFFFFFFFFFFFFFFFFFFFFFFFFFFFO.",
    "..OOOOOOOOOOOOOOOOOOOOOOOOOOOO..",
]

MARK_16 = [
    ".OOOOOOOOOOOOOO.",
    "OhhhhhhhhhhhhhhO",
    "OFLLLLLLLLLLLLFO",
    "OFFFFFFFFFFFFFFO",
    "OFWWFFFFFFFFWWFO",
    "OFTTFFttttFFTTFO",
    "OFFFFtTTTTtFFFFO",
    "OFFFFtWTTTtFFFFO",
    "OFWWFtTTTTtFWWFO",
    "OFTTFtTTTTtFTTFO",
    "OFFFFtTTTTtFFFFO",
    "OFFFFtTTTTtFFFFO",
    "OFFFFtTTTTtFFFFO",
    "OFFFFtTTTTtFFFFO",
    "OFFFLLLLLLLLFFFO",
    ".OOOOOOOOOOOOOO.",
]

SIGN_MARK = [
    ".hhhhhhhhh.",
    "hLLLLLLLLLh",
    "hhhhhhhhhhh",
    "hWWhttthWWh",
    "hTTtTTTtTTh",
    "hhhtWTTthhh",
    "hWWtTTTtWWh",
    "hTTtTTTtTTh",
    "hhhtTTTthhh",
    "hhhtTTTthhh",
    ".hLLLLLLLh.",
]


def mark(size: int) -> Image.Image:
    if size == 32:
        return art.render_map(MARK_32, PALETTE)
    if size == 16:
        return art.render_map(MARK_16, PALETTE)
    raise ValueError(f"mark desenhado só existe em 16 e 32 px (pedido: {size})")


def _i_dot(x: int, y: int) -> tuple[int, int]:
    ix = x + art.text_width("atr") + 1
    return ix + art.FONT["i"][0].index("#"), y


def _wordmark(img: Image.Image, x: int, y: int) -> None:
    art.draw_text(img, x + 1, y + 1, NAME, DEEP)
    art.draw_text(img, x, y, NAME, LIGHT)
    img.putpixel(_i_dot(x, y), art.hex_rgba(TEAL))


def signage() -> Image.Image:
    w, h = 64, 16
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    p = img.load()
    outline, top, face, bottom = (art.hex_rgba(c) for c in (DEEP, GRAPHITE_2, GRAPHITE, "#111113"))
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
        p[sx, 7] = art.hex_rgba(MUTED)
        p[sx, 8] = art.hex_rgba(GRAPHITE_3)
    sym = art.render_map(SIGN_MARK, PALETTE)
    gap = 4
    x0 = (w - (sym.width + gap + art.text_width(NAME))) // 2
    img.alpha_composite(sym, (x0, 3))
    _wordmark(img, x0 + sym.width + gap, 6)
    return img


def wordmark_rows() -> list[str]:
    w, h = art.text_width(NAME) + 1, art.CAP_HEIGHT + 1
    grid = [["."] * w for _ in range(h)]
    for offset, ch in ((1, "s"), (0, "c")):
        x = offset
        for letter in NAME:
            glyph = art.FONT[letter]
            for gy in range(art.CAP_HEIGHT):
                for gx, bit in enumerate(glyph[gy]):
                    if bit == "#":
                        grid[gy + offset][x + gx] = ch
            x += len(glyph[0]) + 1
    ix, iy = _i_dot(0, 0)
    grid[iy][ix] = "t"
    return ["".join(r) for r in grid]


def app_icon(base: int, factor: int, mark_scale: int = 1) -> Image.Image:
    scene = Image.new("RGBA", (base, base), art.hex_rgba(DEEP))
    m = px.upscale(mark(32), mark_scale)
    scene.alpha_composite(m, ((base - m.width) // 2, (base - m.height) // 2))
    return px.upscale(scene, factor)


def og_image() -> Image.Image:
    w, h = 600, 315
    og = Image.new("RGBA", (w, h), art.hex_rgba(GRAPHITE))
    teal = art.hex_rgba(TEAL)
    for x in range(w):
        og.putpixel((x, h - 6), teal)
        og.putpixel((x, h - 5), teal)
    m = px.upscale(mark(32), 6)
    mx, my = 48, (h - m.height) // 2 - 4
    og.alpha_composite(m, (mx, my))
    tx = mx + m.width + 40
    title = Image.new("RGBA", (art.text_width(NAME) + 1, art.CELL_HEIGHT + 1), (0, 0, 0, 0))
    _wordmark(title, 0, 0)
    og.alpha_composite(px.upscale(title, 8), (tx, my + 8))
    lines = ["Seus agentes trabalhando,", "ao vivo, num prédio", "em pixel art."]
    for i, line in enumerate(lines):
        img = art.text_image(line, "#A1A1AA", 2)
        if tx + img.width > w - 12:
            raise ValueError(f"linha do og-image larga demais: {line!r}")
        og.alpha_composite(img, (tx, my + 100 + i * 22))
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
