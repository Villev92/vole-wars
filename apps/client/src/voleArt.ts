import { Assets, Container, Sprite, Texture } from "pixi.js";

// Built from designs/HeroParts.png, which contains 4 separate pre-drawn pieces on one transparent
// canvas (head, torso, gun+arm, one foot — the same foot art is reused for both near and far leg).
// Each piece was cropped out to its own file under public/art/ (see designs/HeroParts.png for the
// original sheet) rather than traced into vector polygons like the previous art, since the source
// is already flat shaded artwork.
//
// Rig convention: every part is positioned by main.ts at the vole's single shared origin O (the
// server's vole.x/y). Torso and head each carry a Sprite anchor at their own "neck" point, so
// leaving their .position at the Sprite default of (0,0) makes both necks land exactly on O —
// that's the seam between the two pieces, with no offset math needed. The gun's anchor is its
// shoulder attach point, same trick, same reason its rotation pivot (set by main.ts) lands at the
// shoulder instead of some arbitrary corner. Feet are the one part that isn't naturally anchored at
// O: their offset from O (HIP_X/FOOT_GROUND_Y below) was measured from the torso art's own hip/leg-
// nub, since that's where a leg would actually attach.
//
// Scale constants convert source pixels to "vole-local units". There's no single shared px-per-unit
// ratio across parts — each was picked independently so the assembled character's proportions land
// close to the old traced design's (helmet top ~12 units above O, boots ~15-18 below), not because
// the source parts were drawn to a common internal scale.
//
// ENTITY_SCALE converts those vole-local units into terrain units (the same space vole.x/y lives
// in) — main.ts applies it as every part's own .scale every frame, on top of the world container's
// camera zoom. It used to be counter-scaled by that zoom (1 vole-local-unit held a constant *screen*
// size no matter how far the camera was zoomed to fit the window) — that broke the rig internally:
// the whole point of ENTITY_SCALE is to be the single fixed ratio every part shares, so resizing the
// whole character (this constant) can never change any part's position *relative to* another part —
// only their shared position/rotation/facing, set by main.ts each frame, should do that.
//
// FOOT_GROUND_Y (below) deliberately does NOT follow VOLE_RADIUS/ENTITY_SCALE the way an earlier
// version of this file did. That formula only holds the foot at the *physics* circle's edge — a
// terrain-unit quantity that doesn't scale with ENTITY_SCALE at all — while the torso's own leg-nub
// (also below) is a vole-local quantity that shrinks right along with ENTITY_SCALE. Shrinking the
// character (as happened going from 1.3 to 0.45 to 0.225 here) made that formula place the foot
// further and further below the torso's own shrinking reach — the "body detached from its feet"
// bug. FOOT_GROUND_Y is fixed in vole-local units instead, matching the torso's own nub, so the two
// always move together at any ENTITY_SCALE. That in turn means physics.ts's VOLE_RADIUS is set to
// match THIS art (FOOT_GROUND_Y * ENTITY_SCALE), not the other way around — see its comment. If
// either FOOT_GROUND_Y or ENTITY_SCALE changes, VOLE_RADIUS needs to change with it, or the
// character will float above (or sink into) the ground again.
export const ENTITY_SCALE = 0.225;

const ART_BASE = "/art/";

export interface PartAnchors {
  torsoNeck: { x: number; y: number };
  headNeck: { x: number; y: number };
  gunShoulder: { x: number; y: number };
  footSole: { x: number; y: number };
}

export interface VoleTextures {
  head: Texture;
  helmetTint: Texture;
  torso: Texture;
  gun: Texture;
  foot: Texture;
  /** Per-hero render overrides. Absent for the built-in Burrows art (the create* helpers fall back
   *  to the hand-measured module constants below); populated by loadHeroArt() for the slice-built
   *  heroes, whose parts have their own sizes/anchors (see dev/slice-heroes.py). */
  scales?: { torso: number; head: number; gun: number; foot: number };
  anchors?: PartAnchors;
}

export type HeroId = "burrows" | "bristle" | "moss";

let texturesPromise: Promise<VoleTextures> | null = null;

/** Loads (and caches) the 5 source images used to build every vole's rig. Call once before the first renderVole. */
export function loadVoleTextures(): Promise<VoleTextures> {
  if (!texturesPromise) {
    texturesPromise = (async () => {
      const [head, helmetTint, torso, gun, foot] = await Promise.all([
        Assets.load<Texture>(`${ART_BASE}head.png`),
        // Same crop box and pixel grid as head.png, but the helmet area is flattened to white (and
        // the highlight stripe to over-bright white) with everything else transparent — a multiply
        // tint on this reproduces the old per-team helmet fill/shade exactly, without recoloring the
        // fur underneath. See designs/HeroParts.png header note for how it was extracted.
        Assets.load<Texture>(`${ART_BASE}helmet_tint.png`),
        Assets.load<Texture>(`${ART_BASE}torso.png`),
        Assets.load<Texture>(`${ART_BASE}gun.png`),
        Assets.load<Texture>(`${ART_BASE}foot.png`),
      ]);
      return { head, helmetTint, torso, gun, foot };
    })();
  }
  return texturesPromise;
}

