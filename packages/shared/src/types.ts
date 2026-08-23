export interface Vec2 {
  x: number;
  y: number;
}

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
  /** True from the instant a jump is triggered until the jump input is released — requires a fresh
   *  press (not just still being held) to jump again, even once grounded again. */
  jumpHeld: boolean;
  /** Seconds remaining before another jump can trigger, set on landing. */
  jumpCooldown: number;
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
}

export interface ProjectileSimState {
  id: string;
  ownerId: string;
  weaponId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
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
