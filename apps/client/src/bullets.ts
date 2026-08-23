import { Container, Graphics } from "pixi.js";
import {
  SIM_DT,
  WEAPONS,
  stepProjectile,
  type ProjectileSimState,
  type TerrainField,
  type VoleHitTarget,
} from "@vole-wars/shared";

const IMPACT_DURATION = 0.2;
// Safety net only: if a bullet somehow never resolves (e.g. terrain desync), stop simulating it
// rather than let it fly forever.
const MAX_LIFETIME = 4;

interface Bullet {
  sim: ProjectileSimState;
  graphic: Graphics;
  drawImpact: (g: Graphics, t: number) => void;
  impact: Graphics | null;
  impactAge: number;
  life: number;
  done: boolean;
}

/**
 * The server never streams per-tick projectile positions to clients — only the spawn event and the
 * eventual terrain-carve. So each bullet here is simulated locally with the same shared
 * stepProjectile() physics against the same (locally-mirrored) terrain, purely to render a bullet
 * flying to its impact point. It's not authoritative: damage/craters still come from the server.
 */
export class BulletLayer {
  private bullets: Bullet[] = [];
  // Stepping stepProjectile() with the same fixed dt the server uses (rather than the variable
  // per-frame render dt) keeps terrain-hit sampling in lockstep with the server's simulation —
  // see SIM_DT's doc comment for why step size changes where a fast projectile is judged to land.
  private accumulator = 0;

  constructor(
    private readonly world: Container,
    private readonly terrain: TerrainField
  ) {}

  spawn(
    data: ProjectileSimState,
    drawBullet: (g: Graphics) => void,
    drawImpact: (g: Graphics, t: number) => void
  ): void {
    const graphic = new Graphics();
    drawBullet(graphic);
    graphic.position.set(data.x, data.y);
    graphic.rotation = Math.atan2(data.vy, data.vx);
    this.world.addChild(graphic);

    this.bullets.push({
      sim: { ...data },
      graphic,
      drawImpact,
      impact: null,
      impactAge: 0,
      life: 0,
      done: false,
    });
  }

  update(dt: number, entityScale: number, voles: VoleHitTarget[]): void {
    this.accumulator += dt;
    while (this.accumulator >= SIM_DT) {
      this.accumulator -= SIM_DT;
      this.stepFlyingBullets(SIM_DT, entityScale, voles);
    }
    for (const bullet of this.bullets) {
      if (!bullet.impact) {
        // Between fixed physics steps, still update the on-screen pose every render frame so
        // rotation/position don't look stepped at 30Hz.
        bullet.graphic.position.set(bullet.sim.x, bullet.sim.y);
        bullet.graphic.rotation = Math.atan2(bullet.sim.vy, bullet.sim.vx);
        bullet.graphic.scale.set(entityScale);
        continue;
      }
      bullet.impactAge += dt;
      const t = bullet.impactAge / IMPACT_DURATION;
      if (t >= 1) {
        this.world.removeChild(bullet.impact);
        bullet.done = true;
      } else {
        bullet.impact.clear();
        bullet.drawImpact(bullet.impact, t);
        bullet.impact.scale.set(entityScale);
      }
    }

    if (this.bullets.some((b) => b.done)) {
      this.bullets = this.bullets.filter((b) => !b.done);
    }
  }

  private stepFlyingBullets(stepDt: number, entityScale: number, voles: VoleHitTarget[]): void {
    for (const bullet of this.bullets) {
      if (bullet.impact) continue;

      const weapon = WEAPONS[bullet.sim.weaponId];
      const result = stepProjectile(bullet.sim, weapon, this.terrain, stepDt, voles);
      bullet.life += stepDt;
      const outOfBounds = !this.terrain.inBounds(Math.floor(bullet.sim.x), Math.floor(bullet.sim.y));

      if (result.exploded || outOfBounds || bullet.life > MAX_LIFETIME) {
        this.world.removeChild(bullet.graphic);
        bullet.impact = new Graphics();
        bullet.impact.position.set(result.x, result.y);
        bullet.impact.scale.set(entityScale);
        this.world.addChild(bullet.impact);
      }
    }
  }
}
