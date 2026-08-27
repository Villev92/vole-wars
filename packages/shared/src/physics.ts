import { TERRAIN_ROCK, TerrainField } from "./terrain.js";
import type { WeaponDef } from "./weapons.js";
import type { CorpseSimState, DamageEvent, PlayerInput, ProjectileSimState, VoleSimState } from "./types.js";

export const GRAVITY = 900; // px/s^2
// Matched to the client's character art proportions (apps/client/src/voleArt.ts's
// FOOT_GROUND_Y * ENTITY_SCALE, currently 15.5 * 0.225 ≈ 3.5) rather than the other way around —
// the art has no separate leg piece to stretch, so for the feet to both stay attached to the torso
// AND touch the ground exactly, the collision circle has to match how far down the torso itself
// visually reaches, not an arbitrary gameplay-only hitbox size. Keep these two in sync if either
// changes: a mismatch here reappears as the character floating above (or sinking into) the ground.
export const VOLE_RADIUS = 3.5;
export const MOVE_SPEED = 50; // px/s
// Peak jump height is JUMP_SPEED^2 / (2*GRAVITY), so it scales with the *square* of this. Raised
// 161.7 -> 200 (was ≈14.5 units high/0.36s airtime, now ≈22.2 units/0.44s) for a punchier launch —
// requested directly ("add jump speed") alongside the render-smoothing fix (see
// LOCAL_POSITION_SMOOTH_RATE in main.ts) for a jump that visibly snaps off the ground instead of
// feeling like it's still ramping up.
export const JUMP_SPEED = 200; // px/s
// Kept deliberately tiny — this isn't the anti-spam measure itself (jumpHeld's "must release and
// press again" requirement below is), just a small safety margin on top of it so landing and
// re-triggering within the same/next tick (e.g. from network jitter) can't slip through. Shaved down
// to ~1 tick at 30Hz (was 0.08, noticeably laggier) since jumpHeld's release-then-repress requirement
// is what actually blocks bunnyhopping — this only needs to survive network jitter, not add its own
// deliberate delay.
const JUMP_COOLDOWN = 0.04; // seconds

// "Coyote time": a jump press still counts as grounded for a brief window after the vole leaves the
// ground with no jump input yet (walking off a ledge, or the single-tick grounded flicker that can
// happen crossing an uneven/sloped cell boundary) — named for the cartoon physics of not falling
// until you look down. Without this, a press that lands one tick after grounded flips false reads as
// a missed jump even though the player was standing on solid ground a moment ago.
const COYOTE_TIME = 0.1; // seconds
// Jump input buffering: a press that arrives up to this long BEFORE touchdown still fires the jump
// the instant landing (or coyote time) makes it valid, rather than being silently dropped for having
// arrived one tick too early — the single biggest source of "jump feels unresponsive" complaints in
// platformers, since a player pressing jump right before impact is a completely normal input, not a
// timing mistake. Does not defeat the anti-bunnyhop rule: it only fires once per fresh press
// (jumpHeld still requires a release before the next one), never on a press held through a landing.
const JUMP_BUFFER_TIME = 0.12; // seconds

// The server steps physics in fixed 1/30s increments. stepProjectile() only samples terrain at the
// end of each step, so the step size affects exactly where a fast-moving projectile is judged to
// hit — a client stepping with a different dt would tunnel through thin terrain the server didn't
// (or vice versa) and its locally-simulated bullet would visibly land somewhere else than the
// server's authoritative explosion. Sharing this constant lets any client-side visual simulation
// (see apps/client's BulletLayer) match the server's step size and land in the same place.
export const SIM_TICK_RATE = 30;
export const SIM_DT = 1 / SIM_TICK_RATE;

/**
 * Checks every terrain cell whose center falls inside the circle, rather than a handful of
 * perimeter samples. Sparse sampling (the old approach: 8 points around the rim, 45° apart) could
 * miss a solid cell sitting between two sample rays — most visible as the vole resting on a narrow
 * ledge with a gap the sampling missed, making it look like it's floating a pixel or two above the
 * ground it's actually (mostly) standing on. A full scan over the bounding box is still cheap: at
 * VOLE_RADIUS=8 that's ~200 cell reads, called twice per vole per 30Hz tick.
 */
export function circleHitsTerrain(terrain: TerrainField, cx: number, cy: number, radius: number): boolean {
  const minX = Math.floor(cx - radius);
  const maxX = Math.ceil(cx + radius);
  const minY = Math.floor(cy - radius);
  const maxY = Math.ceil(cy + radius);
  const r2 = radius * radius;
  for (let y = minY; y <= maxY; y++) {
    const dy = y + 0.5 - cy;
    for (let x = minX; x <= maxX; x++) {
      const dx = x + 0.5 - cx;
      if (dx * dx + dy * dy <= r2 && terrain.isSolid(x, y)) return true;
    }
  }
  return false;
}

// Resolving a whole tick's movement in one jump (as if the vole simply doesn't move whenever the
// destination collides) leaves it resting wherever it was at the START of the tick it hit ground —
// after a fast fall that can be several pixels above the actual surface, reading as "floating".
// Sub-stepping at ~1 unit and stopping at the first blocked sub-step lands it right at the surface.
const MOVE_SUBSTEP = 1;

