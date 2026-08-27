import { Container, Graphics } from "pixi.js";
import {
  PROJECTILE_OWNER_CLEARANCE,
  SIM_DT,
  TerrainField,
  WEAPONS,
  stepProjectile,
  type ProjectileSimState,
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
  // Actual path length flown so far — mirrors the server's own weapon.maxRange cutoff (see
  // GameRoom.update) purely so the visual bullet stops at the same point the authoritative one did,
  // rather than visibly flying on past where the server already made it fizzle out.
  traveled: number;
  // Distance actually spent inside solid dirt/stone — mirrors weapon.pierceTerrainLimit the same
  // way traveled mirrors maxRange, so a piercing weapon's local bullet visual stops punching
  // through walls at the same point the real one does.
  terrainPierced: number;
  // A piercing weapon (see WeaponDef.piercing) sends multiple incremental "terrain-carve" broadcasts
  // as it tunnels — one per server tick — which mutate the SAME live `terrain` this bullet's own
  // local replay reads solidity from. Those broadcasts can (and regularly do, on ordinary network
  // jitter, no throttling needed) arrive and clear cells ahead of where this bullet's own real-time
  // replay has gotten to, making a not-yet-simulated stretch of wall look already-empty locally —
  // so the local bullet keeps flying (and its own pierceDistance/terrainPierced stays under-counted)
  // well past where the real, authoritative bullet actually stopped. A private snapshot frozen at
  // spawn time, used ONLY for this bullet's own solidity checks (never mutated by later broadcasts,
  // including its own), makes its stopping decision immune to that race — the live `terrain` is
  // still what's rendered/carved for everyone to see. Null for non-piercing weapons, which never
  // touch more than one solid cell and so were never exposed to this race in the first place.
  terrainSnapshot: TerrainField | null;
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

    // See Bullet.terrainSnapshot's own comment — only piercing weapons need this, since only they
    // can outlive a single solid-cell check and so race their own multi-tick carve broadcasts.
    const weapon = WEAPONS[data.weaponId];
    const terrainSnapshot = weapon.piercing ? new TerrainField(this.terrain.width, this.terrain.height, new Uint8Array(this.terrain.data)) : null;

    this.bullets.push({
      sim: { ...data },
      graphic,
      drawImpact,
      impact: null,
      impactAge: 0,
      life: 0,
      traveled: 0,
      terrainSnapshot,
      terrainPierced: 0,
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

  /**
   * Forces a specific in-flight bullet straight to an impact at the server's own authoritative
   * explosion point (see the "terrain-carve" handler in main.ts, which shares the projectile's own
   * `id` on both the "fire" spawn and the eventual explosion broadcast). This bullet's own local
   * re-simulation (stepFlyingBullets, below) is a real-time guess run independently on whatever
   * terrain/vole positions this client currently knows about — for a fast, small-blast weapon that
   * guess reliably lands within a pixel of the truth, but a slow-arcing shot (bazooka) flying toward
   * a moving target over half a second or more can drift enough that the local guess sails past the
   * target's current hitbox that the server already resolved a direct hit against a moment earlier
   * at the position the target ACTUALLY was in then. The result reads as "the rocket flew through
   * them without exploding" even though the server's blood/carve broadcasts already fired correctly
   * — this just makes sure the visual bullet itself always snaps to match. A no-op if the bullet
   * already resolved its own impact this tick (whichever happens first wins; both land at
   * essentially the same spot for anything that wasn't already drifting).
   */
  resolve(id: string, x: number, y: number, entityScale: number): void {
    const bullet = this.bullets.find((b) => b.sim.id === id && !b.impact);
    if (!bullet) return;
    this.world.removeChild(bullet.graphic);
    bullet.impact = new Graphics();
    bullet.impact.position.set(x, y);
    bullet.impact.scale.set(entityScale);
    this.world.addChild(bullet.impact);
  }

  private stepFlyingBullets(stepDt: number, entityScale: number, voles: VoleHitTarget[]): void {
    for (const bullet of this.bullets) {
      if (bullet.impact) continue;

      const weapon = WEAPONS[bullet.sim.weaponId];
      const prevX = bullet.sim.x;
      const prevY = bullet.sim.y;
      // Mirrors GameRoom.update's own pierceRange/pierceTerrainLimit cutoffs (see WeaponDef) so this
      // purely-visual bullet stops punching through walls at the same point the authoritative one
      // does, rather than visibly tunneling further than the real terrain damage extends.
      const piercingActive =
        weapon.piercing &&
        (weapon.pierceRange === undefined || bullet.traveled < weapon.pierceRange) &&
        (weapon.pierceTerrainLimit === undefined || bullet.terrainPierced < weapon.pierceTerrainLimit);
      const effectiveWeapon = piercingActive ? weapon : { ...weapon, piercing: false };
      const pierceBudget = weapon.pierceTerrainLimit === undefined ? Infinity : weapon.pierceTerrainLimit - bullet.terrainPierced;
      // The frozen snapshot (see Bullet.terrainSnapshot), not the live this.terrain, is what decides
      // whether THIS bullet explodes/keeps piercing — the live terrain is still what carve() renders
      // from, just not what this bullet's own stopping decision is based on.
      // Match GameRoom: don't let the visual bullet resolve on its own shooter right out of the
      // barrel (a wall-blocked shot spawns next to them).
      const ignoreOwner = bullet.traveled < PROJECTILE_OWNER_CLEARANCE ? bullet.sim.ownerId : undefined;
      const result = stepProjectile(
        bullet.sim,
        effectiveWeapon,
        bullet.terrainSnapshot ?? this.terrain,
        stepDt,
        voles,
        pierceBudget,
        ignoreOwner
      );
      bullet.traveled += Math.hypot(result.x - prevX, result.y - prevY);
      bullet.terrainPierced += result.pierceDistance;
      bullet.life += stepDt;
      const outOfBounds = !this.terrain.inBounds(Math.floor(bullet.sim.x), Math.floor(bullet.sim.y));
      const outOfRange = !result.exploded && weapon.maxRange !== undefined && bullet.traveled >= weapon.maxRange;

      if (result.exploded || outOfBounds || outOfRange || bullet.life > MAX_LIFETIME) {
        this.world.removeChild(bullet.graphic);
        bullet.impact = new Graphics();
        bullet.impact.position.set(result.x, result.y);
        bullet.impact.scale.set(entityScale);
        this.world.addChild(bullet.impact);
      }
    }
  }
}
