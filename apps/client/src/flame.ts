import { Container, Graphics } from "pixi.js";
import { raycastTerrain, VOLE_RADIUS, WEAPONS, type TerrainField } from "@vole-wars/shared";

// Kept in step with the server's flamethrower handling (GameRoom FLAME_* constants + weapons.ts).
const FLAME_RANGE = WEAPONS.flamethrower.flameRange ?? 15;
const CONE_HALF = WEAPONS.flamethrower.flameConeHalfRadians ?? 0.34;
const MUZZLE_DIST = VOLE_RADIUS + 4; // matches server FLAME_MUZZLE_DIST
// Overall visual tightness of the jet — scales its width and blob sizes (not its length).
const JET_NARROW = 0.8;
// Burn-patch radius — the SAME value the server uses to decide "is this vole standing in it"
// (GameRoom BURN_CONTACT_RADIUS). The ground fire is drawn to roughly fill this footprint so the
// visual and the damage area match.
const BURN_RADIUS = WEAPONS.flamethrower.burnRadius ?? 4.5;

/** A vole currently spraying flame — pose comes from the client's smoothed render state, not raw
 *  server x/y, so the stream tracks the character as fluidly as the rig does. */
export interface FlamingVole {
  id: string;
  x: number;
  y: number;
  aimAngle: number;
}

export interface BurnMarker {
  id: string;
  x: number;
  y: number;
}

/** Fractional part — used to derive stable per-particle "randomness" and looping life phases from
 *  a plain time value, so the whole effect stays stateless (nothing to spawn/track/GC). */
function fract(x: number): number {
  return x - Math.floor(x);
}
function hash(n: number): number {
  return fract(Math.sin(n * 127.1) * 43758.5453);
}

// Flame colour ramp by "age": 0 = white-hot at the nozzle/base, 1 = cool smoke at the tip.
// Alphas are deliberately low — everything is drawn additively so overlapping blobs stack into the
// bright dense core on their own.
function flameColour(t: number): [number, number] {
  if (t < 0.14) return [0xffefc4, 0.42];
  if (t < 0.38) return [0xffc858, 0.42];
  if (t < 0.7) return [0xff8b2e, 0.38];
  if (t < 0.88) return [0xe8461c, 0.26];
  return [0x8a2410, 0.15 * (1 - (t - 0.88) / 0.12)];
}

/**
 * One soft-edged flame puff = three concentric circles (wide + dim, mid, tight + bright). Stacked
 * additively they read as a blurred blob without any actual filter — which is the point: the flame
 * used to lean on a BlurFilter, and that filter clamped at its own texture edge and left the
 * occasional straight line off the side/tip of the long thin jet.
 */
function softBlob(g: Graphics, x: number, y: number, size: number, color: number, alpha: number): void {
  if (size < 0.05 || alpha < 0.01) return;
  g.circle(x, y, size * 2).fill({ color, alpha: alpha * 0.22 });
  g.circle(x, y, size * 1.35).fill({ color, alpha: alpha * 0.45 });
  g.circle(x, y, size).fill({ color, alpha: alpha * 0.9 });
}

/**
 * Renders the flamethrower's purely-visual bits. The flame stream is a stateless procedural
 * particle jet (each "particle" is a warm additive blob whose position/size/colour is a pure
 * function of time and its index, looping from nozzle to tip), clipped to the terrain the same way
 * the server's damage rays are. Each burn patch gets a small animated bed of ground fire — a faint
 * heat haze, a fountain of rising flame blobs, and sparks. All cosmetic; damage, terrain ignition
 * and burn lifetimes are the server's (see GameRoom.updateFlames).
 */
export class FlameLayer {
  // Two additive containers, no filters — the soft edge comes from stacked concentric circles
  // (softBlob), so there's no BlurFilter to clamp against its own edge and streak. Kept separate
  // only for z-order: ground under cones, so a flamer standing in a burn patch has the jet on top.
  private readonly coneLayer = new Container();
  private readonly groundLayer = new Container();
  private readonly cones = new Map<string, Graphics>();
  private readonly burns = new Map<string, { fire: Graphics; seed: number }>();

