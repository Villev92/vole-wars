import { Application, BlurFilter, ColorMatrixFilter, Container, Graphics, type ColorMatrix } from "pixi.js";
import { getStateCallbacks } from "colyseus.js";
import {
  DEFAULT_WEAPON_ID,
  TERRAIN_STONE,
  TerrainField,
  WEAPONS,
  type PlayerInput,
  type ProjectileSimState,
  type VoleHitTarget,
} from "@vole-wars/shared";
import { connect, requestTerrain, sendFire, sendFlame, sendInput } from "./net.js";
import { TerrainRenderer, DIRT_COLOR, STONE_COLOR } from "./terrainRenderer.js";
import { BloodRenderer } from "./bloodRenderer.js";
import { createCaveBackground } from "./caveBackground.js";
import { createSkeleton, loadSkeletonTexture } from "./skeletonArt.js";
import { InputTracker } from "./input.js";
import { createFoot, createGun, createHead, createTorso, loadVoleTextures, setGunVisual, ENTITY_SCALE, GUN_SHOULDER_OFFSET } from "./voleArt.js";
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
import { GrenadeAimGuide } from "./grenadeAim.js";
import { DamageNumberLayer } from "./damageNumbers.js";
import {
  getMasterVolume,
  playAkGunshot,
  playBazookaExplosion,
  playBazookaFire,
  playGrenadeBounce,
  playGrenadeExplosion,
  playGrenadeSokka,
  playGrenadeThrow,
  playGrunt,
  playSniperShot,
  playTerrainImpact,
  setMasterVolume,
  startFlameLoop,
  stopFlameLoop,
  unlockAudio,
} from "./sound.js";
import { WeaponSelector } from "./weaponSelector.js";
import { loadWeaponIconTextures, type TexturedWeaponId } from "./weaponIcons.js";

const PLAYER_COLORS = [0x4caf50, 0xef5350, 0x42a5f5, 0xffca28];

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
  rope: Graphics;
  facing: 1 | -1;
  renderX: number;
  renderY: number;
  renderAngle: number;
  walkPhaseOffset: number;
  lastWeaponId: string;
  walkAmount: number;
  lastHpKey: string;
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

