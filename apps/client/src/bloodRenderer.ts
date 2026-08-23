import { Sprite, Texture } from "pixi.js";
import type { TerrainField } from "@vole-wars/shared";

const BLOOD_DARK: [number, number, number] = [92, 10, 12];
const BLOOD_MID: [number, number, number] = [138, 18, 22];
const INK = "rgba(40, 4, 6, 0.6)";

// Light supersampling only (unlike terrainRenderer.ts's RENDER_SCALE=3) — blood is soft, irregular
// blobs painted straight into canvas 2D, not a per-cell material lookup that needs crisp bilinear
// edges, so a small oversample just softens jagged circle edges a touch.
const RENDER_SCALE = 2;

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function rgb(color: [number, number, number], jitter: number): string {
  const r = clamp255(color[0] + (Math.random() - 0.5) * jitter);
  const g = clamp255(color[1] + (Math.random() - 0.5) * jitter);
  const b = clamp255(color[2] + (Math.random() - 0.5) * jitter);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * A persistent blood-decal layer, painted directly with canvas 2D (unlike terrainRenderer.ts, this
 * isn't derived from a data model that gets recomputed per rect — it's an append-only paint canvas,
 * so a splatter is just drawn once and stays until explicitly cleared). Sits in the world just above
 * the terrain sprite and below every character/skeleton. Synced across clients the same way
 * terrain-carve/fire already are: the server broadcasts "blood" on every hit, every client paints
 * the same shapes at the same spot (not pixel-identical, but visually equivalent, which is all this
 * needs).
 */
export class BloodRenderer {
  readonly sprite: Sprite;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: Texture;

  constructor(private readonly terrain: TerrainField) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = terrain.width * RENDER_SCALE;
    this.canvas.height = terrain.height * RENDER_SCALE;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;

    this.texture = Texture.from(this.canvas);
    this.texture.source.scaleMode = "linear";
    this.sprite = new Sprite(this.texture);
    this.sprite.scale.set(1 / RENDER_SCALE);
  }

  /**
   * Paints a splatter of irregular blobs centered on (x, y) — skipped entirely if that point isn't
   * currently solid terrain (blood needs ground to land on; the victim's own position is almost
   * always solid ground since they were standing on it when hit).
   */
  splatter(x: number, y: number, amount: number): void {
    if (!this.terrain.isSolid(x, y)) return;

    const cx = x * RENDER_SCALE;
    const cy = y * RENDER_SCALE;
    const blobCount = 5 + Math.min(9, Math.round(amount));
    const spread = (3 + amount * 0.5) * RENDER_SCALE;

    for (let i = 0; i < blobCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * spread;
      const bx = cx + Math.cos(angle) * dist;
      const by = cy + Math.sin(angle) * dist;
      const radius = (1 + Math.random() * 2.2) * RENDER_SCALE;

      this.ctx.fillStyle = rgb(Math.random() < 0.5 ? BLOOD_DARK : BLOOD_MID, 18);
      this.ctx.globalAlpha = 0.55 + Math.random() * 0.35;
      this.drawBlob(bx, by, radius);
    }

    // A darker, tighter core near the exact hit point so the splatter reads as centered on
    // something rather than a uniform scatter.
    this.ctx.fillStyle = INK;
    this.ctx.globalAlpha = 0.7;
    this.drawBlob(cx, cy, 1.4 * RENDER_SCALE);
    this.ctx.globalAlpha = 1;

    this.texture.source.update();
  }

  /** Clears blood within a circle — called in lockstep with terrainRenderer.carve() so blood on
   *  terrain that's just been destroyed disappears with it. */
  clearCircle(cx: number, cy: number, radius: number): void {
    this.ctx.save();
    this.ctx.globalCompositeOperation = "destination-out";
    this.ctx.beginPath();
    this.ctx.arc(cx * RENDER_SCALE, cy * RENDER_SCALE, radius * RENDER_SCALE, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.restore();
    this.texture.source.update();
  }

  private drawBlob(x: number, y: number, radius: number): void {
    const sides = 5 + Math.floor(Math.random() * 3);
    this.ctx.beginPath();
    for (let i = 0; i < sides; i++) {
      const angle = (i / sides) * Math.PI * 2 + (Math.random() - 0.5) * 0.7;
      const r = radius * (0.7 + Math.random() * 0.5);
      const px = x + Math.cos(angle) * r;
      const py = y + Math.sin(angle) * r;
      if (i === 0) this.ctx.moveTo(px, py);
      else this.ctx.lineTo(px, py);
    }
    this.ctx.closePath();
    this.ctx.fill();
  }
}
