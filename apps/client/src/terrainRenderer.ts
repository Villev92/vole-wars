import { Sprite, Texture } from "pixi.js";
import { TERRAIN_DIRT, TERRAIN_ROCK, TERRAIN_STONE, type TerrainField } from "@vole-wars/shared";

export const DIRT_COLOR: [number, number, number] = [117, 79, 48];
const DIRT_SHADOW: [number, number, number] = [86, 57, 33];
const GRASS_COLOR: [number, number, number] = [92, 158, 62];
export const STONE_COLOR: [number, number, number] = [118, 121, 130];
const STONE_HIGHLIGHT: [number, number, number] = [168, 171, 180];
const STONE_SHADOW: [number, number, number] = [72, 74, 82];
const ROCK_COLOR: [number, number, number] = [58, 60, 66];

// Fine per-pixel grain, layered on top of the coarse blotches below for texture detail. This used
// to be the ONLY variation (at amplitude 9, with nothing coherent underneath it) — pure per-pixel
// noise with no spatial correlation at all reads as exactly what it is, TV static, no matter the
// resolution it's rendered at. Turned down now that the blotches below are doing the actual "this
// looks like dirt/stone" work.
const NOISE_AMOUNT = 5;
// World units per soft color blotch — bilinearly interpolated between random corner values the same
// way caveBackground.ts's backdrop is, so the variation reads as coherent patches instead of static.
// Stone uses a smaller cell (tighter, more numerous facets) than dirt (soft, broad clumps) — that
// difference in scale, on top of stone shading both lighter AND darker (see STONE_BLOTCH_STRENGTH
// below) while dirt only darkens, is what reads as "broken rock" instead of "dirt with grey paint".
const BLOTCH_CELL_DIRT = 9;
const BLOTCH_CELL_STONE = 4;
const DIRT_BLOTCH_STRENGTH = 0.55; // how far toward DIRT_SHADOW a blotch's darkest point pulls dirt
const STONE_BLOTCH_STRENGTH = 0.4; // how far toward STONE_HIGHLIGHT/STONE_SHADOW a blotch's extremes pull stone

// How many cells deep the grass/topsoil tint band is at its strongest edge, fading to nothing by
// GRASS_DEPTH_MAX cells in — was implicitly ~1 cell (tied to the anti-aliasing ramp itself, via the
// old rimStrength formula). This is now independent of that ramp: see grassDepth below.
const GRASS_DEPTH_MAX = 5;
// Fraction of GRASS_DEPTH_MAX that stays fully saturated green before fading — without this, a
// straight 0-to-GRASS_DEPTH_MAX gradient reads as a soft blur into the dirt rather than a band with
// a defined (if still anti-aliased) edge, no matter how deep the band itself is.
const GRASS_CORE_FRACTION = 0.5;

// Half-width (in raw bilinear solidity units, where 0.5 is the true cell boundary) of the
// antialiasing ramp on the terrain's outer edge. The old code smoothstepped across the *entire*
// 0..1 range, which — after RENDER_SCALE supersampling and the linear-filtered upscale to screen
// size — read as a soft blur rather than an edge. Narrowing the ramp to only the pixels actually
// near the boundary keeps jagged cell-grid corners rounded off (the reason this ramp exists at all)
// without smearing it across a wide band.
const EDGE_SOFTNESS = 0.12;

// The terrain's physics/collision grid is 1 world-unit per cell — plenty fine for gameplay, but
// rendering it 1:1 and zooming the camera in makes every cell boundary a visible hard square edge.
// Rendering at a higher internal resolution and bilinearly interpolating "solidness" between cell
// centers turns those hard edges into smooth, properly anti-aliased curves (the same idea behind
// smooth-voxel/metaball rendering of a binary occupancy grid), without touching the actual
// gameplay grid at all.
const RENDER_SCALE = 3;

/** Small deterministic per-pixel hash, so terrain texture doesn't look like flat pixel-art blocks. */
function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return ((h >>> 0) / 4294967295) * 2 - 1; // -> [-1, 1]
}