export function sweepAxis(terrain: TerrainField, x: number, y: number, dx: number, dy: number, isX: boolean): { pos: number; blocked: boolean } {
  const dist = Math.abs(dx) + Math.abs(dy); // one of these is always 0 (axis-separated calls)
  // Can't infer which axis this call is for from dx/dy here — dist === 0 means dx and dy are BOTH
  // 0 (that's what makes dist 0), so "dx !== 0" can never be true in this branch regardless of which
  // axis this call belongs to. The old `dx !== 0 ? x : y` therefore always evaluated to `y`, so any
  // idle tick (no horizontal input, dx === 0) overwrote vole.x with vole.y outright. isX is passed
  // explicitly so this doesn't depend on inferring intent from values that are always zero here.
  if (dist === 0) return { pos: isX ? x : y, blocked: false };
  const steps = Math.max(1, Math.ceil(dist / MOVE_SUBSTEP));
  const stepX = dx / steps;
  const stepY = dy / steps;
  let cx = x;
  let cy = y;
  for (let i = 0; i < steps; i++) {
    const nx = cx + stepX;
    const ny = cy + stepY;
    if (circleHitsTerrain(terrain, nx, ny, VOLE_RADIUS)) {
      return { pos: isX ? cx : cy, blocked: true };
    }
    cx = nx;
    cy = ny;
  }
  return { pos: isX ? cx : cy, blocked: false };
}

/**
 * Same substepped approach as sweepAxis, but toward an arbitrary point rather than one axis at a
 * time — used by the rope swing, whose per-tick movement isn't axis-separated (an axis-decomposed
 * X-then-Y sweep was tried here first and rejected: letting one axis move freely while the other is
 * blocked doesn't just slide along the wall, it lets gravity keep dragging the vole down the wall
 * face far past the rope's actual length, since the target position both axes are aiming for is only
 * valid as a *combined* move onto the taut-rope circle). Stops at the last clear substep and reports
 * it as blocked, rather than reporting the endpoint's collision and leaving the caller to figure out
 * where to actually put the vole.
 */
function sweepPoint(terrain: TerrainField, x0: number, y0: number, x1: number, y1: number): { x: number; y: number; blocked: boolean } {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return { x: x0, y: y0, blocked: false };
  const steps = Math.max(1, Math.ceil(dist / MOVE_SUBSTEP));
  const stepX = dx / steps;
  const stepY = dy / steps;
  let cx = x0;
  let cy = y0;
  for (let i = 0; i < steps; i++) {
    const nx = cx + stepX;
    const ny = cy + stepY;
    if (circleHitsTerrain(terrain, nx, ny, VOLE_RADIUS)) {
      return { x: cx, y: cy, blocked: true };
    }
    cx = nx;
    cy = ny;
  }
  return { x: cx, y: cy, blocked: false };
}

// Worms-style ground movement: a vole shouldn't stop dead against a curb or gentle rise it could
// obviously just step over. When a horizontal move is blocked, this retries it from progressively
// higher starting points (up to STEP_HEIGHT) and takes the smallest lift that lets the *whole* move
// through — small per-tick steps (MOVE_SPEED * one tick) mean this also makes walking up a gradual
// slope feel continuous, one small step-up per tick, rather than needing special-case slope logic.
// Deliberately smaller than VOLE_RADIUS (same ~0.75 ratio the original 6/8 had): this is meant to
// clear a curb-height bump underfoot, not let the vole climb most of its own body height, which
// would start reading as wall-climbing instead of walking.
const STEP_HEIGHT = 2.6;
const STEP_SEARCH_INCREMENT = 0.5;

// Downhill counterpart of STEP_HEIGHT: gravity alone only pulls a grounded vole down by
// GRAVITY*dt^2 in the first tick it walks past a downward slope (~1 unit at 30Hz) — on anything
// steeper than a shallow grade, MOVE_SPEED carries it past the drop-off faster than that, so it
// spends most of a downhill walk airborne for a tick at a time between micro-landings. Since jumping
// requires being grounded, that flicker reads as "jump doesn't work going downhill" even though
// jump's own logic is fine. Larger than STEP_HEIGHT on purpose — gravity is already doing part of
// the work here, this just bridges the gap sweepAxis's single-tick gravity fall doesn't cover yet.
const DOWNHILL_SNAP_DISTANCE = 4;

function tryStepUp(
  terrain: TerrainField,
  x: number,
  y: number,
  dx: number
): { x: number; y: number } | null {
  for (let lift = STEP_SEARCH_INCREMENT; lift <= STEP_HEIGHT; lift += STEP_SEARCH_INCREMENT) {
    const liftedY = y - lift;
    // Ceiling too low to even stand at this lift — no point sweeping sideways from here.
    if (circleHitsTerrain(terrain, x, liftedY, VOLE_RADIUS)) continue;
    const stepped = sweepAxis(terrain, x, liftedY, dx, 0, true);
    if (!stepped.blocked) return { x: stepped.pos, y: liftedY };
  }
  return null;
}

