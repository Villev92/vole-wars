import { MapSchema, Schema, type } from "@colyseus/schema";

export class VoleSchema extends Schema {
  @type("string") id = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") vx = 0;
  @type("number") vy = 0;
  @type("number") aimAngle = 0;
  @type("number") health = 100;
  @type("boolean") grounded = false;
  @type("boolean") alive = true;
  @type("boolean") jumpHeld = false;
  @type("number") jumpCooldown = 0;
  @type("number") coyoteTimer = 0;
  @type("number") jumpBufferTimer = 0;
  @type("boolean") ropeActive = false;
  @type("number") ropeAnchorX = 0;
  @type("number") ropeAnchorY = 0;
  @type("number") ropeLength = 0;
  /** True while this vole is holding down the flamethrower and still within its 10s-per-squeeze
   *  budget — the client renders the flame stream cone for any vole with this set. */
  @type("boolean") flaming = false;
  @type("string") displayName = "";
  @type("boolean") isBot = false;
  @type("number") kills = 0;
  @type("number") deaths = 0;
  @type("number") score = 0;
}

/** A dead vole's remains — purely cosmetic/synced position, never removed (see memory/CLAUDE.md:
 *  skeletons stay until the match ends). facing is baked in at death time, not re-derived, since a
 *  corpse never turns. angle is the rest tilt matching the ground slope it landed on (see
 *  stepCorpse), recomputed each time it lands. */
export class CorpseSchema extends Schema {
  @type("string") id = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") facing = 1;
  @type("number") angle = 0;
}

/** A patch of terrain lit on fire by a flamethrower stream. Purely a damage/render marker — it
 *  doesn't change the terrain grid. The server removes it after BURN_DURATION_MS; the client shows
 *  a flickering fire decal at (x, y) for as long as it's in the map. */
export class BurnSchema extends Schema {
  @type("string") id = "";
  @type("number") x = 0;
  @type("number") y = 0;
}

export class GameState extends Schema {
  @type({ map: VoleSchema }) voles = new MapSchema<VoleSchema>();
  @type({ map: CorpseSchema }) corpses = new MapSchema<CorpseSchema>();
  @type({ map: BurnSchema }) burns = new MapSchema<BurnSchema>();
  /** Empty until a player reaches the deathmatch win threshold; once set, the match is frozen. */
  @type("string") winnerId = "";
}
