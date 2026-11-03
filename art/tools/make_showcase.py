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
# mood colours and a typical remaining percentage, keep in sync with src/renderer/common/view.ts
COLORS = {
    "energetic": (79, 224, 122),
    "relaxed": (166, 224, 90),
    "tired": (242, 201, 76),
    "anxious": (255, 145, 66),
    "exhausted": (255, 90, 90),
}
LEVELS = {"energetic": 88, "relaxed": 48, "tired": 24, "anxious": 8, "exhausted": 0}
BG = (32, 30, 44, 255)
CARD = (42, 40, 58, 255)
EDGE = (11, 10, 16, 255)
SEGMENTS = 8
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
    top = 70
    meter_h = 34
    width = cell_w * len(MOODS) + 24
    height = top + row_h * len(chars) + meter_h + 22
    font_path = ROOT / "assets/fonts/fusion-pixel-12px.woff2"
    try:
        font = ImageFont.truetype(str(font_path), 24)
        small = ImageFont.truetype(str(font_path), 12)
        mid = ImageFont.truetype(str(font_path), 24)
    except OSError:
        font = small = mid = ImageFont.load_default()

    base = Image.new("RGBA", (width, height), BG)
    d = ImageDraw.Draw(base)
    d.fontmode = "1"
    for i, mood in enumerate(MOODS):
        name, rng = LABELS[mood]
        x0 = 12 + i * cell_w
        x = x0 + cell_w // 2
        # a card per mood: name in the mood colour, the remaining range, both buddies, a meter
        d.rectangle((x0 + 4, 4, x0 + cell_w - 4, height - 6), fill=CARD, outline=EDGE, width=2)
        d.text((x, 14), name, font=font, fill=COLORS[mood], anchor="ma")
        d.text((x, 44), f"剩余 {rng}", font=small, fill=(169, 166, 191), anchor="ma")
        my = height - meter_h - 4
        lit = 0 if LEVELS[mood] <= 0 else max(1, round(LEVELS[mood] / 100 * SEGMENTS))
        seg, gap = 8, 2
        mx = x - (SEGMENTS * (seg + gap) - gap) // 2 - 22
        for s in range(SEGMENTS):
            d.rectangle((mx + s * (seg + gap), my + 6, mx + s * (seg + gap) + seg - 1, my + 15), fill=COLORS[mood] if s < lit else (56, 54, 70))
        d.text((mx + SEGMENTS * (seg + gap) + 6, my + 1), f"{LEVELS[mood]}%", font=mid, fill=COLORS[mood])

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
