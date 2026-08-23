export interface WeaponDef {
  id: string;
  projectileSpeed: number;
  gravityScale: number;
  explosionRadius: number;
  carveRadius: number;
  damage: number;
  /** Projectiles spawned per "fire" — defaults to 1. >1 fans them out across spreadRadians (flamethrower). */
  pelletCount?: number;
  /** Total random aim-angle jitter pellets are fanned across when pelletCount > 1. Unused otherwise. */
  spreadRadians?: number;
}

export const WEAPONS: Record<string, WeaponDef> = {
  bazooka: {
    id: "bazooka",
    projectileSpeed: 420,
    gravityScale: 0.6,
    explosionRadius: 34,
    carveRadius: 11,
    damage: 40,
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
  },
  grenade: {
    id: "grenade",
    projectileSpeed: 260,
    gravityScale: 1.2,
    explosionRadius: 44,
    carveRadius: 15,
    damage: 55,
  },
  sniper: {
    id: "sniper",
    // Precision one-shot: fastest, flattest (no drop) round in the game and the highest single-hit
    // damage, but a blast even tighter than the ak47's — this is a "hit the vole directly" weapon,
    // not an area weapon.
    projectileSpeed: 900,
    gravityScale: 0,
    explosionRadius: 6,
    carveRadius: 2,
    damage: 65,
  },
  railgun: {
    id: "railgun",
    // Reads as an instant energy beam by simply outrunning anything else in the game (SIM_DT-scale
    // travel time across the whole 480-wide arena) rather than true hitscan — moderate splash/damage,
    // the opposite tradeoff from sniper (precision) or bazooka (big slow lob).
    projectileSpeed: 1300,
    gravityScale: 0,
    explosionRadius: 10,
    carveRadius: 4,
    damage: 55,
  },
  flamethrower: {
    id: "flamethrower",
    // Short-range spray rather than a single shot: each "fire" fans pelletCount weak flame gouts
    // across spreadRadians, each with its own small blast — individually minor damage, but they
    // stack fast at close range where several gouts connect, and rapidly chew up nearby terrain.
    // Slight gravityScale so the flames arc and fall short rather than flying flat forever.
    projectileSpeed: 200,
    gravityScale: 0.25,
    explosionRadius: 13,
    carveRadius: 4,
    damage: 10,
    pelletCount: 5,
    spreadRadians: 0.4,
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
  },
};

export const DEFAULT_WEAPON_ID = "bazooka";
