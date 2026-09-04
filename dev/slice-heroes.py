#!/usr/bin/env python3
"""Slice the per-hero part sheets in designs/Heroes/<Hero>/Parts/*.png into individual
head / torso / gun / foot PNGs under apps/client/public/art/heroes/<id>/, plus a <id>.json
of per-part render scale + anchor so the client rig (voleArt.ts) can assemble any hero the
same way it assembles the built-in Burrows art.

Run from the repo root:  python dev/slice-heroes.py
"""
import json
import os
import sys
from collections import deque

import numpy as np
from PIL import Image

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_ROOT = os.path.join(REPO, "apps", "client", "public", "art", "heroes")

# Built-in Burrows reference (apps/client/public/art/*.png + voleArt.ts constants). New heroes are
# scaled so the equivalent part lands at the same vole-local size.
REF = {
    "torso": {"px": (517, 461), "scale": 0.033, "match": "h"},
    "head":  {"px": (492, 416), "scale": 0.030, "match": "h"},
    "gun":   {"px": (844, 302), "scale": 0.0225, "match": "w"},
    "foot":  {"px": (224, 128), "scale": 0.020, "match": "w"},
}
REF_TARGET = {
    k: (v["px"][0] * v["scale"] if v["match"] == "w" else v["px"][1] * v["scale"])
    for k, v in REF.items()
}

HEROES = {
    "burrows": {
        "sheet": "designs/Heroes/Burrows/Parts/HeroParts.png",
        "portrait": "designs/Heroes/Burrows/Portraits/front-sarge.png",
        "slice": False,   # already shipped as hand-tuned public/art/*.png
    },
    "bristle": {
        "sheet": "designs/Heroes/Bristle/Parts/bristle-parts.png",
        "portrait": "designs/Heroes/Bristle/Portraits/front-bristle.png",
        "slice": True,
    },
    "moss": {
        "sheet": "designs/Heroes/Moss/Parts/moss-parts.png",
        "portrait": "designs/Heroes/Moss/Portraits/front-moss.png",
        "slice": True,
    },
}

ALPHA_MIN = 16


def connected_components(mask):
    """4-connected component labelling. Returns list of (area, (x0,y0,x1,y1), coords_bool_slice)."""
    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    comps = []
    for sy in range(h):
        for sx in range(w):
            if not mask[sy, sx] or seen[sy, sx]:
                continue
            q = deque([(sy, sx)])
            seen[sy, sx] = True
            pts = []
            while q:
                y, x = q.popleft()
                pts.append((y, x))
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        q.append((ny, nx))
            ys = np.array([p[0] for p in pts])
            xs = np.array([p[1] for p in pts])
            comps.append((len(pts), (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)))
    return comps


def merge_close(comps, gap):
    """Merge component bboxes whose gap is < `gap` px (re-unites a part split by a thin AA break,
    e.g. an ear or a bandana tail just off the head)."""
    boxes = [list(b) for _, b in comps]
    areas = [a for a, _ in comps]
    changed = True
    while changed:
        changed = False
        for i in range(len(boxes)):
            for j in range(i + 1, len(boxes)):
                ax0, ay0, ax1, ay1 = boxes[i]
                bx0, by0, bx1, by1 = boxes[j]
                dx = max(0, max(ax0, bx0) - min(ax1, bx1))
                dy = max(0, max(ay0, by0) - min(ay1, by1))
                if dx < gap and dy < gap:
                    boxes[i] = [min(ax0, bx0), min(ay0, by0), max(ax1, bx1), max(ay1, by1)]
                    areas[i] += areas[j]
                    del boxes[j]
                    del areas[j]
                    changed = True
                    break
            if changed:
                break
    return list(zip(areas, [tuple(b) for b in boxes]))


