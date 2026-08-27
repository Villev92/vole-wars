import type { CarveRect } from "./types.js";

export const TERRAIN_EMPTY = 0;
export const TERRAIN_DIRT = 1;
export const TERRAIN_ROCK = 2;
// A second destructible material, purely for visual variety right now (same carve/collision rules
// as dirt). Reserved so a future pass can make it tougher to dig through than dirt without another
// data migration — carveCircle/isSolid already treat it as a distinct material.
export const TERRAIN_STONE = 3;

// Deterministic PRNG so the same seed produces the same cave on every machine.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class TerrainField {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  /**
   * Centers of guaranteed-clear circles carved during generation (see generateCaves' spawnZone*
   * options) — always empty on both client and server since they're baked into the deterministic
   * seed-based generation, unlike a runtime carve+broadcast (which a client can miss if it arrives
   * before that client finishes registering its "terrain-carve" handler on join, leaving its local
   * terrain solid where the server thinks it's already clear).
   */
  spawnPoints: { x: number; y: number }[] = [];

  constructor(width: number, height: number, data?: Uint8Array) {
    this.width = width;
    this.height = height;
    this.data = data ?? new Uint8Array(width * height);
  }

  private index(x: number, y: number): number {
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  get(x: number, y: number): number {
    if (!this.inBounds(x, y)) return TERRAIN_ROCK; // treat out-of-bounds as solid
    return this.data[this.index(x, y)];
  }

  set(x: number, y: number, material: number): void {
    if (this.inBounds(x, y)) this.data[this.index(x, y)] = material;
  }

  isSolid(x: number, y: number): boolean {
    const m = this.get(Math.floor(x), Math.floor(y));
    return m === TERRAIN_DIRT || m === TERRAIN_STONE || m === TERRAIN_ROCK;
  }

  /** Carves a circle of empty space out of destructible dirt/stone. Rock is unaffected. */
  carveCircle(cx: number, cy: number, radius: number): CarveRect {
    const minX = Math.max(0, Math.floor(cx - radius));
    const maxX = Math.min(this.width - 1, Math.ceil(cx + radius));
    const minY = Math.max(0, Math.floor(cy - radius));
    const maxY = Math.min(this.height - 1, Math.ceil(cy + radius));
    const r2 = radius * radius;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r2) {
          const material = this.get(x, y);
          if (material === TERRAIN_DIRT || material === TERRAIN_STONE) this.set(x, y, TERRAIN_EMPTY);
        }
      }
    }
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }

  /**
   * Carves a capsule — a circle of `radius` swept along the segment from (x1,y1) to (x2,y2) — out of
   * destructible dirt/stone, same "rock is unaffected" rule as carveCircle. Used for a piercing
   * projectile's per-tick travel: carveCircle alone only clears a pocket at the endpoint, leaving the
   * rest of that tick's swept path untouched, which is wrong for a weapon meant to destroy everything
   * along its whole flight rather than just where it finally stops.
   */
  carveCapsule(x1: number, y1: number, x2: number, y2: number, radius: number): CarveRect {
    const minX = Math.max(0, Math.floor(Math.min(x1, x2) - radius));
    const maxX = Math.min(this.width - 1, Math.ceil(Math.max(x1, x2) + radius));
    const minY = Math.max(0, Math.floor(Math.min(y1, y2) - radius));
    const maxY = Math.min(this.height - 1, Math.ceil(Math.max(y1, y2) + radius));
    const segDx = x2 - x1;
    const segDy = y2 - y1;
    const lenSq = segDx * segDx + segDy * segDy;
    const r2 = radius * radius;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        // Distance from (x,y) to the nearest point on the segment.
        let px = x1;
        let py = y1;
        if (lenSq > 1e-6) {
          const t = Math.max(0, Math.min(1, ((x - x1) * segDx + (y - y1) * segDy) / lenSq));
          px = x1 + segDx * t;
          py = y1 + segDy * t;
        }
        const dx = x - px;
        const dy = y - py;
        if (dx * dx + dy * dy <= r2) {
          const material = this.get(x, y);
          if (material === TERRAIN_DIRT || material === TERRAIN_STONE) this.set(x, y, TERRAIN_EMPTY);
        }
      }
    }
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }

  /**
   * Sweeps a circle of varying radius along a slowly-turning random walk, calling `stamp` at each
   * stop. Used for both the open paths and the stone patches below — a handful of deliberate,
   * organic-looking blobby regions by construction, instead of leaving it to chance the way
   * cellular-automata noise would (which reliably fragments into many small, scattered blobs
   * rather than a few large ones, no matter how it's tuned).
   */
  private static randomWalkStamp(
    rand: () => number,
    width: number,
    height: number,
    margin: number,
    steps: number,
    radiusRange: [number, number],
    stamp: (x: number, y: number, radius: number) => void
  ): void {
    const [radiusMin, radiusMax] = radiusRange;
    let x = margin + rand() * (width - 2 * margin);
    let y = margin + rand() * (height - 2 * margin);
    let heading = rand() * Math.PI * 2;
    for (let s = 0; s < steps; s++) {
      const radius = radiusMin + rand() * (radiusMax - radiusMin);
      stamp(x, y, radius);
      heading += (rand() - 0.5) * 1.1;
      const stepLen = radius * 0.85;
      x = Math.min(width - margin, Math.max(margin, x + Math.cos(heading) * stepLen));
      y = Math.min(height - margin, Math.max(margin, y + Math.sin(heading) * stepLen));
    }
  }

  /** Fills TERRAIN_DIRT cells within the circle with `material`, leaving anything else alone. */
  private stampCircle(cx: number, cy: number, radius: number, material: number): void {
    const minX = Math.max(0, Math.floor(cx - radius));
    const maxX = Math.min(this.width - 1, Math.ceil(cx + radius));
    const minY = Math.max(0, Math.floor(cy - radius));
    const maxY = Math.min(this.height - 1, Math.ceil(cy + radius));
    const r2 = radius * radius;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r2 && this.get(x, y) === TERRAIN_DIRT) this.set(x, y, material);
      }
    }
  }

  /**
   * Generates a mostly-solid destructible arena: solid dirt throughout, with a scattering of
   * larger stone patches for texture, a handful of wide carved paths for pre-made routes, and an
   * indestructible rock border. Seeded, so client and server can agree from a seed alone.
   */
  static generateCaves(
    width: number,
    height: number,
    seed: number,
    options: {
      rockBorder?: number;
      pathCount?: number;
      pathRadius?: [number, number];
      pathSteps?: number;
      stonePatchCount?: number;
      stoneRadius?: [number, number];
      stoneSteps?: number;
      spawnZoneCount?: number;
      spawnZoneRadius?: number;
    } = {}
  ): TerrainField {
    // Thick enough that the border stays on-screen even when the client's camera crops the map to
    // fill an aspect ratio other than the arena's own (apps/client's applyCamera() deliberately
    // scales the map to *cover* the window rather than letterboxing, so it crops whichever axis
    // overflows) — at 4px, spawn positions or open paths that generation placed close to the edge
    // could land past the crop line and render off-screen ("spawns out of the visible game area")
    // even though they were always physically in-bounds. Every other margin below (paths, stone
    // patches, spawn zones) is already derived from rockBorder, so raising it pushes all of them
    // inward together.
    const rockBorder = options.rockBorder ?? 32;
    // Fewer, much larger open corridors than old-style cave noise would produce — a handful of
    // wide paths carved through the solid ground, so there's usually a walkable route without
    // digging, while most of the map stays solid to destroy.
    const pathCount = options.pathCount ?? Math.max(2, Math.round((width * height) / 45000));
    const [pathRadiusMin, pathRadiusMax] = options.pathRadius ?? [12, 20];
    const pathSteps = options.pathSteps ?? 26;
    // A handful of large stone outcrops for visual variety (see TERRAIN_STONE's doc comment).
    const stonePatchCount = options.stonePatchCount ?? Math.max(3, Math.round((width * height) / 60000));
    const [stoneRadiusMin, stoneRadiusMax] = options.stoneRadius ?? [8, 16];
    const stoneSteps = options.stoneSteps ?? 9;
    // A few always-clear rooms baked into the terrain itself so spawn placement never depends on
    // randomly finding open space (or on a runtime carve reaching every client in time).
    const spawnZoneCount = options.spawnZoneCount ?? 3;
    const spawnZoneRadius = options.spawnZoneRadius ?? 26;
    const rand = mulberry32(seed);

    const field = new TerrainField(width, height);
    field.data.fill(TERRAIN_DIRT);

    const stoneMargin = stoneRadiusMax + rockBorder;
    for (let p = 0; p < stonePatchCount; p++) {
      TerrainField.randomWalkStamp(rand, width, height, stoneMargin, stoneSteps, [stoneRadiusMin, stoneRadiusMax], (x, y, radius) =>
        field.stampCircle(x, y, radius, TERRAIN_STONE)
      );
    }

    // Runs after the stone patches (so a path can cut through one, same as it cuts through dirt)
    // and before the rock border below (so a path that wanders near the edge is trimmed back to
    // an indestructible wall like everything else).
    const pathMargin = pathRadiusMax + rockBorder;
    for (let p = 0; p < pathCount; p++) {
      TerrainField.randomWalkStamp(rand, width, height, pathMargin, pathSteps, [pathRadiusMin, pathRadiusMax], (x, y, radius) =>
        field.carveCircle(x, y, radius)
      );
    }

    const spawnMargin = spawnZoneRadius + rockBorder;
    for (let i = 0; i < spawnZoneCount; i++) {
      const sx = spawnMargin + rand() * (width - 2 * spawnMargin);
      const sy = spawnMargin + rand() * (height - 2 * spawnMargin);
      field.carveCircle(sx, sy, spawnZoneRadius);
      field.spawnPoints.push({ x: sx, y: sy });
    }

    // Indestructible rock border so nothing can dig out of the arena.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const nearEdge =
          x < rockBorder || y < rockBorder || x >= width - rockBorder || y >= height - rockBorder;
        if (nearEdge) field.set(x, y, TERRAIN_ROCK);
      }
    }

    return field;
  }
}
