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
  @type("boolean") ropeActive = false;
  @type("number") ropeAnchorX = 0;
  @type("number") ropeAnchorY = 0;
  @type("number") ropeLength = 0;
  @type("string") displayName = "";
  @type("boolean") isBot = false;
  @type("number") kills = 0;
  @type("number") deaths = 0;
  @type("number") score = 0;
}

/** A dead vole's remains — purely cosmetic/synced position, never removed (see memory/CLAUDE.md:
 *  skeletons stay until the match ends). facing is baked in at death time, not re-derived, since a
 *  corpse never turns. */
export class CorpseSchema extends Schema {
  @type("string") id = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") facing = 1;
}

export class GameState extends Schema {
  @type({ map: VoleSchema }) voles = new MapSchema<VoleSchema>();
  @type({ map: CorpseSchema }) corpses = new MapSchema<CorpseSchema>();
  /** Empty until a player reaches the deathmatch win threshold; once set, the match is frozen. */
  @type("string") winnerId = "";
}
