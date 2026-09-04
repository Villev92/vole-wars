import type { HeroId } from "./voleArt.js";

export interface HeroDef {
  id: HeroId;
  name: string;
  /** Short line under the name on the selection card. */
  blurb: string;
}

// The three heroes shown on the pre-match selection screen (see main.ts selectHero). Portraits live
// at /art/heroes/<id>/portrait.png; the in-game rig parts are resolved by voleArt.ts's loadHeroArt.
export const HEROES: HeroDef[] = [
  { id: "burrows", name: "Private Burrows", blurb: "the in-game default" },
  { id: "bristle", name: "Sergeant Bristle", blurb: "grizzled opossum" },
  { id: "moss", name: "Lieutenant Moss", blurb: "goggled mole" },
];

export const heroPortraitUrl = (id: HeroId): string => `/art/heroes/${id}/portrait.png`;
