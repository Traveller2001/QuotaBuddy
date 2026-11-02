#!/usr/bin/env python3
"""Builds tray icons and the app icon from the sprites.

  assets/icons/tray.png, tray@2x.png               coloured tray icon (Windows / Linux)
  assets/icons/trayTemplate.png, trayTemplate@2x.png  macOS menu bar template (black + alpha)
  build/icon.png                                    1024x1024 app icon (electron-builder makes .ico/.icns)
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]

# Clawd as drawn by the Claude Code welcome banner, one char = one pixel.
CLAWD = [
    "..############..",
    "..############..",
    "..##E######E##..",
    "..##E######E##..",
    "################",
    "################",
    "..############..",
    "..############..",
    "...#.#....#.#...",
    "...#.#....#.#...",
]
ORANGE = (217, 119, 87, 255)
EYE = (43, 26, 20, 255)


def clawd_icon(size: int, template: bool) -> Image.Image:
    unit = size // 16
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    top = (16 - len(CLAWD)) // 2 * unit
    for y, row in enumerate(CLAWD):
        for x, ch in enumerate(row):
            if ch == ".":
                continue
            if template:
                if ch == "E":
                    continue  # eyes are holes in the template silhouette
                colour = (0, 0, 0, 255)
            else:
                colour = EYE if ch == "E" else ORANGE
            img.paste(colour, (x * unit, top + y * unit, (x + 1) * unit, top + (y + 1) * unit))
    return img


def first_frame(char: str, mood: str) -> Image.Image:
    import json

    meta = json.loads((ROOT / "assets/sprites" / char / "sprite.json").read_text(encoding="utf-8"))
    strip = Image.open(ROOT / "assets/sprites" / char / f"{mood}.png").convert("RGBA")
    return strip.crop((0, 0, meta["frameWidth"], meta["frameHeight"])), meta


def app_icon() -> Image.Image:
    size = 1024
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # stepped-corner pixel tile
    step, pad = 32, 40
    bg, edge = (36, 34, 52, 255), (14, 13, 19, 255)
    for inset, colour in ((0, edge), (16, bg)):
        x0, y0, x1, y1 = pad + inset, pad + inset, size - pad - inset, size - pad - inset
        d.rectangle([x0 + step, y0, x1 - step, y1], fill=colour)
        d.rectangle([x0, y0 + step, x1, y1 - step], fill=colour)
        d.rectangle([x0 + step // 2, y0 + step // 2, x1 - step // 2, y1 - step // 2], fill=colour)
    claude, mc = first_frame("claude", "energetic")
    gpt, mg = first_frame("gpt", "energetic")
    scale = max(1, 860 // (claude.width + gpt.width))
    ground = 572
    cw, gw = claude.width * scale, gpt.width * scale
    gap = -6 * scale
    total = cw + gw + gap
    x = (size - total) // 2
    big_c = claude.resize((cw, claude.height * scale), Image.NEAREST)
    big_g = gpt.resize((gw, gpt.height * scale), Image.NEAREST)
    img.alpha_composite(big_c, (x, ground - mc["groundY"] * scale))
    img.alpha_composite(big_g, (x + cw + gap, ground - mg["groundY"] * scale))
    # quota meter
    seg_w, seg_h, seg_gap, n = 56, 48, 12, 10
    mx = (size - (n * seg_w + (n - 1) * seg_gap)) // 2
    my = 652
    d.rectangle([mx - 20, my - 20, mx + n * seg_w + (n - 1) * seg_gap + 19, my + seg_h + 19], fill=edge)
    for i in range(n):
        colour = (79, 224, 122, 255) if i < 8 else (58, 56, 72, 255)
        sx = mx + i * (seg_w + seg_gap)
        d.rectangle([sx, my, sx + seg_w - 1, my + seg_h - 1], fill=colour)
    return img


def main() -> None:
    icons = ROOT / "assets/icons"
    icons.mkdir(parents=True, exist_ok=True)
    clawd_icon(16, False).save(icons / "tray.png")
    clawd_icon(32, False).save(icons / "tray@2x.png")
    clawd_icon(16, True).save(icons / "trayTemplate.png")
    clawd_icon(32, True).save(icons / "trayTemplate@2x.png")
    build = ROOT / "build"
    build.mkdir(exist_ok=True)
    icon = app_icon()
    icon.save(build / "icon.png")
    icon.resize((256, 256), Image.NEAREST).save(icons / "app-256.png")
    print("icons written to", icons, "and", build / "icon.png")


if __name__ == "__main__":
    main()