  constructor(
    private readonly world: Container,
    private readonly terrain: TerrainField
  ) {
    for (const layer of [this.groundLayer, this.coneLayer]) {
      layer.blendMode = "add";
      this.world.addChild(layer);
    }
  }

  update(time: number, flamingVoles: FlamingVole[], burnMarkers: BurnMarker[]): void {
    // Fire belongs on top of the characters producing it — keep both layers last in the world.
    const kids = this.world.children;
    if (kids[kids.length - 1] !== this.coneLayer || kids[kids.length - 2] !== this.groundLayer) {
      this.world.addChild(this.groundLayer);
      this.world.addChild(this.coneLayer);
    }

    const liveCones = new Set<string>();
    for (const vole of flamingVoles) {
      liveCones.add(vole.id);
      let g = this.cones.get(vole.id);
      if (!g) {
        g = new Graphics();
        this.coneLayer.addChild(g);
        this.cones.set(vole.id, g);
      }
      this.drawJet(g, vole, time);
    }
    for (const [id, g] of this.cones) {
      if (liveCones.has(id)) continue;
      g.destroy();
      this.cones.delete(id);
    }

    const liveBurns = new Set<string>();
    for (const marker of burnMarkers) {
      liveBurns.add(marker.id);
      let entry = this.burns.get(marker.id);
      if (!entry) {
        const fire = new Graphics();
        fire.position.set(marker.x, marker.y);
        this.groundLayer.addChild(fire);
        entry = { fire, seed: Math.random() * 1000 };
        this.burns.set(marker.id, entry);
      }
      drawGroundFire(entry.fire, entry.seed, time);
    }
    for (const [id, entry] of this.burns) {
      if (liveBurns.has(id)) continue;
      entry.fire.destroy();
      this.burns.delete(id);
    }
  }

  /** The flame stream: a looping procedural particle jet from the muzzle, clipped by terrain. */
  private drawJet(g: Graphics, vole: FlamingVole, time: number): void {
    g.clear();
    const mx = vole.x + Math.cos(vole.aimAngle) * MUZZLE_DIST;
    const my = vole.y + Math.sin(vole.aimAngle) * MUZZLE_DIST;

    // Shorten the jet where terrain blocks it — middle ray plus both cone edges, shortest wins.
    let maxLen = FLAME_RANGE;
    for (const off of [-CONE_HALF, 0, CONE_HALF]) {
      const hit = raycastTerrain(this.terrain, mx, my, vole.aimAngle + off, FLAME_RANGE);
      if (hit) maxLen = Math.min(maxLen, Math.hypot(hit.x - mx, hit.y - my));
    }

    const dx = Math.cos(vole.aimAngle);
    const dy = Math.sin(vole.aimAngle);
    const perpX = -dy;
    const perpY = dx;
    // Always draw a little flame even when jammed right up against a wall.
    const visLen = Math.max(maxLen, 2.5);

    // Steady spine — a continuous core down the whole jet so it never flickers out between the
    // phased particle bursts below; the particles ride on top of this and give it life.
    const spineN = Math.max(6, Math.round(visLen * 0.9));
    for (let i = 0; i < spineN; i++) {
      const f = (i + 0.5) / spineN;
      const wob = (Math.sin(time * 8 + i * 0.9) * 0.7 + Math.sin(time * 19 + i) * 0.3) * JET_NARROW;
      const [col, a] = flameColour(f);
      softBlob(
        g,
        mx + dx * f * visLen + perpX * wob,
        my + dy * f * visLen + perpY * wob,
        (1.5 + 1.4 * Math.sin(f * Math.PI * 0.9)) * JET_NARROW,
        col,
        a * 0.85
      );
    }

    // Scale count with length so a short (wall-blocked) jet stays the same density as a full-length
    // one instead of cramming every particle into a few units and blowing out to solid white.
    const PARTICLES = Math.round(16 + visLen * 2.2);
    for (let i = 0; i < PARTICLES; i++) {
      const r1 = hash(i + 1);
      const r2 = hash(i + 57.3);
      const r3 = hash(i * 2.7 + 3);
      // Age 0..1, staggered per particle so the jet is continuous, jittered per lap so it doesn't
      // pulse in lockstep.
      const lap = Math.floor(time * 2.3 + r1);
      const life = fract(time * 2.3 + r1);
      const dist = life * visLen;
      // Near-constant half-width: a tight directional jet that barely widens from barrel to tip,
      // rather than a spreading cone.
      const halfW = (1.4 + life * 0.5) * JET_NARROW;
      const wander =
        (r2 - 0.5) * 2 * halfW +
        Math.sin(time * 10 + i * 2.1 + lap * 4) * halfW * 0.35 +
        Math.sin(time * 23 + i) * halfW * 0.12;
      const cx = mx + dx * dist + perpX * wander;
      const cy = my + dy * dist + perpY * wander;
      // Stays fairly full along the whole length (narrow jets can't lean on size to stay visible),
      // just fading out over the last stretch.
      const grow = 0.55 + 0.45 * Math.sin(life * Math.PI);
      const [col, a] = flameColour(life);
      softBlob(g, cx, cy, (1.9 + life * 0.35) * JET_NARROW * grow * (0.7 + r3 * 0.6), col, a);
    }

    // Hot nozzle core — a small bright puff right at the muzzle so the barrel tip always has fire on
    // it regardless of jet length.
    for (let k = 0; k < 2; k++) {
      const j = 0.3 + k * 1 + Math.sin(time * 36 + k * 2) * 0.3;
      softBlob(g, mx + dx * j, my + dy * j, 1.7 - k * 0.5, k === 0 ? 0xffefd0 : 0xffb347, 0.24 - k * 0.06);
    }
  }
}

