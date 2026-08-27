export interface Vec2 {
  x: number;
  y: number;
}

// Single source of truth for a full-health vole — weapon damage tuning (see weapons.ts) is
// expressed relative to this (e.g. sniper's one-shot-to-half-health design), so it lives here
// rather than as a magic 100 repeated at every vole.health assignment.
export const MAX_HEALTH = 100;

export interface PlayerInput {
  left: boolean;
  right: boolean;
  jump: boolean;
  aimAngle: number;
  fire: boolean;
  /** Right mouse button held — casts/holds the grapple rope. */
  grapple: boolean;
  /** W/ArrowUp held — reels the rope in while attached. */
  up: boolean;
  /** S/ArrowDown held — reels the rope out while attached. */
  down: boolean;
}

export interface VoleSimState {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  aimAngle: number;
  health: number;
  grounded: boolean;
  alive: boolean;
  /** True from the instant a jump press is registered (buffered or triggered) until the jump input
   *  is released — requires a fresh press (not just still being held) to jump again, even once
   *  grounded again. */
  jumpHeld: boolean;
  /** Seconds remaining before another jump can trigger, set on landing. */
  jumpCooldown: number;
  /** Seconds remaining after walking off a ledge (ungrounded with no jump input yet) during which a
   *  jump still counts as grounded — standard "coyote time" so a step off uneven/sloped ground a
   *  tick before a press doesn't read as a missed jump. */
  coyoteTimer: number;
  /** Seconds remaining after a jump press during which landing (or entering coyote time) still
   *  triggers the jump — lets a press an instant before touchdown register instead of being
   *  silently dropped for having arrived one tick too early. */
  jumpBufferTimer: number;
  ropeActive: boolean;
  ropeAnchorX: number;
  ropeAnchorY: number;
  ropeLength: number;
}

export interface CorpseSimState {
  id: string;
  x: number;
  y: number;
  vy: number;
  grounded: boolean;
  /** Rest tilt (radians) matching the ground slope under it — recomputed each time it lands, see
   *  stepCorpse. */
  angle: number;
}

export interface ProjectileSimState {
  id: string;
  ownerId: string;
  weaponId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** How many times this projectile has bounced off terrain so far (see WeaponDef.bounces /
   *  stepProjectile). Absent/0 for weapons that don't bounce. Mutated in place by stepProjectile, so
   *  the client's local re-sim stays in lockstep with the server. */
  bounces?: number;
}

export interface CarveRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DamageEvent {
  targetId: string;
  amount: number;
  knockbackX: number;
  knockbackY: number;
}
