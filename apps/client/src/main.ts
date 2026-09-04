import { Application, BlurFilter, ColorMatrixFilter, Container, Graphics, Text, type ColorMatrix } from "pixi.js";
import { getStateCallbacks } from "colyseus.js";
import {
  BURROW_DURATION,
  DEFAULT_WEAPON_ID,
  TERRAIN_STONE,
  TerrainField,
  WEAPONS,
  type PlayerInput,
  type ProjectileSimState,
  type VoleHitTarget,
} from "@vole-wars/shared";
import { connect, requestTerrain, sendDig, sendFire, sendFlame, sendInput, sendRailgun } from "./net.js";
import { TerrainRenderer, DIRT_COLOR, STONE_COLOR } from "./terrainRenderer.js";
import { BloodRenderer } from "./bloodRenderer.js";
import { createCaveBackground } from "./caveBackground.js";
import { createSkeleton, loadSkeletonTexture } from "./skeletonArt.js";
import { InputTracker } from "./input.js";
import { createFoot, createGun, createHead, createTorso, loadHeroArt, setGunVisual, setGunTint, ENTITY_SCALE, GUN_SHOULDER_OFFSET, type HeroId, type VoleTextures } from "./voleArt.js";
import { HEROES, heroPortraitUrl } from "./heroes.js";
import {
  drawAkBullet,
  drawBazookaExplosion,
  drawBullet,
  drawFlameBullet,
  drawGrenadeBullet,
  drawImpactFlash,
  drawMineBullet,
  drawMineImpactFlash,
  drawMinigunBullet,
  drawMissileBullet,
  drawRailgunBullet,
  drawRailgunImpactFlash,
  drawShotgunPellet,
  drawSniperBullet,
} from "./bulletArt.js";
import { BulletLayer } from "./bullets.js";
import { ParticleLayer } from "./particles.js";
import { FlameLayer, type BurnMarker, type FlamingVole } from "./flame.js";
import { RailgunLayer, type RailBeamView, type RailChargeView } from "./railgun.js";
import { GrenadeAimGuide } from "./grenadeAim.js";
import { DamageNumberLayer } from "./damageNumbers.js";
import { MineLayer, type MineView } from "./mines.js";
import { ExplosionLayer } from "./explosions.js";
import { Minimap, type MinimapVole } from "./minimap.js";
import {
  getMasterVolume,
  playAkGunshot,
  playDash,
  startBurrowSwirlSound,
  stopBurrowSwirlSound,
  playBazookaExplosion,
  playBazookaFire,
  playGrenadeBounce,
  playGrenadeExplosion,
  playGrenadeSokka,
  playGrenadeThrow,
  playGrunt,
  playShotgunReload,
  playShotgunShoot,
  playSniperShot,
  playTerrainImpact,
  setMasterVolume,
  startFlameLoop,
  startMinigunLoop,
  startRailgunChargeSound,
  startRailgunFireSound,
  stopFlameLoop,
  stopMinigunLoop,
  stopRailgunChargeSound,
  stopRailgunFireSound,
  unlockAudio,
} from "./sound.js";
import { WeaponSelector } from "./weaponSelector.js";
import { loadWeaponIconTextures, type TexturedWeaponId } from "./weaponIcons.js";

// Helmet colour = allegiance at a glance. For free-for-all deathmatch: your own vole's helmet is
// green, every other vole's is red. Team deathmatch (not built yet) will add a third case —
// teammates in yellow (0xffca28) — which slots in at helmetColorFor below.
const HELMET_SELF = 0x4caf50; // green
const HELMET_ENEMY = 0xef5350; // red

// The server only ticks (and broadcasts state) at 30Hz. Rendering vole position/aim straight from
// the last-received patch makes motion visibly step every ~33ms even on a 60/144Hz display. Instead
// each view keeps its own smoothed "render" pose that eases toward the latest server pose every
// animation frame, so movement reads as fluid regardless of network tick rate or jitter.
const POSITION_SMOOTH_RATE = 18;
// The local player's own vole uses a much snappier rate than remote ones (below): there's no network
// jitter to hide for input you just pressed yourself, so the same easing that keeps a REMOTE player's
// motion from stepping just reads as input lag on your own character — most noticeable on jump, a
// sudden velocity reversal, where the ~55ms time constant POSITION_SMOOTH_RATE=18 works out to (95%
// caught up only after ~165ms) was the actual source of "pressing space doesn't feel instant", not
// the underlying physics (JUMP_SPEED launches at full speed the very tick it triggers, no ramp-up).
const LOCAL_POSITION_SMOOTH_RATE = 55;
const ANGLE_SMOOTH_RATE = 22;
// Shift+scroll zoom (see zoomLevel below) is a core play loop, not just a nice-to-have — scrolled
// out to scout, zoomed in to fight — so snapping straight to each wheel tick's target reads as
// jarring exactly when the player is mid-fight. renderZoom eases toward zoomLevel the same way
// vole poses ease toward server state, so the zoom itself glides instead of stepping.
const ZOOM_SMOOTH_RATE = 9;
// Camera follow (see applyCamera). The view no longer pins the local vole to the exact screen
// centre — that made every 1-2px terrain-step nudge to the vole's Y shove the whole world. Instead
// a separate `camFocus` point trails the vole: it only starts chasing once the vole is more than
// CAM_DEADZONE_* world units off it (bigger on Y, where the jitter shows), then eases in at
// CAM_FOLLOW_RATE. Within the deadzone the camera holds perfectly still.
const CAM_DEADZONE_X = 4;
const CAM_DEADZONE_Y = 9;
const CAM_FOLLOW_RATE = 11;

// Walk cycle: near/far feet swing fore/aft and lift on alternating halves of one sine, in vole-local
// units (see voleArt.ts's header for that unit system) added on top of their own static hip-spread
// offset. The head gets a small bob at double that frequency — one dip per footfall, both feet
// landing twice per full swing period. WALK_EASE_RATE fades the whole thing in/out smoothly rather
// than snapping it on/off the instant vx crosses zero, which read as a pop.
const WALK_CYCLE_SPEED = 10;
const WALK_EASE_RATE = 10;
const FOOT_SWING_X = 1.8;
const FOOT_LIFT_Y = 1.2;
const HEAD_BOB_Y = 0.5;

// Burrow superpower's visual (see renderVole's burrowing branch): every rig part collapses onto O and
// flips together in sync — scale.x cycling through 0 at BURROW_SPIN_SPEED rad/s of phase, not an
// in-plane rotation — reading as the whole body spinning around a vertical axis (like a transformation
// sequence), not tumbling nose-over-tail. BURROW_SHRINK is how much of the rig's scale is lost by the
// time the descent (burrowElapsed / BURROW_DURATION) completes; BURROW_DUST_RATE is dust motes (see
// particles.ts's burrowSwirl) spawned per second while it's active.
const BURROW_SPIN_SPEED = 44; // rad/s of flip phase (16 -> 22 -> doubled to 44 per user requests)
const BURROW_SHRINK = 0.3; // fraction of scale lost by the end of the descent
const BURROW_DUST_RATE = 34; // motes/second (bumped from 26 to feed the taller tornado funnel)
// The tornado funnel (see drawTornado) isn't spun as a rigid shape — that read as a windmill. It's
// redrawn every frame with a scrolling `phase` (this rate * burrowElapsed) that churns its stacked
// bands sideways so the column looks like it's turning and rising.
const TORNADO_CHURN_SPEED = 7; // rad/s the funnel's band-sway phase advances

// Sending input on every animation frame (up to 240Hz on some displays) floods the socket for no
// benefit — the server only samples input once per its own 30Hz tick. Capping the send rate cuts
// that traffic without any loss of responsiveness.
const INPUT_SEND_RATE = 30;
const INPUT_SEND_INTERVAL = 1 / INPUT_SEND_RATE;

// Only the local player's held-weapon art tracks the weapon selector (see setGunVisual's own doc
// comment for why remote voles don't). All ten textured weapons are gun-only art (no arm/hand,
// unlike the default gun.png every vole starts with) at the same 1040x340 source resolution — scale
// is still per-weapon rather than shared, though: each source drawing fills a different fraction of
// its own canvas (confirmed with a quick alpha-bounding-box script, not eyeballed), so an equal scale
// would visually over/undersize some relative to the others. Anchors are each weapon's own
// grip/trigger area — the natural "this is where a hand would be" pivot point now that there's no
// arm sprite to carry an actual hand there. grenade and mine are the exception: their art is a small
// centered icon (not a full-width gun), so both anchor and scale target the object itself rather
// than a grip point on a barrel. missile's art is a bare rocket (no gun body at all) — anchored
// mid-body near the fins, same idea as gripping a held rocket by hand like the grenade/mine.
const HELD_WEAPON_VISUALS: Record<TexturedWeaponId, { anchorX: number; anchorY: number; scale: number }> = {
  ak47: { anchorX: 0.298, anchorY: 0.662, scale: 0.034 },
  bazooka: { anchorX: 0.413, anchorY: 0.647, scale: 0.045 },
  sniper: { anchorX: 0.41, anchorY: 0.66, scale: 0.042 },
  railgun: { anchorX: 0.37, anchorY: 0.65, scale: 0.044 },
  flamethrower: { anchorX: 0.44, anchorY: 0.66, scale: 0.046 },
  grenade: { anchorX: 0.5, anchorY: 0.55, scale: 0.055 },
  shotgun: { anchorX: 0.37, anchorY: 0.68, scale: 0.043 },
  minigun: { anchorX: 0.26, anchorY: 0.76, scale: 0.044 },
  mine: { anchorX: 0.5, anchorY: 0.58, scale: 0.041 },
  missile: { anchorX: 0.42, anchorY: 0.5, scale: 0.046 },
};

// Per-weapon flight/impact visuals for the "fire" broadcast below — falls back to the bazooka's own
// plain rocket art + the default orange flash for any weapon without its own entry (every
// WEAPON_IDS slot has one now — see weapons.ts — so this fallback is currently unreachable, kept as
// a safety net).
const BULLET_VISUALS: Partial<Record<string, { draw: (g: Graphics) => void; impact: (g: Graphics, t: number) => void }>> = {
  ak47: { draw: drawAkBullet, impact: drawImpactFlash },
  sniper: { draw: drawSniperBullet, impact: drawImpactFlash },
  bazooka: { draw: drawBullet, impact: drawBazookaExplosion },
  railgun: { draw: drawRailgunBullet, impact: drawRailgunImpactFlash },
  flamethrower: { draw: drawFlameBullet, impact: drawImpactFlash },
  grenade: { draw: drawGrenadeBullet, impact: drawImpactFlash },
  shotgun: { draw: drawShotgunPellet, impact: drawImpactFlash },
  minigun: { draw: drawMinigunBullet, impact: drawImpactFlash },
  mine: { draw: drawMineBullet, impact: drawMineImpactFlash },
  missile: { draw: drawMissileBullet, impact: drawImpactFlash },
};
const DEFAULT_BULLET_VISUAL = { draw: drawBullet, impact: drawImpactFlash };