async function main(): Promise<void> {
  const hud = document.getElementById("hud") as HTMLDivElement;
  const fpsEl = document.getElementById("fps") as HTMLDivElement;
  const scoreboardEl = document.getElementById("scoreboard") as HTMLDivElement;
  const winnerBannerEl = document.getElementById("winner-banner") as HTMLDivElement;
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
    connect(),
    loadVoleTextures(),
    loadWeaponIconTextures(),
    loadSkeletonTexture(),
  ]);
  hud.textContent = `connected (session ${room.sessionId})`;

  const weaponSelector = new WeaponSelector(weaponIconTextures);

  // Left Shift + scroll zooms the camera (see zoomLevel below) instead of stepping the weapon
  // selector. Tracked via keydown/keyup on the specific ShiftLeft code (same pattern as tabHeld
  // below) rather than the wheel event's own shiftKey flag, since that can't distinguish left from
  // right shift — the user asked for left shift specifically.
  let leftShiftHeld = false;
  window.addEventListener("keydown", (e) => {
    if (e.code === "ShiftLeft") leftShiftHeld = true;
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "ShiftLeft") leftShiftHeld = false;
  });

  const MIN_ZOOM = 1; // today's fully-zoomed-out "cover the window" view
  const MAX_ZOOM = 5;
  const ZOOM_STEP = 1.12;
  // zoomLevel is the target the wheel handler jumps immediately; renderZoom (what applyCamera
  // actually draws with) eases toward it every frame — see ZOOM_SMOOTH_RATE.
  let zoomLevel = MIN_ZOOM;
  let renderZoom = MIN_ZOOM;

  // Ctrl+scroll (and trackpad pinch, which browsers report as a wheel event with ctrlKey set)
  // triggers native browser page zoom. That scales DOM elements (HUD, respawn button) and Pixi's
  // entityScale-counter-scaled entities differently than the terrain sprite, which just fills
  // whatever size the canvas resizes to — throwing their relative on-screen sizes out of sync.
  // Nothing on this page should ever scroll, so block wheel input outright rather than trying to
  // special-case the zoom gesture — repurposed here to step the weapon selector, or (holding left
  // shift) the camera zoom instead.
  window.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (leftShiftHeld) {
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

  // The camera zooms the world so the map covers the whole window (cropping overflow rather than
  // letterboxing). entityScale is ENTITY_SCALE itself, not counter-scaled against that zoom — voles,
  // bullets, and the terrain all need to shrink/grow together as the camera zooms, since voleArt.ts's
  // rig (the feet in particular) is built assuming ENTITY_SCALE converts its vole-local units into
  // the same terrain-unit space the terrain sprite already renders in.
  const entityScale = ENTITY_SCALE;

  const voleViews = new Map<string, VoleView>();
  const colorAssignments = new Map<string, number>();
  let nextColorIndex = 0;
  const colorFor = (sessionId: string): number => {
    if (!colorAssignments.has(sessionId)) {
      colorAssignments.set(sessionId, PLAYER_COLORS[nextColorIndex++ % PLAYER_COLORS.length]);
    }
    return colorAssignments.get(sessionId)!;
  };

  function makeVoleView(sessionId: string, vole: { x: number; y: number; aimAngle: number }): VoleView {
    const color = colorFor(sessionId);
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
            farFoot: createFoot(voleTextures, -1.4, -0.4),
            torso: createTorso(voleTextures),
            head: createHead(voleTextures, color),
            nearFoot: createFoot(voleTextures, 0, 0),
          }
        : null;
    if (glow) {
      glow.container.addChild(glow.farFoot, glow.torso, glow.head, glow.nearFoot);
      const solid = new ColorMatrixFilter();
      solid.matrix = solidColorMatrix(GLOW_COLOR);
      // Flatten to a solid blue silhouette first, then blur that — order matters.
      glow.container.filters = [solid, new BlurFilter({ strength: GLOW_BLUR, quality: 3 })];
    }
    const farFoot = createFoot(voleTextures, -1.4, -0.4);
    const torso = createTorso(voleTextures);
    const head = createHead(voleTextures, color);
    const nearFoot = createFoot(voleTextures, 0, 0);
    const gun = createGun(voleTextures);
    const hp = new Graphics();
    // Small in-world echo of the weapon-preview panel's cooldown wipe (see WeaponSelector.setCooldown)
    // parked beside the HP bar — only ever drawn for the local player's own view (see renderVole),
    // since a cooldown timer only means anything for the weapon you're personally holding.
    const cooldown = new Graphics();
    // Unlike the other parts, the rope line is drawn in absolute world/terrain coordinates (both
    // endpoints already are), not vole-local units, so it deliberately gets no entityScale here.
    const rope = new Graphics();
    farFoot.scale.set(entityScale);
    torso.scale.set(entityScale);
    head.scale.set(entityScale);
    nearFoot.scale.set(entityScale);
    gun.scale.set(entityScale);
    hp.scale.set(entityScale);
    cooldown.scale.set(entityScale);
    // z-order: far foot mostly hidden behind the torso, head drawn over the torso's neck seam, near
    // foot and gun in front of everything else — same layering the old traced art used. The rope
    // goes in first so the character rig draws on top of it near the attach hand.
    // Glow clone first so it sits behind the whole rig (but still above the terrain/blood layers).
    if (glow) world.addChild(glow.container);
    world.addChild(rope, farFoot, torso, head, nearFoot, gun, hp, cooldown);
    const view: VoleView = {
      glow,
      farFoot,
      torso,
      head,
      nearFoot,
      gun,
      hp,
      cooldown,
      rope,
      facing: 1,
      renderX: vole.x,
      renderY: vole.y,
      renderAngle: vole.aimAngle,
      walkPhaseOffset: hashPhase(sessionId),
      lastWeaponId: "",
      walkAmount: 0,
      lastHpKey: "",
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
    },
    dt: number,
    time: number
  ): void {
    const view = voleViews.get(sessionId) ?? makeVoleView(sessionId, vole);

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

    view.torso.position.set(view.renderX, view.renderY);
    view.torso.scale.set(entityScale * view.facing, entityScale);
    view.torso.visible = vole.alive;

    // A small double-bob (two dips per full leg-swing period, one per footfall) rather than the
    // old always-on idle sway — only present while actually walking, via walkAmount.
    const headBobY = -Math.abs(walkSwing) * HEAD_BOB_Y * view.walkAmount;
    view.head.position.set(view.renderX, view.renderY + headBobY * entityScale);
    view.head.scale.set(entityScale * view.facing, entityScale);
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
    view.farFoot.visible = vole.alive;

    view.nearFoot.position.set(
      view.renderX + nearSwingX * entityScale * view.facing,
      view.renderY + nearLiftY * entityScale
    );
    view.nearFoot.scale.set(entityScale * view.facing, entityScale);
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
    if (sessionId === room.sessionId && weaponSelector.selectedId !== "ak47") {
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
  const grenadeGuide = new GrenadeAimGuide(world);
  const damageNumbers = new DamageNumberLayer(world);

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
    const focusX = selfView ? selfView.renderX : terrain.width / 2;
    const focusY = selfView ? selfView.renderY : terrain.height / 2;

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
    }
    // At most one impact sound per bullet — see soundedProjectileIds' own comment above. A message
    // with no id (shouldn't happen now that both server broadcast sites send one, but harmless if
    // it ever did) just always plays, same as before this existed. Bazooka gets its own recorded
    // blast instead of the generic synthesized crack+thump every other weapon still uses.
    if (msg.id === undefined || !soundedProjectileIds.has(msg.id)) {
      if (msg.id !== undefined) soundedProjectileIds.add(msg.id);
      if (msg.weaponId === "bazooka") playBazookaExplosion();
      else if (msg.weaponId === "grenade") playGrenadeExplosion();
      else playTerrainImpact();
    }
  });

  room.onMessage("fire", (msg: ProjectileSimState) => {
    const visual = BULLET_VISUALS[msg.weaponId] ?? DEFAULT_BULLET_VISUAL;
    bulletLayer.spawn(msg, visual.draw, visual.impact);
    if (msg.weaponId === "ak47") playAkGunshot();
    if (msg.weaponId === "sniper") playSniperShot();
    if (msg.weaponId === "bazooka") playBazookaFire();
  });

  room.onMessage("blood", (msg: { x: number; y: number; amount: number }) => {
    bloodRenderer.splatter(msg.x, msg.y, msg.amount);
    damageNumbers.spawn(msg.x, msg.y, msg.amount);
  });

  // Server sends this (throttled per vole) whenever any player takes flamethrower or fall damage.
  room.onMessage("grunt", () => playGrunt());
  // Sent by the server each time a grenade caroms off terrain (see stepProjectile bounce handling).
  room.onMessage("grenade-bounce", () => playGrenadeBounce());

  $(room.state).voles.onRemove((_vole, sessionId) => {
    const view = voleViews.get(sessionId);
    if (view) {
      world.removeChild(view.rope, view.farFoot, view.torso, view.head, view.nearFoot, view.gun, view.hp, view.cooldown);
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
  // Client-side mirror of GameRoom.handleFire's own rate-of-fire cap (same weapon.fireCooldown
  // constant, same "time since last accepted fire" gate) — the server is still the one that
  // actually enforces it, this just avoids spamming useless "fire" messages during cooldown and
  // drives the preview panel's round cooldown indicator (see weaponSelector.setCooldown) without
  // waiting on a round trip.
  const lastFireAt = new Map<string, number>();
  input.setFireHandler(() => {
    const weaponId = weaponSelector.selectedId;
    // Neither of these is a one-shot click weapon: the flamethrower is driven by the held-fire
    // `flame` message, and the grenade by the hold-to-charge / release-to-throw block in the ticker.
    if (weaponId === "flamethrower" || weaponId === "grenade") return;
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

  let inputSendAccumulator = 0;
  let fpsDisplayAccumulator = 0;

  app.ticker.add((ticker) => {
    const dt = ticker.deltaMS / 1000;
    const time = performance.now() / 1000;

    const playerInput: PlayerInput = input.poll();
    inputSendAccumulator += dt;
    if (inputSendAccumulator >= INPUT_SEND_INTERVAL) {
      inputSendAccumulator = 0;
      sendInput(room, playerInput);
    }

    const selectedWeapon = WEAPONS[weaponSelector.selectedId] ?? WEAPONS[DEFAULT_WEAPON_ID];
    const lastFire = lastFireAt.get(weaponSelector.selectedId) ?? -Infinity;
    weaponSelector.setCooldown(1 - (time - lastFire) / selectedWeapon.fireCooldown);

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
        },
        sessionId: string
      ) => renderVole(sessionId, vole, dt, time)
    );
    const bulletVoles: VoleHitTarget[] = [];
    room.state.voles.forEach((vole: { x: number; y: number; alive: boolean }, sessionId: string) => {
      bulletVoles.push({ id: sessionId, x: vole.x, y: vole.y, alive: vole.alive });
    });
    bulletLayer.update(dt, entityScale, bulletVoles);
    particleLayer.update(dt, entityScale);
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

    const self = room.state.voles.get(room.sessionId);
    if (self) {
      // Respawn is fully automatic now (see memory: project-deathmatch-mode) — no button, just a
      // status line while dead so it doesn't look like the game hung.
      const status = self.alive ? "" : room.state.winnerId ? "  (match over)" : "  (respawning...)";
      hud.textContent = `hp ${Math.max(0, Math.round(self.health))}  players ${room.state.voles.size}${status}`;
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
