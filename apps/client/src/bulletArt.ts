import { Graphics } from "pixi.js";
import { WEAPONS } from "@vole-wars/shared";
import { ENTITY_SCALE } from "./voleArt.js";

/** Draws a small rocket, local +x = direction of travel (the graphic is rotated to the bullet's heading). */
export function drawBullet(g: Graphics): void {
  const outline = { width: 0.6, color: 0x241a13 } as const;

  // Flame/smoke trail — fixed in local space so it always trails behind the nose as the
  // graphic's rotation tracks the bullet's current heading, with no per-frame redraw needed.
  g.moveTo(-4, 0).lineTo(-11, -2.6).lineTo(-7, 0).lineTo(-11, 2.6).closePath().fill({ color: 0xff9d3d, alpha: 0.55 });
  g.moveTo(-4, 0).lineTo(-8, -1.2).lineTo(-6, 0).lineTo(-8, 1.2).closePath().fill({ color: 0xffe9a8, alpha: 0.75 });

  // Body
  g.roundRect(-4, -1.6, 8, 3.2, 1.3).fill(0x4a4f55).stroke(outline);
  g.roundRect(-4, -1.6, 3.5, 3.2, 1).fill(0x6b6f74);

  // Fins
  g.moveTo(-4, -1.4).lineTo(-6.4, -3.2).lineTo(-3.4, -1.2).closePath().fill(0x33383d).stroke(outline);
  g.moveTo(-4, 1.4).lineTo(-6.4, 3.2).lineTo(-3.4, 1.2).closePath().fill(0x33383d).stroke(outline);

  // Nose cone
  g.moveTo(4, -1.6).lineTo(7.5, 0).lineTo(4, 1.6).closePath().fill(0xd6503a).stroke(outline);
}

/**
 * Draws a small rifle round — a plain tapered slug with a thin tracer streak, not a rocket. Local
 * +x = direction of travel, same convention as drawBullet. Deliberately much smaller than the
 * rocket (~8.5 units nose-to-tracer-tip vs. drawBullet's ~18.5) to read as a bullet at a glance.
 */
export function drawAkBullet(g: Graphics): void {
  const outline = { width: 0.35, color: 0x241a13 } as const;

  // Thin tracer streak trailing the slug.
  g.moveTo(-6, 0).lineTo(-1.4, -0.35).lineTo(-1.4, 0.35).closePath().fill({ color: 0xffe9a8, alpha: 0.6 });

  // Brass-cased slug, tapering to a point.
  g.moveTo(-1.4, -0.7)
    .lineTo(1, -0.55)
    .lineTo(2.4, 0)
    .lineTo(1, 0.55)
    .lineTo(-1.4, 0.7)
    .closePath()
    .fill(0xc9a24a)
    .stroke(outline);
}

/** Draws a brief expanding-and-fading impact flash at a bullet's point of detonation. t goes 0 -> 1. */
export function drawImpactFlash(g: Graphics, t: number): void {
  const grow = 1 - Math.pow(1 - t, 2);
  const fade = 1 - t;
  g.circle(0, 0, 2 + grow * 6.5).fill({ color: 0xff8a3d, alpha: fade * 0.55 });
  g.circle(0, 0, 1 + grow * 3.5).fill({ color: 0xffe3a3, alpha: fade * 0.85 });
}

/**
 * Sniper round — a longer, thinner, brighter tracer than the AK's slug (same tapered-brass shape,
 * stretched and lit up) so a precision hit reads as a fast, clean line rather than a stubby pellet.
 */
export function drawSniperBullet(g: Graphics): void {
  const outline = { width: 0.3, color: 0x241a13 } as const;

  g.moveTo(-9, 0).lineTo(-1.6, -0.3).lineTo(-1.6, 0.3).closePath().fill({ color: 0xfff2c8, alpha: 0.75 });

  g.moveTo(-1.6, -0.55)
    .lineTo(1.6, -0.4)
    .lineTo(3, 0)
    .lineTo(1.6, 0.4)
    .lineTo(-1.6, 0.55)
    .closePath()
    .fill(0xe8dcc0)
    .stroke(outline);
}