// ── Minigun overheat model ──────────────────────────────────────────────────────────────────────
// The minigun has no per-shot cooldown and no magazine — instead it builds HEAT, tracked as a 0..1
// fraction (0 = cold, 1 = overheated). Firing raises heat; releasing the trigger bleeds it off.
// All values here are meant to be tuned by feel — see the "Minigun: overheat" block in the ticker
// and the local-player barrel tint / reload-icon handling in renderVole for how they combine.
const MINIGUN_HEAT = {
  /** Seconds of continuous fire to go from cold (0) to overheated (1). Heat fraction maps 1:1 onto a
   *  playback position in minigun.mp3 (heat × this), so the barrel sound stays in sync with the
   *  barrel colour however the player feathers the trigger. The clip's audible fire is ~13.35 s
   *  (RMS-envelope scan); at 8 s we simply stop partway through it, which sounds like the gun
   *  cutting out — fine. Keep this ≤ ~13.35, or playback walks into the clip's silent reverb tail. */
  FIRE_SECONDS: 8,
  /** While HEATING UP (or bleeding off after an early release), the barrel tints toward TINT_COLOR
   *  linearly across TINT_START..TINT_FULL heat — below TINT_START there's no tint. During the
   *  overheat LOCKOUT the tint instead tracks the cooldown counter directly (full red at 0 s → none
   *  at OVERHEAT_LOCKOUT_SECONDS), which is what heat itself is doing then anyway. See renderVole. */
  TINT_START: 0.5,
  /** Heat fraction at which the barrel is fully TINT_COLOR — same point as overheat. */
  TINT_FULL: 1.0,
  /** Barrel tint colour at full heat, lerped up from 0xffffff (untinted). */
  TINT_COLOR: 0xff3b2f,
  /** On overheat, firing is locked out for this long while heat (and the barrel redness) ramp
   *  1 → 0. After it, fully cold. */
  OVERHEAT_LOCKOUT_SECONDS: 6.0,
  /** While the trigger is released and NOT overheated, heat bleeds off this fast, in fraction per
   *  second. 1/3 ⇒ a full 100→0 cool takes 3 s (vs. 6 s if you push it to an overheat). */
  RELEASE_COOL_PER_SECOND: 1 / 3,
  /** How long the "OVERHEAT" banner stays up after an overheat (kept equal to the lockout). */
  OVERHEAT_NOTICE_SECONDS: 6.0,
  /** World units the "OVERHEAT" banner floats above the local vole's origin (its feet). */
  OVERHEAT_TEXT_RISE: 13,
  // ── Overheat smoke (see the smoke-emit block after the renderVole loop) ──
  /** Heat fraction above which the barrel starts smoking. */
  SMOKE_START: 0.5,
  /** Puffs per second at heat 1 while NOT overheated (scales linearly from 0 at SMOKE_START). */
  SMOKE_RATE_MAX: 16,
  /** Emission multiplier applied on top of SMOKE_RATE_MAX during the overheat lockout. */
  SMOKE_OVERHEAT_MULT: 2.2,
  /** Terrain units from the gun's shoulder pivot, along the aim, to the smoke emit point (muzzle). */
  SMOKE_MUZZLE_FORWARD: 6,
} as const;

/** Linear RGB interpolation between two 0xRRGGBB colours (t clamped 0..1). */
function lerpColor(from: number, to: number, t: number): number {
  const k = Math.max(0, Math.min(1, t));
  const fr = (from >> 16) & 0xff;
  const fg = (from >> 8) & 0xff;
  const fb = from & 0xff;
  const r = Math.round(fr + (((to >> 16) & 0xff) - fr) * k);
  const g = Math.round(fg + (((to >> 8) & 0xff) - fg) * k);
  const b = Math.round(fb + ((to & 0xff) - fb) * k);
  return (r << 16) | (g << 8) | b;
}

// A blue self-marker for the local player only, so a glance is enough to tell which character is
// yours: a clone of the character rig sitting behind the real one, flattened to a solid blue
// silhouette (ColorMatrixFilter) then given a narrow blur (BlurFilter) so only a bright rim peeks
// out around the sharp real art — a glowing outline tracing the body, head and feet. The gun is
// deliberately NOT cloned: a long barrel swinging past vertical stretched the filter region into a
// thin sliver and the blur clamped at its edge, leaving a blue streak trailing off the muzzle.
const GLOW_COLOR = 0x6ab8ff;
const GLOW_BLUR = 3.3;
interface GlowRig {
  container: Container;
  farFoot: Container;
  torso: Container;
  head: Container;
  nearFoot: Container;
}

/**
 * A ColorMatrixFilter matrix that replaces every pixel's RGB with a flat colour while keeping its
 * original alpha — turns the textured rig clone into a solid-colour silhouette the blur can work on
 * (a plain multiply `tint` would only darken the tan art toward navy, not give a bright emitter).
 */
function solidColorMatrix(color: number): ColorMatrix {
  const r = ((color >> 16) & 0xff) / 255;
  const g = ((color >> 8) & 0xff) / 255;
  const b = (color & 0xff) / 255;
  // prettier-ignore
  return [
    0, 0, 0, 0, r,
    0, 0, 0, 0, g,
    0, 0, 0, 0, b,
    0, 0, 0, 1, 0,
  ] as ColorMatrix;
}

/** Copies a real rig part's per-frame transform onto its glow clone. */
function copyPartTransform(twin: Container, real: Container): void {
  twin.position.copyFrom(real.position);
  twin.scale.copyFrom(real.scale);
  twin.rotation = real.rotation;
  twin.visible = real.visible;
}

interface VoleView {
  glow: GlowRig | null;
  farFoot: Container;
  torso: Container;
  head: Container;
  nearFoot: Container;
  gun: Container;
  hp: Graphics;
  cooldown: Graphics;
  railCharge: Graphics;
  rope: Graphics;
  /** Burrow's tornado funnel (see drawTornado) — redrawn every frame while burrowing (its shape
   *  churns), hidden otherwise. */
  tornado: Graphics;
  facing: 1 | -1;
  renderX: number;
  renderY: number;
  renderAngle: number;
  walkPhaseOffset: number;
  lastWeaponId: string;
  walkAmount: number;
  lastHpKey: string;
  /** Fractional accumulator for Burrow's swirling dust motes (see renderVole's burrowing branch) —
   *  same pattern as the minigun's smokeAccum, so the emission rate is frame-rate independent. */
  burrowDustAccum: number;
}

// Small in-world echo of the weapon not being fireable yet, parked right next to the local player's
// own character (see renderVole) — a solid blue disc that starts as a full circle right after firing
// and loses that blue area clockwise from the top as the cooldown counts down, down to nothing once
// it's ready again. Same wipe math as WeaponSelector.setCooldown's preview-panel version, just a
// different look (filled blue rather than a dark overlay) since this one reads against the terrain
// instead of the HUD panel's own background.
const SMALL_COOLDOWN_RADIUS = 4;
function drawSmallCooldown(g: Graphics, ratio: number): void {
  g.clear();
  if (ratio <= 0) return;
  const start = -Math.PI / 2;
  const end = start + ratio * Math.PI * 2;
  g.moveTo(0, 0).arc(0, 0, SMALL_COOLDOWN_RADIUS, start, end).lineTo(0, 0).fill({ color: 0x2f8fef, alpha: 0.9 });
}

// Burrow's tornado funnel (see renderVole's burrowing branch). The previous version — five curved
// blades swept around the origin and spun as one rigid graphic — read as a windmill/pinwheel, not
// weather. This is a debris funnel instead: a vertical stack of thin, near-horizontal elliptical
// bands. `f` runs 0 at the narrow tip (TORNADO_BOTTOM_Y, just below the vole's feet — where it's
// drilling in) to 1 at the wide ragged mouth (TORNADO_TOP_Y, around the top of the head), so the
// funnel WRAPS the whole character rather than floating above it. Each band is nudged sideways by a
// sine of its own height plus a scrolling `phase`, and its brightness ripples along the stack with
// `phase`, so the column visibly churns, leans and appears to spiral upward — redrawn every frame
// rather than rotated. A faint haze polygon sits behind the bands so the gaps between them still
// read as "inside the funnel", and a few thin spiral streaks run its length for the swirl lines.
// Inspiration: designs/tornado.svg (a layered blue-grey funnel), recoloured to warm dust tones so
// it stays legible against both dirt (brown) and stone (grey) terrain.
const TORNADO_BOTTOM_Y = 18; // vole-local units BELOW O the tip sits (clearly past the feet)
const TORNADO_TOP_Y = -9; // vole-local units ABOVE O the mouth reaches (~helmet band — hugs the head, doesn't tower over it)
const TORNADO_TOP_RADIUS = 13; // half-width of the ragged mouth (a bit wider still)
const TORNADO_BOTTOM_RADIUS = 2; // half-width at the drilling tip
const TORNADO_BANDS = 11;
// Dark -> light dust, indexed bottom-to-top so the funnel pales toward its mouth (like the SVG).
const TORNADO_BAND_COLORS = [0x4a3a2a, 0x6f5942, 0x9c7d59, 0xc7a87f, 0xe2caa0];
const TORNADO_HAZE_COLOR = 0x8f7452;
const TORNADO_STREAK_COLOR = 0xf3e7cb;
function drawTornado(g: Graphics, phase: number): void {
  g.clear();
  const yAt = (f: number): number => TORNADO_BOTTOM_Y + (TORNADO_TOP_Y - TORNADO_BOTTOM_Y) * f;
  // A near-linear taper (very slight curve via the 1.25 power) — a straighter cone reads as a
  // tornado funnel; the previous f*f piled all the width into a bulbous mushroom cap at the top.
  const radiusAt = (f: number): number =>
    TORNADO_BOTTOM_RADIUS + (TORNADO_TOP_RADIUS - TORNADO_BOTTOM_RADIUS) * Math.pow(f, 1.25);
  const swayAt = (f: number): number => Math.sin(phase * 0.7 + f * 3.1) * radiusAt(f) * 0.3;

  // Full-height haze behind the bands (left edge going up, right edge coming back down).
  const haze: number[] = [];
  const hazeSteps = 12;
  for (let i = 0; i <= hazeSteps; i++) {
    const f = i / hazeSteps;
    haze.push(swayAt(f) - radiusAt(f), yAt(f));
  }
  for (let i = hazeSteps; i >= 0; i--) {
    const f = i / hazeSteps;
    haze.push(swayAt(f) + radiusAt(f), yAt(f));
  }
  g.poly(haze).fill({ color: TORNADO_HAZE_COLOR, alpha: 0.22 });

  // Stacked bands, drilling tip (tight) up to mouth (wide).
  for (let i = 0; i < TORNADO_BANDS; i++) {
    const f = i / (TORNADO_BANDS - 1);
    const r = radiusAt(f);
    const cx = swayAt(f) + Math.sin(phase + f * 4.2) * r * 0.34 * (0.3 + f);
    const cy = yAt(f);
    const ry = Math.max(0.6, r * 0.32);
    const color = TORNADO_BAND_COLORS[Math.min(TORNADO_BAND_COLORS.length - 1, Math.floor(f * TORNADO_BAND_COLORS.length))];
    const alpha = 0.6 + 0.35 * (0.5 + 0.5 * Math.sin(phase * 1.6 - i * 0.9));
    g.ellipse(cx, cy, r, ry).fill({ color, alpha });
  }

  // Thin spiral streaks running the funnel's length — the "swirl lines" from the SVG.
  for (let k = 0; k < 3; k++) {
    const steps = 16;
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      const x = swayAt(f) + Math.sin(phase * 1.5 + f * 7 + k * 2.1) * radiusAt(f) * 0.82;
      if (i === 0) g.moveTo(x, yAt(f));
      else g.lineTo(x, yAt(f));
    }
    g.stroke({ width: 0.9, color: TORNADO_STREAK_COLOR, alpha: 0.3 });
  }
}

function shortestAngleDelta(from: number, to: number): number {
  const twoPi = Math.PI * 2;
  let delta = (to - from) % twoPi;
  if (delta > Math.PI) delta -= twoPi;
  if (delta < -Math.PI) delta += twoPi;
  return delta;
}

