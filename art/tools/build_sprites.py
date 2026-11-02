#!/usr/bin/env python3
"""Rebuilds every sprite strip and icon from the raw generated sheets.

The art-pixel size of each sheet is pinned here: auto-detection works on most sheets but can lock
onto a harmonic on very regular patterns (e.g. the black-and-white knot), so the shipped
parameters are explicit and reproducible.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ROWS = "energetic,relaxed,tired,anxious,exhausted"

# Both characters are sampled with the same step (source px per sprite pixel) so they share one
# pixel density and roughly the same on-screen size. The GPT sheet draws thin facial lines, which a
# coarser step would lose.
STEP = 3.5
SHEETS = [
    # (raw sheet, sprite folder, art pixel size in source px, extra args)
    ("art/raw/clawd_sheet_v1.png", "claude", 9.2, []),
    ("art/raw/gpt_sheet_black.png", "gpt", 10.5, ["--despill", "1", "--merge", "60"]),
]


def main() -> None:
    for raw, char, pixel, extra in SHEETS:
        cmd = [sys.executable, "art/tools/pixelize.py", raw, "--char", char, "--cols", "4", "--rows", ROWS,
               "--pixel", str(pixel), "--step", str(STEP), "--scale", "3", *extra]
        print("$", " ".join(cmd))
        subprocess.run(cmd, cwd=ROOT, check=True)
    subprocess.run([sys.executable, "art/tools/make_icons.py"], cwd=ROOT, check=True)


if __name__ == "__main__":
    main()