// sweepAxis only ever checks the position it's about to move INTO — if a vole's current position is
// itself already solid (whatever the cause: a spawn placement bug, a future terrain feature that
// fills cells, floating-point edge cases at boundaries, ...), every substep out of it reads as
// "blocked" too, since a 1px nudge from deep inside solid ground is still solid. vx/vy get zeroed
// every tick forever and the vole is permanently stuck — this is what "spawns in terrain, can't
// move" actually was. Rather than trying to make every terrain/spawn code path provably perfect,
// this runs unconditionally at the top of every tick: nearly free when not embedded (one bounding-box
// scan), and guarantees the invariant "a vole is never stuck in solid ground" regardless of how it
// got there.
const DEPENETRATE_MAX_RING = VOLE_RADIUS * 8;
const DEPENETRATE_DIRECTIONS = 16;

function findNearestClearSpot(terrain: TerrainField, x: number, y: number, radius: number): { x: number; y: number } | null {
  for (let ring = 1; ring <= DEPENETRATE_MAX_RING; ring++) {
    for (let i = 0; i < DEPENETRATE_DIRECTIONS; i++) {
      const angle = (i / DEPENETRATE_DIRECTIONS) * Math.PI * 2;
      const nx = x + Math.cos(angle) * ring;
      const ny = y + Math.sin(angle) * ring;
      if (!circleHitsTerrain(terrain, nx, ny, radius)) return { x: nx, y: ny };
    }
  }
  return null;
}

// Cast distance for the grapple rope, in terrain units — a generous cap rather than a real gameplay
// range limit (the user explicitly wants "moves until it hits something" for now; a proper max range
// is a later addition). Sized to comfortably outrange the 480x270 arena's diagonal (~550) so a shot
// toward open sky near a border still resolves against the rock border instead of stopping short.
export const ROPE_MAX_DISTANCE = 600;
const ROPE_CAST_STEP = 1;
// A rope shorter than this would let the vole clip past the anchor point itself.
export const ROPE_MIN_LENGTH = 10;
// Below this distance, an attach attempt is left pending (see updateRopeAttachment) instead of
// grabbing on immediately — cave terrain means the very first raycast tick often finds a wall just a
// few units away (right next to whatever the player happened to be standing near), which used to grab
// on instantly and leave them stuck pendulum-swinging in a tiny arc against that wall instead of the
// actual distant point they were aiming for. Recasting every held tick (already the existing
// behavior) means holding the button and sweeping the aim past a too-close wall just keeps trying
// until it reaches something far enough away to be a real anchor.
const ROPE_MIN_ATTACH_DISTANCE = 24;
const ROPE_REEL_SPEED = 42; // px/s change to rope length while reeling in/out
// Tangential thrust from the A/D swing pump — raised from 340 (was sluggish enough that fighting
// gravity/momentum to actually redirect a swing felt like it barely responded to input at all).
const ROPE_SWING_ACCEL = 560; // px/s^2

/**
 * Walks a ray from (x, y) at `angle` in fixed steps, returning the first solid terrain cell it
 * enters. Step-sampled rather than a DDA/Bresenham line so it reuses TerrainField's cell lookup
 * directly — the rope only casts once per attach attempt (not every tick), so the extra iterations
 * versus a "proper" line algorithm are negligible.
 */
export function raycastTerrain(
  terrain: TerrainField,
  x: number,
  y: number,
  angle: number,
  maxDistance: number
): { x: number; y: number } | null {
  const dx = Math.cos(angle) * ROPE_CAST_STEP;
  const dy = Math.sin(angle) * ROPE_CAST_STEP;
  const steps = Math.ceil(maxDistance / ROPE_CAST_STEP);
  let cx = x;
  let cy = y;
  for (let i = 0; i < steps; i++) {
    cx += dx;
    cy += dy;
    if (!terrain.inBounds(cx, cy)) return null;
    if (terrain.isSolid(cx, cy)) return { x: cx, y: cy };
  }
  return null;
}

// Recast every tick the button is held and not yet attached (rather than once on the initial
// press) so swinging the mouse around while holding right-click keeps trying new directions until
// one connects, instead of only getting a single shot at the angle held the instant the button went
// down.
function updateRopeAttachment(vole: VoleSimState, input: PlayerInput, terrain: TerrainField): void {
  if (!input.grapple) {
    vole.ropeActive = false;
    return;
  }
  if (vole.ropeActive) {
    // Anchor point got carved away (an explosion, someone else's) since attaching — release rather
    // than keep swinging from a point that's now open air. Checked fresh every tick against current
    // terrain rather than via a carve-event listener, matching how depenetration below re-derives
    // from current terrain state each tick instead of tracking "what changed".
    if (!terrain.isSolid(vole.ropeAnchorX, vole.ropeAnchorY)) {
      vole.ropeActive = false;
    }
    return;
  }

  const hit = raycastTerrain(terrain, vole.x, vole.y, vole.aimAngle, ROPE_MAX_DISTANCE);
  if (!hit) return;
  if (Math.hypot(hit.x - vole.x, hit.y - vole.y) < ROPE_MIN_ATTACH_DISTANCE) return;

  vole.ropeActive = true;
  vole.ropeAnchorX = hit.x;
  vole.ropeAnchorY = hit.y;
  vole.ropeLength = Math.max(ROPE_MIN_LENGTH, Math.hypot(hit.x - vole.x, hit.y - vole.y));
}