/** Railgun bolt — an elongated cyan energy capsule with a glowing core, local +x = travel direction. */
export function drawRailgunBullet(g: Graphics): void {
  g.moveTo(-10, 0).lineTo(-2, -0.9).lineTo(-2, 0.9).closePath().fill({ color: 0x4fd6ff, alpha: 0.45 });
  g.roundRect(-2.5, -1.1, 5, 2.2, 1.1).fill({ color: 0x2a8fbf, alpha: 0.9 }).stroke({ width: 0.4, color: 0x0d3a4d });
  g.roundRect(-1.4, -0.5, 3.4, 1, 0.5).fill(0xe8fdff);
}

/** A single small gout of flame — no fins/casing, just a soft warm blob (one flamethrower pellet). */
export function drawFlameBullet(g: Graphics): void {
  g.circle(0, 0, 2.6).fill({ color: 0xb33a2a, alpha: 0.65 });
  g.circle(0.3, 0, 1.8).fill({ color: 0xff9d3d, alpha: 0.85 });
  g.circle(0.6, 0, 0.9).fill({ color: 0xffe9a8, alpha: 0.9 });
}

/** A tumbling hand grenade in flight — round body, cross-hatch texture, neck+lever, no thrust trail. */
export function drawGrenadeBullet(g: Graphics): void {
  const outline = { width: 0.4, color: 0x1c130c } as const;

  g.circle(0, 0, 3.6).fill(0x5b6b45).stroke(outline);
  for (let i = -2; i <= 2; i += 2) {
    g.moveTo(-3.2, i).lineTo(3.2, i).stroke({ width: 0.3, color: 0x1c130c, alpha: 0.5 });
  }
  g.moveTo(0, -3.2).lineTo(0, 3.2).stroke({ width: 0.3, color: 0x1c130c, alpha: 0.5 });
  g.poly([-0.9, -3.6, 0.9, -3.6, 0.9, -2.4, -0.9, -2.4], true).fill(0x565f68).stroke(outline); // neck
}

/** Railgun's own impact — cyan energy burst instead of the default orange/fire flash. t goes 0 -> 1. */
export function drawRailgunImpactFlash(g: Graphics, t: number): void {
  const grow = 1 - Math.pow(1 - t, 2);
  const fade = 1 - t;
  g.circle(0, 0, 2 + grow * 6.5).fill({ color: 0x4fd6ff, alpha: fade * 0.55 });
  g.circle(0, 0, 1 + grow * 3.5).fill({ color: 0xe8fdff, alpha: fade * 0.85 });
}

/** A single buckshot pellet — a plain round ball with a small tracer streak, smaller than the AK's slug. */
export function drawShotgunPellet(g: Graphics): void {
  // A small round lead ball — buckshot, no tracer streak.
  g.circle(0, 0, 1.15).fill(0x9aa0a8).stroke({ width: 0.3, color: 0x241a13 });
  g.circle(-0.4, -0.4, 0.42).fill({ color: 0xe6eaef, alpha: 0.75 });
}

/** A single minigun round — like the AK's tracer slug but tinier, for a rapid-burst stream of them. */
export function drawMinigunBullet(g: Graphics): void {
  g.moveTo(-4, 0).lineTo(-0.9, -0.25).lineTo(-0.9, 0.25).closePath().fill({ color: 0xffe9a8, alpha: 0.6 });
  g.moveTo(-0.9, -0.45).lineTo(0.7, -0.35).lineTo(1.5, 0).lineTo(0.7, 0.35).lineTo(-0.9, 0.45).closePath().fill(0xc9a24a).stroke({
    width: 0.25,
    color: 0x241a13,
  });
}

/** A tossed mine tumbling before it lands — the same disc/dome shape as its held art, seen from the side. */
export function drawMineBullet(g: Graphics): void {
  const outline = { width: 0.4, color: 0x1c130c } as const;
  g.ellipse(0, 0, 3.4, 2.2).fill(0x3f4a35).stroke(outline);
  g.ellipse(0, -0.6, 2.2, 1.1).fill(0x5b6b45).stroke(outline);
  g.circle(0, -0.6, 0.7).fill(0xb3282a);
}

/**
 * Heavier cousin of the bazooka's rocket (drawBullet) — same silhouette, bigger, and a distinct
 * white/grey/red paint scheme (matching its held-weapon art) instead of the bazooka's plain grey.
 */