/**
 * Loads the rig art for a chosen hero. "burrows" is the hand-tuned built-in set (public/art/*.png +
 * the module constants below). "bristle"/"moss" are assembled from parts sliced out of their design
 * sheets by dev/slice-heroes.py into public/art/heroes/<id>/, each carrying its own per-part scale
 * and anchor in spec.json — those ride along on the returned VoleTextures so the create* helpers
 * pick them up instead of the Burrows constants. Their headgear is baked into the head art, so
 * there's no separate team-tint layer (helmetTint is an empty texture).
 */
export async function loadHeroArt(heroId: HeroId): Promise<VoleTextures> {
  if (heroId === "burrows") return loadVoleTextures();
  const base = `/art/heroes/${heroId}/`;
  const spec = (await fetch(`${base}spec.json`).then((r) => r.json())) as Record<
    "torso" | "head" | "gun" | "foot",
    { scale: number; anchor: { x: number; y: number } }
  >;
  const [head, torso, gun, foot] = await Promise.all([
    Assets.load<Texture>(`${base}head.png`),
    Assets.load<Texture>(`${base}torso.png`),
    Assets.load<Texture>(`${base}gun.png`),
    Assets.load<Texture>(`${base}foot.png`),
  ]);
  return {
    head,
    torso,
    gun,
    foot,
    helmetTint: Texture.EMPTY,
    scales: { torso: spec.torso.scale, head: spec.head.scale, gun: spec.gun.scale, foot: spec.foot.scale },
    anchors: {
      torsoNeck: spec.torso.anchor,
      headNeck: spec.head.anchor,
      gunShoulder: spec.gun.anchor,
      footSole: spec.foot.anchor,
    },
  };
}

const TORSO_SCALE = 0.033;
const HEAD_SCALE = 0.03;
const GUN_SCALE = 0.0225;
const FOOT_SCALE = 0.02;

// Normalized (0-1) anchor points within each source image, measured from its alpha mask's own
// extents (topmost/bottommost/leftmost pixel runs) — not eyeballed.
const TORSO_NECK_ANCHOR = { x: 0.652, y: 0.0065 } as const;
const HEAD_NECK_ANCHOR = { x: 0.4453, y: 0.9904 } as const;
const GUN_SHOULDER_ANCHOR = { x: 0.0036, y: 0.6951 } as const;
// The sole, not the top of the foot art — see createFoot for why this one's the ground-contact
// point instead of an attach point like every other anchor here.
const FOOT_SOLE_ANCHOR = { x: 0.5037, y: 0.9688 } as const;

// Torso's hip/leg-nub bottom x, relative to its own neck anchor (i.e. relative to O), in
// vole-local units.
const HIP_X = -0.5;

// How far below O the foot's sole anchor (see createFoot) sits, in vole-local units — the torso's
// own leg-nub bottom is ~14.98 below its neck anchor (measured the same way TORSO_NECK_ANCHOR was),
// so this sits just past that: the foot peeks out below the nub instead of hiding inside it or
// floating away from it, at any ENTITY_SCALE.
const FOOT_GROUND_Y = 15.5;

// Nudges the head down into the torso's neck (closing the gap the raw anchor-to-anchor seam left)
// and slightly forward (+x, mirrored by facing like the rest of the rig) so it doesn't read as
// perched on top of the body.
const HEAD_OFFSET = { x: 2.6, y: 2.6 } as const;

// Where the shoulder actually sits relative to O: down from the neck and back toward the torso's
// centerline, so it reads as the top-mid of the body rather than hanging off the jaw. Applied in
// main.ts (not baked into createGun's own Sprite) because it has to land the CONTAINER's local
// origin at this point — that's both the render position and the rotation pivot main.ts sets every
// frame, and only the container's own position (not an internal child offset) can move a rotation
// pivot.
export const GUN_SHOULDER_OFFSET = { x: -2.8, y: 5.6 } as const;

/**
 * Torso — the rig's root piece. Its neck anchor sits at the shared origin O. Returns a wrapper
 * Container (not the Sprite itself): main.ts calls .scale.set() on this every frame to apply
 * entityScale/facing, which would overwrite rather than compose with a scale baked directly onto
 * the Sprite — same reasoning as createFoot's wrapper.
 */