def anchor_from_band(crop_alpha, edge):
    """Semantic anchor for a part crop, matching voleArt.ts's hand-measured ones:
    torso  -> top edge,   x = centroid of the topmost opaque band
    head   -> bottom edge, x = centroid of the bottommost opaque band
    gun    -> left edge,   y = centroid of the leftmost opaque band
    foot   -> bottom edge, x = centroid of the bottommost opaque band
    """
    m = crop_alpha >= ALPHA_MIN
    h, w = m.shape
    ys, xs = np.where(m)
    if edge == "top":
        cut = ys.min() + max(1, int(round(h * 0.04)))
        sel = ys < cut
        return (float(xs[sel].mean() / w), float((ys.min() + 0.5) / h))
    if edge == "bottom":
        # Wider band for the x centroid: a thin band at the very bottom of a head catches only the
        # snout tip (long on the opossum/mole), which drags the "neck" anchor way off toward the
        # nose. Averaging the lower quarter keeps it near the actual head mass.
        cut = ys.max() - max(1, int(round(h * 0.25)))
        sel = ys > cut
        return (float(xs[sel].mean() / w), float((ys.max() - 0.5) / h))
    if edge == "left":
        cut = xs.min() + max(1, int(round(w * 0.03)))
        sel = xs < cut
        return (float((xs.min() + 0.5) / w), float(ys[sel].mean() / h))
    raise ValueError(edge)


PART_EDGE = {"torso": "top", "head": "bottom", "gun": "left", "foot": "bottom"}

# Manual anchor tweaks the alpha-band heuristic can't get right. The head "neck" point is the worst
# case: a long snout (opossum, mole) drags any bottom-edge centroid toward the nose, so the head is
# pinned by the wrong spot and floats forward. These x values were eyeballed to sit under the
# back-of-jaw where the neck actually attaches. {hero: {part: {axis: value}}}
ANCHOR_OVERRIDE = {
    "bristle": {"head": {"x": 0.40}},
    "moss": {"head": {"x": 0.42}},
}


def slice_hero(hid, sheet_path):
    im = Image.open(os.path.join(REPO, sheet_path)).convert("RGBA")
    arr = np.array(im)
    alpha = arr[:, :, 3]
    mask = alpha >= ALPHA_MIN
    total = mask.size

    comps = connected_components(mask)
    comps = [c for c in comps if c[0] > total * 0.002]
    comps = merge_close(comps, gap=max(im.size) * 0.02)
    comps.sort(key=lambda c: -c[0])
    if len(comps) < 4:
        print(f"  !! {hid}: only found {len(comps)} components", file=sys.stderr)
        return None
    comps = comps[:4]

    # classify
    by_area = sorted(comps, key=lambda c: c[0])
    foot = by_area[0]
    rest = by_area[1:]
    gun = max(rest, key=lambda c: (c[1][0] + c[1][2]) / 2)
    rest = [c for c in rest if c is not gun]
    head, torso = sorted(rest, key=lambda c: c[1][1])  # smaller min-y first
    parts = {"head": head, "torso": torso, "gun": gun, "foot": foot}

    out_dir = os.path.join(OUT_ROOT, hid)
    os.makedirs(out_dir, exist_ok=True)
    spec = {}
    for name, (area, (x0, y0, x1, y1)) in parts.items():
        crop = im.crop((x0, y0, x1, y1))
        crop.save(os.path.join(out_dir, f"{name}.png"))
        cw, ch = crop.size
        ax, ay = anchor_from_band(np.array(crop)[:, :, 3], PART_EDGE[name])
        ov = ANCHOR_OVERRIDE.get(hid, {}).get(name, {})
        ax, ay = ov.get("x", ax), ov.get("y", ay)
        match = REF[name]["match"]
        scale = REF_TARGET[name] / (cw if match == "w" else ch)
        spec[name] = {"file": f"{name}.png", "w": cw, "h": ch, "scale": round(scale, 5),
                      "anchor": {"x": round(ax, 4), "y": round(ay, 4)}}
        print(f"  {hid}/{name}: crop {cw}x{ch}  scale {scale:.5f}  anchor ({ax:.3f},{ay:.3f})  bbox=({x0},{y0},{x1},{y1})")
    with open(os.path.join(out_dir, "spec.json"), "w") as f:
        json.dump(spec, f, indent=2)
    return spec


def copy_portrait(hid, portrait_path):
    im = Image.open(os.path.join(REPO, portrait_path)).convert("RGBA")
    out_dir = os.path.join(OUT_ROOT, hid)
    os.makedirs(out_dir, exist_ok=True)
    im.save(os.path.join(out_dir, "portrait.png"))
    print(f"  {hid}/portrait.png  {im.size}")


def main():
    os.makedirs(OUT_ROOT, exist_ok=True)
    for hid, cfg in HEROES.items():
        print(f"[{hid}]")
        copy_portrait(hid, cfg["portrait"])
        if cfg["slice"]:
            slice_hero(hid, cfg["sheet"])
    print("done ->", OUT_ROOT)


if __name__ == "__main__":
    main()