/** Frame-rate-independent exponential ease: fraction of the remaining distance closed this frame. */
function easeFactor(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

function hashPhase(sessionId: string): number {
  let h = 0;
  for (let i = 0; i < sessionId.length; i++) h = (h * 31 + sessionId.charCodeAt(i)) % 1000;
  return (h / 1000) * Math.PI * 2;
}

/** Pre-match hero picker (see index.html #hero-select). Resolves to the chosen hero id plus the
 *  nickname typed in the name field (trimmed; "" if left blank — the server then assigns "Player N").
 *  The "Skip" button resolves to "burrows" (the assets already shipped in public/art/), so it's an
 *  instant no-swap path into the game; the nickname field is still honoured on Skip. */
function selectHero(): Promise<{ heroId: HeroId; nickname: string }> {
  const overlay = document.getElementById("hero-select") as HTMLDivElement;
  const row = document.getElementById("hero-row") as HTMLDivElement;
  const skip = document.getElementById("hero-skip") as HTMLButtonElement;
  const nameInput = document.getElementById("nickname-input") as HTMLInputElement;
  return new Promise((resolve) => {
    const done = (id: HeroId): void => {
      overlay.classList.add("hidden");
      resolve({ heroId: id, nickname: nameInput.value.trim() });
    };
    for (const hero of HEROES) {
      const card = document.createElement("div");
      card.className = "hero-card";
      const img = document.createElement("img");
      img.src = heroPortraitUrl(hero.id);
      img.alt = hero.name;
      const name = document.createElement("div");
      name.className = "hero-name";
      name.textContent = hero.name;
      const sub = document.createElement("div");
      sub.className = "hero-sub";
      sub.textContent = hero.blurb;
      card.append(img, name, sub);
      card.addEventListener("click", () => done(hero.id));
      row.appendChild(card);
    }
    skip.addEventListener("click", () => done("burrows"));
  });
}

async function main(): Promise<void> {
  const hud = document.getElementById("hud") as HTMLDivElement;
  const fpsEl = document.getElementById("fps") as HTMLDivElement;
  const scoreboardEl = document.getElementById("scoreboard") as HTMLDivElement;
  const winnerBannerEl = document.getElementById("winner-banner") as HTMLDivElement;
  // Top-right kill feed (see index.html #kill-feed). Each server "kill" broadcast prepends one row
  // (newest on top), capped at KILL_FEED_MAX; every row fades and removes itself after
  // KILL_FEED_TTL_MS. displayName comes straight from the server (nickname or "Player N").
  const killFeedEl = document.getElementById("kill-feed") as HTMLDivElement;
  const KILL_FEED_MAX = 6;
  const KILL_FEED_TTL_MS = 6000;
  const pushKillFeed = (msg: { killerName?: string; victimName?: string; selfKill?: boolean }): void => {
    const victim = msg.victimName ?? "?";
    const row = document.createElement("div");
    row.className = "kill-row";
    if (msg.killerName) {
      row.innerHTML = `<span class="kf-killer"></span><span class="kf-verb">&#9760;</span><span class="kf-victim"></span>`;
      (row.querySelector(".kf-killer") as HTMLElement).textContent = msg.killerName;
      (row.querySelector(".kf-victim") as HTMLElement).textContent = victim;
    } else {
      row.innerHTML = `<span class="kf-victim"></span><span class="kf-verb">${msg.selfKill ? "self-destructed" : "died"}</span>`;
      (row.querySelector(".kf-victim") as HTMLElement).textContent = victim;
    }
    killFeedEl.prepend(row);
    while (killFeedEl.childElementCount > KILL_FEED_MAX) killFeedEl.lastElementChild?.remove();
    window.setTimeout(() => {
      row.style.opacity = "0";
      window.setTimeout(() => row.remove(), 450);
    }, KILL_FEED_TTL_MS);
  };
  // Top-centre "terrain remaining" readout (see index.html #terrain-remaining / GameState
  // .terrainRemaining) — 100% = the freshly-generated arena, 0% = every destructible cell dug out.
  const terrainRemainingValueEl = document.getElementById("terrain-remaining-value") as HTMLSpanElement;
  const terrainRemainingFillEl = document.getElementById("terrain-remaining-fill") as HTMLSpanElement;
  // Superpower HUD (see index.html #superpowers). Dash row: charge pips + a live recharge countdown,
  // both driven from the synced vole.dashCharges / vole.dashRechargeTimer each frame.
  const dashPowerEl = document.getElementById("power-dash") as HTMLDivElement;
  const dashCdEl = dashPowerEl.querySelector(".power-cd") as HTMLSpanElement;
  const dashPipEls = Array.from(dashPowerEl.querySelectorAll(".pip")) as HTMLSpanElement[];
  // Burrow row: one pip (single-charge, unlike dash's two) + a live cooldown countdown, driven from
  // the synced vole.burrowCooldownTimer each frame.
  const burrowPowerEl = document.getElementById("power-burrow") as HTMLDivElement;
  const burrowCdEl = burrowPowerEl.querySelector(".power-cd") as HTMLSpanElement;
  const burrowPipEl = burrowPowerEl.querySelector(".pip") as HTMLSpanElement;
  // Double Jump row: single pip, no cooldown text (refills on landing, not a timer).
  const doubleJumpPowerEl = document.getElementById("power-doublejump") as HTMLDivElement;
  const doubleJumpPipEl = doubleJumpPowerEl.querySelector(".pip") as HTMLSpanElement;
  // Abilities HUD (see index.html #abilities) — always-available, no charges/cooldown; the row just
  // shows the key and briefly pulses (flashAbility) when used.
  const digAbilityEl = document.getElementById("ability-dig") as HTMLDivElement;
  const flashAbility = (el: HTMLElement): void => {
    el.classList.remove("used");
    void el.offsetWidth; // restart the CSS animation
    el.classList.add("used");
  };
  // Pick a hero (and nickname) before anything else — the game world / connection spin up behind the
  // overlay.
  const { heroId, nickname } = await selectHero();

  const app = new Application();
  await app.init({ resizeTo: window, background: "#101418", antialias: false });
  document.getElementById("app")!.appendChild(app.canvas);

  window.addEventListener("pointerdown", unlockAudio, { once: true });

  // Volume slider (top-right, see index.html) — starts at whatever was last saved (or a sensible
  // default if nothing was), and dragging it both sets the live master gain and remembers the
  // choice via setMasterVolume itself (see sound.ts). "input" rather than "change" so it responds
  // continuously while dragging, not just on release.
  const volumeSlider = document.getElementById("volume-slider") as HTMLInputElement;
  volumeSlider.value = String(Math.round(getMasterVolume() * 100));
  volumeSlider.addEventListener("input", () => setMasterVolume(Number(volumeSlider.value) / 100));

  document.addEventListener("gesturestart", (e) => e.preventDefault());

  hud.textContent = "connecting to server...";
  const [room, voleTextures, weaponIconTextures, skeletonTexture] = await Promise.all([
    connect(nickname, heroId),
    loadHeroArt(heroId),
    loadWeaponIconTextures(),
    loadSkeletonTexture(),
  ]);
  hud.textContent = `connected (session ${room.sessionId})`;

  // Per-hero rig art, keyed by the vole's synced `heroId` so each player renders with their OWN
  // pick, not whatever the local player chose. Seeded with the local player's set (already loaded
  // above); other heroes are fetched lazily the first time a vole using one shows up — that vole
  // just isn't drawn for the ~one frame or two until its art resolves.
  const KNOWN_HEROES = new Set<HeroId>(HEROES.map((h) => h.id));
  const asHeroId = (raw: string): HeroId => (KNOWN_HEROES.has(raw as HeroId) ? (raw as HeroId) : "burrows");
  const heroArt = new Map<HeroId, VoleTextures>([[heroId, voleTextures]]);
  const heroArtLoading = new Set<HeroId>();
  function heroTexturesFor(rawHeroId: string): VoleTextures | null {
    const id = asHeroId(rawHeroId);
    const cached = heroArt.get(id);
    if (cached) return cached;
    if (!heroArtLoading.has(id)) {
      heroArtLoading.add(id);
      loadHeroArt(id)
        .then((tex) => heroArt.set(id, tex))
        .catch((err) => {
          console.error(`hero art load failed for "${id}"`, err);
          heroArtLoading.delete(id); // let a later frame retry
        });
    }
    return null;
  }

  const weaponSelector = new WeaponSelector(weaponIconTextures);

  // Left Ctrl + scroll zooms the camera (see zoomLevel below) instead of stepping the weapon
  // selector. Left Shift now drives the Dash superpower (see input.ts), so zoom moved off it onto
  // Left Ctrl to free the key up. Tracked via keydown/keyup on the specific ControlLeft code (same
  // pattern as tabHeld below) rather than the wheel event's own ctrlKey flag, since that can't
  // distinguish left from right Ctrl — the user asked for left ctrl specifically (matching dash's
  // own left-specific Shift).
  let leftCtrlHeld = false;
  window.addEventListener("keydown", (e) => {
    if (e.code === "ControlLeft") leftCtrlHeld = true;
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "ControlLeft") leftCtrlHeld = false;
  });

  const MIN_ZOOM = 1; // today's fully-zoomed-out "cover the window" view
  const MAX_ZOOM = 5;
  const ZOOM_STEP = 1.12;
  // zoomLevel is the target the wheel handler jumps immediately; renderZoom (what applyCamera
  // actually draws with) eases toward it every frame — see ZOOM_SMOOTH_RATE.
  let zoomLevel = MIN_ZOOM;
  let renderZoom = MIN_ZOOM;
  // The camera's own trailing focus point (see applyCamera / CAM_* constants). NaN until the first
  // applyCamera call snaps it onto the vole.
  let camFocusX = NaN;
  let camFocusY = NaN;

  // Scroll steps the weapon selector; holding left Ctrl while scrolling zooms the camera (see
  // zoomLevel below) instead — scrolled out to scout, zoomed in to fight. Ctrl+scroll (and trackpad
  // pinch, which browsers report as a wheel event with ctrlKey set) would otherwise ALSO trigger
  // native browser page zoom, which scales DOM elements and Pixi's entity-counter-scaled entities
  // differently than the terrain sprite and throws their relative on-screen sizes out of sync —
  // preventDefault below stops that regardless of which branch this event takes.
  window.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (leftCtrlHeld) {
        const factor = e.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP;
        zoomLevel = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoomLevel * factor));
        return;
      }
      weaponSelector.step(e.deltaY > 0 ? 1 : -1);
    },
    { passive: false }
  );

  // Digit1-9 select slots 1-9, Digit0 selects the 10th (matches the "1" printed in each slot).
  window.addEventListener("keydown", (e) => {
    const digitMatch = /^Digit([0-9])$/.exec(e.code);
    if (!digitMatch) return;
    const digit = Number(digitMatch[1]);
    weaponSelector.setSelected(digit === 0 ? 9 : digit - 1);
  });

  // Hold-Tab scoreboard (see memory: project-deathmatch-mode) — a plain hold-to-show toggle, not a
  // press-to-open panel. preventDefault so Tab doesn't cycle focus off the canvas (e.g. onto the
  // respawn button) while held.
  let tabHeld = false;
  window.addEventListener("keydown", (e) => {
    if (e.code === "Tab") {
      e.preventDefault();
      tabHeld = true;
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Tab") tabHeld = false;
  });

  const world = new Container();
  app.stage.addChild(world);
  app.stage.addChild(weaponSelector.container);
  app.stage.addChild(weaponSelector.preview);
  weaponSelector.layout(app.renderer.width, app.renderer.height);
  app.renderer.on("resize", () => weaponSelector.layout(app.renderer.width, app.renderer.height));

  // "OVERHEAT" banner shown while the minigun is cooling down from an overheat (see the ticker's
  // minigun block). Screen-space, but pinned above the local vole's head each frame it's visible by
  // projecting the vole's world position through the camera transform (so it stays a fixed pixel
  // size regardless of zoom).
  const overheatBanner = new Text({
    text: "OVERHEAT",
    style: { fill: 0xff4b3a, fontFamily: "monospace", fontSize: 17, fontWeight: "700", letterSpacing: 2 },
  });
  overheatBanner.anchor.set(0.5, 1);
  overheatBanner.visible = false;
  app.stage.addChild(overheatBanner);

  // "MAX CHARGE" prompt — same screen-space-pinned-above-the-head treatment as the OVERHEAT banner,
  // shown (blinking) once a held railgun charge tops out. See the ticker's railgun block.
  const maxChargeBanner = new Text({
    text: "MAX CHARGE",
    style: { fill: 0x8fc2ff, fontFamily: "monospace", fontSize: 17, fontWeight: "700", letterSpacing: 2 },
  });
  maxChargeBanner.anchor.set(0.5, 1);
  maxChargeBanner.visible = false;
  app.stage.addChild(maxChargeBanner);

  // The camera zooms the world so the map covers the whole window (cropping overflow rather than
  // letterboxing). entityScale is ENTITY_SCALE itself, not counter-scaled against that zoom — voles,
  // bullets, and the terrain all need to shrink/grow together as the camera zooms, since voleArt.ts's
  // rig (the feet in particular) is built assuming ENTITY_SCALE converts its vole-local units into
  // the same terrain-unit space the terrain sprite already renders in.
  const entityScale = ENTITY_SCALE;

  const voleViews = new Map<string, VoleView>();
  // The one place allegiance colour is decided (see HELMET_SELF/HELMET_ENEMY). When team deathmatch
  // lands, add: `else if (sameTeam(sessionId, room.sessionId)) return HELMET_ALLY;` here.
  const helmetColorFor = (sessionId: string): number =>
    sessionId === room.sessionId ? HELMET_SELF : HELMET_ENEMY;

  function makeVoleView(
    sessionId: string,
    vole: { x: number; y: number; aimAngle: number },
    textures: VoleTextures
  ): VoleView {
    const color = helmetColorFor(sessionId);
    // Near foot sits centered under the torso's hip/leg nub (spreadX 0 lands it right on
    // HIP_OFFSET.x, the nub's own x); far foot is offset back+up just enough to peek out from
    // behind it, instead of the wide near/far stance the old traced legs had.
    // Only the local player's own vole gets the blue self-marker (see GlowRig) — the whole point is
    // to pick your own character out, so tagging every vole would defeat it. It's a full second copy
    // of the rig, blue-tinted, blurred, and parked behind the real one; renderVole copies each real
    // part's transform onto its twin every frame so the two stay locked together.
    const glow: GlowRig | null =
      sessionId === room.sessionId
        ? {
            container: new Container(),
            farFoot: createFoot(textures, -1.4, -0.4),
            torso: createTorso(textures),
            head: createHead(textures, color),
            nearFoot: createFoot(textures, 0, 0),
          }
        : null;
    if (glow) {
      glow.container.addChild(glow.farFoot, glow.torso, glow.head, glow.nearFoot);
      const solid = new ColorMatrixFilter();
      solid.matrix = solidColorMatrix(GLOW_COLOR);
      // Flatten to a solid blue silhouette first, then blur that — order matters.
      glow.container.filters = [solid, new BlurFilter({ strength: GLOW_BLUR, quality: 3 })];
    }
    const farFoot = createFoot(textures, -1.4, -0.4);
    const torso = createTorso(textures);
    const head = createHead(textures, color);
    const nearFoot = createFoot(textures, 0, 0);
    const gun = createGun(textures);
    const hp = new Graphics();
    // Small in-world echo of the weapon-preview panel's cooldown wipe (see WeaponSelector.setCooldown)
    // parked beside the HP bar — only ever drawn for the local player's own view (see renderVole),
    // since a cooldown timer only means anything for the weapon you're personally holding.
    const cooldown = new Graphics();
    // Railgun charge bar — local player only, shown while charging and below 100% (see renderVole;
    // at 100% the "MAX CHARGE" banner takes over).
    const railCharge = new Graphics();
    // Unlike the other parts, the rope line is drawn in absolute world/terrain coordinates (both
    // endpoints already are), not vole-local units, so it deliberately gets no entityScale here.
    const rope = new Graphics();
    // Burrow's tornado funnel (see drawTornado) — its band positions churn, so it's redrawn every
    // frame in renderVole while burrowing rather than drawn once and transformed.
    const tornado = new Graphics();
    tornado.visible = false;
    farFoot.scale.set(entityScale);
    torso.scale.set(entityScale);
    head.scale.set(entityScale);
    nearFoot.scale.set(entityScale);
    gun.scale.set(entityScale);
    hp.scale.set(entityScale);
    cooldown.scale.set(entityScale);
    railCharge.scale.set(entityScale);
    tornado.scale.set(entityScale);
    // z-order: far foot mostly hidden behind the torso, head drawn over the torso's neck seam, near
    // foot and gun in front of everything else — same layering the old traced art used. The rope
    // goes in first so the character rig draws on top of it near the attach hand; the tornado funnel
    // goes right after so it reads as swirling around/behind the character, not covering it.
    // Glow clone first so it sits behind the whole rig (but still above the terrain/blood layers).
    if (glow) world.addChild(glow.container);
    world.addChild(rope, tornado, farFoot, torso, head, nearFoot, gun, hp, cooldown, railCharge);
    const view: VoleView = {
      glow,
      farFoot,
      torso,
      head,
      nearFoot,
      gun,
      hp,
      cooldown,
      railCharge,
      rope,
      tornado,
      facing: 1,
      renderX: vole.x,
      renderY: vole.y,
      renderAngle: vole.aimAngle,
      walkPhaseOffset: hashPhase(sessionId),
      lastWeaponId: "",
      walkAmount: 0,
      lastHpKey: "",
      burrowDustAccum: 0,
    };
    voleViews.set(sessionId, view);
    return view;
  }

  function renderVole(
    sessionId: string,
    vole: {
      x: number;
      y: number;
      vx: number;
      aimAngle: number;
      health: number;
      alive: boolean;
      grounded: boolean;
      ropeActive: boolean;
      ropeAnchorX: number;
      ropeAnchorY: number;
      burrowActive: boolean;
      burrowElapsed: number;
      heroId: string;
    },
    dt: number,
    time: number
  ): void {
    let view = voleViews.get(sessionId);
    if (!view) {
      const textures = heroTexturesFor(vole.heroId);
      if (!textures) return; // this vole's hero art is still loading — draw it next frame
      view = makeVoleView(sessionId, vole, textures);
    }

    const posEase = easeFactor(sessionId === room.sessionId ? LOCAL_POSITION_SMOOTH_RATE : POSITION_SMOOTH_RATE, dt);
    view.renderX += (vole.x - view.renderX) * posEase;
    view.renderY += (vole.y - view.renderY) * posEase;
    view.renderAngle += shortestAngleDelta(view.renderAngle, vole.aimAngle) * easeFactor(ANGLE_SMOOTH_RATE, dt);

    view.facing = Math.cos(view.renderAngle) >= 0 ? 1 : -1;

    // Walk cycle: eased toward 1 while actually walking (grounded, on the ground, vx from input)
    // and 0 otherwise, rather than snapping — an instant on/off was visible as a pop at the first
    // frame of a step.
    const walking = vole.alive && vole.grounded && vole.vx !== 0;
    view.walkAmount += ((walking ? 1 : 0) - view.walkAmount) * easeFactor(WALK_EASE_RATE, dt);
    const walkPhase = time * WALK_CYCLE_SPEED + view.walkPhaseOffset;
    const walkSwing = Math.sin(walkPhase);

    const burrowing = vole.alive && vole.burrowActive;

    if (burrowing) {
      // Horizontal spin: every part collapses onto O and flips together as ONE coherent body
      // (same phase, no rotation) rather than tumbling nose-over-tail — the classic 2D "spinning
      // around a vertical axis" trick (a transformation-sequence spin, not a wheel roll): scale.x
      // oscillates through 0 via cos(spinPhase) while scale.y stays put, so the silhouette narrows to
      // an edge-on sliver and flips rather than rotating in the picture plane. The whole rig also
      // shrinks a little as the descent (burrowElapsed / BURROW_DURATION) progresses — selling
      // "digging down and out of sight". Dust motes (below) fill in the rest of the read.
      const t = Math.min(1, vole.burrowElapsed / BURROW_DURATION);
      const spinPhase = vole.burrowElapsed * BURROW_SPIN_SPEED;
      const flip = Math.cos(spinPhase);
      const s = entityScale * (1 - BURROW_SHRINK * t);

      view.torso.position.set(view.renderX, view.renderY);
      view.torso.scale.set(s * flip, s);
      view.torso.rotation = 0;
      view.torso.visible = true;

      view.head.position.set(view.renderX, view.renderY);
      view.head.scale.set(s * flip, s);
      view.head.rotation = 0;
      view.head.visible = true;

      view.farFoot.position.set(view.renderX, view.renderY);
      view.farFoot.scale.set(s * flip, s);
      view.farFoot.rotation = 0;
      view.farFoot.visible = true;

      view.nearFoot.position.set(view.renderX, view.renderY);
      view.nearFoot.scale.set(s * flip, s);
      view.nearFoot.rotation = 0;
      view.nearFoot.visible = true;

      view.gun.position.set(view.renderX, view.renderY);
      view.gun.scale.set(s * flip, s);
      view.gun.rotation = 0;
      view.gun.visible = true;

      // Tornado funnel — redrawn each frame (its bands churn), rooted at O, sized with the same
      // shrink as the rig so it tightens in as the vole digs deeper. It fades in over the first
      // ~150ms and back out over the last ~250ms so it doesn't pop on/off.
      const tornadoFade = Math.min(1, vole.burrowElapsed / 0.15, (BURROW_DURATION - vole.burrowElapsed) / 0.25);
      view.tornado.position.set(view.renderX, view.renderY);
      view.tornado.rotation = 0;
      view.tornado.scale.set(s);
      view.tornado.alpha = Math.max(0, tornadoFade);
      view.tornado.visible = true;
      drawTornado(view.tornado, vole.burrowElapsed * TORNADO_CHURN_SPEED);

      // Dust motes flung outward around O, timed so the ring keeps up regardless of frame rate (same
      // accumulator pattern as the minigun's overheat smoke).
      view.burrowDustAccum += BURROW_DUST_RATE * dt;
      while (view.burrowDustAccum >= 1) {
        view.burrowDustAccum -= 1;
        particleLayer.burrowSwirl(view.renderX, view.renderY, Math.random() * Math.PI * 2);
      }
    } else {
      view.burrowDustAccum = 0;
      view.tornado.visible = false;

      view.torso.position.set(view.renderX, view.renderY);
      view.torso.scale.set(entityScale * view.facing, entityScale);
      view.torso.rotation = 0;
      view.torso.visible = vole.alive;

      // A small double-bob (two dips per full leg-swing period, one per footfall) rather than the
      // old always-on idle sway — only present while actually walking, via walkAmount.
      const headBobY = -Math.abs(walkSwing) * HEAD_BOB_Y * view.walkAmount;
      view.head.position.set(view.renderX, view.renderY + headBobY * entityScale);
      view.head.scale.set(entityScale * view.facing, entityScale);
      view.head.rotation = 0;
      view.head.visible = vole.alive;

      // Near/far feet swing fore/aft in opposite phase and lift only on their forward half-stride
      // (Math.max(0, ...) — a foot doesn't lift while planted and swinging back), scaled by
      // walkAmount so they settle back to their static hip-relative pose (baked into createFoot) when
      // not walking. Swing/lift are in vole-local units like GUN_SHOULDER_OFFSET, so they need the
      // same by-hand entityScale (and facing, for the mirrored X) main.ts already applies there.
      const nearSwingX = walkSwing * FOOT_SWING_X * view.walkAmount;
      const nearLiftY = -Math.max(0, walkSwing) * FOOT_LIFT_Y * view.walkAmount;
      const farSwingX = -walkSwing * FOOT_SWING_X * view.walkAmount;
      const farLiftY = -Math.max(0, -walkSwing) * FOOT_LIFT_Y * view.walkAmount;

      view.farFoot.position.set(
        view.renderX + farSwingX * entityScale * view.facing,
        view.renderY + farLiftY * entityScale
      );
      view.farFoot.scale.set(entityScale * view.facing, entityScale);
      view.farFoot.rotation = 0;
      view.farFoot.visible = vole.alive;

      view.nearFoot.position.set(
        view.renderX + nearSwingX * entityScale * view.facing,
        view.renderY + nearLiftY * entityScale
      );
      view.nearFoot.scale.set(entityScale * view.facing, entityScale);
      view.nearFoot.rotation = 0;
      view.nearFoot.visible = vole.alive;

      // Pixi's local transform is rotate(rotation) ∘ scale(scale) — scale is applied first, then
      // rotation. So when scale.x is mirrored (facing -1), a barrel drawn along local +x ends up
      // pointing at (rotation + π) instead of `rotation`. Setting rotation = renderAngle + π cancels
      // that out, landing the barrel exactly on renderAngle for any aim direction. (A previous version
      // used π - renderAngle, which only agrees with the correct value at the boundary angles 0/π and
      // is otherwise its vertical mirror — that was the "aim looks reversed while facing left" bug.)
      //
      // The gun's own local origin is its shoulder attach point (see createGun), and main.ts sets both
      // its position and rotation every frame — so shifting GUN_SHOULDER_OFFSET (in the same abstract
      // units as the rest of the rig) into this position moves the shoulder to the top-mid of the body
      // *and* keeps the rotation below pivoting there, instead of at O. The offset is scaled by
      // entityScale by hand here because, unlike scale/rotation, Pixi doesn't apply a container's own
      // scale to the position main.ts is about to assign it.
      view.gun.position.set(
        view.renderX + GUN_SHOULDER_OFFSET.x * entityScale * view.facing,
        view.renderY + GUN_SHOULDER_OFFSET.y * entityScale
      );
      view.gun.rotation = view.facing === 1 ? view.renderAngle : view.renderAngle + Math.PI;
      view.gun.scale.set(entityScale * view.facing, entityScale);
      view.gun.visible = vole.alive;
    }

    // Only the local player's held weapon follows the selector — remote players' selection isn't
    // synced to this client at all, so they keep whatever createGun() gave them by default. Every
    // weapon slot has real art now (see HELD_WEAPON_VISUALS), so this always has a visual to show.
    if (sessionId === room.sessionId && weaponSelector.selectedId !== view.lastWeaponId) {
      const selectedId = weaponSelector.selectedId;
      view.lastWeaponId = selectedId;
      const visual = HELD_WEAPON_VISUALS[selectedId];
      const gunVisual = {
        texture: weaponIconTextures[selectedId],
        anchorX: visual.anchorX,
        anchorY: visual.anchorY,
        scale: visual.scale,
      };
      setGunVisual(view.gun, gunVisual);
    }

    // Local player's minigun barrel glows toward MINIGUN_HEAT.TINT_COLOR; anything else stays
    // untinted. Per-frame (not gated on weapon change) since heat moves continuously. Two mappings:
    // during the overheat lockout the redness tracks the cooldown counter 1:1 (full red at 0 s,
    // half at half the lockout, gone at the end — which is exactly what minigunHeat does then);
    // otherwise it ramps in over TINT_START..TINT_FULL heat as the barrel warms. lerpColor clamps.
    if (sessionId === room.sessionId) {
      if (weaponSelector.selectedId === "minigun") {
        const inLockout = minigunOverheatUntil > time;
        const t = inLockout
          ? minigunHeat
          : (minigunHeat - MINIGUN_HEAT.TINT_START) / (MINIGUN_HEAT.TINT_FULL - MINIGUN_HEAT.TINT_START);
        setGunTint(view.gun, lerpColor(0xffffff, MINIGUN_HEAT.TINT_COLOR, t));
      } else {
        setGunTint(view.gun, 0xffffff);
      }
    }

    // Blue self-marker (local player only): lock every glow-clone part onto its real counterpart so
    // the blurred blue silhouette stays exactly behind the live art, showing only as a rim.
    if (view.glow) {
      const g = view.glow;
      copyPartTransform(g.farFoot, view.farFoot);
      copyPartTransform(g.torso, view.torso);
      copyPartTransform(g.head, view.head);
      copyPartTransform(g.nearFoot, view.nearFoot);
      g.container.visible = vole.alive;
    }

    const barWidth = 16;
    const pct = Math.max(0, vole.health) / 100;
    const hpKey = `${Math.round(pct * barWidth)}:${vole.alive ? 1 : 0}`;
    if (hpKey !== view.lastHpKey) {
      view.lastHpKey = hpKey;
      view.hp.clear();
      view.hp.rect(-barWidth / 2, -18, barWidth, 3).fill(0x333333);
      view.hp.rect(-barWidth / 2, -18, barWidth * pct, 3).fill(pct > 0.4 ? 0x66bb6a : 0xef5350);
    }
    view.hp.position.set(view.renderX, view.renderY);
    view.hp.scale.set(entityScale);
    view.hp.visible = vole.alive;

    // Only the local player gets this — a cooldown timer for another player's weapon isn't
    // something the server tells us (or something the player needs to see), so it stays hidden.
    // ak47 fires fast enough (fireCooldown 0.15s) that this indicator was mostly just flickering
    // noise next to the character rather than a readable cooldown timer — hidden for it entirely.
    // minigun likewise has no per-shot cooldown: its blue disc appears ONLY while it's overheated,
    // counting the OVERHEAT_LOCKOUT_SECONDS back down.
    if (sessionId === room.sessionId && weaponSelector.selectedId === "minigun") {
      const ratio =
        minigunOverheatUntil > time
          ? (minigunOverheatUntil - time) / MINIGUN_HEAT.OVERHEAT_LOCKOUT_SECONDS
          : 0;
      drawSmallCooldown(view.cooldown, ratio);
      view.cooldown.position.set(view.renderX - view.facing * 1.5, view.renderY - 6);
      view.cooldown.scale.set(entityScale);
      view.cooldown.visible = vole.alive && ratio > 0;
    } else if (sessionId === room.sessionId && weaponSelector.selectedId !== "ak47") {
      const weapon = WEAPONS[weaponSelector.selectedId] ?? WEAPONS[DEFAULT_WEAPON_ID];
      const lastFire = lastFireAt.get(weaponSelector.selectedId) ?? -Infinity;
      const ratio = Math.max(0, Math.min(1, 1 - (time - lastFire) / weapon.fireCooldown));
      drawSmallCooldown(view.cooldown, ratio);
      // Close to the character, tucked just above and behind (opposite whichever way they're
      // currently facing) rather than out past the HP bar.
      view.cooldown.position.set(view.renderX - view.facing * 1.5, view.renderY - 6);
      view.cooldown.scale.set(entityScale);
      view.cooldown.visible = vole.alive && ratio > 0;
    } else {
      view.cooldown.visible = false;
    }

    // Local player's railgun charge meter — a small blue bar just above the HP bar that fills toward
    // full charge. Hidden the instant it hits 100% (the screen-space "MAX CHARGE" banner takes over)
    // and whenever not charging.
    if (sessionId === room.sessionId && railChargeFrac > 0 && railChargeFrac < 1) {
      const cw = 16;
      const chh = 2.5;
      view.railCharge.clear();
      view.railCharge.rect(-cw / 2, -23, cw, chh).fill({ color: 0x0b1a2b, alpha: 0.85 });
      view.railCharge.rect(-cw / 2, -23, cw * railChargeFrac, chh).fill(0x5aa0ff);
      view.railCharge.rect(-cw / 2, -23, cw, chh).stroke({ width: 0.4, color: 0x9cc2ff, alpha: 0.7 });
      view.railCharge.position.set(view.renderX, view.renderY);
      view.railCharge.scale.set(entityScale);
      view.railCharge.visible = vole.alive;
    } else {
      view.railCharge.visible = false;
    }

    // Redrawn every frame (rather than cached like the hp bar above) since the vole end moves every
    // frame while swinging — there's no stable "key" to gate a skip on the way the hp bar has.
    view.rope.clear();
    if (vole.alive && vole.ropeActive) {
      view.rope
        .moveTo(view.renderX, view.renderY)
        .lineTo(vole.ropeAnchorX, vole.ropeAnchorY)
        .stroke({ width: 0.5, color: 0xd8c48a });
    }
  }

  const $ = getStateCallbacks(room);

  // Fetched from the server rather than regenerated from a seed: this client may be joining after
  // other players have already carved craters into it, and a seed alone would only reconstruct
  // the pristine starting terrain.
  const { width: terrainWidth, height: terrainHeight, data: terrainData } = await requestTerrain(room);
  const terrain = new TerrainField(terrainWidth, terrainHeight, new Uint8Array(terrainData));
  const terrainRenderer = new TerrainRenderer(terrain);
  const bloodRenderer = new BloodRenderer(terrain);
  // Background first so it sits behind the terrain sprite — visible only through the fully
  // transparent holes TerrainRenderer punches wherever the terrain's been carved away. Blood sits
  // directly above the terrain sprite (below every character/skeleton).
  world.addChildAt(createCaveBackground(terrainWidth, terrainHeight), 0);
  world.addChildAt(terrainRenderer.sprite, 1);
  world.addChildAt(bloodRenderer.sprite, 2);
  const bulletLayer = new BulletLayer(world, terrain);
  const particleLayer = new ParticleLayer(world);
  const flameLayer = new FlameLayer(world, terrain);
  const railgunLayer = new RailgunLayer(world, terrain);
  const grenadeGuide = new GrenadeAimGuide(world);
  const damageNumbers = new DamageNumberLayer(world);
  const mineLayer = new MineLayer(world, weaponIconTextures.mine);
  const explosionLayer = new ExplosionLayer(world);

  // Bottom-right minimap: whole-map terrain raster + a dot per live player + a white rectangle for
  // the on-screen viewport. Screen-space, so it goes on the stage (not the camera-transformed
  // `world`), above it so it's never hidden behind terrain.
  const minimap = new Minimap(terrain);
  app.stage.addChild(minimap.container);
  minimap.layout(app.renderer.width, app.renderer.height);
  app.renderer.on("resize", () => minimap.layout(app.renderer.width, app.renderer.height));

  // The camera keeps the local player centered and always on-screen, zoomed by zoomLevel (see left
  // Shift + scroll above) on top of the same "cover the window" base scale the fully-zoomed-out view
  // always used. Clamped to the terrain bounds on both axes so zooming in near an edge never shows a
  // gap past the map — at zoomLevel 1 (MIN_ZOOM) that clamp range collapses to exactly the old
  // always-centered-on-the-map behavior, since the map exactly covers the window at that scale.
  function applyCamera(dt = 0): void {
    renderZoom += (zoomLevel - renderZoom) * easeFactor(ZOOM_SMOOTH_RATE, dt);
    const coverScale = Math.max(app.renderer.width / terrain.width, app.renderer.height / terrain.height);
    const scale = coverScale * renderZoom;
    world.scale.set(scale);

    const selfView = voleViews.get(room.sessionId);
    const targetX = selfView ? selfView.renderX : terrain.width / 2;
    const targetY = selfView ? selfView.renderY : terrain.height / 2;
    // Deadzone-then-ease follow (see CAM_* constants): the focus only moves once the vole leaves a
    // small box around it, then glides after it — so tiny vertical jitter never scrolls the world.
    if (Number.isNaN(camFocusX)) {
      camFocusX = targetX;
      camFocusY = targetY;
    }
    const dzx = targetX - camFocusX;
    const dzy = targetY - camFocusY;
    const anchorX = Math.abs(dzx) > CAM_DEADZONE_X ? targetX - Math.sign(dzx) * CAM_DEADZONE_X : camFocusX;
    const anchorY = Math.abs(dzy) > CAM_DEADZONE_Y ? targetY - Math.sign(dzy) * CAM_DEADZONE_Y : camFocusY;
    camFocusX += (anchorX - camFocusX) * easeFactor(CAM_FOLLOW_RATE, dt);
    camFocusY += (anchorY - camFocusY) * easeFactor(CAM_FOLLOW_RATE, dt);
    const focusX = camFocusX;
    const focusY = camFocusY;

    const worldPxW = terrain.width * scale;
    const worldPxH = terrain.height * scale;
    const desiredX = app.renderer.width / 2 - focusX * scale;
    const desiredY = app.renderer.height / 2 - focusY * scale;
    const minOffsetX = Math.min(0, app.renderer.width - worldPxW);
    const minOffsetY = Math.min(0, app.renderer.height - worldPxH);
    world.position.set(Math.max(minOffsetX, Math.min(0, desiredX)), Math.max(minOffsetY, Math.min(0, desiredY)));
  }
  applyCamera();
  // Explicit () => applyCamera() rather than passing applyCamera directly — Pixi's "resize" event
  // emits (width, height), which would otherwise land in applyCamera's dt param and make the zoom
  // ease snap instantly on every window resize instead of gliding.
  app.renderer.on("resize", () => applyCamera());

  // A piercing weapon's shot sends several "terrain-carve" messages (one per server tick it spends
  // tunneling, plus its own final one) that all share the same projectile id — tracks which ids have
  // already played the impact sound so a single sniper shot doesn't sound like a burst of gunfire.
  // Ids are never reused and this only grows for the life of the page, but at one entry per shot
  // fired all game, that's negligible even over a very long session.
  const soundedProjectileIds = new Set<string>();

  room.onMessage("terrain-carve", (msg: { id?: string; weaponId?: string; x: number; y: number; x2?: number; y2?: number; radius: number }) => {
    // Sampled before carving, since carve()/carveCapsule() clears the material this destroys.
    const material = terrain.get(Math.floor(msg.x), Math.floor(msg.y));
    const debrisColor = material === TERRAIN_STONE ? STONE_COLOR : DIRT_COLOR;
    // x2/y2 present = a piercing weapon's per-tick capsule (see GameRoom.update), not a single
    // circular explosion — same idea, swept along a segment instead of centered on one point.
    if (msg.x2 !== undefined && msg.y2 !== undefined) {
      terrainRenderer.carveCapsule(msg.x, msg.y, msg.x2, msg.y2, msg.radius);
      const midX = (msg.x + msg.x2) / 2;
      const midY = (msg.y + msg.y2) / 2;
      const halfLen = Math.hypot(msg.x2 - msg.x, msg.y2 - msg.y) / 2;
      // onTerrainCarved's own circle-membership check is only a cheap pre-filter (the real check is
      // re-testing terrain.isSolid), so a bounding circle around the whole capsule is a safe stand-in
      // for a dedicated capsule variant.
      bloodRenderer.onTerrainCarved(midX, midY, halfLen + msg.radius);
      particleLayer.burst(midX, midY, debrisColor, Math.round(14 + msg.radius));
    } else {
      terrainRenderer.carve(msg.x, msg.y, msg.radius);
      // Blood on terrain that's just been destroyed falls (like a corpse losing its footing) rather
      // than being erased outright — see BloodRenderer.onTerrainCarved.
      bloodRenderer.onTerrainCarved(msg.x, msg.y, msg.radius);
      particleLayer.burst(msg.x, msg.y, debrisColor, Math.round(14 + msg.radius));
      // A single-circle carve (no x2/y2) is always a projectile's FINAL impact, whether that's a
      // direct vole hit or hitting terrain — snap this bullet's own local visual straight to the
      // server's real impact point rather than trusting this client's own in-flight guess, which can
      // drift enough over a slow shot's flight to visibly sail past a moving target (see
      // BulletLayer.resolve's own comment for why).
      if (msg.id !== undefined) bulletLayer.resolve(msg.id, msg.x, msg.y, entityScale);
      // Grenades and mines get a full standalone blast animation (the generic bullet impact flash
      // is tiny and, for a proximity/timed mine, there's no bullet to carry one at all).
      if (msg.weaponId === "grenade" || msg.weaponId === "mine") {
        explosionLayer.spawn(msg.x, msg.y, msg.radius, msg.weaponId);
      }
    }
    // At most one impact sound per bullet — see soundedProjectileIds' own comment above. A message
    // with no id (shouldn't happen now that both server broadcast sites send one, but harmless if
    // it ever did) just always plays, same as before this existed. Bazooka gets its own recorded
    // blast instead of the generic synthesized crack+thump every other weapon still uses.
    if (msg.id === undefined || !soundedProjectileIds.has(msg.id)) {
      if (msg.id !== undefined) soundedProjectileIds.add(msg.id);
      if (msg.weaponId === "bazooka") playBazookaExplosion();
      else if (msg.weaponId === "grenade" || msg.weaponId === "mine") playGrenadeExplosion();
      else playTerrainImpact();
    }
  });

  // Railgun beam biting into terrain at its front — the server sends the capsule it carved this
  // carve tick (owner position → beam front, dig radius). Its own message (not "terrain-carve") so
  // it doesn't trip the per-impact sound / bullet-resolve path — just keeps this client's terrain
  // mirror + render in step with the server's authoritative carve (see GameRoom.updateRailgun).
  room.onMessage(
    "railgun-carve",
    (msg: { x1: number; y1: number; x2: number; y2: number; radius: number }) => {
      terrainRenderer.carveCapsule(msg.x1, msg.y1, msg.x2, msg.y2, msg.radius);
      bloodRenderer.onTerrainCarved(
        (msg.x1 + msg.x2) / 2,
        (msg.y1 + msg.y2) / 2,
        Math.hypot(msg.x2 - msg.x1, msg.y2 - msg.y1) / 2 + msg.radius
      );
    }
  );

  // Burrow digging through terrain (see GameRoom.update's BURROW_CARVE_RADIUS block) — one circle per
  // server tick spent burrowing. Own message (not "terrain-carve") for the same reason as
  // "railgun-carve" above: reusing that event would fire the per-impact sound and a bullet-resolve
  // lookup on every one of these, ~30/s while active.
  room.onMessage("burrow-carve", (msg: { x: number; y: number; radius: number }) => {
    terrainRenderer.carve(msg.x, msg.y, msg.radius);
    bloodRenderer.onTerrainCarved(msg.x, msg.y, msg.radius);
  });

  // Dig ability (see GameRoom.handleDig) — a short tunnel capsule + a dirt spray out of its mouth.
  // Own message, same reasoning as "burrow-carve".
  room.onMessage(
    "dig-carve",
    (msg: { ownerId: string; x: number; y: number; x2: number; y2: number; radius: number }) => {
      terrainRenderer.carveCapsule(msg.x, msg.y, msg.x2, msg.y2, msg.radius);
      bloodRenderer.onTerrainCarved(
        (msg.x + msg.x2) / 2,
        (msg.y + msg.y2) / 2,
        Math.hypot(msg.x2 - msg.x, msg.y2 - msg.y) / 2 + msg.radius
      );
      particleLayer.digBurst(msg.x, msg.y, Math.atan2(msg.y2 - msg.y, msg.x2 - msg.x));
      if (msg.ownerId === room.sessionId) flashAbility(digAbilityEl);
    }
  );

  room.onMessage("fire", (msg: ProjectileSimState) => {
    const visual = BULLET_VISUALS[msg.weaponId] ?? DEFAULT_BULLET_VISUAL;
    bulletLayer.spawn(msg, visual.draw, visual.impact);
    if (msg.weaponId === "ak47") playAkGunshot();
    if (msg.weaponId === "sniper") playSniperShot();
    if (msg.weaponId === "bazooka") playBazookaFire();
  });

  // One per shotgun volley (not per pellet). Everyone hears the bang; the shooter also hears the
  // pump-action reload that runs during the post-shot cooldown, staggered just after the bang.
  room.onMessage("shotgun-fire", (msg: { ownerId: string }) => {
    playShotgunShoot();
    if (msg.ownerId === room.sessionId) window.setTimeout(playShotgunReload, 130);
  });

  room.onMessage("blood", (msg: { x: number; y: number; amount: number }) => {
    bloodRenderer.splatter(msg.x, msg.y, msg.amount);
    damageNumbers.spawn(msg.x, msg.y, msg.amount);
  });

  // Dash superpower fired (see GameRoom.update). Lay down a thick, continuous smoke trail from where
  // the vole left to where it landed — dense enough that the whole blink path is visible as a line
  // of smoke — plus a heavier cloud at each end. Fires for the local player and everyone watching.
  room.onMessage("dash", (msg: { id: string; fromX: number; fromY: number; x: number; y: number; angle: number }) => {
    // The local player already heard their own whoosh the instant they pressed Left Shift (see the
    // ticker's dash-sound prediction) — playing it again on the server echo would just double it up,
    // a network round-trip late. Remote voles get theirs here.
    if (msg.id !== room.sessionId) playDash();
    const dx = Math.cos(msg.angle);
    const dy = Math.sin(msg.angle);
    const routeX = msg.x - msg.fromX;
    const routeY = msg.y - msg.fromY;
    const dist = Math.hypot(routeX, routeY);
    // One sample per ~1.4 route units (min 20), three tightly-jittered puffs per sample — reads as a
    // dense narrow smoke ribbon along the whole blink path rather than a dotted line.
    const samples = Math.max(20, Math.round(dist / 1.4));
    const perpX = -dy;
    const perpY = dx;
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const bx = msg.fromX + routeX * t;
      const by = msg.fromY + routeY * t;
      for (let k = 0; k < 3; k++) {
        const off = (Math.random() - 0.5) * 2; // tight spread across the path — a thin ribbon, not a band
        particleLayer.dashPuff(bx + perpX * off, by + perpY * off, dx, dy);
      }
    }
    // Denser bloom at the launch point and the landing point.
    for (let i = 0; i < 18; i++) particleLayer.dashPuff(msg.fromX, msg.fromY, dx, dy);
    for (let i = 0; i < 14; i++) particleLayer.dashPuff(msg.x, msg.y, dx, dy);
  });

  // Server sends this (throttled per vole) whenever any player takes flamethrower or fall damage.
  room.onMessage("grunt", () => playGrunt());
  // Sent by the server each time a grenade caroms off terrain (see stepProjectile bounce handling).
  room.onMessage("grenade-bounce", () => playGrenadeBounce());
  // One per death (see GameRoom.applyDamage) — feeds the top-right kill feed.
  room.onMessage("kill", (msg: { killerName?: string; victimName?: string; selfKill?: boolean }) => pushKillFeed(msg));

  $(room.state).voles.onRemove((_vole, sessionId) => {
    const view = voleViews.get(sessionId);
    if (view) {
      world.removeChild(view.rope, view.farFoot, view.torso, view.head, view.nearFoot, view.gun, view.hp, view.cooldown, view.railCharge);
      if (view.glow) world.removeChild(view.glow.container);
      voleViews.delete(sessionId);
    }
  });

  interface CorpseView {
    container: Container;
    renderX: number;
    renderY: number;
    renderAngle: number;
  }
  const corpseViews = new Map<string, CorpseView>();
  $(room.state).corpses.onAdd((corpse) => {
    const container = createSkeleton(skeletonTexture);
    container.scale.set(entityScale * corpse.facing, entityScale);
    container.position.set(corpse.x, corpse.y);
    container.rotation = corpse.angle;
    // Inserted right above the terrain/blood layers (indices 0-2) rather than appended, so a
    // skeleton always renders under every living character's parts, however many of each already
    // exist in the display list.
    world.addChildAt(container, 3);
    corpseViews.set(corpse.id, { container, renderX: corpse.x, renderY: corpse.y, renderAngle: corpse.angle });
  });
  $(room.state).corpses.onRemove((corpse) => {
    const view = corpseViews.get(corpse.id);
    if (view) {
      world.removeChild(view.container);
      corpseViews.delete(corpse.id);
    }
  });

  $(room.state).mines.onAdd((mine) => mineLayer.add(mine.id, mine.x, mine.y));
  $(room.state).mines.onRemove((mine) => mineLayer.remove(mine.id));

  const input = new InputTracker(
    app.canvas,
    () => {
      const self = room.state.voles.get(room.sessionId);
      return self ? { x: self.x, y: self.y } : null;
    },
    () => ({ scale: world.scale.x, offsetX: world.position.x, offsetY: world.position.y })
  );
  // Clicking a weapon slot selects it — but that click also lands on the canvas as a left-press and
  // would fire the weapon. The slot's pointerdown fires first, so it can veto that press here.
  weaponSelector.onSlotPointerDown = () => input.suppressNextFire();
  // Dig ability — the gesture is detected in InputTracker; the server validates the wall/aim and
  // carves. Fire-and-forget: an invalid attempt just does nothing server-side.
  input.setDigHandler((dir) => sendDig(room, dir));
  // Client-side mirror of GameRoom.handleFire's own rate-of-fire cap (same weapon.fireCooldown
  // constant, same "time since last accepted fire" gate) — the server is still the one that
  // actually enforces it, this just avoids spamming useless "fire" messages during cooldown and
  // drives the preview panel's round cooldown indicator (see weaponSelector.setCooldown) without
  // waiting on a round trip.
  const lastFireAt = new Map<string, number>();
  input.setFireHandler(() => {
    const weaponId = weaponSelector.selectedId;
    // None of these is a one-shot click weapon: the flamethrower is driven by the held-fire `flame`
    // message, the grenade by the hold-to-charge / release-to-throw block in the ticker, the minigun
    // by the held-fire auto-repeat block, and the railgun by its own hold-to-charge block.
    if (
      weaponId === "flamethrower" ||
      weaponId === "grenade" ||
      weaponId === "minigun" ||
      weaponId === "railgun"
    )
      return;
    const weapon = WEAPONS[weaponId] ?? WEAPONS[DEFAULT_WEAPON_ID];
    const now = performance.now() / 1000;
    const last = lastFireAt.get(weaponId) ?? -Infinity;
    if (now - last < weapon.fireCooldown) return;
    lastFireAt.set(weaponId, now);
    sendFire(room, weaponId);
  });

  // Flamethrower: streams while left-click is held, capped at FLAME_MAX_MS per uninterrupted
  // squeeze (must release and press again for a fresh budget). The client only tells the server
  // when the hold starts/stops (`flame` message); the server runs the actual stream (GameRoom
  // updateFlames) and the FlameLayer renders it from the synced `flaming` flag.
  const FLAME_MAX_MS = 10_000;
  let flameHoldPrev = false;
  let flameSqueezeStart = 0;
  let localFlaming = false;

  // Grenade: hold LMB to charge (further throw the longer you hold), release to throw. A short click
  // (~0 charge) plops it at the feet. The trajectory preview (grenadeGuide) shows the throw arc
  // while charging. The server maps the released 0..1 power to a launch speed.
  const GRENADE_CHARGE_MS = 900;
  let grenadeHoldPrev = false;
  let grenadeCharging = false;
  let grenadeChargeStart = 0;

  // Minigun: held-fire governed by the heat model in MINIGUN_HEAT. `minigunHeat` is the live 0..1
  // heat; `minigunFiringPrev` tracks whether the barrel loop was running last tick (so a fresh
  // press re-seeds the audio at the heat-matched offset); `minigunOverheatUntil` / `-NoticeUntil`
  // are wall-clock deadlines for the fire lockout and the on-screen banner. All read again in
  // renderVole for the barrel tint + reload icon. See the "Minigun: overheat" ticker block.
  let minigunHeat = 0;
  let minigunFiringPrev = false;
  let minigunOverheatUntil = 0;
  let minigunOverheatNoticeUntil = 0;
  let minigunSmokeAccum = 0; // fractional puff counter for the overheat smoke emitter

  // Railgun: hold LMB to charge, release to fire. The server times the charge authoritatively (see
  // its `railgun` handler); these mirror it locally so the charge orb + "MAX CHARGE" prompt respond
  // without a round-trip. railChargingLocal tracks "am I mid-charge", railChargeStart is when this
  // charge began (performance.now()).
  const RAIL_MAX_CHARGE_MS = WEAPONS.railgun.railgunChargeMs ?? 4000;
  let railHoldPrev = false;
  let railChargingLocal = false;
  let railChargeStart = 0;
  let railChargeFrac = 0; // 0..1 local charge progress — read in renderVole for the charge bar
  let railMaxedSince = 0; // performance.now() the local charge first hit 100% (0 = not maxed)
  let railChargeSoundOn = false; // charge-up sound playing (tied to anyone charging)
  let railFireSoundOn = false; // beam sound playing (tied to any visible beam)

  let inputSendAccumulator = 0;
  let fpsDisplayAccumulator = 0;
  // Dash-sound prediction: play the whoosh the instant Left Shift goes down (rising edge) with a charge
  // available, rather than waiting for the server's "dash" broadcast to round-trip — that echo was
  // audibly late. The "dash" handler skips the sound for the local player so it isn't doubled.
  let dashKeyPrev = false;
  // Burrow's swirl sound — gated on the synced self.burrowActive (not predicted like Dash's whoosh
  // above; a burrow's activation already has a whole 1.2s animation, so the one-tick network round
  // trip before this flips isn't perceptible the way it would be for a snappy one-shot).
  let localBurrowSoundOn = false;

  app.ticker.add((ticker) => {
    const dt = ticker.deltaMS / 1000;
    const time = performance.now() / 1000;

    const playerInput: PlayerInput = input.poll();
    inputSendAccumulator += dt;
    if (inputSendAccumulator >= INPUT_SEND_INTERVAL) {
      inputSendAccumulator = 0;
      sendInput(room, playerInput);
    }

    if (playerInput.dash && !dashKeyPrev) {
      const me = room.state.voles.get(room.sessionId) as
        | { alive: boolean; dashCharges: number; ropeActive: boolean }
        | undefined;
      if (me && me.alive && me.dashCharges > 0 && !me.ropeActive) playDash();
    }
    dashKeyPrev = playerInput.dash;

    if (weaponSelector.selectedId === "minigun") {
      // The minigun has no per-shot cooldown wipe (it would just strobe at 20 Hz). The preview
      // panel's clock instead shows the overheat lockout counting down, and nothing otherwise.
      const remain =
        minigunOverheatUntil > time
          ? (minigunOverheatUntil - time) / MINIGUN_HEAT.OVERHEAT_LOCKOUT_SECONDS
          : 0;
      weaponSelector.setCooldown(remain);
    } else {
      const selectedWeapon = WEAPONS[weaponSelector.selectedId] ?? WEAPONS[DEFAULT_WEAPON_ID];
      const lastFire = lastFireAt.get(weaponSelector.selectedId) ?? -Infinity;
      weaponSelector.setCooldown(1 - (time - lastFire) / selectedWeapon.fireCooldown);
    }

    // Flamethrower hold state → server + looping sound. holdPrev/squeezeStart give the FLAME_MAX_MS
    // cap a "release and press again to refill" feel: while the budget's spent the button stays
    // held but we report not-flaming, and only a fresh press (rising edge) resets the timer.
    const selfNow = room.state.voles.get(room.sessionId) as { alive: boolean } | undefined;
    const holdingFlame =
      weaponSelector.selectedId === "flamethrower" && input.isFireHeld() && !!selfNow && selfNow.alive;
    if (holdingFlame && !flameHoldPrev) flameSqueezeStart = performance.now();
    flameHoldPrev = holdingFlame;
    const wantFlaming = holdingFlame && performance.now() - flameSqueezeStart < FLAME_MAX_MS;
    if (wantFlaming !== localFlaming) {
      localFlaming = wantFlaming;
      sendFlame(room, wantFlaming);
      if (wantFlaming) startFlameLoop();
      else stopFlameLoop();
    }

    // Grenade: hold LMB to charge a longer throw, release to throw. Rising edge (with the weapon off
    // cooldown) starts the charge; while charging, draw the predicted throw arc; on release throw
    // with the built-up 0..1 power. Dying or switching weapon mid-charge just cancels it.
    const grenadeAlive = !!selfNow && selfNow.alive;
    const holdingGrenade = weaponSelector.selectedId === "grenade" && grenadeAlive && input.isFireHeld();
    if (holdingGrenade && !grenadeHoldPrev) {
      const lastGren = lastFireAt.get("grenade") ?? -Infinity;
      if (time - lastGren >= (WEAPONS.grenade.fireCooldown ?? 0)) {
        grenadeCharging = true;
        grenadeChargeStart = performance.now();
        playGrenadeSokka(); // "pin pull" as the charge starts
      }
    }
    grenadeHoldPrev = holdingGrenade;

    if (grenadeCharging) {
      const power = Math.max(0, Math.min(1, (performance.now() - grenadeChargeStart) / GRENADE_CHARGE_MS));
      const stillCharging = weaponSelector.selectedId === "grenade" && grenadeAlive && input.isFireHeld();
      const selfView = voleViews.get(room.sessionId);
      if (stillCharging && selfView) {
        grenadeGuide.bringToFront(world);
        grenadeGuide.show(selfView.renderX, selfView.renderY, playerInput.aimAngle, power, terrain);
      } else {
        grenadeCharging = false;
        grenadeGuide.hide();
        // Throw only on a genuine release (still alive, grenade still selected, button now up).
        if (weaponSelector.selectedId === "grenade" && grenadeAlive && !input.isFireHeld()) {
          lastFireAt.set("grenade", time);
          sendFire(room, "grenade", power);
          playGrenadeThrow();
        }
      }
    }

    // Railgun: hold LMB to charge, release to fire. Rising edge (weapon off cooldown) starts the
    // charge and tells the server to start timing it; a release / death / weapon-switch ends it and
    // the server fires a beam sized by however long it was held. railChargeFrac is the local mirror
    // of that timing, driving the charge orb + "MAX CHARGE" prompt without waiting on a round-trip.
    const holdingRail = weaponSelector.selectedId === "railgun" && grenadeAlive && input.isFireHeld();
    if (holdingRail && !railHoldPrev) {
      const lastRail = lastFireAt.get("railgun") ?? -Infinity;
      if (time - lastRail >= (WEAPONS.railgun.fireCooldown ?? 0)) {
        railChargingLocal = true;
        railChargeStart = performance.now();
        sendRailgun(room, true);
      }
    }
    railHoldPrev = holdingRail;
    if (railChargingLocal && (!holdingRail || !grenadeAlive)) {
      railChargingLocal = false;
      // Genuine trigger release fires; ending the charge because the weapon was switched away (button
      // still held) cancels it instead — matches how the grenade charge behaves.
      const fired = !input.isFireHeld();
      sendRailgun(room, false, !fired);
      if (fired) lastFireAt.set("railgun", time);
    }
    railChargeFrac = railChargingLocal
      ? Math.min(1, (performance.now() - railChargeStart) / RAIL_MAX_CHARGE_MS)
      : 0;
    if (railChargeFrac >= 1) {
      if (railMaxedSince === 0) railMaxedSince = performance.now();
    } else {
      railMaxedSince = 0;
    }

    // Minigun: overheat model (see MINIGUN_HEAT). Holding fire raises minigunHeat over FIRE_SECONDS
    // from 0 to 1; at 1 the gun overheats — fire is locked out for OVERHEAT_LOCKOUT_SECONDS while
    // heat ramps back to 0 and the "OVERHEAT" banner + reload icon show. Releasing the trigger early
    // bleeds heat off at RELEASE_COOL_PER_SECOND. The barrel loop is always (re)started at
    // heat × FIRE_SECONDS so the recorded fire matches the barrel's heat/colour, and while firing
    // "fire" is re-sent every fireCooldown (the server still rate-limits authoritatively).
    // Switching weapon / dying just stops the stream; heat then cools on its own.
    const minigunLockedOut = minigunOverheatUntil > time;
    const wantMinigunFire =
      weaponSelector.selectedId === "minigun" && grenadeAlive && input.isFireHeld() && !minigunLockedOut;

    if (minigunLockedOut) {
      // Cooling ramp owns heat for the duration of the lockout: 1 → 0 across OVERHEAT_LOCKOUT_SECONDS.
      minigunHeat = Math.max(0, (minigunOverheatUntil - time) / MINIGUN_HEAT.OVERHEAT_LOCKOUT_SECONDS);
    }

    if (wantMinigunFire) {
      if (!minigunFiringPrev) {
        minigunFiringPrev = true;
        startMinigunLoop(minigunHeat * MINIGUN_HEAT.FIRE_SECONDS); // seed audio at the current heat
      }
      minigunHeat = Math.min(1, minigunHeat + dt / MINIGUN_HEAT.FIRE_SECONDS);
      if (minigunHeat >= 1) {
        // Overheated — stop firing, start the lockout + banner.
        minigunFiringPrev = false;
        minigunOverheatUntil = time + MINIGUN_HEAT.OVERHEAT_LOCKOUT_SECONDS;
        minigunOverheatNoticeUntil = time + MINIGUN_HEAT.OVERHEAT_NOTICE_SECONDS;
        stopMinigunLoop();
      } else {
        const lastMg = lastFireAt.get("minigun") ?? -Infinity;
        if (time - lastMg >= WEAPONS.minigun.fireCooldown) {
          lastFireAt.set("minigun", time);
          sendFire(room, "minigun");
        }
      }
    } else {
      if (minigunFiringPrev) {
        minigunFiringPrev = false;
        stopMinigunLoop();
      }
      // Bleed heat off while released (unless the lockout ramp is already driving it).
      if (!minigunLockedOut && minigunHeat > 0) {
        minigunHeat = Math.max(0, minigunHeat - MINIGUN_HEAT.RELEASE_COOL_PER_SECOND * dt);
      }
    }

    room.state.voles.forEach(
      (
        vole: {
          x: number;
          y: number;
          vx: number;
          aimAngle: number;
          health: number;
          alive: boolean;
          grounded: boolean;
          ropeActive: boolean;
          ropeAnchorX: number;
          ropeAnchorY: number;
          burrowActive: boolean;
          burrowElapsed: number;
          heroId: string;
        },
        sessionId: string
      ) => renderVole(sessionId, vole, dt, time)
    );

    // "OVERHEAT" / "MAX CHARGE" banners — pinned above the local vole's head (world → screen via the
    // camera transform). Done after renderVole so renderX/renderY are this frame's.
    const localVoleView = voleViews.get(room.sessionId);
    const bannerScreen = (): [number, number] => [
      Math.round(world.x + localVoleView!.renderX * world.scale.x),
      Math.round(world.y + (localVoleView!.renderY - MINIGUN_HEAT.OVERHEAT_TEXT_RISE) * world.scale.y),
    ];
    overheatBanner.visible = minigunOverheatNoticeUntil > time && !!localVoleView;
    if (overheatBanner.visible && localVoleView) overheatBanner.position.set(...bannerScreen());
    // "MAX CHARGE": the instant the local charge tops out it shows solid for ~0.35 s (so the moment
    // is never missed), then blinks fast + mostly-on as a persistent reminder while still held.
    const railMaxedFor = railMaxedSince > 0 ? performance.now() - railMaxedSince : -1;
    maxChargeBanner.visible =
      railMaxedFor >= 0 && !!localVoleView && (railMaxedFor < 350 || Math.sin(time * 14) > -0.5);
    if (maxChargeBanner.visible && localVoleView) maxChargeBanner.position.set(...bannerScreen());

    // Overheat smoke — grey puffs from the minigun muzzle while the barrel is hot (heat >
    // SMOKE_START), billowing harder during the overheat lockout. Emitted here so the gun's world
    // transform (gun.x/y, set in renderVole) is current.
    if (
      weaponSelector.selectedId === "minigun" &&
      minigunHeat > MINIGUN_HEAT.SMOKE_START &&
      localVoleView &&
      selfNow?.alive
    ) {
      const ramp = (minigunHeat - MINIGUN_HEAT.SMOKE_START) / (1 - MINIGUN_HEAT.SMOKE_START);
      let rate = MINIGUN_HEAT.SMOKE_RATE_MAX * Math.max(0, ramp);
      if (minigunOverheatUntil > time) rate *= MINIGUN_HEAT.SMOKE_OVERHEAT_MULT;
      minigunSmokeAccum += rate * dt;
      while (minigunSmokeAccum >= 1) {
        minigunSmokeAccum -= 1;
        const a = localVoleView.renderAngle;
        particleLayer.smoke(
          localVoleView.gun.x + Math.cos(a) * MINIGUN_HEAT.SMOKE_MUZZLE_FORWARD,
          localVoleView.gun.y + Math.sin(a) * MINIGUN_HEAT.SMOKE_MUZZLE_FORWARD
        );
      }
    } else {
      minigunSmokeAccum = 0;
    }
    const bulletVoles: VoleHitTarget[] = [];
    room.state.voles.forEach((vole: { x: number; y: number; alive: boolean }, sessionId: string) => {
      bulletVoles.push({ id: sessionId, x: vole.x, y: vole.y, alive: vole.alive });
    });
    // Mines are projectile hit-targets too (matches the server) — a shot resolves on one, and the
    // server's terrain-carve broadcast draws the actual detonation.
    const mineViews: MineView[] = [];
    room.state.mines.forEach((mine: { id: string; x: number; y: number; armed: boolean }) => {
      mineViews.push({ id: mine.id, x: mine.x, y: mine.y, armed: mine.armed });
      bulletVoles.push({ id: `mine:${mine.id}`, x: mine.x, y: mine.y, alive: true });
    });
    bulletLayer.update(dt, entityScale, bulletVoles);
    mineLayer.update(time, mineViews);
    particleLayer.update(dt, entityScale);
    explosionLayer.update(dt);
    bloodRenderer.update(dt);

    // Flame streams (per flaming vole) + burn-patch decals — cosmetic; damage is the server's.
    const flamingVoles: FlamingVole[] = [];
    room.state.voles.forEach((vole: { x: number; y: number; aimAngle: number; alive: boolean; flaming: boolean }, sessionId: string) => {
      if (!vole.alive || !vole.flaming) return;
      const v = voleViews.get(sessionId);
      flamingVoles.push({
        id: sessionId,
        x: v ? v.renderX : vole.x,
        y: v ? v.renderY : vole.y,
        aimAngle: v ? v.renderAngle : vole.aimAngle,
      });
    });
    // Show the local player's own stream the instant they fire, without waiting for the server's
    // `flaming` flag to round-trip back.
    if (localFlaming && !flamingVoles.some((f) => f.id === room.sessionId)) {
      const v = voleViews.get(room.sessionId);
      if (v) flamingVoles.push({ id: room.sessionId, x: v.renderX, y: v.renderY, aimAngle: v.renderAngle });
    }
    const burnMarkers: BurnMarker[] = [];
    room.state.burns.forEach((burn: { id: string; x: number; y: number }) => {
      burnMarkers.push({ id: burn.id, x: burn.x, y: burn.y });
    });
    flameLayer.update(time, flamingVoles, burnMarkers);

    // Railgun beams + charge orbs (per vole) — cosmetic; damage / carving / lifetime are the
    // server's (GameRoom.updateRailgun). Pose comes from the smoothed render state like the flame
    // jet; length/half-width are the server's synced values, re-clipped to terrain in RailgunLayer.
    const railBeamViews: RailBeamView[] = [];
    const railChargeViews: RailChargeView[] = [];
    room.state.voles.forEach(
      (
        vole: {
          x: number;
          y: number;
          aimAngle: number;
          alive: boolean;
          railgunCharge: number;
          railgunBeamActive: boolean;
          railgunBeamLength: number;
          railgunBeamWidth: number;
        },
        sessionId: string
      ) => {
        if (!vole.alive) return;
        const v = voleViews.get(sessionId);
        const rx = v ? v.renderX : vole.x;
        const ry = v ? v.renderY : vole.y;
        const ra = v ? v.renderAngle : vole.aimAngle;
        if (vole.railgunBeamActive) {
          // length can be ~0 when dug straight into the ground; RailgunLayer keeps a short stub.
          railBeamViews.push({ id: sessionId, x: rx, y: ry, aimAngle: ra, length: vole.railgunBeamLength, halfWidth: vole.railgunBeamWidth });
        }
        if (vole.railgunCharge > 0) {
          railChargeViews.push({ id: sessionId, x: rx, y: ry, aimAngle: ra, charge: vole.railgunCharge });
        }
      }
    );
    // Local player: show the charge orb immediately, before the server's railgunCharge round-trips.
    if (railChargingLocal && !railChargeViews.some((c) => c.id === room.sessionId) && localVoleView) {
      railChargeViews.push({
        id: room.sessionId,
        x: localVoleView.renderX,
        y: localVoleView.renderY,
        aimAngle: localVoleView.renderAngle,
        charge: railChargeFrac,
      });
    }
    railgunLayer.update(time, railBeamViews, railChargeViews);
    // Charge-up sound plays while someone (local or remote) is winding up a railgun charge; the beam
    // (laserfire) sound plays for exactly as long as a fired beam is on screen. Each starts on the
    // first, stops (with a short fade) when the last one ends — so a quick tap doesn't leave either
    // clip ringing on after its cause is gone.
    const anyRailCharge = railChargeViews.length > 0;
    if (anyRailCharge && !railChargeSoundOn) {
      railChargeSoundOn = true;
      startRailgunChargeSound();
    } else if (!anyRailCharge && railChargeSoundOn) {
      railChargeSoundOn = false;
      stopRailgunChargeSound();
    }
    const anyRailBeam = railBeamViews.length > 0;
    if (anyRailBeam && !railFireSoundOn) {
      railFireSoundOn = true;
      startRailgunFireSound();
    } else if (!anyRailBeam && railFireSoundOn) {
      railFireSoundOn = false;
      stopRailgunFireSound();
    }
    damageNumbers.update(dt);

    const corpsePosEase = easeFactor(POSITION_SMOOTH_RATE, dt);
    room.state.corpses.forEach((corpse: { x: number; y: number; facing: number; angle: number }, id: string) => {
      const view = corpseViews.get(id);
      if (!view) return;
      view.renderX += (corpse.x - view.renderX) * corpsePosEase;
      view.renderY += (corpse.y - view.renderY) * corpsePosEase;
      view.renderAngle += shortestAngleDelta(view.renderAngle, corpse.angle) * easeFactor(ANGLE_SMOOTH_RATE, dt);
      view.container.position.set(view.renderX, view.renderY);
      view.container.rotation = view.renderAngle;
      view.container.scale.set(entityScale * corpse.facing, entityScale);
    });

    // Depends on this frame's renderVole pass above (uses the local player's just-updated smoothed
    // render position as the zoom focus point), so it has to run after that loop, every frame — not
    // just on resize — since the focus point moves continuously. Passing dt here is what drives the
    // renderZoom easing inside applyCamera.
    applyCamera(dt);

    // Minimap — after applyCamera so `world`'s transform is this frame's. The on-screen viewport in
    // world units is the inverse of that transform: screen (0,0)..(w,h) maps back to world
    // (-pos/scale) .. (-pos/scale + screenSize/scale).
    const camScale = world.scale.x;
    const minimapVoles: MinimapVole[] = [];
    room.state.voles.forEach((vole: { x: number; y: number; alive: boolean }, sessionId: string) => {
      if (!vole.alive) return;
      const v = voleViews.get(sessionId);
      minimapVoles.push({
        x: v ? v.renderX : vole.x,
        y: v ? v.renderY : vole.y,
        color: helmetColorFor(sessionId),
        self: sessionId === room.sessionId,
      });
    });
    minimap.update(dt, minimapVoles, {
      x: -world.position.x / camScale,
      y: -world.position.y / camScale,
      w: app.renderer.width / camScale,
      h: app.renderer.height / camScale,
    });

    // Terrain-remaining readout (top-centre) — server-synced fraction of the original destructible
    // terrain still standing, shown as a whole percent plus a shrinking bar.
    const terrainFrac = Math.max(0, Math.min(1, (room.state as { terrainRemaining?: number }).terrainRemaining ?? 1));
    terrainRemainingValueEl.textContent = `${Math.round(terrainFrac * 100)}%`;
    terrainRemainingFillEl.style.width = `${terrainFrac * 100}%`;

    const self = room.state.voles.get(room.sessionId);
    if (self) {
      // Respawn is fully automatic now (see memory: project-deathmatch-mode) — no button, just a
      // status line while dead so it doesn't look like the game hung.
      const status = self.alive ? "" : room.state.winnerId ? "  (match over)" : "  (respawning...)";
      hud.textContent = `hp ${Math.max(0, Math.round(self.health))}  players ${room.state.voles.size}${status}`;

      // Dash superpower readout: one pip per stored charge (filled = available), a recharge countdown
      // whenever charges aren't full, and the whole row dimmed when there are no dashes left.
      // dashCharges / dashRechargeTimer are synced from the server (see state.ts).
      const selfDash = self as { dashCharges?: number; dashRechargeTimer?: number };
      const dashCharges = selfDash.dashCharges ?? dashPipEls.length;
      const dashRecharge = selfDash.dashRechargeTimer ?? 0;
      dashPipEls.forEach((pip, i) => pip.classList.toggle("spent", i >= dashCharges));
      dashPowerEl.classList.toggle("ready", dashCharges > 0);
      dashPowerEl.classList.toggle("empty", dashCharges === 0);
      dashCdEl.textContent = dashCharges >= dashPipEls.length ? "" : `${Math.max(0, dashRecharge).toFixed(1)}s`;

      // Burrow superpower readout: same ready/cooldown convention as dash, but a single charge (one
      // pip) since burrow doesn't stack uses — burrowActive / burrowCooldownTimer are synced from the
      // server (see state.ts).
      const selfBurrow = self as { burrowActive?: boolean; burrowCooldownTimer?: number };
      const burrowReady = (selfBurrow.burrowCooldownTimer ?? 0) <= 0;
      burrowPipEl.classList.toggle("spent", !burrowReady);
      burrowPowerEl.classList.toggle("ready", burrowReady);
      burrowPowerEl.classList.toggle("empty", !burrowReady);
      burrowCdEl.textContent = burrowReady ? "" : `${Math.max(0, selfBurrow.burrowCooldownTimer ?? 0).toFixed(1)}s`;
      const wantBurrowSound = !!selfBurrow.burrowActive;
      if (wantBurrowSound !== localBurrowSoundOn) {
        localBurrowSoundOn = wantBurrowSound;
        if (wantBurrowSound) startBurrowSwirlSound();
        else stopBurrowSwirlSound();
      }

      // Double Jump superpower readout: single pip, ready whenever the air-jump charge is available
      // (no cooldown countdown — it refills on landing, not on a timer, so power-cd stays empty).
      const selfDoubleJump = self as { doubleJumpAvailable?: boolean };
      const doubleJumpReady = selfDoubleJump.doubleJumpAvailable ?? true;
      doubleJumpPipEl.classList.toggle("spent", !doubleJumpReady);
      doubleJumpPowerEl.classList.toggle("ready", doubleJumpReady);
      doubleJumpPowerEl.classList.toggle("empty", !doubleJumpReady);
    }

    scoreboardEl.style.display = tabHeld ? "block" : "none";
    if (tabHeld) {
      const rows: { name: string; kills: number; deaths: number; score: number }[] = [];
      room.state.voles.forEach((vole: { displayName: string; kills: number; deaths: number; score: number }, sessionId: string) => {
        const name = sessionId === room.sessionId ? `${vole.displayName} (you)` : vole.displayName;
        rows.push({ name, kills: vole.kills, deaths: vole.deaths, score: vole.score });
      });
      rows.sort((a, b) => b.score - a.score);
      const lines = rows.map((r) => `${r.name.padEnd(18)} K:${r.kills}  D:${r.deaths}  Score:${r.score}`);
      scoreboardEl.innerHTML = `<span class="title">Scoreboard (first to 20 wins)</span>${lines.join("\n")}`;
    }

    if (room.state.winnerId) {
      const winner = room.state.voles.get(room.state.winnerId);
      winnerBannerEl.textContent = winner ? `${winner.displayName} wins!` : "Match over!";
      winnerBannerEl.style.display = "block";
    }

    fpsDisplayAccumulator += dt;
    if (fpsDisplayAccumulator >= 0.25) {
      fpsDisplayAccumulator = 0;
      fpsEl.textContent = `${Math.round(app.ticker.FPS)} fps`;
    }
  });
}

main().catch((err) => {
  console.error(err);
  const hud = document.getElementById("hud");
  if (hud) hud.textContent = `error: ${String(err)}`;
});