// Pendulum swing: A/D apply tangential thrust, W/S change the taut rope's length, and every tick the
// vole's position is re-projected onto the circle of that radius around the anchor with the radial
// velocity component removed — a "rigid rope", always taut, rather than a slack one that would need
// its own tension/collision handling.
function stepSwing(vole: VoleSimState, input: PlayerInput, terrain: TerrainField, dt: number): void {
  if (input.up) vole.ropeLength = Math.max(ROPE_MIN_LENGTH, vole.ropeLength - ROPE_REEL_SPEED * dt);
  // Capped at the same distance the rope could ever have been cast to attach in the first place —
  // otherwise reeling out is unbounded and a rope held taut for a long stretch (e.g. an idle player)
  // can stretch the vole arbitrarily far from the actual arena.
  if (input.down) vole.ropeLength = Math.min(ROPE_MAX_DISTANCE, vole.ropeLength + ROPE_REEL_SPEED * dt);

  const rx = vole.x - vole.ropeAnchorX;
  const ry = vole.y - vole.ropeAnchorY;
  const dist = Math.hypot(rx, ry) || 1;
  // Tangent is the radial vector rotated 90° — the direction "around" the anchor at constant radius.
  const tx = -ry / dist;
  const ty = rx / dist;

  const swing = input.right ? -1 : input.left ? 1 : 0;
  vole.vx += tx * swing * ROPE_SWING_ACCEL * dt;
  vole.vy += ty * swing * ROPE_SWING_ACCEL * dt;
  vole.vy += GRAVITY * dt;

  // Two separate passes rather than one "project onto the circle, then sweep toward that" step
  // (which this used to be): that approach stops at whatever point along the line to the target a
  // wall happens to block first, and since that point generally ISN'T back on the circle, next
  // tick's projection starts from an already-off-circle position — under a wall's continuous contact
  // this compounded tick over tick, and the vole could end up drifting tens of units past its own
  // rope length, at which point it's effectively not constrained by the rope at all anymore (which
  // is what actually let it get stuck: an unconstrained mass resting against a wall under gravity,
  // far from anywhere the tangential swing thrust could meaningfully reach it back onto the circle).
  //
  // Pass 1: ordinary terrain-swept free-flight motion, rope not considered yet.
  const oldX = vole.x;
  const oldY = vole.y;
  const freeTargetX = oldX + vole.vx * dt;
  const freeTargetY = oldY + vole.vy * dt;
  const freeSwept = sweepPoint(terrain, oldX, oldY, freeTargetX, freeTargetY);
  vole.x = freeSwept.x;
  vole.y = freeSwept.y;
  if (freeSwept.blocked) {
    // Only cancel velocity on the axis actually obstructed, not the vole's whole velocity — wiping
    // it completely every blocked tick was the actual bug behind "touching terrain while on the
    // rope, can't swing away": each tick's tangential swing thrust is tiny on its own
    // (ROPE_SWING_ACCEL * one tick), so it needs to accumulate across several ticks of held input to
    // build up enough speed to clear an obstruction, and a full reset every tick meant it never got
    // the chance to. Checked per-axis (same as stepVole's own grounded movement) rather than
    // cancelling whatever the diagonal move's own direction was — that direction is by definition
    // 100% of the velocity, so "the component along it" is trivially everything, right back to the
    // same bug.
    const xTest = sweepAxis(terrain, oldX, oldY, freeTargetX - oldX, 0, true);
    if (xTest.blocked) vole.vx = 0;
    const yTest = sweepAxis(terrain, oldX, oldY, 0, freeTargetY - oldY, false);
    if (yTest.blocked) vole.vy = 0;
  }

  // Pass 2: if that left the vole farther than the rope allows, yank it back onto the circle — also
  // swept, so the yank itself can't tunnel through terrain — re-anchoring to the *true* circle fresh
  // every tick instead of interpolating toward one, which is what stops the drift from compounding.
  const arx = vole.x - vole.ropeAnchorX;
  const ary = vole.y - vole.ropeAnchorY;
  const adist = Math.hypot(arx, ary) || 1;
  if (adist > vole.ropeLength) {
    const anx = arx / adist;
    const any = ary / adist;
    const clampX = vole.ropeAnchorX + anx * vole.ropeLength;
    const clampY = vole.ropeAnchorY + any * vole.ropeLength;
    const pullSwept = sweepPoint(terrain, vole.x, vole.y, clampX, clampY);
    vole.x = pullSwept.x;
    vole.y = pullSwept.y;
    if (!pullSwept.blocked) {
      // Drop the velocity component pointing outward along the (now taut) rope, keeping only the
      // tangential/swinging part — otherwise the vole would keep accelerating radially every tick
      // even though its position is clamped, storing up energy that snaps out the instant the rope
      // releases.
      const radial = vole.vx * anx + vole.vy * any;
      vole.vx -= radial * anx;
      vole.vy -= radial * any;
    }
  }

  vole.grounded = false;
}

