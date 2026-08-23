import { Graphics } from "pixi.js";

// No skeleton art asset exists (voleArt.ts's rig is built from 4 pre-drawn PNG pieces cut from
// designs/HeroParts.png, none of which are bones) — drawn procedurally instead, the same technique
// already used for the debris chunks in particles.ts and the HP bar in main.ts. Proportioned in the
// same vole-local unit system voleArt.ts uses (O sits at the neck/hip seam, roughly VOLE_RADIUS
// terrain units of "reach" above and below) so entityScale sizes it consistently with a living vole
// — it doesn't need to match voleArt.ts's rig pixel-for-pixel since it's a visually distinct dead
// state, just the same rough scale.
const BONE = 0xe8e0d0;
const BONE_SHADOW = 0xb8ae98;
const INK = 0x2a2018;

/** Draws a simple procedural skeleton, lying/standing at O, facing +x. Static — drawn once per
 *  corpse, not redrawn per frame (a corpse doesn't animate). */
export function drawSkeleton(g: Graphics): void {
  // Skull.
  g.circle(0, -12.5, 3.6).fill(BONE).stroke({ width: 0.5, color: INK });
  // Jaw hint.
  g.rect(-1.6, -10.2, 3.2, 1.3).fill(BONE_SHADOW).stroke({ width: 0.4, color: INK });

  // Spine.
  g.moveTo(0, -9).lineTo(0, 2).stroke({ width: 1.3, color: BONE });

  // Ribcage — a few short horizontal strokes off the spine.
  for (let i = 0; i < 4; i++) {
    const y = -7 + i * 1.9;
    const w = 3.2 - i * 0.3;
    g.moveTo(-w, y).lineTo(w, y).stroke({ width: 0.8, color: BONE_SHADOW });
  }

  // Pelvis.
  g.moveTo(-2.6, 2).lineTo(2.6, 2).stroke({ width: 1.4, color: BONE });

  // Arms, splayed slightly outward from the shoulders.
  g.moveTo(0, -8).lineTo(-4.5, -3).stroke({ width: 1, color: BONE });
  g.moveTo(0, -8).lineTo(4.5, -3.5).stroke({ width: 1, color: BONE });

  // Legs, from the pelvis down to where the feet would be.
  g.moveTo(-1.6, 2).lineTo(-3.2, 14).stroke({ width: 1.3, color: BONE });
  g.moveTo(1.6, 2).lineTo(3, 13.5).stroke({ width: 1.3, color: BONE });
}
