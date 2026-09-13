import { Container, Graphics } from "pixi.js";
import { drawBazookaExplosion, drawMissileBullet } from "./bulletArt.js";

// Guided missiles are the one projectile the server streams a position for (see weapons.ts
// `missile` / GameRoom.updateMissiles) rather than letting the client re-simulate — their flight
// isn't deterministic from the launch state. This layer draws the in-flight rocket from the synced
// x/y/angle (eased toward each patch like a vole pose so 30Hz updates don't visibly step) and,
// separately, plays the bazooka's own impact animation at each detonation point — the missile
// deliberately shares the bazooka's blast art + sound.

// Eases the rendered pose toward the latest synced one. Matches the vole POSITION_SMOOTH_RATE feel.
const SMOOTH_RATE = 20;
// Same duration BulletLayer runs its impact draws for, so the missile's blast reads identically to
// a bazooka rocket's own.
const EXPLOSION_DURATION = 0.2;

export interface MissileView {
  id: string;
  x: number;
  y: number;
  angle: number;
}

interface MissileSprite {
  g: Graphics;
  renderX: number;
  renderY: number;
  renderAngle: number;
  seen: boolean;
}

interface Blast {
  g: Graphics;
  age: number;
}

/** Shortest signed delta from angle `from` to `to`, in (-π, π]. */
function shortestAngle(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

export class MissileLayer {
  private readonly container = new Container();
  private readonly missiles = new Map<string, MissileSprite>();
  private readonly blasts: Blast[] = [];

  constructor(private readonly world: Container) {
    world.addChild(this.container);
  }

  /** Smoothed render position of a live missile, for the camera to follow. Null if not (yet) known. */
  renderPos(id: string): { x: number; y: number } | null {
    const m = this.missiles.get(id);
    return m ? { x: m.renderX, y: m.renderY } : null;
  }

  /** Kicks off a one-shot bazooka-style blast animation at (x, y). Driven by the server's
   *  `terrain-carve` broadcast for the missile, same as grenades/mines drive ExplosionLayer. */
  explode(x: number, y: number, entityScale: number): void {
    const g = new Graphics();
    g.position.set(x, y);
    g.scale.set(entityScale);
    this.container.addChild(g);
    this.blasts.push({ g, age: 0 });
  }

  update(dt: number, entityScale: number, views: MissileView[]): void {
    // Keep the layer on top while it has anything to show, so a blast sits over whoever's caught in
    // it (other world layers re-assert themselves the same way).
    if (views.length > 0 || this.blasts.length > 0) {
      const kids = this.world.children;
      if (kids.length > 0 && kids[kids.length - 1] !== this.container) this.world.addChild(this.container);
    }

    for (const m of this.missiles.values()) m.seen = false;

    for (const v of views) {
      let m = this.missiles.get(v.id);
      if (!m) {
        const g = new Graphics();
        drawMissileBullet(g);
        g.scale.set(entityScale);
        this.container.addChild(g);
        m = { g, renderX: v.x, renderY: v.y, renderAngle: v.angle, seen: true };
        this.missiles.set(v.id, m);
      }
      m.seen = true;
      const k = 1 - Math.exp(-SMOOTH_RATE * dt);
      m.renderX += (v.x - m.renderX) * k;
      m.renderY += (v.y - m.renderY) * k;
      m.renderAngle += shortestAngle(m.renderAngle, v.angle) * k;
      m.g.position.set(m.renderX, m.renderY);
      m.g.rotation = m.renderAngle;
      m.g.scale.set(entityScale);
    }

    for (const [id, m] of this.missiles) {
      if (!m.seen) {
        m.g.destroy();
        this.missiles.delete(id);
      }
    }

    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const b = this.blasts[i];
      b.age += dt;
      const t = b.age / EXPLOSION_DURATION;
      if (t >= 1) {
        b.g.destroy();
        this.blasts.splice(i, 1);
        continue;
      }
      b.g.clear();
      drawBazookaExplosion(b.g, t);
    }
  }
}