export function stepVole(vole: VoleSimState, input: PlayerInput, terrain: TerrainField, dt: number): void {
  if (!vole.alive) return;

  if (circleHitsTerrain(terrain, vole.x, vole.y, VOLE_RADIUS)) {
    const clear = findNearestClearSpot(terrain, vole.x, vole.y, VOLE_RADIUS);
    if (clear) {
      vole.x = clear.x;
      vole.y = clear.y;
    }
  }

  vole.aimAngle = input.aimAngle;

  updateRopeAttachment(vole, input, terrain);

  if (vole.ropeActive) {
    stepSwing(vole, input, terrain, dt);
    return;
  }

  vole.vx = input.left ? -MOVE_SPEED : input.right ? MOVE_SPEED : 0;

  // Captured before the jump trigger below can flip vole.grounded to false, and used again after
  // this tick's Y-sweep recomputes it — see the landing-edge check at the bottom of this function.
  const wasGrounded = vole.grounded;

  vole.jumpCooldown = Math.max(0, vole.jumpCooldown - dt);
  // Decayed from last tick's value before this tick's landing (below) potentially refreshes it —
  // same "reflects state as of the end of the previous tick" timing as wasGrounded above.
  vole.coyoteTimer = Math.max(0, vole.coyoteTimer - dt);
  vole.jumpBufferTimer = Math.max(0, vole.jumpBufferTimer - dt);

  // Requires input.jump to have gone false at some point since the last jump — holding the button
  // down through a landing (jumpHeld stays true the whole time) does NOT re-trigger; the player has
  // to actually release and press again. This is the actual anti-bunnyhop rule; buffering below only
  // changes WHEN a fresh press is allowed to land, never whether repeated presses are required.
  if (!input.jump) vole.jumpHeld = false;
  // A fresh press is "used up" immediately (jumpHeld = true) whether or not it can jump this instant
  // — it either fires below (grounded/coyote) or gets parked in the buffer to fire on an imminent
  // landing. Either way, holding through that landing must not re-trigger, so jumpHeld still flips
  // the moment the press is registered, not only once a jump actually launches.
  if (input.jump && !vole.jumpHeld) {
    vole.jumpHeld = true;
    vole.jumpBufferTimer = JUMP_BUFFER_TIME;
  }
  if ((wasGrounded || vole.coyoteTimer > 0) && vole.jumpBufferTimer > 0 && vole.jumpCooldown <= 0) {
    vole.vy = -JUMP_SPEED;
    vole.grounded = false;
    vole.jumpBufferTimer = 0;
    vole.coyoteTimer = 0;
  }

  vole.vy += GRAVITY * dt;

  const moveX = sweepAxis(terrain, vole.x, vole.y, vole.vx * dt, 0, true);
  if (moveX.blocked && vole.grounded && vole.vx !== 0) {
    // Blocked walking into a rise while grounded — see if it's short enough to just step over
    // before giving up and treating it as a wall.
    const stepped = tryStepUp(terrain, vole.x, vole.y, vole.vx * dt);
    if (stepped) {
      vole.x = stepped.x;
      vole.y = stepped.y;
    } else {
      vole.x = moveX.pos;
      vole.vx = 0;
    }
  } else {
    vole.x = moveX.pos;
    if (moveX.blocked) vole.vx = 0;
  }

  const moveY = sweepAxis(terrain, vole.x, vole.y, 0, vole.vy * dt, false);
  vole.y = moveY.pos;
  if (moveY.blocked) {
    if (vole.vy > 0) vole.grounded = true;
    vole.vy = 0;
  } else {
    vole.grounded = false;

    // Was on the ground at the start of this tick and gravity's own fall this tick (still tiny —
    // vy>=0 rules out a jump just launched this same tick) didn't reach anything: probe a bit further
    // down before conceding it's airborne, so a downward slope keeps reading as grounded instead of
    // flickering airborne every tick. A genuine ledge/cliff is taller than this and correctly falls
    // through untouched.
    if (wasGrounded && vole.vy >= 0) {
      const snap = sweepAxis(terrain, vole.x, vole.y, 0, DOWNHILL_SNAP_DISTANCE, false);
      if (snap.blocked) {
        vole.y = snap.pos;
        vole.vy = 0;
        vole.grounded = true;
      }
    }
  }

  if (!wasGrounded && vole.grounded) {
    vole.jumpCooldown = JUMP_COOLDOWN;
  }
  // Refresh every grounded tick (not just on the falling->grounded transition above) so coyote time
  // always counts from the LAST tick the vole was actually standing on something, however that ended.
  if (vole.grounded) {
    vole.coyoteTimer = COYOTE_TIME;
  }
}

// A dead vole's corpse reuses the living collision size (fits through the same passages the vole
// itself did) and only ever falls straight down — no horizontal movement, no jump, no depenetration
// (terrain only ever LOSES solidity via carveCircle, never gains it, so a corpse resting on solid
// ground can't become newly embedded the way a spawning vole sometimes does).
const CORPSE_RADIUS = VOLE_RADIUS;
// How far below its own center to probe for support each tick while grounded — cheap enough to run
// unconditionally, and only needs to be a small nudge past the collision circle's own edge to detect
// "the ground just under me is now gone" without re-running a full sweep for every resting corpse.
const CORPSE_SUPPORT_PROBE = 1;

