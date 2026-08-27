import { MAX_HEALTH } from "./types.js";

export interface WeaponDef {
  id: string;
  projectileSpeed: number;
  gravityScale: number;
  explosionRadius: number;
  carveRadius: number;
  // Direct-hit damage (see physics.ts applyExplosion) — a body hit does exactly this; a headshot
  // multiplies it by headshotMultiplier. Splash-only damage (caught in the blast but not the
  // direct target) is a small flat amount, not weapon-specific.
  damage: number;
  /** Headshot damage = damage * headshotMultiplier. Defaults to 2 (see applyExplosion) when unset.
   *  Sniper sets this to 1 so a hit is always exactly damage regardless of where it lands — see its
   *  own comment. */
  headshotMultiplier?: number;
  /** Damage dealt to anyone caught in the blast radius who ISN'T the direct target — defaults to a
   *  small flat SPLASH_ONLY_DAMAGE (see applyExplosion) when unset. Weapon-specific so a
   *  big-blast weapon (bazooka) can make "caught in the splash" actually hurt instead of reading as
   *  a rounding error next to a direct hit. */
  splashDamage?: number;
  /** Max distance (terrain units — same units as vole x/y, so e.g. ARENA_WIDTH=679 is a ready
   *  yardstick: a maxRange of 300 crosses ~44% of the arena) a projectile can travel before it
   *  fizzles out with no damage/carve, tracked as actual path length (not just flight time), so it
   *  behaves the same for flat-flying and gravity-arced weapons alike. Undefined = unlimited
   *  (only railgun: it's meant to reach anywhere on the map, beam-style). See GameRoom.update's
   *  per-projectile `traveled` tracking and BulletLayer's client-side mirror of the same cutoff. */
  maxRange?: number;
  /** Minimum seconds between shots, enforced server-side per player (see GameRoom.handleFire's
   *  lastFireAt) regardless of how fast the client sends "fire" messages — this is the actual
   *  rate-of-fire mechanic, not just click speed. */
  fireCooldown: number;
  /** When true, the projectile doesn't stop at the first dirt/stone cell it touches (only
   *  indestructible rock or a vole stops it — see physics.ts's stepProjectile) — GameRoom.update
   *  carves a capsule (TerrainField.carveCapsule) along however far it actually travels each tick,
   *  so it destroys everything destructible along its whole flight instead of a small pocket at a
   *  single impact point. Only sniper sets this. */
  piercing?: boolean;
  /** How far (measured the same way as maxRange: cumulative path length since it was fired, not
   *  just time spent piercing) a piercing weapon keeps its "punch through dirt/stone" behavior.
   *  Past this distance it behaves like a normal weapon for the rest of its flight — stops dead at
   *  the next solid cell it touches — though it can still keep flying through open air up to
   *  maxRange same as before. Undefined/unset means piercing never turns off on its own (unused
   *  currently; sniper is the only piercing weapon and sets this to a shorter distance than its own
   *  maxRange, so the destructible "reach" is deliberately less than the full possible flight
   *  distance a shot that never hits anything solid can cover). See GameRoom.update's `pierced-off`
   *  effectiveWeapon override and BulletLayer's client-side mirror. */
  pierceRange?: number;
  /** Max cumulative distance a piercing weapon can spend actually inside solid dirt/stone before
   *  piercing turns off — unlike pierceRange above, open-air travel doesn't count against this at
   *  all, only distance where it was genuinely destroying material (see stepProjectile's
   *  `pierceBudget` param/`pierceDistance` result and GameRoom.update's `terrainPierced` tracking).
   *  A shot fired straight into a wall burns through this budget almost immediately (stops "quite
   *  soon"); a shot that flies through open space first doesn't lose any of it until it actually
   *  touches something. Whichever of this or pierceRange is hit first turns piercing off. Undefined
   *  means no separate terrain-distance cap (only sniper sets this). */
  pierceTerrainLimit?: number;
  /** Projectiles spawned per "fire" — defaults to 1. >1 fans them out across spreadRadians (shotgun/minigun). */
  pelletCount?: number;
  /** Total random aim-angle jitter pellets are fanned across when pelletCount > 1. Unused otherwise. */
  spreadRadians?: number;
  /** Flamethrower only — it is NOT a projectile weapon. Held-fire continuous flame stream this many
   *  terrain units long (see GameRoom's flame handling): it doesn't carve terrain, terrain blocks
   *  it, hitting terrain lights a short-lived burn patch, and both direct contact and standing in a
   *  burn patch deal damage-over-time. */
  flameRange?: number;
  /** Half-angle (radians) of the flamethrower's spray cone. */
  flameConeHalfRadians?: number;
  /** Times the projectile may bounce off dirt/stone before it detonates — on the (bounces+1)-th
   *  terrain contact it explodes. Undefined = detonates on the first contact like normal. A contact
   *  with a vole always detonates regardless of bounce count. See stepProjectile. */
  bounces?: number;
  /** Fraction of speed kept through a bounce (0..1). Defaults to 0.5. */
  bounceRestitution?: number;
  /** When true, splash damage to a non-direct target falls off linearly with distance from the
   *  blast centre — full `damage` at the centre, 0 at `explosionRadius` — instead of the flat
   *  `splashDamage`. Rounded to the nearest integer. See applyExplosion. */
  linearFalloff?: boolean;
  /** When true this weapon is thrown with a hold-to-charge power (see main.ts / GameRoom.handleFire):
   *  the "fire" message carries a 0..1 `power` that maps to a launch speed between minThrowSpeed and
   *  maxThrowSpeed. projectileSpeed is unused for these. */
  chargeThrow?: boolean;
  minThrowSpeed?: number;
  maxThrowSpeed?: number;
}

