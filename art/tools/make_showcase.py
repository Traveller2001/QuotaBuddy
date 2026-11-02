#!/usr/bin/env python3
"""Renders docs/showcase.gif: both buddies in every mood, animated with the in-app frame timings."""
from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
MOODS = ["energetic", "relaxed", "tired", "anxious", "exhausted"]
LABELS = {
    "energetic": ("活力满满", "60%+"),
    "relaxed": ("悠闲", "35-60%"),
    "tired": ("有点累", "15-35%"),
    "anxious": ("焦虑", "3-15%"),
    "exhausted": ("累瘫了", "<3%"),
}
# keep in sync with src/renderer/common/sprites.ts
SEQUENCES = {
    "energetic": [(0, 190), (1, 140), (2, 220), (3, 170)],
    "relaxed": [(0, 800), (1, 700), (0, 800), (1, 700), (2, 150), (0, 600), (1, 700), (3, 1100)],
    "tired": [(0, 900), (1, 900), (2, 1300), (3, 900)],
    "anxious": [(0, 120), (1, 110), (2, 110), (1, 110), (2, 110), (3, 220)],
    "exhausted": [(0, 1000), (1, 900), (2, 900), (3, 1300)],
}
SCALE = 2
STEP_MS = 50
TOTAL_MS = 5550


def load(char: str):
    meta = json.loads((ROOT / "assets/sprites" / char / "sprite.json").read_text(encoding="utf-8"))
    frames = {}
    for mood in MOODS:
        strip = Image.open(ROOT / "assets/sprites" / char / f"{mood}.png").convert("RGBA")
        fw, fh = meta["frameWidth"], meta["frameHeight"]
        frames[mood] = [strip.crop((i * fw, 0, (i + 1) * fw, fh)).resize((fw * SCALE, fh * SCALE), Image.NEAREST) for i in range(4)]
    return meta, frames


def frame_at(mood: str, t: int) -> int:
    seq = SEQUENCES[mood]
    total = sum(d for _, d in seq)
    t %= total
    for idx, dur in seq:
        if t < dur:
            return idx
        t -= dur
    return seq[-1][0]


def main() -> None:
    chars = [("claude", *load("claude")), ("gpt", *load("gpt"))]
    cell_w = max(m["frameWidth"] for _, m, _ in chars) * SCALE + 18
    ground_h = max(m["groundY"] for _, m, _ in chars) * SCALE
    below = max(m["frameHeight"] - m["groundY"] for _, m, _ in chars) * SCALE
    row_h = ground_h + below + 10
    top = 62
    width = cell_w * len(MOODS) + 24
    height = top + row_h * len(chars) + 10
    font_path = ROOT / "assets/fonts/fusion-pixel-12px.woff2"
    try:
        font = ImageFont.truetype(str(font_path), 24)
        small = ImageFont.truetype(str(font_path), 12)
    except OSError:
        font = small = ImageFont.load_default()

    base = Image.new("RGBA", (width, height), (74, 92, 124, 255))
    d = ImageDraw.Draw(base)
    for i, mood in enumerate(MOODS):
        name, rng = LABELS[mood]
        x = 12 + i * cell_w + cell_w // 2
        d.text((x, 8), name, font=font, fill=(244, 241, 255), anchor="ma")
        d.text((x, 38), rng, font=small, fill=(214, 222, 240), anchor="ma")

    frames = []
    for t in range(0, TOTAL_MS, STEP_MS):
        img = base.copy()
        for r, (_, meta, sprite) in enumerate(chars):
            for i, mood in enumerate(MOODS):
                f = sprite[mood][frame_at(mood, t)]
                x = 12 + i * cell_w + (cell_w - f.width) // 2
                y = top + r * row_h + ground_h - meta["groundY"] * SCALE
                img.alpha_composite(f, (x, y))
        frames.append(img.convert("RGB").quantize(colors=96, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE))
    out = ROOT / "docs/showcase.gif"
    out.parent.mkdir(exist_ok=True)
    frames[0].save(out, save_all=True, append_images=frames[1:], duration=STEP_MS, loop=0, optimize=True, disposal=1)
    print(out, f"{len(frames)} frames", f"{out.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
