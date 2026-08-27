import { Sprite, Texture } from "pixi.js";
import { GRAVITY, type TerrainField } from "@vole-wars/shared";

// Liero-style blood (see designs/examples/LieroBlood.jpg): individual small square "pixels" in a
// handful of saturated reds, not soft airbrushed blobs — each candidate pixel is only painted if it
// lands on currently-solid terrain, so the stain naturally hugs ground contours and piles up against
// walls/floors instead of floating over the dug-out air next to them, the same way Liero's blood
// particles fall and stick to whatever they land on.
const BLOOD_PALETTE = [0xc41414, 0x8f0d0f, 0xe0341f, 0x6b0808, 0xa81616];

// Light supersampling (unlike terrainRenderer.ts's RENDER_SCALE=3) just gives pixel-sized dots a
// couple of canvas pixels of size to work with — the look is meant to stay blocky/pixelated, not
// smoothed, hence "nearest" scaleMode below instead of terrain's bilinear "linear".
const RENDER_SCALE = 2;

// Sub-step size for fallStep below, same idea as physics.ts's sweepAxis — checks solidity every unit
// of fall distance rather than only at the destination, so a fast-falling drop can't tunnel past a
// thin ledge in one big jump.
const DROP_SUBSTEP = 1;

function pickColor(): number {
  return BLOOD_PALETTE[Math.floor(Math.random() * BLOOD_PALETTE.length)];
}

interface BloodDrop {
  x: number;
  y: number;
  vy: number;
  size: number;
  color: number;
}

/**
 * Falls straight down (substepped the same way physics.ts's sweepAxis is, just for a single point
 * rather than a circle — a blood pixel has no meaningful radius of its own) until it lands on solid
 * terrain, or forever if it somehow never finds any (terrain.get treats out-of-bounds as solid rock,
 * so in practice every column bottoms out eventually). Returns the landing y unchanged if it was
 * already resting on solid ground with no distance to fall.
 */
function fallStep(terrain: TerrainField, x: number, y: number, dy: number): { y: number; landed: boolean } {
  const steps = Math.max(1, Math.ceil(Math.abs(dy) / DROP_SUBSTEP));
  const stepY = dy / steps;
  let cy = y;
  for (let i = 0; i < steps; i++) {
    const ny = cy + stepY;
    if (terrain.isSolid(x, ny)) return { y: cy, landed: true };
    cy = ny;
  }
  return { y: cy, landed: false };
}

/**
 * A persistent blood-decal layer, painted directly with canvas 2D (unlike terrainRenderer.ts, this
 * isn't derived from a data model that gets recomputed per rect — it's an append-only paint canvas
 * for landed drops, plus a small live list of still-falling ones). Sits in the world just above the
 * terrain sprite and below every character/skeleton. Synced across clients the same way
 * terrain-carve/fire already are: the server broadcasts "blood" on every hit, every client paints
 * the same shapes at the same spot (not pixel-identical, but visually equivalent, which is all this
 * needs).
 *
 * Landed drops react to terrain destruction the same way a corpse does (see stepCorpse in
 * physics.ts): losing the ground under them doesn't erase them, it drops them back into the falling
 * list to land again on whatever's now underneath, however many craters down that takes.
 */
export class BloodRenderer {
  readonly sprite: Sprite;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: Texture;

  private readonly grounded: BloodDrop[] = [];
  private falling: BloodDrop[] = [];

  constructor(private readonly terrain: TerrainField) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = terrain.width * RENDER_SCALE;
    this.canvas.height = terrain.height * RENDER_SCALE;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;

