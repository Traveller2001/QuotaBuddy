#!/usr/bin/env python3
"""Turn an AI-generated "pixel art" sprite sheet into clean, crisp sprites.

Image models draw pixel art as soft, not-quite-uniform blocks on a flat background. This tool:
  1. keys out the background (existing alpha, or a flat colour auto-detected from the border),
  2. splits the sheet into rows x cols frames using the empty gaps between them,
  3. estimates the sheet's art-pixel size from colour edges, then samples every frame on a grid of
     (art pixel / subdiv) with a per-frame phase, taking a majority vote per cell. Oversampling
     (subdiv 2) keeps the slightly uneven blocks image models draw from collapsing or doubling,
  4. snaps all frames to one shared palette built by colour distance (rare accents such as
     sweat drops or sparkles keep their own colour instead of being averaged away),
  5. aligns frames on a shared canvas (body centred, ground line preserved so jumps stay jumps),
  6. writes one horizontal strip per row + sprite.json + an upscaled preview.

Example:
  python art/tools/pixelize.py art/raw/clawd_sheet_v1.png --char claude --cols 4 \
      --rows energetic,relaxed,tired,anxious,exhausted
"""
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage


# ----------------------------------------------------------------------------- background


def detect_background(rgb: np.ndarray) -> np.ndarray:
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]]).astype(np.int32)
    keys = (border // 16) @ np.array([256, 16, 1])
    mode = np.bincount(keys).argmax()
    return border[keys == mode].mean(axis=0)


def foreground_mask(img: np.ndarray, threshold: float, alpha_min: int) -> tuple[np.ndarray, np.ndarray | None]:
    rgb = img[..., :3].astype(np.float32)
    alpha = img[..., 3]
    bg = None
    if (alpha < 128).mean() > 0.2:  # the image already carries transparency
        mask = alpha >= alpha_min
    else:
        bg = detect_background(img[..., :3])
        mask = np.linalg.norm(rgb - bg, axis=2) > threshold
    labels, n = ndimage.label(mask)  # drop isolated specks of compression noise
    if n:
        sizes = ndimage.sum(mask, labels, index=np.arange(1, n + 1))
        keep = np.zeros(n + 1, bool)
        keep[1:] = sizes >= 12
        mask = keep[labels]
    return mask, bg


# ----------------------------------------------------------------------------- layout


def occupied_runs(profile: np.ndarray) -> list[list[int]]:
    runs, start = [], None
    for i, on in enumerate(profile):
        if on and start is None:
            start = i
        elif not on and start is not None:
            runs.append([start, i])
            start = None
    if start is not None:
        runs.append([start, len(profile)])
    return runs


def split_into(profile: np.ndarray, n: int) -> list[tuple[int, int]]:
    """Split an occupancy profile into n bands by repeatedly merging the closest runs."""
    runs = occupied_runs(profile)
    if len(runs) < n:
        raise ValueError(f"expected {n} bands but found only {len(runs)} separated runs")
    while len(runs) > n:
        gaps = [runs[i + 1][0] - runs[i][1] for i in range(len(runs) - 1)]
        i = int(np.argmin(gaps))
        runs[i] = [runs[i][0], runs[i + 1][1]]
        del runs[i + 1]
    return [(a, b) for a, b in runs]


# ----------------------------------------------------------------------------- grid


def edge_positions(rgb: np.ndarray, mask: np.ndarray, axis: int) -> np.ndarray:
    a = rgb.astype(np.int32)
    if axis == 1:
        diff = np.abs(a[:, 1:] - a[:, :-1]).sum(axis=2)
        involved = mask[:, 1:] | mask[:, :-1]
        _, xs = np.nonzero((diff > 60) & involved)
        return (xs + 1).astype(np.float64)
    diff = np.abs(a[1:] - a[:-1]).sum(axis=2)
    involved = mask[1:] | mask[:-1]
    ys, _ = np.nonzero((diff > 60) & involved)
    return (ys + 1).astype(np.float64)


def coherence(pos: np.ndarray, periods: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    if len(pos) > 6000:
        pos = np.random.default_rng(0).choice(pos, 6000, replace=False)
    z = np.exp(2j * np.pi * pos[None, :] / periods[:, None]).mean(axis=1)
    return np.abs(z), np.angle(z)


def frame_period(rgb: np.ndarray, mask: np.ndarray, pmin: float, pmax: float) -> float | None:
    xs, ys = edge_positions(rgb, mask, 1), edge_positions(rgb, mask, 0)
    if len(xs) < 20 or len(ys) < 20:
        return None
    periods = np.arange(pmin, pmax, 0.05)
    score = (coherence(xs, periods)[0] + coherence(ys, periods)[0]) / 2
    strong = np.nonzero(score >= 0.8 * score.max())[0]  # P, P/2, P/3... all score; keep the largest
    best = strong[-1]
    lo, hi = max(best - 20, 0), min(best + 20, len(periods))
    return float(periods[lo + int(np.argmax(score[lo:hi]))])


def frame_phase(rgb: np.ndarray, mask: np.ndarray, step: float) -> tuple[float, float]:
    xs, ys = edge_positions(rgb, mask, 1), edge_positions(rgb, mask, 0)
    _, ax = coherence(xs, np.array([step]))
    _, ay = coherence(ys, np.array([step]))
    return (ax[0] / (2 * np.pi)) * step % step, (ay[0] / (2 * np.pi)) * step % step


def sample_frame(rgb: np.ndarray, mask: np.ndarray, step: float, ox: float, oy: float, despill: int = 2):
    """Majority-vote one colour per grid cell. Returns (RGBA array, x0, y0 in crop px).

    Occupancy comes from the full mask, colour only from "core" pixels at least `despill` px away
    from the background, so anti-aliased fringes (outline blended into the key colour) never win.
    """
    h, w = mask.shape
    core = mask & ~ndimage.binary_dilation(~mask, iterations=despill) if despill > 0 else mask
    x0 = ox - step * np.ceil(ox / step)
    y0 = oy - step * np.ceil(oy / step)
    nx = int(np.ceil((w - x0) / step))
    ny = int(np.ceil((h - y0) / step))
    out = np.zeros((ny, nx, 4), np.uint8)
    inner = 0.2
    for j in range(ny):
        ya = max(int(round(y0 + (j + inner) * step)), 0)
        yb = min(int(round(y0 + (j + 1 - inner) * step)), h)
        if yb <= ya:
            continue
        for i in range(nx):
            xa = max(int(round(x0 + (i + inner) * step)), 0)
            xb = min(int(round(x0 + (i + 1 - inner) * step)), w)
            if xb <= xa:
                continue
            m = mask[ya:yb, xa:xb]
            if m.mean() < 0.5:
                continue
            c = core[ya:yb, xa:xb]
            if not c.any():  # the cell is pure anti-aliased fringe: treat it as background
                continue
            cols = rgb[ya:yb, xa:xb][c].astype(np.int32)
            keys = (cols // 24) @ np.array([4096, 64, 1])
            mode = np.bincount(keys).argmax()
            out[j, i, :3] = cols[keys == mode].mean(axis=0).round().astype(np.uint8)
            out[j, i, 3] = 255
    return out, x0, y0


# ----------------------------------------------------------------------------- palette


def build_palette(frames: list[np.ndarray], merge_dist: float) -> tuple[np.ndarray, np.ndarray]:
    """Greedy colour clustering by distance, most frequent first, so rare accents survive."""
    opaque = np.concatenate([f[f[..., 3] > 0][:, :3] for f in frames]).astype(np.float64)
    keys = (opaque.astype(np.int32) // 8) @ np.array([1024, 32, 1])
    uniq, inverse, counts = np.unique(keys, return_inverse=True, return_counts=True)
    means = np.zeros((len(uniq), 3))
    np.add.at(means, inverse, opaque)
    means /= counts[:, None]
    order = np.argsort(-counts)
    centers: list[np.ndarray] = []
    weights: list[float] = []
    for idx in order:
        c, n = means[idx], counts[idx]
        if centers:
            d = np.linalg.norm(np.array(centers) - c, axis=1)
            k = int(d.argmin())
            if d[k] < merge_dist:
                total = weights[k] + n
                centers[k] = (centers[k] * weights[k] + c * n) / total
                weights[k] = total
                continue
        centers.append(c.copy())
        weights.append(float(n))
    return np.array(centers), np.array(weights)


TRANSPARENT = -1


def resolve_palette(centers: np.ndarray, weights: np.ndarray, bg: np.ndarray | None,
                    rare: float, min_cells: int) -> tuple[np.ndarray, np.ndarray]:
    """Map every clustered colour to a kept palette index, or TRANSPARENT.

    A rare colour that is (almost exactly) a mix of the key colour and a more common colour may be
    fringe left by the image model: on the silhouette edge, mostly-key mixes become transparent and
    the rest fold into the common colour. The same colour *inside* the body is design (pink blush
    is literally "white mixed with magenta"), so interior cells keep it.

    Returns (edge_target, interior_target).
    """
    total = weights.sum()
    order = np.argsort(-weights)
    target = np.arange(len(centers))
    interior = np.arange(len(centers))
    kept: list[int] = []
    for i in order:
        c = centers[i]
        if weights[i] < min_cells:
            target[i] = kept[int(np.linalg.norm(centers[kept] - c, axis=1).argmin())] if kept else TRANSPARENT
            interior[i] = target[i]
            continue
        if bg is not None and weights[i] < rare * total and kept:
            best = None
            for j in kept:
                p = centers[j]
                d = bg - p
                a = float(np.clip(np.dot(c - p, d) / max(np.dot(d, d), 1e-6), 0, 1))
                resid = float(np.linalg.norm(c - (p + a * d)))
                if a >= 0.15 and resid < 28 and (best is None or resid < best[0]):
                    best = (resid, a, j)
            if best:
                target[i] = TRANSPARENT if best[1] >= 0.5 else best[2]
                continue  # interior[i] stays i: kept for cells inside the body
        kept.append(int(i))
    return target, interior


def key_blend(c: np.ndarray, palette_idx: list[int], centers: np.ndarray, bg: np.ndarray) -> tuple[float, int] | None:
    """If colour c is (almost) a mix of the key colour and a palette colour, return (key share, index)."""
    best = None
    for j in palette_idx:
        p = centers[j]
        d = bg - p
        a = float(np.clip(np.dot(c - p, d) / max(np.dot(d, d), 1e-6), 0, 1))
        resid = float(np.linalg.norm(c - (p + a * d)))
        if a >= 0.2 and resid < 28 and (best is None or resid < best[0]):
            best = (resid, a, j)
    return (best[1], best[2]) if best else None


def snap(frame: np.ndarray, centers: np.ndarray, target: np.ndarray, interior: np.ndarray,
         bg: np.ndarray | None = None) -> np.ndarray:
    """Snap every cell to the palette; peel key-colour fringe off the silhouette."""
    import colorsys

    out = frame.copy()
    h, w = out.shape[:2]
    m = out[..., 3] > 0
    ys, xs = np.nonzero(m)
    cols = out[m][:, :3].astype(np.float64)
    nearest = ((cols[:, None, :] - centers[None, :, :]) ** 2).sum(axis=2).argmin(axis=1)
    kept = sorted(set(int(t) for t in np.concatenate([target, interior]) if t != TRANSPARENT))
    key_hue = None
    if bg is not None:
        bh, bs, _ = colorsys.rgb_to_hsv(*(bg / 255.0))
        key_hue = bh if bs > 0.5 else None

    def fringe(k: int) -> int | None:
        """New mapping for silhouette cell k if it is fringe, else None."""
        if bg is None:
            return None
        if key_hue is not None:
            hh, sat, _ = colorsys.rgb_to_hsv(*(cols[k] / 255.0))
            if sat > 0.2 and min(abs(hh - key_hue), 1 - abs(hh - key_hue)) < 0.07:
                return TRANSPARENT
        blend = key_blend(cols[k], kept, centers, bg)
        if blend:
            return TRANSPARENT if blend[0] >= 0.5 else blend[1]
        return None

    mapped = interior[nearest].copy()
    grid = np.full((h, w), -2, np.int64)  # -2 = empty
    grid[ys, xs] = np.arange(len(ys))
    for _ in range(4):  # fringe can be several cells thick: peel until stable
        solid = np.zeros((h, w), bool)
        solid[ys, xs] = mapped != TRANSPARENT
        edge = ndimage.binary_dilation(~solid, structure=np.ones((3, 3))) & solid
        changed = False
        for y, x in zip(*np.nonzero(edge)):
            k = grid[y, x]
            new_map = fringe(k)
            if new_map is None:
                new_map = target[nearest[k]]
            if new_map != mapped[k]:
                mapped[k] = new_map
                changed = True
        if not changed:
            break

    rgba = np.zeros((len(mapped), 4), np.uint8)
    solid_k = mapped != TRANSPARENT
    rgba[solid_k, :3] = np.round(centers[mapped[solid_k]]).astype(np.uint8)
    rgba[solid_k, 3] = 255
    out[m] = rgba
    return out


def body_box(frame: np.ndarray) -> tuple[int, int, int, int]:
    """Bounding box (x0, y0, x1, y1) of the largest connected blob = the character body."""
    m = frame[..., 3] > 0
    labels, n = ndimage.label(m)
    if n == 0:
        raise ValueError("empty frame")
    sizes = ndimage.sum(m, labels, index=np.arange(1, n + 1))
    biggest = int(np.argmax(sizes)) + 1
    ys, xs = np.nonzero(labels == biggest)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def remove_specks(frame: np.ndarray, min_cells: int) -> np.ndarray:
    m = frame[..., 3] > 0
    labels, n = ndimage.label(m, structure=np.ones((3, 3)))
    if n == 0:
        return frame
    sizes = ndimage.sum(m, labels, index=np.arange(1, n + 1))
    out = frame.copy()
    for i, s in enumerate(sizes, start=1):
        if s < min_cells:
            out[labels == i] = 0
    return out


# ----------------------------------------------------------------------------- main


@dataclass
class Frame:
    art: np.ndarray
    body: tuple[int, int, int, int]
    lift: int  # cells the body sits above the row's ground line


def process(args: argparse.Namespace) -> None:
    img = np.asarray(Image.open(args.image).convert("RGBA"))
    rgb = img[..., :3]
    mask, bg = foreground_mask(img, args.threshold, args.alpha_min)
    row_names = args.rows.split(",")
    bands = split_into(mask.any(axis=1), len(row_names))

    crops = []
    periods = []
    for ya, yb in bands:
        row = []
        for xa, xb in split_into(mask[ya:yb].any(axis=0), args.cols):
            c_rgb, c_mask = rgb[ya:yb, xa:xb], mask[ya:yb, xa:xb]
            p = frame_period(c_rgb, c_mask, args.pmin, args.pmax)
            if p:
                periods.append(p)
            row.append((c_rgb, c_mask))
        crops.append(row)

    base = args.pixel or float(np.median(periods))
    step = args.step or base / args.subdiv
    print(f"art pixel ~{base:.2f}px (frames: {' '.join(f'{p:.1f}' for p in periods)}); sampling step {step:.2f}px")

    raw = []
    for row in crops:
        raw_row = []
        for c_rgb, c_mask in row:
            ox, oy = frame_phase(c_rgb, c_mask, step)
            art, _, y0 = sample_frame(c_rgb, c_mask, step, ox, oy, args.despill)
            raw_row.append((art, y0))
        raw.append(raw_row)

    centers, weights = build_palette([a for r in raw for a, _ in r], args.merge)
    target, interior = resolve_palette(centers, weights, bg, args.rare, args.min_colour_cells)
    kept = sorted(set(int(t) for t in np.concatenate([target, interior]) if t != TRANSPARENT), key=lambda i: -weights[i])
    print(f"palette: {len(kept)} colours (from {len(centers)} clusters): "
          + " ".join("#%02x%02x%02x" % tuple(np.round(centers[i]).astype(int)) for i in kept))

    rows: list[list[Frame]] = []
    for raw_row in raw:
        sampled = []
        for art, y0 in raw_row:
            art = remove_specks(snap(art, centers, target, interior, bg), args.min_speck)
            box = body_box(art)
            sampled.append((art, box, y0 + box[3] * step))
        ground = max(s[2] for s in sampled)
        rows.append([Frame(a, b, int(round((ground - bottom) / step))) for a, b, bottom in sampled])

    left = right = up = down = 0
    for frames in rows:
        for f in frames:
            h, w = f.art.shape[:2]
            cx = (f.body[0] + f.body[2]) / 2
            left = max(left, int(np.ceil(cx)))
            right = max(right, int(np.ceil(w - cx)))
            up = max(up, f.body[3] + f.lift)
            down = max(down, h - f.body[3] - f.lift)
    pad = args.pad
    half = max(left, right) + pad
    fw, fh = 2 * half, up + max(down, 0) + 2 * pad
    ground_y = pad + up

    out_dir = Path(args.out) / args.char
    out_dir.mkdir(parents=True, exist_ok=True)
    meta = {"character": args.char, "frameWidth": fw, "frameHeight": fh, "groundY": ground_y, "moods": {}}
    strips = []
    for name, frames in zip(row_names, rows):
        strip = np.zeros((fh, fw * len(frames), 4), np.uint8)
        for k, f in enumerate(frames):
            art = f.art
            h, w = art.shape[:2]
            cx = (f.body[0] + f.body[2]) / 2
            ox = k * fw + int(round(half - cx))
            oy = ground_y - f.body[3] - f.lift
            for yy in range(h):
                ty = oy + yy
                if not 0 <= ty < fh:
                    continue
                for xx in range(w):
                    tx = ox + xx
                    if art[yy, xx, 3] and k * fw <= tx < (k + 1) * fw:
                        strip[ty, tx] = art[yy, xx]
        Image.fromarray(strip, "RGBA").save(out_dir / f"{name}.png")
        meta["moods"][name] = {"file": f"{name}.png", "frames": len(frames)}
        strips.append((name, strip))
    (out_dir / "sprite.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"frame {fw}x{fh}px, ground y={ground_y}; wrote {len(strips)} strips to {out_dir}")
    if args.preview:
        write_preview(strips, fw, fh, Path(args.preview) / f"{args.char}_preview.png", args.scale)


def write_preview(strips, fw: int, fh: int, path: Path, scale: int) -> None:
    label_w = 90
    width = label_w + max(s.shape[1] for _, s in strips) * scale
    height = len(strips) * (fh * scale + 6)
    canvas = Image.new("RGBA", (width, height), (255, 255, 255, 255))
    draw = ImageDraw.Draw(canvas)
    checker = Image.new("RGBA", (fw * scale, fh * scale))
    cd = ImageDraw.Draw(checker)
    for y in range(0, fh * scale, 8):
        for x in range(0, fw * scale, 8):
            cd.rectangle([x, y, x + 7, y + 7], fill=(70, 70, 78, 255) if (x // 8 + y // 8) % 2 else (90, 90, 98, 255))
    for r, (name, strip) in enumerate(strips):
        y = r * (fh * scale + 6)
        draw.text((6, y + fh * scale // 2 - 6), name, fill=(0, 0, 0, 255))
        big = Image.fromarray(strip, "RGBA").resize((strip.shape[1] * scale, fh * scale), Image.NEAREST)
        for k in range(strip.shape[1] // fw):
            x = label_w + k * fw * scale
            canvas.paste(checker, (x, y))
            canvas.alpha_composite(big.crop((k * fw * scale, 0, (k + 1) * fw * scale, fh * scale)), (x, y))
    path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(path)
    print(f"preview: {path}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image")
    ap.add_argument("--char", required=True)
    ap.add_argument("--rows", required=True, help="comma separated row (mood) names, top to bottom")
    ap.add_argument("--cols", type=int, required=True, help="frames per row")
    ap.add_argument("--out", default="assets/sprites")
    ap.add_argument("--preview", default="art/preview")
    ap.add_argument("--pixel", type=float, default=None, help="override detected art-pixel size (source px)")
    ap.add_argument("--subdiv", type=float, default=2.0, help="grid cells per art pixel")
    ap.add_argument("--step", type=float, default=None, help="sampling step in source px (overrides --subdiv)")
    ap.add_argument("--merge", type=float, default=38.0, help="palette merge distance (RGB)")
    ap.add_argument("--rare", type=float, default=0.02, help="colours under this share may be key-colour fringe")
    ap.add_argument("--min-colour-cells", type=int, default=4, help="colours used by fewer cells fold into neighbours")
    ap.add_argument("--min-speck", type=int, default=3, help="drop isolated blobs smaller than this (cells)")
    ap.add_argument("--threshold", type=float, default=70.0, help="colour distance from a flat background")
    ap.add_argument("--alpha-min", type=int, default=200)
    ap.add_argument("--despill", type=int, default=2, help="ignore colours within N px of the background")
    ap.add_argument("--pmin", type=float, default=5.0)
    ap.add_argument("--pmax", type=float, default=48.0)
    ap.add_argument("--pad", type=int, default=2)
    ap.add_argument("--scale", type=int, default=4)
    process(ap.parse_args())


if __name__ == "__main__":
    main()