// How far to each side of the corpse's own x to sample ground height for its rest tilt — roughly the
// art's own length (see skeletonArt.ts) so the sampled slope reflects the ground actually under the
// whole body, not just the point directly below its center.
const CORPSE_SLOPE_SAMPLE_OFFSET = 4;
// Vertical window (each way from the corpse's own y) searched for the topmost solid cell in a slope
// sample column — wide enough to find the surface under a landed corpse even after it's sunk a
// couple of units into a substep, narrow enough that it can't reach past a nearby cliff/overhang and
// sample unrelated ground several body-lengths away.
const CORPSE_SLOPE_SEARCH_RANGE = 12;
// Caps how far off-horizontal the rest tilt can go, so a corpse landing right at the lip of a steep
// or vertical drop reads as "resting near the edge" rather than pinned flat up a near-vertical face.
const CORPSE_MAX_TILT = 0.9; // radians, ~52°

/** Topmost solid cell in column x within CORPSE_SLOPE_SEARCH_RANGE of yCenter, or null if the whole
 *  window is empty (e.g. sampling out past the edge of a ledge, over open air). */
function findSurfaceY(terrain: TerrainField, x: number, yCenter: number): number | null {
  const minY = Math.floor(yCenter - CORPSE_SLOPE_SEARCH_RANGE);
  const maxY = Math.ceil(yCenter + CORPSE_SLOPE_SEARCH_RANGE);
  for (let y = minY; y <= maxY; y++) {
    if (terrain.isSolid(x, y)) return y;
  }
  return null;
}

/**
 * Rest tilt for a corpse landing at (x, y): the angle between ground-surface samples a fixed offset
 * to either side, so the body reads as lying flush along the actual slope underneath it instead of
 * always flat — a corpse landing on a steep bank with only one edge actually touching down otherwise
 * looks like it's floating above the rest of its own body. Falls back to 0 (flat) if either sample
 * misses solid ground entirely (e.g. one side hangs off a ledge) rather than guessing.
 */
function computeRestAngle(terrain: TerrainField, x: number, y: number): number {
  const leftY = findSurfaceY(terrain, x - CORPSE_SLOPE_SAMPLE_OFFSET, y);
  const rightY = findSurfaceY(terrain, x + CORPSE_SLOPE_SAMPLE_OFFSET, y);
  if (leftY === null || rightY === null) return 0;
  const angle = Math.atan2(rightY - leftY, CORPSE_SLOPE_SAMPLE_OFFSET * 2);
  return Math.max(-CORPSE_MAX_TILT, Math.min(CORPSE_MAX_TILT, angle));
}

/**
 * Vertical-only physics for a dead vole's skeleton: rests in place while supported, and starts
 * falling (reusing the same substepped sweepAxis as stepVole) the instant an explosion carves away
 * the ground underneath it, until it lands on whatever terrain (or the rock border) is now below —
 * recomputing its rest tilt (see computeRestAngle) each time it lands, since the ground it settles on
 * next is generally not the same shape as what it left.
 */
export function stepCorpse(corpse: CorpseSimState, terrain: TerrainField, dt: number): void {
  if (corpse.grounded) {
    if (circleHitsTerrain(terrain, corpse.x, corpse.y + CORPSE_SUPPORT_PROBE, CORPSE_RADIUS)) return;
    corpse.grounded = false;
  }

  corpse.vy += GRAVITY * dt;
  const moveY = sweepAxis(terrain, corpse.x, corpse.y, 0, corpse.vy * dt, false);
  corpse.y = moveY.pos;
  if (moveY.blocked) {
    corpse.grounded = true;
    corpse.vy = 0;
    corpse.angle = computeRestAngle(terrain, corpse.x, corpse.y);
  }
}

export type HitPart = "head" | "body";

export interface VoleHit {
  targetId: string;
  part: HitPart;
}

// Direct-hit hitboxes for projectiles, layered on top of the same rig voleArt.ts renders: O
// (vole.x/y) sits at the neck, so the body hitbox reuses the movement collision circle as-is
// (VOLE_RADIUS already spans neck-to-sole, see its own comment) rather than a second, separately-
// tuned radius. The head gets its own zone centered a full VOLE_RADIUS above O — i.e. tangent to the
// body circle's own top edge, not nested inside it. That placement is deliberate: an earlier version
// centered the head circle much closer to O (just barely above it), which put the ENTIRE head
// hitbox inside the body circle's radius (since offset + headRadius < VOLE_RADIUS) — any bullet
// converging on the head first had to cross the strictly larger body circle surrounding it, so a
// "headshot" could never actually resolve as anything but a body hit, from any approach angle.
// Tangent placement guarantees a real head-only band (approaching from above, or level with the top
// of the head) that a shot can reach without ever entering the body circle first.
const HEAD_HIT_RADIUS = 1.8;
const HEAD_CENTER_Y_OFFSET = -VOLE_RADIUS; // terrain units above vole.y — head sits above the neck
const BODY_HIT_RADIUS = VOLE_RADIUS;

