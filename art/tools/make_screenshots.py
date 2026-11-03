#!/usr/bin/env python3
"""Renders the README screenshots from real app captures (demo data, throwaway profile).

  docs/hero.png    title, the panel and the buddies on a desktop
  docs/meters.png  what the meter under a buddy shows for each "桌面额度" choice, calm and tight
  docs/panel.png   the panel when quota runs out, and its settings

Needs a build (npm run build). Every capture runs `electron . --demo=...` with QB_CAPTURE, so it
never touches the copy you are running or your real settings.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs"
FONT = ROOT / "assets/fonts/fusion-pixel-12px.woff2"

# captures are 2x (retina); the README shows the images at half width
INK = (244, 241, 255)
INK_DIM = (214, 210, 236)
GOLD = (255, 205, 102)
TOP, BOTTOM = (76, 92, 150), (196, 160, 196)

MODES = [("both", "5h + 7d（默认）"), ("5h", "5h 优先"), ("7d", "7d 优先"), ("auto", "最紧张")]
STATES = [("relaxed", "额度充足"), ("tired", "额度紧张")]


def font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONT), size)


def draw(img: Image.Image) -> ImageDraw.ImageDraw:
    d = ImageDraw.Draw(img)
    d.fontmode = "1"  # crisp pixel font, no antialiasing
    return d


def wallpaper(w: int, h: int) -> Image.Image:
    grad = Image.linear_gradient("L").resize((w, h))
    top = Image.new("RGBA", (w, h), TOP + (255,))
    bottom = Image.new("RGBA", (w, h), BOTTOM + (255,))
    return Image.composite(bottom, top, grad)


def shadowed(base: Image.Image, img: Image.Image, xy: tuple[int, int], blur: int = 18, offset: int = 10) -> None:
    """Pastes a window with a soft drop shadow, like a real one on the desktop."""
    alpha = img.getchannel("A").point(lambda a: 110 if a > 0 else 0)
    shadow = Image.new("RGBA", img.size, (20, 16, 40, 0))
    shadow.putalpha(alpha)
    pad = blur * 3
    layer = Image.new("RGBA", (img.width + pad * 2, img.height + pad * 2), (0, 0, 0, 0))
    layer.alpha_composite(shadow, (pad, pad))
    layer = layer.filter(ImageFilter.GaussianBlur(blur))
    base.alpha_composite(layer, (xy[0] - pad, xy[1] - pad + offset))
    base.alpha_composite(img, xy)


def crop(img: Image.Image, pad: int = 0) -> Image.Image:
    l, t, r, b = img.getchannel("A").getbbox()
    return img.crop((l - pad, t - pad, r + pad, b + pad))


def capture(out: Path, demo: str, settings: dict, **env: str) -> Path:
    out.mkdir(parents=True, exist_ok=True)
    full = {
        **os.environ,
        "QB_CAPTURE": str(out),
        "QB_CAPTURE_SETTINGS": json.dumps({"locale": "zh-CN", **settings}),
        **env,
    }
    electron = ROOT / "node_modules/.bin/electron"
    subprocess.run([str(electron), ".", f"--demo={demo}"], cwd=ROOT, env=full, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return out


def hero(main: Path) -> None:
    panel = Image.open(main / "panel.png").convert("RGBA")
    pets = crop(Image.open(main / "pet.png").convert("RGBA"), 4)
    m, gap = 88, 64
    w = m + max(pets.width, 760) + gap + panel.width + m
    h = m + panel.height + m
    img = wallpaper(w, h)
    d = draw(img)

    # title block, top left
    icon = Image.open(ROOT / "assets/icons/app-256.png").convert("RGBA").resize((144, 144), Image.NEAREST)
    img.alpha_composite(icon, (m, m + 8))
    d.text((m + 176, m + 14), "QuotaBuddy", font=font(72), fill=INK)
    d.text((m + 180, m + 104), "额度小伙伴", font=font(48), fill=GOLD)
    d.text((m, m + 200), "住在桌面角落的像素小伙伴，", font=font(36), fill=INK)
    d.text((m, m + 248), "用心情告诉你 AI 编程工具还剩多少额度。", font=font(36), fill=INK)
    chips = ["Claude Code · Codex", "自动识别本机配置", "5 种心情", "5h / 7d 恢复倒计时", "Sub2API 号池", "one-api / new-api", "Win · macOS · Linux"]
    x, y = m, m + 332
    for chip in chips:
        tw = int(d.textlength(chip, font=font(24)))
        if x + tw + 32 > m + max(pets.width, 760):
            x, y = m, y + 64
        d.rectangle((x, y, x + tw + 32, y + 46), fill=(28, 26, 40, 210), outline=(11, 10, 16), width=4)
        d.text((x + 16, y + 10), chip, font=font(24), fill=INK)
        x += tw + 32 + 16

    # the desktop: buddies bottom left, panel to their right
    shadowed(img, panel, (w - m - panel.width, m))
    img.alpha_composite(pets, (m + max(pets.width, 760) - pets.width, h - m - pets.height + 30))
    img.save(DOCS / "hero.png", optimize=True)


def meters(caps: dict[tuple[str, str], Path]) -> None:
    tiles = {k: crop(Image.open(p / "pet.png").convert("RGBA")) for k, p in caps.items()}
    cell_w = max(t.width for t in tiles.values()) + 56
    cell_h = max(t.height for t in tiles.values())
    label_w, head = 220, 96
    w = label_w + cell_w * len(MODES) + 40
    h = head + (cell_h + 56) * len(STATES) + 24
    img = wallpaper(w, h)
    d = draw(img)
    for c, (mode, title) in enumerate(MODES):
        x = label_w + c * cell_w + cell_w // 2
        d.text((x, 36), title, font=font(36), fill=GOLD if mode == "both" else INK, anchor="ma")
    for r, (state, title) in enumerate(STATES):
        y = head + r * (cell_h + 56)
        d.text((40, y + cell_h - 92), title, font=font(36), fill=INK)
        if r:
            d.line((40, y - 28, w - 40, y - 28), fill=(255, 255, 255, 90), width=2)
        for c, (mode, _) in enumerate(MODES):
            t = tiles[(state, mode)]
            img.alpha_composite(t, (label_w + c * cell_w + (cell_w - t.width) // 2, y + cell_h - t.height))
    img.save(DOCS / "meters.png", optimize=True)


def panels(main: Path, tight: Path) -> None:
    shots = [("额度见底时", Image.open(tight / "panel.png").convert("RGBA")), ("设置", Image.open(main / "panel-settings.png").convert("RGBA"))]
    m, gap, head = 72, 72, 96
    w = m * 2 + sum(s.width for _, s in shots) + gap
    h = head + max(s.height for _, s in shots) + m
    img = wallpaper(w, h)
    d = draw(img)
    x = m
    for title, shot in shots:
        d.text((x + shot.width // 2, 28), title, font=font(48), fill=INK, anchor="ma")
        shadowed(img, shot, (x, head))
        x += shot.width + gap
    img.save(DOCS / "panel.png", optimize=True)


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="qb-shots-") as tmp:
        base = Path(tmp)
        print("capturing desktop + panel")
        main_cap = capture(base / "main", "energetic,tired", {}, QB_CAPTURE_HOVER="codex", QB_CAPTURE_VIEWS="settings")
        print("capturing panel, quota running out")
        tight_cap = capture(base / "tight", "anxious,exhausted", {})
        caps = {}
        for state, _ in STATES:
            for mode, _ in MODES:
                print(f"capturing meter {state} / {mode}")
                caps[(state, mode)] = capture(base / f"{state}-{mode}", f"{state},{state}", {"hudMode": mode, "showCodex": False})
        hero(main_cap)
        meters(caps)
        panels(main_cap, tight_cap)
    for name in ["hero.png", "meters.png", "panel.png"]:
        p = DOCS / name
        print(p, Image.open(p).size, f"{p.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
