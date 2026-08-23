import { Assets, Texture } from "pixi.js";

// All ten weapon-selector slots now have real art (designs/wpn_*_side.png, copied into
// public/art/) rendered as Sprites — see loadWeaponIconTextures below. This used to also hold a
// vector-drawn fallback (Graphics silhouettes) for slots without art yet; the last four (mine,
// minigun, shotgun, missile) got real art too, so that fallback path is gone. If a future weapon
// slot is added without art up front, that vector-icon approach is still in this file's history to
// resurrect rather than reinvent.

export const WEAPON_IDS = [
  "ak47",
  "sniper",
  "bazooka",
  "flamethrower",
  "grenade",
  "mine",
  "minigun",
  "railgun",
  "shotgun",
  "missile",
] as const;

export type WeaponId = (typeof WEAPON_IDS)[number];

export const WEAPON_LABELS: Record<WeaponId, string> = {
  ak47: "AK-47",
  sniper: "Sniper Rifle",
  bazooka: "Bazooka",
  flamethrower: "Flamethrower",
  grenade: "Grenade",
  mine: "Mine",
  minigun: "Minigun",
  railgun: "Railgun",
  shotgun: "Shotgun",
  missile: "Missile",
};

/** All ten weapons have real art (see the header comment) — every slot is rendered as a Sprite. */
export const TEXTURED_WEAPON_IDS = WEAPON_IDS;
export type TexturedWeaponId = (typeof TEXTURED_WEAPON_IDS)[number];

const ICON_ART_BASE = "/art/";

let iconTexturesPromise: Promise<Record<TexturedWeaponId, Texture>> | null = null;

/** Loads (and caches) the real-art weapon icon textures — see the header comment for which ones. */
export function loadWeaponIconTextures(): Promise<Record<TexturedWeaponId, Texture>> {
  if (!iconTexturesPromise) {
    iconTexturesPromise = (async () => {
      const [ak47, bazooka, sniper, flamethrower, grenade, railgun, mine, minigun, shotgun, missile] = await Promise.all([
        Assets.load<Texture>(`${ICON_ART_BASE}weapon_ak47.png`),
        Assets.load<Texture>(`${ICON_ART_BASE}weapon_bazooka.png`),
        Assets.load<Texture>(`${ICON_ART_BASE}weapon_sniper.png`),
        Assets.load<Texture>(`${ICON_ART_BASE}weapon_flamethrower.png`),
        Assets.load<Texture>(`${ICON_ART_BASE}weapon_grenade.png`),
        Assets.load<Texture>(`${ICON_ART_BASE}weapon_railgun.png`),
        Assets.load<Texture>(`${ICON_ART_BASE}weapon_mine.png`),
        Assets.load<Texture>(`${ICON_ART_BASE}weapon_minigun.png`),
        Assets.load<Texture>(`${ICON_ART_BASE}weapon_shotgun.png`),
        Assets.load<Texture>(`${ICON_ART_BASE}weapon_missile.png`),
      ]);
      return { ak47, bazooka, sniper, flamethrower, grenade, railgun, mine, minigun, shotgun, missile };
    })();
  }
  return iconTexturesPromise;
}