// Only what hit-testing needs — lets the client's local (visual-only) bullet re-simulation
// (apps/client/src/bullets.ts) pass its own synced vole render state straight in without building a
// full VoleSimState just for this.
export type VoleHitTarget = Pick<VoleSimState, "id" | "x" | "y" | "alive">;

// A just-fired projectile spawns near its owner (see GameRoom.handleFire) — ignore hits on that
// owner until it has flown this far, so it can't detonate on the shooter's own head/body coming out
// of the barrel. Comfortably clears BODY_HIT_RADIUS + the head zone above it, plus margin.
export const PROJECTILE_OWNER_CLEARANCE = 9;

/** Checked once per sampled point along a projectile's step, same idea as circleHitsTerrain.
 *  `ignoreVoleId` (the still-close shooter, early in the projectile's life) is skipped. */
function findVoleHit(voles: VoleHitTarget[], x: number, y: number, ignoreVoleId?: string): VoleHit | null {
  for (const vole of voles) {
    if (!vole.alive || vole.id === ignoreVoleId) continue;
    const hdx = x - vole.x;
    const hdy = y - (vole.y + HEAD_CENTER_Y_OFFSET);
    if (hdx * hdx + hdy * hdy <= HEAD_HIT_RADIUS * HEAD_HIT_RADIUS) {
      return { targetId: vole.id, part: "head" };
    }
    const bdx = x - vole.x;
    const bdy = y - vole.y;
    if (bdx * bdx + bdy * bdy <= BODY_HIT_RADIUS * BODY_HIT_RADIUS) {
      return { targetId: vole.id, part: "body" };
    }
  }
  return null;
}

export interface ProjectileStepResult {
  exploded: boolean;
  x: number;
  y: number;
  /** Set when `exploded` resolved from hitting a vole directly, rather than terrain/bounds. */
  hit: VoleHit | null;
  /** Distance (within this call's traveled segment) actually spent inside solid dirt/stone while a
   *  piercing weapon flew through it without exploding — 0 for a non-piercing weapon or whenever no
   *  solid material was in the way. Lets the caller track "how much terrain has this projectile
   *  actually destroyed" (see WeaponDef.pierceTerrainLimit) separately from total distance flown,
   *  which counts open-air travel too. */
  pierceDistance: number;
}

/**
 * Rough outward surface normal at a solid-terrain point: sum the directions to every solid cell in a
 * small neighbourhood (weighted by 1/distance) and point away from that. Falls back to straight up
 * (a floor) when there's no gradient to read. Used by stepProjectile to bounce grenades — good
 * enough to kick off floors, walls and slopes believably, not a precise contact solver.
 */
export function terrainNormal(terrain: TerrainField, x: number, y: number): { x: number; y: number } {
  let sx = 0;
  let sy = 0;
  const radius = 3;
  for (let oy = -radius; oy <= radius; oy++) {
    for (let ox = -radius; ox <= radius; ox++) {
      if (ox === 0 && oy === 0) continue;
      if (!terrain.isSolid(x + ox, y + oy)) continue;
      const d = Math.hypot(ox, oy);
      sx += ox / d;
      sy += oy / d;
    }
  }
  const len = Math.hypot(sx, sy);
  if (len < 1e-4) return { x: 0, y: -1 };
  return { x: -sx / len, y: -sy / len };
}

