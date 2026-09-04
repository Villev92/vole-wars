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
  /** Left Shift held — the Dash superpower (see stepVole). Edge-triggered server-side via `dashHeld`,
   *  so holding it dashes once per press, not once per recharge. */
  dash: boolean;
  /** 'C' held — the Burrow superpower (see stepVole). Edge-triggered server-side via `burrowHeld`, so
   *  a fresh press starts (or, mid-animation, cancels) a burrow rather than repeating every tick. */
  burrow: boolean;
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
  /** Double Jump superpower: true whenever the extra air jump is available. Starts true, spent by one
   *  jump taken while genuinely airborne (see stepVole), and refilled the instant the vole is grounded
   *  again — a landing-based reset, not a cooldown timer. */
  doubleJumpAvailable: boolean;
  ropeActive: boolean;
  ropeAnchorX: number;
  ropeAnchorY: number;
  ropeLength: number;
  /** Stored Dash superpower charges (0..DASH_MAX_CHARGES). Each dash spends one; see stepVole. */
  dashCharges: number;
  /** Seconds until the next dash charge is restored — only meaningful while dashCharges is below max
   *  (see stepVole / DASH_RECHARGE). */
  dashRechargeTimer: number;
  /** True from the instant a dash press is registered until Shift is released — a fresh press (not
   *  just still holding it once the cooldown clears) is required to dash again. */
  dashHeld: boolean;
  /** True while a Burrow (see stepVole) is in progress — the vole is scripted straight down
   *  BURROW_DEPTH terrain units over BURROW_DURATION seconds, ignoring terrain collision entirely for
   *  the duration. */
  burrowActive: boolean;
  /** Seconds elapsed since the current burrow began (0 when not burrowing) — drives the descent's
   *  progress (elapsed / BURROW_DURATION) and, client-side, the tornado-spin animation. */
  burrowElapsed: number;
  /** The vole's y at the instant the current burrow began — the descent is startY + BURROW_DEPTH *
   *  progress, not an incremental per-tick move, so this anchor has to be remembered. */
  burrowStartY: number;
  /** Seconds until the next burrow can start — set to BURROW_COOLDOWN the instant one begins (not
   *  when it ends). */
  burrowCooldownTimer: number;
  /** True from the instant a burrow press is registered until 'C' is released — a fresh press (not
   *  just still holding it) is required to start (or cancel) the next one. */
  burrowHeld: boolean;
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