// ak47 is the baseline maxRange every other weapon's range is designed relative to (see each
// weapon's own comment) — sniper is specifically pinned to exactly double it per design.
const AK47_MAX_RANGE = 300;

export const WEAPONS: Record<string, WeaponDef> = {
  bazooka: {
    id: "bazooka",
    projectileSpeed: 420,
    gravityScale: 0.6,
    // Bumped up (was 34/11) for a bigger, more satisfying crater and a blast that actually threatens
    // anyone nearby, not just a direct hit.
    explosionRadius: 48,
    carveRadius: 16,
    // Direct hit 30, anyone else caught in the blast 20 (splashDamage) — a deliberately narrow gap
    // between the two now that the blast radius is this big, so "caught in the splash" is a real
    // threat rather than a rounding error next to a direct hit.
    damage: 30,
    splashDamage: 20,
    maxRange: 260,
    fireCooldown: 1.1,
  },
  ak47: {
    id: "ak47",
    // Fast, flat-shooting rifle round rather than a lobbed rocket — no gravityScale, so it flies
    // dead straight (no bullet drop) — and a much smaller blast, a quarter of the bazooka's own
    // explosionRadius/carveRadius in both terrain destruction and damage falloff distance.
    projectileSpeed: 650,
    gravityScale: 0,
    explosionRadius: 8.5,
    carveRadius: 2.75,
    damage: 40,
    maxRange: AK47_MAX_RANGE,
    fireCooldown: 0.15,
  },
  grenade: {
    id: "grenade",
    // Charge-thrown, not clicked: the client holds LMB to build power (see main.ts) and the server
    // maps it to a launch speed between minThrowSpeed (a short click — plops at the feet) and
    // maxThrowSpeed (a full charge, ~30 units of throw at a 45° aim). Low gravityScale for a slight
    // lob, not a high arc. bounces:1 — it survives its first terrain contact (bounces) and detonates
    // on the second, or on any contact with a vole. Splash uses linear distance falloff (see
    // applyExplosion / linearFalloff): full `damage` at the blast centre, 0 at the edge; a
    // projectile that physically strikes a vole does a flat `damage` (headshotMultiplier 1).
    projectileSpeed: 0,
    gravityScale: 0.5,
    explosionRadius: 44,
    carveRadius: 15,
    damage: 40,
    headshotMultiplier: 1,
    linearFalloff: true,
    maxRange: 240,
    fireCooldown: 1.0,
    bounces: 1,
    bounceRestitution: 0.5,
    chargeThrow: true,
    minThrowSpeed: 22,
    // ~45 units of throw at a 45° aim (range scales with speed², so a 1.5x range is a ~1.22x speed
    // bump — 120 -> 147).
    maxThrowSpeed: 147,
  },
  sniper: {
    id: "sniper",
    // Precision one-shot: fastest, flattest (no drop) round in the game and the highest single-hit
    // damage. damage is exactly half of MAX_HEALTH so two direct hits always kill, and
    // headshotMultiplier is pinned to 1 so a headshot doesn't overshoot that "always exactly half"
    // design the way every other weapon's default 2x bonus would. maxRange is exactly double
    // ak47's, and gravityScale stays 0 (no drop) same as before. piercing (see WeaponDef) makes it
    // punch clean through dirt/stone instead of stopping at the surface. carveRadius (tunnel width,
    // not depth — depth is governed by pierceRange/pierceTerrainLimit below) was bumped 2 -> 7 when
    // piercing was first added, then narrowed twice more after playtesting judged it too wide: 7 ->
    // 4.7 (2/3) -> 3.5 — still fatter than the original pre-piercing 2, just not as heavy-handed.
    // A shot that never hits anything solid can still fly the full 600 (maxRange, unaffected by
    // either cap below). pierceTerrainLimit=50 is the real terrain-impact limiter: it can only ever
    // destroy 50 units' worth of actual dirt/stone, so a shot fired straight into a wall stops
    // almost immediately, while one that flies through open caves first doesn't burn any of that
    // budget until it actually touches something. pierceRange=200 is a secondary, coarser backstop
    // measured in total distance traveled (not just terrain contact) — whichever of the two is hit
    // first turns piercing off; past that it stops at the next solid cell like a normal weapon
    // (still free to keep flying through open air up to maxRange, just without punching more walls).
    projectileSpeed: 900,
    gravityScale: 0,
    explosionRadius: 6,
    carveRadius: 3.5,
    damage: MAX_HEALTH / 2,
    headshotMultiplier: 1,
    maxRange: AK47_MAX_RANGE * 2,
    pierceRange: 200,
    pierceTerrainLimit: 50,
    fireCooldown: 1.4,
    piercing: true,
  },
  railgun: {
    id: "railgun",
    // Reads as an instant energy beam by simply outrunning anything else in the game (SIM_DT-scale
    // travel time across the whole 480-wide arena) rather than true hitscan — moderate splash/damage,
    // the opposite tradeoff from sniper (precision) or bazooka (big slow lob). No maxRange: a beam
    // weapon should reach anywhere on the map, not fizzle partway.
    projectileSpeed: 1300,
    gravityScale: 0,
    explosionRadius: 10,
    carveRadius: 4,
    damage: 55,
    fireCooldown: 1.6,
  },
  flamethrower: {
    id: "flamethrower",
    // NOT a projectile weapon — a held-fire continuous flame stream handled entirely server-side
    // (see GameRoom's FLAME_* constants and flame handling). It never spawns projectiles, so the
    // projectile-shaped fields below are all zeroed; flameRange/flameConeHalfRadians are the ones
    // that matter. The stream doesn't carve terrain (flames don't break it) and is blocked by it;
    // where it meets terrain it lights a 5s burn patch. Direct contact = 5 dmg / 0.5s, standing in
    // a burn patch = 3 dmg / 0.5s. fireCooldown 0 since rate-of-fire isn't the mechanic here (the
    // client streams a hold state and the server caps a single squeeze at 10s).
    projectileSpeed: 0,
    gravityScale: 0,
    explosionRadius: 0,
    carveRadius: 0,
    damage: 0,
    fireCooldown: 0,
    flameRange: 28,
    // Nearly parallel — the stream is a tight directional jet, not a spreading cone.
    flameConeHalfRadians: 0.096,
  },
  shotgun: {
    id: "shotgun",
    // Classic buckshot spread: many fast, flat-flying pellets, each individually weak with a tiny
    // blast — devastating at point-blank where most connect, but the wide spreadRadians means most
    // miss entirely past close range (unlike flamethrower's short gravity-dropped arc).
    projectileSpeed: 700,
    gravityScale: 0,
    explosionRadius: 7,
    carveRadius: 2.5,
    damage: 12,
    maxRange: 130,
    fireCooldown: 0.6,
    pelletCount: 7,
    spreadRadians: 0.55,
  },
  minigun: {
    id: "minigun",
    // Also a per-"fire" burst (see flamethrower/shotgun), but a much tighter cone than shotgun's —
    // reads as a rapid stream of bullets landing in roughly the same spot rather than a spread.
    projectileSpeed: 750,
    gravityScale: 0,
    explosionRadius: 6,
    carveRadius: 2,
    damage: 9,
    maxRange: 240,
    fireCooldown: 0.08,
    pelletCount: 6,
    spreadRadians: 0.12,
  },
  mine: {
    id: "mine",
    // Not a true placed/proximity-triggered mine (that would need a persistent stationary entity
    // and a fuse timer, which the shared projectile model — and the client's local re-simulation of
    // it for bullet rendering, see BulletLayer — isn't built for without desyncing the two). Instead:
    // a heavy, slow toss that drops almost straight down and explodes on contact like everything
    // else, but with by far the biggest single blast in the game — the "area denial" niche without
    // new machinery.
    projectileSpeed: 80,
    gravityScale: 1.8,
    explosionRadius: 50,
    carveRadius: 18,
    damage: 70,
    maxRange: 90,
    fireCooldown: 1.2,
  },
  missile: {
    id: "missile",
    // Heavier ordnance than bazooka: faster and flies flatter (less gravityScale), with a bigger
    // blast and more damage — a straightforward upgrade tier rather than a new niche.
    projectileSpeed: 520,
    gravityScale: 0.35,
    explosionRadius: 40,
    carveRadius: 14,
    damage: 60,
    maxRange: 340,
    fireCooldown: 1.3,
  },
};

export const DEFAULT_WEAPON_ID = "bazooka";
