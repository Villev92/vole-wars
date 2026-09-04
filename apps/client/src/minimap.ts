import { Container, Graphics, Sprite, Texture } from "pixi.js";
import { TERRAIN_DIRT, TERRAIN_ROCK, TERRAIN_STONE, type TerrainField } from "@vole-wars/shared";
import { DIRT_COLOR, STONE_COLOR } from "./terrainRenderer.js";

// Screen-space HUD element, bottom-right. MARGIN_BOTTOM leaves a strip clear for the "hold Tab for
// scoreboard" hint (index.html #hint) that also lives bottom-right.
const MARGIN_RIGHT = 10;
const MARGIN_BOTTOM = 24;
const PAD = 4; // gap between the panel edge and the terrain image inside it
const MAX_W = 220;
const MAX_H = 132;

// The terrain image is re-rasterized from the (mirrored) TerrainField on this cadence rather than
// every frame — a minimap that's a fraction of a second behind the craters is imperceptible, and
// this keeps the per-pixel sampling loop off the frame budget.
const TERRAIN_REDRAW_INTERVAL = 0.35; // seconds

const ROCK_RGB: [number, number, number] = [58, 60, 66]; // matches terrainRenderer's ROCK_COLOR

export interface MinimapVole {
  x: number;
  y: number;
  color: number;
  self: boolean;
}

export interface MinimapView {
  x: number;
  y: number;
  w: number;
  h: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Bottom-right minimap: a downscaled raster of the whole TerrainField, a dot per live player
 * (self picked out with a white ring), and a white rectangle showing the slice of the map currently
 * on screen. Purely a readout — never eats pointer input. main.ts owns it: `layout()` on resize,
 * `update()` every frame with the current player set and camera-visible world rect.
 */
export class Minimap {
  readonly container: Container;

  private readonly panel: Graphics;
  private readonly terrainSprite: Sprite;
  private readonly overlay: Graphics;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: Texture;
  private readonly mapW: number;
  private readonly mapH: number;
  private redrawAccum = TERRAIN_REDRAW_INTERVAL; // force a render on the first update()

  constructor(private readonly terrain: TerrainField) {
    const fit = Math.min(MAX_W / terrain.width, MAX_H / terrain.height);
    this.mapW = Math.max(1, Math.round(terrain.width * fit));
    this.mapH = Math.max(1, Math.round(terrain.height * fit));

    this.canvas = document.createElement("canvas");
    this.canvas.width = this.mapW;
    this.canvas.height = this.mapH;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    this.texture = Texture.from(this.canvas);
    this.texture.source.scaleMode = "linear";

    this.container = new Container();
    this.container.eventMode = "none"; // a HUD readout, not a control — let clicks through to the canvas

    this.panel = new Graphics();
    const panelW = this.mapW + PAD * 2;
    const panelH = this.mapH + PAD * 2;
    this.panel.roundRect(0, 0, panelW, panelH, 6).fill({ color: 0x0e1216, alpha: 0.82 });
    this.panel.roundRect(0, 0, panelW, panelH, 6).stroke({ width: 1, color: 0x59524a });

    this.terrainSprite = new Sprite(this.texture);
    this.terrainSprite.position.set(PAD, PAD);

    this.overlay = new Graphics();

    this.container.addChild(this.panel, this.terrainSprite, this.overlay);
    this.renderTerrain();
  }

  /** Positions the panel in the bottom-right corner for the given screen size. */
  layout(screenWidth: number, screenHeight: number): void {
    const panelW = this.mapW + PAD * 2;
    const panelH = this.mapH + PAD * 2;
    this.container.position.set(
      Math.round(screenWidth - panelW - MARGIN_RIGHT),
      Math.round(screenHeight - panelH - MARGIN_BOTTOM)
    );
  }

  private renderTerrain(): void {
    const { width, height } = this.terrain;
    const image = this.ctx.createImageData(this.mapW, this.mapH);
    const data = image.data;
    for (let py = 0; py < this.mapH; py++) {
      const ty = Math.min(height - 1, Math.floor((py / this.mapH) * height));
      for (let px = 0; px < this.mapW; px++) {
        const tx = Math.min(width - 1, Math.floor((px / this.mapW) * width));
        const i = (py * this.mapW + px) * 4;
        const m = this.terrain.get(tx, ty);
        let rgb: [number, number, number] | null = null;
        if (m === TERRAIN_DIRT) rgb = DIRT_COLOR;
        else if (m === TERRAIN_STONE) rgb = STONE_COLOR;
        else if (m === TERRAIN_ROCK) rgb = ROCK_RGB;
        if (rgb) {
          data[i] = rgb[0];
          data[i + 1] = rgb[1];
          data[i + 2] = rgb[2];
          data[i + 3] = 255;
        } else {
          data[i + 3] = 0; // empty terrain — the dark panel shows through as "open space"
        }
      }
    }
    this.ctx.putImageData(image, 0, 0);
    this.texture.source.update();
  }

  update(dt: number, voles: MinimapVole[], view: MinimapView): void {
    this.redrawAccum += dt;
    if (this.redrawAccum >= TERRAIN_REDRAW_INTERVAL) {
      this.redrawAccum = 0;
      this.renderTerrain();
    }

    const sx = this.mapW / this.terrain.width;
    const sy = this.mapH / this.terrain.height;
    const g = this.overlay;
    g.clear();

    // White rectangle = the portion of the map currently visible on screen. Clamped to the map
    // rect so it never draws outside the panel when the camera sits hard against an edge.
    const vx0 = PAD + clamp(view.x, 0, this.terrain.width) * sx;
    const vy0 = PAD + clamp(view.y, 0, this.terrain.height) * sy;
    const vx1 = PAD + clamp(view.x + view.w, 0, this.terrain.width) * sx;
    const vy1 = PAD + clamp(view.y + view.h, 0, this.terrain.height) * sy;
    g.rect(vx0, vy0, Math.max(1, vx1 - vx0), Math.max(1, vy1 - vy0)).stroke({ width: 1, color: 0xffffff, alpha: 0.9 });

    // One dot per live player; the local player also gets a white ring so it's easy to find.
    for (const v of voles) {
      const dx = PAD + clamp(v.x, 0, this.terrain.width) * sx;
      const dy = PAD + clamp(v.y, 0, this.terrain.height) * sy;
      g.circle(dx, dy, v.self ? 2.6 : 2.2).fill({ color: v.color });
      if (v.self) g.circle(dx, dy, 4.2).stroke({ width: 1, color: 0xffffff, alpha: 0.8 });
    }
  }
}
