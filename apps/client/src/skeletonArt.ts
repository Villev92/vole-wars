import { Assets, Container, Sprite, Texture } from "pixi.js";

// designs/models/vole-skeleton.png, copied to public/art/skeleton.png — a single pre-drawn corpse
// pose (lying on its side, facing +x, same convention voleArt.ts's rig uses), unlike the rest of the
// rig which is assembled from several separately-posed pieces. Replaces an earlier procedurally
// drawn (Graphics) skeleton now that real art exists for it.
//
// ANCHOR is the source image's alpha-weighted centroid (measured with a small script over the PNG's
// alpha channel, the same "not eyeballed" approach voleArt.ts's part anchors use) rather than a
// bounding-box center — landing the sprite's local origin there keeps the corpse's visual "mass"
// centered on the physics corpse position (corpse.x/y) it's placed at in main.ts, instead of e.g. the
// helmet or the tail dominating where it appears to sit.
const ANCHOR = { x: 0.541, y: 0.558 } as const;

// Converts the source image's ~1193px width into vole-local units, picked to land the corpse at
// roughly the same overall size as the living rig (compare voleArt.ts's TORSO_SCALE) once main.ts
// applies ENTITY_SCALE on top.
const SCALE = 0.033;

let texturePromise: Promise<Texture> | null = null;

/** Loads (and caches) the skeleton corpse texture. Call once before the first corpse spawns. */
export function loadSkeletonTexture(): Promise<Texture> {
  if (!texturePromise) texturePromise = Assets.load<Texture>("/art/skeleton.png");
  return texturePromise;
}

/**
 * One corpse's skeleton art. Returns a wrapper Container (not the Sprite itself), same reasoning as
 * voleArt.ts's createTorso/createFoot/createGun: main.ts calls .scale.set() on this every frame to
 * apply entityScale/facing, which needs to compose with (not overwrite) SCALE baked onto the Sprite.
 */
export function createSkeleton(texture: Texture): Container {
  const sprite = new Sprite(texture);
  sprite.anchor.set(ANCHOR.x, ANCHOR.y);
  sprite.scale.set(SCALE);
  const container = new Container();
  container.addChild(sprite);
  return container;
}
