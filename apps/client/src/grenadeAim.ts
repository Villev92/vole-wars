import { Container, Graphics } from "pixi.js";
import { GRAVITY, VOLE_RADIUS, WEAPONS, type TerrainField } from "@vole-wars/shared";

const SPAWN_DIST = VOLE_RADIUS + 4; // matches GameRoom.handleFire's spawnDist
const SIM_STEP = 1 / 60;
const MAX_STEPS = 200;

/**
 * The throw-preview arc shown while the local player is charging a grenade (holding LMB). It
 * integrates the grenade's launch (muzzle position + aim + a 0..1 charge power mapped to speed the
 * same way the server does) forward under gravity until it would hit terrain or leave the map, and
 * draws that path as a fading dotted line with a marker where it lands. Cosmetic only — the real
 * throw is the server's, and the grenade bounces once past this preview.
 */
export class GrenadeAimGuide {
  private readonly g = new Graphics();

  constructor(world: Container) {
    world.addChild(this.g);
    this.g.visible = false;
  }

  hide(): void {
    if (!this.g.visible) return;
    this.g.visible = false;
    this.g.clear();
  }

  /** Keep the guide last so it draws over terrain/characters. */
  bringToFront(world: Container): void {
    if (world.children[world.children.length - 1] !== this.g) world.addChild(this.g);
  }

  show(originX: number, originY: number, aimAngle: number, power: number, terrain: TerrainField): void {
    const w = WEAPONS.grenade;
    const min = w.minThrowSpeed ?? 0;
    const max = w.maxThrowSpeed ?? 0;
    const speed = min + Math.max(0, Math.min(1, power)) * (max - min);
    const g = GRAVITY * (w.gravityScale ?? 1);
    const maxRange = w.maxRange ?? Infinity;

    let x = originX + Math.cos(aimAngle) * SPAWN_DIST;
    let y = originY + Math.sin(aimAngle) * SPAWN_DIST;
    let vx = Math.cos(aimAngle) * speed;
    let vy = Math.sin(aimAngle) * speed;

    const pts: number[] = [x, y];
    let travelled = 0;
    for (let i = 0; i < MAX_STEPS; i++) {
      vy += g * SIM_STEP;
      const nx = x + vx * SIM_STEP;
      const ny = y + vy * SIM_STEP;
      travelled += Math.hypot(nx - x, ny - y);
      x = nx;
      y = ny;
      if (!terrain.inBounds(x, y) || terrain.isSolid(x, y) || travelled >= maxRange) break;
      pts.push(x, y);
    }

    this.g.clear();
    this.g.visible = true;
    // Fading dotted line along the arc.
    const dots = pts.length / 2;
    for (let i = 0; i < dots; i += 2) {
      const t = i / Math.max(1, dots - 1);
      this.g.circle(pts[i * 2], pts[i * 2 + 1], 0.9).fill({ color: 0xffd27a, alpha: 0.9 * (1 - t * 0.55) });
    }
    // Landing marker.
    const lx = pts[pts.length - 2];
    const ly = pts[pts.length - 1];
    this.g.circle(lx, ly, 3).stroke({ width: 0.8, color: 0xffb347, alpha: 0.95 });
    this.g.circle(lx, ly, 1).fill({ color: 0xffe08a, alpha: 0.95 });

    // Power pip at the muzzle so a tiny/short charge still reads.
    this.g.circle(pts[0], pts[1], 1.2 + power * 1.6).fill({ color: 0xff8b2e, alpha: 0.55 });
  }
}