    this.texture = Texture.from(this.canvas);
    this.texture.source.scaleMode = "nearest";
    this.sprite = new Sprite(this.texture);
    this.sprite.scale.set(1 / RENDER_SCALE);
  }

  /**
   * Sprays a cloud of pixel-sized blood drops around (x, y). Each candidate point is checked against
   * the terrain before being added: one that lands on solid ground is already at rest (baked straight
   * into the canvas, same as before); the wound center itself is deliberately NOT required to be
   * solid (the server broadcasts "terrain-carve" for an explosion before "blood" from the same hit —
   * see GameRoom.ts — so the ground right at the victim's own position has often just been carved
   * into empty air by the time this runs), so the spray still lands wherever solid ground actually
   * remains nearby (typically the fresh crater's rim).
   */
  splatter(x: number, y: number, amount: number): void {
    const dropCount = Math.min(220, 70 + Math.round(amount * 11));
    const spread = 3 + amount * 0.6;

    for (let i = 0; i < dropCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      // sqrt-biased distance clusters most pixels near the wound with a sparser outer spray, and the
      // extra downward-only term mimics blood particles falling before they stick.
      const dist = Math.sqrt(Math.random()) * spread;
      const wx = x + Math.cos(angle) * dist;
      const wy = y + Math.sin(angle) * dist * 0.6 + Math.random() * spread * 0.4;
      this.tryLand(wx, wy, (0.6 + Math.random() * 0.7) * RENDER_SCALE);
    }

    // A tight, denser cluster right at the wound itself so the spray reads as centered on something
    // rather than a uniform scatter.
    for (let i = 0; i < 8; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * 1.5;
      const wx = x + Math.cos(angle) * dist;
      const wy = y + Math.sin(angle) * dist;
      this.tryLand(wx, wy, (0.8 + Math.random() * 0.8) * RENDER_SCALE);
    }

    this.texture.source.update();
  }

  private tryLand(x: number, y: number, size: number): void {
    if (!this.terrain.isSolid(x, y)) return;
    const drop: BloodDrop = { x, y, vy: 0, size, color: pickColor() };
    this.grounded.push(drop);
    this.paint(drop);
  }

  /**
   * Reacts to terrain being carved away — instead of erasing blood in the circle outright, any
   * currently-landed drop that's lost its actual support (re-checked against the now-carved terrain,
   * not just circle membership: carveCircle leaves rock untouched, so a drop resting on an exposed
   * rock ledge inside the circle can legitimately still be fine) drops back into the falling list, its
   * old painted pixel erased so it doesn't stay behind as a static trace while the drop itself falls.
   * Drops that keep their support are untouched, painted pixel included.
   */
  onTerrainCarved(cx: number, cy: number, radius: number): void {
    const r2 = radius * radius;
    let write = 0;
    let changed = false;
    for (let i = 0; i < this.grounded.length; i++) {
      const drop = this.grounded[i];
      const dx = drop.x - cx;
      const dy = drop.y - cy;
      if (dx * dx + dy * dy <= r2 && !this.terrain.isSolid(drop.x, drop.y)) {
        this.erase(drop);
        drop.vy = 0;
        this.falling.push(drop);
        changed = true;
      } else {
        this.grounded[write++] = drop;
      }
    }
    this.grounded.length = write;
    if (changed) this.texture.source.update();
  }

  /** Steps every currently-falling drop one frame (see fallStep) and bakes any that land back into
   *  the canvas. Cheap no-op whenever nothing's currently falling, which is nearly always. */
  update(dt: number): void {
    if (this.falling.length === 0) return;

    let anyLanded = false;
    const stillFalling: BloodDrop[] = [];
    for (const drop of this.falling) {
      drop.vy += GRAVITY * dt;
      const result = fallStep(this.terrain, drop.x, drop.y, drop.vy * dt);
      drop.y = result.y;
      if (result.landed) {
        drop.vy = 0;
        this.grounded.push(drop);
        this.paint(drop);
        anyLanded = true;
      } else {
        stillFalling.push(drop);
      }
    }
    this.falling = stillFalling;

    if (anyLanded) this.texture.source.update();
  }

  private paint(drop: BloodDrop): void {
    this.ctx.fillStyle = `#${drop.color.toString(16).padStart(6, "0")}`;
    this.ctx.fillRect(
      drop.x * RENDER_SCALE - drop.size / 2,
      drop.y * RENDER_SCALE - drop.size / 2,
      drop.size,
      drop.size
    );
  }

  /** Erases a single drop's own painted footprint — used when it's about to fall again, so it
   *  doesn't leave a static trace behind at its old (now-unsupported) position. */
  private erase(drop: BloodDrop): void {
    this.ctx.clearRect(
      drop.x * RENDER_SCALE - drop.size / 2,
      drop.y * RENDER_SCALE - drop.size / 2,
      drop.size,
      drop.size
    );
  }
}
