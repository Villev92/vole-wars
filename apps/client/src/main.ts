import { Application, Container, Graphics } from "pixi.js";
import { getStateCallbacks } from "colyseus.js";
import {
  TERRAIN_STONE,
  TerrainField,
  type PlayerInput,
  type ProjectileSimState,
  type VoleHitTarget,
} from "@vole-wars/shared";
import { connect, requestTerrain, sendFire, sendInput } from "./net.js";
import { TerrainRenderer, DIRT_COLOR, STONE_COLOR } from "./terrainRenderer.js";
import { BloodRenderer } from "./bloodRenderer.js";
import { createCaveBackground } from "./caveBackground.js";
import { drawSkeleton } from "./skeletonArt.js";
import { InputTracker } from "./input.js";
import { createFoot, createGun, createHead, createTorso, loadVoleTextures, setGunVisual, ENTITY_SCALE, GUN_SHOULDER_OFFSET } from "./voleArt.js";
import {
  drawAkBullet,
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
import { playGunshot, unlockAudio } from "./sound.js";
import { WeaponSelector } from "./weaponSelector.js";
import { loadWeaponIconTextures, type TexturedWeaponId } from "./weaponIcons.js";

const PLAYER_COLORS = [0x4caf50, 0xef5350, 0x42a5f5, 0xffca28];

// The server only ticks (and broadcasts state) at 30Hz. Rendering vole position/aim straight from
// the last-received patch makes motion visibly step every ~33ms even on a 60/144Hz display. Instead
// each view keeps its own smoothed "render" pose that eases toward the latest server pose every
// animation frame, so movement reads as fluid regardless of network tick rate or jitter.
const POSITION_SMOOTH_RATE = 18;
const ANGLE_SMOOTH_RATE = 22;

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
  ak47: { anchorX: 0.298, anchorY: 0.662, scale: 0.038 },
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

// Per-weapon flight/impact visuals for the "fire" broadcast below — falls back to the bazooka's
// rocket + default orange flash for any weapon without its own entry (every WEAPON_IDS slot has one
// now — see weapons.ts — so this fallback is currently unreachable, kept as a safety net).
const BULLET_VISUALS: Partial<Record<string, { draw: (g: Graphics) => void; impact: (g: Graphics, t: number) => void }>> = {
  ak47: { draw: drawAkBullet, impact: drawImpactFlash },
  sniper: { draw: drawSniperBullet, impact: drawImpactFlash },
  railgun: { draw: drawRailgunBullet, impact: drawRailgunImpactFlash },
  flamethrower: { draw: drawFlameBullet, impact: drawImpactFlash },
  grenade: { draw: drawGrenadeBullet, impact: drawImpactFlash },
  shotgun: { draw: drawShotgunPellet, impact: drawImpactFlash },
  minigun: { draw: drawMinigunBullet, impact: drawImpactFlash },
  mine: { draw: drawMineBullet, impact: drawMineImpactFlash },
  missile: { draw: drawMissileBullet, impact: drawImpactFlash },
};
const DEFAULT_BULLET_VISUAL = { draw: drawBullet, impact: drawImpactFlash };

interface VoleView {
  farFoot: Container;
  torso: Container;
  head: Container;
  nearFoot: Container;
  gun: Container;
  hp: Graphics;
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

  document.addEventListener("gesturestart", (e) => e.preventDefault());

  hud.textContent = "connecting to server...";
  const [room, voleTextures, weaponIconTextures] = await Promise.all([connect(), loadVoleTextures(), loadWeaponIconTextures()]);
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
  let zoomLevel = MIN_ZOOM;

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
    const farFoot = createFoot(voleTextures, -1.4, -0.4);
    const torso = createTorso(voleTextures);
    const head = createHead(voleTextures, color);
    const nearFoot = createFoot(voleTextures, 0, 0);
    const gun = createGun(voleTextures);
    const hp = new Graphics();
    // Unlike the other parts, the rope line is drawn in absolute world/terrain coordinates (both
    // endpoints already are), not vole-local units, so it deliberately gets no entityScale here.
    const rope = new Graphics();
    farFoot.scale.set(entityScale);
    torso.scale.set(entityScale);
    head.scale.set(entityScale);
    nearFoot.scale.set(entityScale);
    gun.scale.set(entityScale);
    hp.scale.set(entityScale);
    // z-order: far foot mostly hidden behind the torso, head drawn over the torso's neck seam, near
    // foot and gun in front of everything else — same layering the old traced art used. The rope
    // goes in first so the character rig draws on top of it near the attach hand.
    world.addChild(rope, farFoot, torso, head, nearFoot, gun, hp);
    const view: VoleView = {
      farFoot,
      torso,
      head,
      nearFoot,
      gun,
      hp,
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

    const posEase = easeFactor(POSITION_SMOOTH_RATE, dt);
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
      setGunVisual(view.gun, {
        texture: weaponIconTextures[selectedId],
        anchorX: visual.anchorX,
        anchorY: visual.anchorY,
        scale: visual.scale,
      });
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

  // The camera keeps the local player centered and always on-screen, zoomed by zoomLevel (see left
  // Shift + scroll above) on top of the same "cover the window" base scale the fully-zoomed-out view
  // always used. Clamped to the terrain bounds on both axes so zooming in near an edge never shows a
  // gap past the map — at zoomLevel 1 (MIN_ZOOM) that clamp range collapses to exactly the old
  // always-centered-on-the-map behavior, since the map exactly covers the window at that scale.
  function applyCamera(): void {
    const coverScale = Math.max(app.renderer.width / terrain.width, app.renderer.height / terrain.height);
    const scale = coverScale * zoomLevel;
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
  app.renderer.on("resize", applyCamera);

  room.onMessage("terrain-carve", (msg: { x: number; y: number; radius: number }) => {
    // Sampled before carving, since carve() clears the material this explosion is destroying.
    const material = terrain.get(Math.floor(msg.x), Math.floor(msg.y));
    const debrisColor = material === TERRAIN_STONE ? STONE_COLOR : DIRT_COLOR;
    terrainRenderer.carve(msg.x, msg.y, msg.radius);
    // Destroying terrain destroys any blood sitting on it too (see project spec: blood persists
    // until the bloody terrain itself is carved away).
    bloodRenderer.clearCircle(msg.x, msg.y, msg.radius);
    particleLayer.burst(msg.x, msg.y, debrisColor, Math.round(14 + msg.radius));
  });

  room.onMessage("fire", (msg: ProjectileSimState) => {
    const visual = BULLET_VISUALS[msg.weaponId] ?? DEFAULT_BULLET_VISUAL;
    bulletLayer.spawn(msg, visual.draw, visual.impact);
    playGunshot();
  });

  room.onMessage("blood", (msg: { x: number; y: number; amount: number }) => {
    bloodRenderer.splatter(msg.x, msg.y, msg.amount);
  });

  $(room.state).voles.onRemove((_vole, sessionId) => {
    const view = voleViews.get(sessionId);
    if (view) {
      world.removeChild(view.rope, view.farFoot, view.torso, view.head, view.nearFoot, view.gun, view.hp);
      voleViews.delete(sessionId);
    }
  });

  interface CorpseView {
    graphic: Graphics;
    renderX: number;
    renderY: number;
  }
  const corpseViews = new Map<string, CorpseView>();
  $(room.state).corpses.onAdd((corpse) => {
    const graphic = new Graphics();
    drawSkeleton(graphic);
    graphic.scale.set(entityScale * corpse.facing, entityScale);
    graphic.position.set(corpse.x, corpse.y);
    // Inserted right above the terrain/blood layers (indices 0-2) rather than appended, so a
    // skeleton always renders under every living character's parts, however many of each already
    // exist in the display list.
    world.addChildAt(graphic, 3);
    corpseViews.set(corpse.id, { graphic, renderX: corpse.x, renderY: corpse.y });
  });
  $(room.state).corpses.onRemove((corpse) => {
    const view = corpseViews.get(corpse.id);
    if (view) {
      world.removeChild(view.graphic);
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
  input.setFireHandler(() => sendFire(room, weaponSelector.selectedId));

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

    const corpsePosEase = easeFactor(POSITION_SMOOTH_RATE, dt);
    room.state.corpses.forEach((corpse: { x: number; y: number; facing: number }, id: string) => {
      const view = corpseViews.get(id);
      if (!view) return;
      view.renderX += (corpse.x - view.renderX) * corpsePosEase;
      view.renderY += (corpse.y - view.renderY) * corpsePosEase;
      view.graphic.position.set(view.renderX, view.renderY);
      view.graphic.scale.set(entityScale * corpse.facing, entityScale);
    });

    // Depends on this frame's renderVole pass above (uses the local player's just-updated smoothed
    // render position as the zoom focus point), so it has to run after that loop, every frame — not
    // just on resize — since the focus point moves continuously.
    applyCamera();

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
