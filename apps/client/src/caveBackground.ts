import { Sprite, Texture } from "pixi.js";

// Deliberately cooler (blue-grey, not warm brown) than DIRT_COLOR/STONE_COLOR (terrainRenderer.ts's
// foreground materials), and bright enough to read clearly against the app's near-black clear color
// — otherwise a "just slightly less black" backdrop is indistinguishable from empty space at a
// glance, which defeats the point of having one.
const BG_BASE: [number, number, number] = [58, 61, 70];
const BG_DEEP: [number, number, number] = [17, 18, 23];
const BG_HIGHLIGHT: [number, number, number] = [88, 93, 106];

// Three octaves of blotch noise (see sampleOctave), each an independently-seeded corner field
// bilinearly sampled at its own cell size and summed by weight — broad cave-wall shadow down to
// fine rock-surface roughness. A single octave (what this used to have) plus strong flat per-pixel
// grain on top is what read as "static": grain with nothing coherent underneath it at any scale is
// exactly that, static, regardless of amplitude. Weights sum to 1 so the combined value stays in
// roughly [0, 1] before the highlight/deep mix below.
const OCTAVES: { cell: number; weight: number }[] = [
  { cell: 42, weight: 0.5 }, // broad shadow/light cave-wall variation
  { cell: 15, weight: 0.32 }, // rock-chunk scale
  { cell: 5, weight: 0.18 }, // fine surface roughness
];
// Fine per-pixel grain layered on top of the octaves, same role (and much-reduced amplitude vs. the
// old flat noise) as terrainRenderer.ts's own NOISE_AMOUNT — texture detail, not the main event.
const NOISE_AMOUNT = 6;

function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295; // -> [0, 1]
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** One octave's corner grid, sized to cover width x height at its own cell size, and a sampler for it. */
function buildOctave(width: number, height: number, cell: number, seed: number): { cellsX: number; corners: Float32Array } {
  const cellsX = Math.ceil(width / cell) + 2;
  const cellsY = Math.ceil(height / cell) + 2;
  const corners = new Float32Array(cellsX * cellsY);
  for (let cy = 0; cy < cellsY; cy++) {
    for (let cx = 0; cx < cellsX; cx++) {
      corners[cy * cellsX + cx] = hash2(cx, cy, seed);
    }
  }
  return { cellsX, corners };
}

function sampleOctave(octave: { cellsX: number; corners: Float32Array }, cell: number, x: number, y: number): number {
  const gx = x / cell;
  const gy = y / cell;
  const gx0 = Math.floor(gx);
  const gy0 = Math.floor(gy);
  const tx = smooth(gx - gx0);
  const ty = smooth(gy - gy0);
  const { corners, cellsX } = octave;
  const c00 = corners[gy0 * cellsX + gx0];
  const c10 = corners[gy0 * cellsX + gx0 + 1];
  const c01 = corners[(gy0 + 1) * cellsX + gx0];
  const c11 = corners[(gy0 + 1) * cellsX + gx0 + 1];
  return lerp(lerp(c00, c10, tx), lerp(c01, c11, tx), ty);
}

/**
 * A static backdrop drawn once, sized to the terrain and placed behind its sprite in the world
 * container. TerrainRenderer punches fully transparent holes wherever terrain is carved away — with
 * nothing behind it, those holes just show the app's flat clear color, which reads as open empty
 * space rather than "there is more rock back there, you're underground". This never needs to
 * redraw itself since carving only affects the foreground terrain layer, not what's behind it.
 */
export function createCaveBackground(width: number, height: number): Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");

  const imageData = ctx.createImageData(width, height);
  const data = imageData.data;

  const octaves = OCTAVES.map((o, i) => buildOctave(width, height, o.cell, i));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let blotch = 0;
      for (let o = 0; o < OCTAVES.length; o++) {
        blotch += sampleOctave(octaves[o], OCTAVES[o].cell, x, y) * OCTAVES[o].weight;
      }
      blotch = clamp01(blotch);

      const [r, g, b] = blotch >= 0.5 ? mix(BG_BASE, BG_HIGHLIGHT, (blotch - 0.5) * 2) : mix(BG_DEEP, BG_BASE, blotch * 2);
      const n = (hash2(x, y, 99) - 0.5) * NOISE_AMOUNT;

      const i = (y * width + x) * 4;
      data[i] = clamp255(r + n);
      data[i + 1] = clamp255(g + n);
      data[i + 2] = clamp255(b + n);
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);

  const texture = Texture.from(canvas);
  texture.source.scaleMode = "linear";
  return new Sprite(texture);
}