export function stepProjectile(
  proj: ProjectileSimState,
  weapon: WeaponDef,
  terrain: TerrainField,
  dt: number,
  voles: VoleHitTarget[] = [],
  // Remaining terrain-piercing budget (see WeaponDef.pierceTerrainLimit) for THIS call only — once
  // the solid material sampled within this single step would exceed it, stop right there instead of
  // finishing the step, so the cutoff isn't just tick-granular the way pierceRange's is. Irrelevant
  // for a non-piercing weapon; defaults to unlimited so existing callers that never pass it (or a
  // piercing weapon with no configured limit) behave as before.
  pierceBudget: number = Infinity,
  // The shooter, while the projectile is still within PROJECTILE_OWNER_CLEARANCE of the barrel — hits
  // on this vole are ignored so a shot fired point-blank into a wall you're hugging carves the wall
  // instead of detonating on your own head. The caller passes it only for that early window.
  ignoreVoleId?: string
): ProjectileStepResult {
  proj.vy += GRAVITY * weapon.gravityScale * dt;
  const nextX = proj.x + proj.vx * dt;
  const nextY = proj.y + proj.vy * dt;

  // A fast projectile can move many pixels in one step (~14px/step for the bazooka at 30Hz) —
  // checking terrain only at the endpoint lets it tunnel clean through thin walls. Sample along
  // the segment it swept this step instead, at sub-pixel intervals, so even a lone 1px-wide dirt
  // speck can't fall between two samples and get skipped. The same sampling covers direct vole
  // hits, so a bullet can't tunnel through a character at high speed any more than it can terrain.
  const dx = nextX - proj.x;
  const dy = nextY - proj.y;
  const segmentLength = Math.hypot(dx, dy);
  const sampleCount = Math.max(1, Math.ceil(segmentLength / 0.5));
  const sampleStep = segmentLength / sampleCount;
  let pierceDistance = 0;
  for (let i = 1; i <= sampleCount; i++) {
    const t = i / sampleCount;
    const x = proj.x + dx * t;
    const y = proj.y + dy * t;
    const hit = findVoleHit(voles, x, y, ignoreVoleId);
    if (hit) {
      return { exploded: true, x, y, hit, pierceDistance };
    }
    if (terrain.isSolid(x, y)) {
      // A bouncing weapon (grenade — see WeaponDef.bounces) rides out its first `bounces` terrain
      // contacts and detonates on the next. Reflect off an estimated surface normal, pull back to
      // just before contact, and end the step there; the leftover motion resumes next tick with the
      // new velocity. A vole hit above still detonates it regardless of bounce count.
      if (weapon.bounces !== undefined) {
        if ((proj.bounces ?? 0) >= weapon.bounces) {
          return { exploded: true, x, y, hit: null, pierceDistance };
        }
        const n = terrainNormal(terrain, x, y);
        const clearT = (i - 1) / sampleCount;
        const bx = proj.x + dx * clearT;
        const by = proj.y + dy * clearT;
        const vDotN = proj.vx * n.x + proj.vy * n.y;
        const restitution = weapon.bounceRestitution ?? 0.5;
        proj.vx = (proj.vx - 2 * vDotN * n.x) * restitution;
        proj.vy = (proj.vy - 2 * vDotN * n.y) * restitution;
        proj.x = bx + n.x * 0.75;
        proj.y = by + n.y * 0.75;
        proj.bounces = (proj.bounces ?? 0) + 1;
        return { exploded: false, x: proj.x, y: proj.y, hit: null, pierceDistance };
      }
      // A piercing weapon (sniper — see WeaponDef.piercing) only stops on indestructible rock or
      // running out of pierceBudget; dirt/stone otherwise don't block it here — the caller
      // (GameRoom.update) is what actually carves that material away as it flies through, tick by
      // tick, rather than this function stopping at the first solid cell like every other weapon.
      if (!weapon.piercing || terrain.get(Math.floor(x), Math.floor(y)) === TERRAIN_ROCK) {
        return { exploded: true, x, y, hit: null, pierceDistance };
      }
      pierceDistance += sampleStep;
      if (pierceDistance >= pierceBudget) {
        return { exploded: true, x, y, hit: null, pierceDistance };
      }
    }
  }

  proj.x = nextX;
  proj.y = nextY;
  return { exploded: false, x: nextX, y: nextY, hit: null, pierceDistance };
}

export interface ExplosionResult {
  carve: ReturnType<TerrainField["carveCircle"]>;
  damageEvents: DamageEvent[];
}

// A direct hit deals the weapon's own damage (headshots multiplied by headshotMultiplier, default
// 2x — see WeaponDef) to the vole actually struck. Anyone else merely caught in the blast radius
// takes weapon.splashDamage (or this small flat default) regardless of how close they were — UNLESS
// the weapon sets linearFalloff (grenade), in which case splash scales linearly from the full
// `damage` at the centre down to 0 at explosionRadius, rounded to the nearest integer.
const DEFAULT_HEADSHOT_MULTIPLIER = 2;
const DEFAULT_SPLASH_DAMAGE = 2;

export function applyExplosion(
  terrain: TerrainField,
  cx: number,
  cy: number,
  weapon: WeaponDef,
  voles: VoleSimState[],
  directHit: VoleHit | null = null
): ExplosionResult {
  const carve = terrain.carveCircle(cx, cy, weapon.carveRadius);
  const damageEvents: DamageEvent[] = [];

  for (const vole of voles) {
    if (!vole.alive) continue;
    const dx = vole.x - cx;
    const dy = vole.y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const isDirectTarget = directHit !== null && vole.id === directHit.targetId;
    if (!isDirectTarget && dist > weapon.explosionRadius) continue;

    const falloff = dist > 0.001 ? Math.min(1, 1 - dist / weapon.explosionRadius) : 1;
    const amount = isDirectTarget
      ? directHit!.part === "head"
        ? weapon.damage * (weapon.headshotMultiplier ?? DEFAULT_HEADSHOT_MULTIPLIER)
        : weapon.damage
      : weapon.linearFalloff
        ? Math.round(weapon.damage * Math.max(0, falloff))
        : weapon.splashDamage ?? DEFAULT_SPLASH_DAMAGE;
    const knockback = 260 * Math.max(falloff, 0);
    const nx = dist > 0.001 ? dx / dist : 0;
    const ny = dist > 0.001 ? dy / dist : -1;

    // Right at the blast edge a linear-falloff weapon does 0 — no blood/knockback event for it.
    if (!isDirectTarget && amount <= 0) continue;

    vole.vx += nx * knockback;
    vole.vy += ny * knockback;

    damageEvents.push({
      targetId: vole.id,
      amount,
      knockbackX: nx * knockback,
      knockbackY: ny * knockback,
    });
  }

  return { carve, damageEvents };
}