/** A low bed of ground fire sized to fill (roughly) BURN_RADIUS around the marker — so what's drawn
 *  matches the area the server actually burns you in. Faint heat glow + a fountain of small rising
 *  flame blobs (same soft particle look as the jet) + a few sparks. */
function drawGroundFire(g: Graphics, seed: number, time: number): void {
  g.clear();
  const R = BURN_RADIUS;

  // Faint low heat haze, kept inside R.
  const gw = 1 + 0.12 * Math.sin(time * 5 + seed);
  for (let k = 0; k < 3; k++) {
    const r = R * (1 - k * 0.28) * gw;
    for (let s = -1; s <= 1; s++) {
      g.circle(s * r * 0.4, 1.4, r * 0.6).fill({ color: k === 2 ? 0xff7d26 : 0xc23c10, alpha: 0.06 });
    }
  }

  // Rising flame blobs — spread within ~R, converging and shrinking as they climb, kept low so it
  // reads as burning ground, not a campfire.
  const N = 18;
  for (let i = 0; i < N; i++) {
    const r1 = hash(i + seed);
    const r2 = hash(i * 2.3 + seed + 4);
    const r3 = hash(i * 5.1 + seed + 11);
    const lap = Math.floor(time * 1.9 + r1);
    const life = fract(time * 1.9 + r1);
    const H = R * (1.1 + r2 * 0.7);
    const x0 = (r1 - 0.5) * R * 1.7;
    const sway = Math.sin(time * 6 + i * 1.7 + lap * 3) * (0.5 + life * 1.2);
    const x = x0 * (1 - life * 0.5) + sway;
    const y = 1.4 - life * H;
    const grow = Math.sin(life * Math.PI * 0.9);
    const [col, a] = flameColour(Math.min(1, life * 1.15));
    softBlob(g, x, y, (0.9 + r3 * 0.9) * grow * (1.2 - life * 0.5), col, a * 1.3);
  }

  // Rising sparks.
  for (let s = 0; s < 3; s++) {
    const t = fract(time * 0.5 + s * 0.33 + seed);
    const sx = Math.sin(seed * 2.7 + s * 2.1) * R * 0.7 + Math.sin(time * 4 + s);
    const sy = 1.4 - t * R * 2.4;
    const r = 0.45 * (1 - t);
    if (r > 0.04) g.circle(sx, sy, r).fill({ color: 0xffd889, alpha: 0.4 * (1 - t) });
  }
}