/** Same hash, mapped to [0, 1] instead of [-1, 1] — used for blotch corner values. */
function hash01(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

const NEIGHBOR_OFFSETS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;

/** Renders a TerrainField to a canvas-backed PixiJS texture, re-uploading only changed regions. */
export class TerrainRenderer {
  readonly sprite: Sprite;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: Texture;
  // Distance (in cells, through solid material only) from the nearest cell that was already empty
  // when this renderer was built — i.e. from the *original* exposed surface/cave walls, not
  // whatever the terrain currently looks like. Computed once and never touched again, specifically
  // so that carving deeper into solid ground later exposes plain dirt, not grass: a freshly-dug
  // cell keeps whatever (large) distance it always had, regardless of what's now next to it. Used
  // in drawRectToCanvas to fade the grass/topsoil tint in over GRASS_DEPTH_MAX cells.
  private readonly grassDepth: Uint8Array;
  // One random "darkness" value per blotch-grid corner, bilinearly sampled per pixel — see
  // caveBackground.ts, same technique, so dirt/stone read as patchy material instead of static.
  private readonly blotchCorners: Float32Array;
  private readonly blotchCellsX: number;

  constructor(private readonly terrain: TerrainField) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = terrain.width * RENDER_SCALE;
    this.canvas.height = terrain.height * RENDER_SCALE;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;

    this.grassDepth = this.computeGrassDepth(terrain);
    // Sized to the smaller (stone) cell so both it and the coarser dirt sampling stay in bounds —
    // dirt just reads a sparser subset of the same underlying corner field.
    this.blotchCellsX = Math.ceil(terrain.width / BLOTCH_CELL_STONE) + 2;
    const blotchCellsY = Math.ceil(terrain.height / BLOTCH_CELL_STONE) + 2;
    this.blotchCorners = new Float32Array(this.blotchCellsX * blotchCellsY);
    for (let cy = 0; cy < blotchCellsY; cy++) {
      for (let cx = 0; cx < this.blotchCellsX; cx++) {
        this.blotchCorners[cy * this.blotchCellsX + cx] = hash01(cx, cy);
      }
    }

    this.drawRectToCanvas(0, 0, terrain.width, terrain.height);
    this.texture = Texture.from(this.canvas);
    this.texture.source.scaleMode = "linear";
    this.sprite = new Sprite(this.texture);
    this.sprite.scale.set(1 / RENDER_SCALE); // sprite is placed in world units, canvas is supersampled
  }

  /**
   * Multi-source BFS distance (through solid cells only, 4-connected) from cells adjacent to
   * originally-empty ones — i.e. how many solid-cell hops a point is from the nearest bit of open
   * space that existed when this renderer was built. A `visited` array (rather than overloading 0
   * as "unvisited") keeps this an ordinary single-pass flood fill: every cell enqueued exactly once.
   */
  private computeGrassDepth(terrain: TerrainField): Uint8Array {
    const { width, height } = terrain;
    const size = width * height;
    const depth = new Uint8Array(size);
    const visited = new Uint8Array(size);
    const queue = new Int32Array(size);
    let queueLen = 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!terrain.isSolid(x, y)) continue;
        let touchesEmpty = false;
        for (const [dx, dy] of NEIGHBOR_OFFSETS) {
          if (!terrain.isSolid(x + dx, y + dy)) {
            touchesEmpty = true;
            break;
          }
        }
        if (!touchesEmpty) continue;
        const idx = y * width + x;
        visited[idx] = 1;
        queue[queueLen++] = idx;
      }
    }

    let head = 0;
    while (head < queueLen) {
      const idx = queue[head++];
      const d = depth[idx];
      if (d >= 255) continue;
      const x = idx % width;
      const y = (idx / width) | 0;
      for (const [dx, dy] of NEIGHBOR_OFFSETS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const nidx = ny * width + nx;
        if (visited[nidx] || !terrain.isSolid(nx, ny)) continue;
        visited[nidx] = 1;
        depth[nidx] = d + 1;
        queue[queueLen++] = nidx;
      }
    }
    return depth;
  }

  /** Redraws the given world-unit rectangle from the terrain bitmap into the canvas and re-uploads it. */
  redrawRect(x: number, y: number, width: number, height: number): void {
    // Expanded by 1 world unit: bilinear sampling near the edge of the changed region reads one
    // cell beyond it, so a pixel just outside still needs redrawing to pick up a neighbor that
    // gained/lost solidity even though its own cell didn't change.
    if (!this.drawRectToCanvas(x - 1, y - 1, width + 2, height + 2)) return;
    this.texture.source.update();
  }

  private drawRectToCanvas(x: number, y: number, width: number, height: number): boolean {
    const minX = Math.max(0, x);
    const minY = Math.max(0, y);
    const maxX = Math.min(this.terrain.width, x + width);
    const maxY = Math.min(this.terrain.height, y + height);
    const w = maxX - minX;
    const h = maxY - minY;
    if (w <= 0 || h <= 0) return false;

    const canvasX = minX * RENDER_SCALE;
    const canvasY = minY * RENDER_SCALE;
    const canvasW = w * RENDER_SCALE;
    const canvasH = h * RENDER_SCALE;

    const imageData = this.ctx.createImageData(canvasW, canvasH);
    const data = imageData.data;
    const terrain = this.terrain;
    const grassDepth = this.grassDepth;
    const terrainWidth = terrain.width;

    for (let oy = 0; oy < canvasH; oy++) {
      const worldY = minY + (oy + 0.5) / RENDER_SCALE - 0.5;
      const gy0 = Math.floor(worldY);
      const ty = worldY - gy0;
      const gy1 = gy0 + 1;

      for (let ox = 0; ox < canvasW; ox++) {
        const worldX = minX + (ox + 0.5) / RENDER_SCALE - 0.5;
        const gx0 = Math.floor(worldX);
        const tx = worldX - gx0;
        const gx1 = gx0 + 1;

        const s00 = terrain.isSolid(gx0, gy0) ? 1 : 0;
        const s10 = terrain.isSolid(gx1, gy0) ? 1 : 0;
        const s01 = terrain.isSolid(gx0, gy1) ? 1 : 0;
        const s11 = terrain.isSolid(gx1, gy1) ? 1 : 0;
        const rawValue = lerp(lerp(s00, s10, tx), lerp(s01, s11, tx), ty);
        // Smoothstep only a narrow band around the true 0.5 boundary (see EDGE_SOFTNESS) into an
        // eased S-curve — rounds off what would otherwise read as a jagged cell-grid corner, without
        // smearing that rounding across the whole cell the way smoothstepping the full 0..1 ramp did.
        const edgeT = clamp01((rawValue - (0.5 - EDGE_SOFTNESS)) / (2 * EDGE_SOFTNESS));
        const value = smooth(edgeT);

        const i = (oy * canvasW + ox) * 4;
        if (value <= 0) {
          data[i + 3] = 0;
          continue;
        }

        const nearestGx = tx < 0.5 ? gx0 : gx1;
        const nearestGy = ty < 0.5 ? gy0 : gy1;
        const material = terrain.get(nearestGx, nearestGy);

        let color: [number, number, number];
        if (material === TERRAIN_ROCK) {
          color = ROCK_COLOR;
        } else {
          // Grass/topsoil band: bilinearly sample the frozen-at-construction depth field (not the
          // live solidity ramp above) so it fades over GRASS_DEPTH_MAX cells and is blind to
          // anything carved after this renderer was built.
          const d00 = inBounds(gx0, gy0, terrainWidth, terrain.height) ? grassDepth[gy0 * terrainWidth + gx0] : GRASS_DEPTH_MAX;
          const d10 = inBounds(gx1, gy0, terrainWidth, terrain.height) ? grassDepth[gy0 * terrainWidth + gx1] : GRASS_DEPTH_MAX;
          const d01 = inBounds(gx0, gy1, terrainWidth, terrain.height) ? grassDepth[gy1 * terrainWidth + gx0] : GRASS_DEPTH_MAX;
          const d11 = inBounds(gx1, gy1, terrainWidth, terrain.height) ? grassDepth[gy1 * terrainWidth + gx1] : GRASS_DEPTH_MAX;
          const depthSample = lerp(lerp(d00, d10, tx), lerp(d01, d11, tx), ty);
          // Full strength for the first GRASS_CORE_FRACTION of the band (a real solid-color band,
          // not a gradient from the very first cell), then an eased fade over the rest of it.
          const coreDepth = GRASS_DEPTH_MAX * GRASS_CORE_FRACTION;
          const rimStrength =
            depthSample <= coreDepth ? 1 : 1 - smooth(clamp01((depthSample - coreDepth) / (GRASS_DEPTH_MAX - coreDepth)));

          // Dirt/stone material blend: bilinearly sample "how much of this pixel's neighborhood is
          // stone" from the 4 corners (rock/empty corners just follow whichever material the nearest
          // corner picked, so they can't skew the blend toward either side) and cross-fade the two
          // materials' fully-shaded colors by it — this is a deliberate stylistic reversal of the
          // sharp nearest-cell material switch this used to be: the grass/dirt edge stayed sharp on
          // its *outer* (solidity) boundary but was always meant to be a soft material fade, and
          // dirt/stone is now the same idea applied to a different pair of materials.
          const nearestIsStone = material === TERRAIN_STONE;
          const stoneWeight = (m: number): number => (m === TERRAIN_STONE ? 1 : m === TERRAIN_DIRT ? 0 : nearestIsStone ? 1 : 0);
          const sw00 = stoneWeight(terrain.get(gx0, gy0));
          const sw10 = stoneWeight(terrain.get(gx1, gy0));
          const sw01 = stoneWeight(terrain.get(gx0, gy1));
          const sw11 = stoneWeight(terrain.get(gx1, gy1));
          const stoneBlend = lerp(lerp(sw00, sw10, tx), lerp(sw01, sw11, tx), ty);

          const dirtBlotch = sampleBlotch(this.blotchCorners, this.blotchCellsX, worldX, worldY, BLOTCH_CELL_DIRT);
          let dirtColor = mix(DIRT_COLOR, GRASS_COLOR, rimStrength);
          dirtColor = mix(dirtColor, DIRT_SHADOW, dirtBlotch * DIRT_BLOTCH_STRENGTH * (1 - rimStrength * 0.6));

          const stoneBlotch = sampleBlotch(this.blotchCorners, this.blotchCellsX, worldX, worldY, BLOTCH_CELL_STONE);
          let stoneColor = mix(STONE_COLOR, STONE_HIGHLIGHT, rimStrength);
          // Both lighter and darker facets (not just darkening, unlike dirt above) — the light/dark
          // contrast is what reads as broken rock rather than tinted soil.
          const shade = (stoneBlotch - 0.5) * 2 * STONE_BLOTCH_STRENGTH;
          stoneColor = shade >= 0 ? mix(stoneColor, STONE_HIGHLIGHT, shade) : mix(stoneColor, STONE_SHADOW, -shade);

          color = mix(dirtColor, stoneColor, stoneBlend);
        }

        const n = hash2(minX * RENDER_SCALE + ox, minY * RENDER_SCALE + oy) * NOISE_AMOUNT;
        data[i] = clamp255(color[0] + n);
        data[i + 1] = clamp255(color[1] + n);
        data[i + 2] = clamp255(color[2] + n);
        data[i + 3] = clamp255(Math.round(255 * value));
      }
    }
    this.ctx.putImageData(imageData, canvasX, canvasY);
    return true;
  }

  carve(cx: number, cy: number, radius: number): void {
    const rect = this.terrain.carveCircle(cx, cy, radius);
    this.redrawRect(rect.x, rect.y, rect.width, rect.height);
  }
}

function inBounds(x: number, y: number, width: number, height: number): boolean {
  return x >= 0 && y >= 0 && x < width && y < height;
}

/** Bilinearly samples the blotch corner field at the given cell size — see blotchCorners' own comment. */
function sampleBlotch(corners: Float32Array, cellsX: number, worldX: number, worldY: number, cellSize: number): number {
  // Clamped rather than left to go negative right at the world edge (worldX/Y can dip just under 0
  // there) — always inside the indestructible rock border in practice, but an unguarded negative
  // index would read undefined out of the typed array and NaN the whole pixel.
  const bgx0 = Math.max(0, Math.floor(worldX / cellSize));
  const bgy0 = Math.max(0, Math.floor(worldY / cellSize));
  const btx = smooth(worldX / cellSize - bgx0);
  const bty = smooth(worldY / cellSize - bgy0);
  const b00 = corners[bgy0 * cellsX + bgx0];
  const b10 = corners[bgy0 * cellsX + bgx0 + 1];
  const b01 = corners[(bgy0 + 1) * cellsX + bgx0];
  const b11 = corners[(bgy0 + 1) * cellsX + bgx0 + 1];
  return lerp(lerp(b00, b10, btx), lerp(b01, b11, btx), bty);
}