export function createTorso(textures: VoleTextures): Container {
  const anchor = textures.anchors?.torsoNeck ?? TORSO_NECK_ANCHOR;
  const sprite = new Sprite(textures.torso);
  sprite.anchor.set(anchor.x, anchor.y);
  sprite.scale.set(textures.scales?.torso ?? TORSO_SCALE);
  const container = new Container();
  container.addChild(sprite);
  return container;
}

/** Head + team-tinted helmet overlay, nudged down/forward from O by HEAD_OFFSET so it sits into the
 *  torso's neck. Sliced heroes bake their headgear into the head art and pass Texture.EMPTY for the
 *  tint layer, so the helmet sprite there just renders nothing. */
export function createHead(textures: VoleTextures, teamColor: number): Container {
  const anchor = textures.anchors?.headNeck ?? HEAD_NECK_ANCHOR;
  const scale = textures.scales?.head ?? HEAD_SCALE;
  const base = new Sprite(textures.head);
  base.anchor.set(anchor.x, anchor.y);
  base.scale.set(scale);
  base.position.set(HEAD_OFFSET.x, HEAD_OFFSET.y);

  const helmet = new Sprite(textures.helmetTint);
  helmet.anchor.set(anchor.x, anchor.y);
  helmet.scale.set(scale);
  helmet.position.set(HEAD_OFFSET.x, HEAD_OFFSET.y);
  helmet.tint = teamColor;

  const container = new Container();
  container.addChild(base, helmet);
  return container;
}

/**
 * One foot. Called twice (near/far) since there's only one foot piece. Anchored at its SOLE rather
 * than its top, and positioned at FOOT_GROUND_Y — both fixed, art-derived vole-local quantities, so
 * the foot stays attached right below the torso's own leg-nub at any ENTITY_SCALE (see that
 * constant's own comment for why this isn't derived from VOLE_RADIUS instead).
 * spreadX/spreadY are ordinary vole-local nudges on top of that (horizontal hip spread, and a small
 * near/far depth offset) — those don't need precision, just to look right.
 */
export function createFoot(textures: VoleTextures, spreadX: number, spreadY = 0): Container {
  const anchor = textures.anchors?.footSole ?? FOOT_SOLE_ANCHOR;
  const sprite = new Sprite(textures.foot);
  sprite.anchor.set(anchor.x, anchor.y);
  sprite.scale.set(textures.scales?.foot ?? FOOT_SCALE);
  sprite.position.set(HIP_X + spreadX, FOOT_GROUND_Y + spreadY);
  const container = new Container();
  container.addChild(sprite);
  return container;
}

/**
 * Arm + paw + rifle. Its shoulder anchor sits at O, so rotating the returned container pivots at
 * the shoulder. Wrapped in a Container for the same reason createTorso is: main.ts sets rotation
 * and scale on this every frame, which must compose with (not overwrite) the baked GUN_SCALE.
 */
export function createGun(textures: VoleTextures): Container {
  const anchor = textures.anchors?.gunShoulder ?? GUN_SHOULDER_ANCHOR;
  const sprite = new Sprite(textures.gun);
  sprite.anchor.set(anchor.x, anchor.y);
  sprite.scale.set(textures.scales?.gun ?? GUN_SCALE);
  const container = new Container();
  container.addChild(sprite);
  return container;
}

export interface HeldWeaponVisual {
  texture: Texture;
  anchorX: number;
  anchorY: number;
  scale: number;
}

/**
 * Swaps what a createGun() container shows, or hides it entirely (visual null) — used only for the
 * local player's own held-weapon display, which tracks the weapon selector instead of always
 * showing the fixed arm+rifle art every other vole uses (their weapon selection isn't known to this
 * client, so they keep the default createGun() art untouched). Takes the CONTAINER createGun()
 * returned, not a raw Sprite, and reaches into its one child — same wrapper-vs-inner-scale split
 * createGun's own doc comment explains (main.ts's per-frame container scale must compose with, not
 * overwrite, this sprite's own baked scale).
 */
export function setGunVisual(gunContainer: Container, visual: HeldWeaponVisual | null): void {
  const sprite = gunContainer.children[0] as Sprite;
  sprite.visible = visual !== null;
  if (visual) {
    sprite.texture = visual.texture;
    sprite.anchor.set(visual.anchorX, visual.anchorY);
    sprite.scale.set(visual.scale);
  }
}

/** Tints the held-weapon sprite (0xffffff = untinted). Only the minigun uses this, to glow the
 *  barrel red as it heats up — see main.ts's overheat block. Reaches into the same one child
 *  setGunVisual does. */
export function setGunTint(gunContainer: Container, tint: number): void {
  (gunContainer.children[0] as Sprite).tint = tint;
}