export function drawMissileBullet(g: Graphics): void {
  const outline = { width: 0.6, color: 0x241a13 } as const;

  g.moveTo(-5, 0).lineTo(-13, -3).lineTo(-8.5, 0).lineTo(-13, 3).closePath().fill({ color: 0xff9d3d, alpha: 0.55 });
  g.moveTo(-5, 0).lineTo(-9.5, -1.4).lineTo(-7, 0).lineTo(-9.5, 1.4).closePath().fill({ color: 0xffe9a8, alpha: 0.75 });

  g.roundRect(-5, -1.9, 10, 3.8, 1.5).fill(0xd7d2c8).stroke(outline);
  g.roundRect(-5, -1.9, 4, 3.8, 1.1).fill(0xeceae4);
  g.roundRect(0.5, -1.9, 2, 3.8, 0).fill(0xc0342a);

  g.moveTo(-5, -1.7).lineTo(-7.7, -3.9).lineTo(-4.2, -1.5).closePath().fill(0x8a8f96).stroke(outline);
  g.moveTo(-5, 1.7).lineTo(-7.7, 3.9).lineTo(-4.2, 1.5).closePath().fill(0x8a8f96).stroke(outline);

  g.moveTo(5, -1.9).lineTo(9, 0).lineTo(5, 1.9).closePath().fill(0xeceae4).stroke(outline);
}

/** Mine's own impact — bigger and darker-red than the default flash, matching its huge blast radius. t goes 0 -> 1. */
export function drawMineImpactFlash(g: Graphics, t: number): void {
  const grow = 1 - Math.pow(1 - t, 2);
  const fade = 1 - t;
  g.circle(0, 0, 3 + grow * 11).fill({ color: 0xb3282a, alpha: fade * 0.5 });
  g.circle(0, 0, 1.5 + grow * 6).fill({ color: 0xff8a3d, alpha: fade * 0.6 });
  g.circle(0, 0, 1 + grow * 3).fill({ color: 0xffe3a3, alpha: fade * 0.85 });
}

// The flash's outer edge is locked to bazooka's actual carveRadius (the crater it leaves in the
// terrain) rather than an independently-tuned magic number, so the visual can never drift out of
// sync with the real destruction radius — it grows to exactly the size of the hole it just made.
// carveRadius is in terrain units, but everything drawn in this file (and every other draw*
// function here) is in vole-local units, which main.ts/bullets.ts scale DOWN by ENTITY_SCALE
// (0.225) at render time — drawing carveRadius directly, unconverted, was rendering a flash about
// 1/0.225 (~4.4x) smaller than the real crater. Dividing by ENTITY_SCALE here undoes that ahead of
// time so the two end up the same size on screen.
const BAZOOKA_CRATER_RADIUS = WEAPONS.bazooka.carveRadius / ENTITY_SCALE;
// Drawn a bit past the crater's own edge (not capped exactly to it) and noticeably softer/more
// translucent than a flat opaque blob — a crater-matched, fully-opaque flash read as too small and
// too solid to actually register as an explosion. This is purely visual; the real destruction
// radius is still exactly carveRadius (BAZOOKA_CRATER_RADIUS above), untouched.
const BAZOOKA_FLASH_SCALE = 1.35;

/** Bazooka's own impact — a proper rocket-explosion blast: a bold red outer ring collapsing into a
 *  bright yellow core, rather than the default flash's muted orange, sized off the crater (see
 *  BAZOOKA_CRATER_RADIUS/BAZOOKA_FLASH_SCALE above). t goes 0 -> 1. */
export function drawBazookaExplosion(g: Graphics, t: number): void {
  const grow = 1 - Math.pow(1 - t, 2);
  const fade = 1 - t;
  const r = BAZOOKA_CRATER_RADIUS * BAZOOKA_FLASH_SCALE;
  g.circle(0, 0, r * 0.25 + grow * r * 0.75).fill({ color: 0xc0342a, alpha: fade * 0.35 });
  g.circle(0, 0, r * 0.15 + grow * r * 0.46).fill({ color: 0xff8a3d, alpha: fade * 0.5 });
  g.circle(0, 0, r * 0.08 + grow * r * 0.25).fill({ color: 0xffde5c, alpha: fade * 0.7 });
}
