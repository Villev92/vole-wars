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
  /** Double Jump superpower (see physics.ts stepVole) — one extra air jump, available whenever true,
   *  spent on use, refilled on landing (not a cooldown timer). */
  @type("boolean") doubleJumpAvailable = true;
  @type("boolean") ropeActive = false;
  @type("number") ropeAnchorX = 0;
  @type("number") ropeAnchorY = 0;
  @type("number") ropeLength = 0;
  /** Dash superpower (see physics.ts stepVole). `dashCharges` (starts full, == DASH_MAX_CHARGES) and
   *  `dashRechargeTimer` (seconds to the next charge) are synced for the client HUD; `dashHeld` is
   *  server-side edge-trigger bookkeeping. */
  @type("number") dashCharges = 2;
  @type("number") dashRechargeTimer = 0;
  @type("boolean") dashHeld = false;
  /** Burrow superpower (see physics.ts stepVole). `burrowActive` + `burrowElapsed` drive the client's
   *  tornado-spin animation and descent (vole.y itself already reflects the current depth);
   *  `burrowCooldownTimer` drives the HUD; `burrowStartY`/`burrowHeld` are server-side bookkeeping,
   *  synced anyway for simplicity (same as dashHeld above). */
  @type("boolean") burrowActive = false;
  @type("number") burrowElapsed = 0;
  @type("number") burrowStartY = 0;
  @type("number") burrowCooldownTimer = 0;
  @type("boolean") burrowHeld = false;
  /** True while this vole is holding down the flamethrower and still within its 10s-per-squeeze
   *  budget — the client renders the flame stream cone for any vole with this set. */
  @type("boolean") flaming = false;
  /** Railgun charge-beam state (see GameRoom.updateRailgun + client railgun.ts). `railgunCharge` is
   *  0..1 while this vole is charging (0 otherwise) — clients draw a muzzle charge-glow from it.
   *  While `railgunBeamActive`, a beam of half-width `railgunBeamWidth` extends up to
   *  `railgunBeamLength` units along the vole's aim (the client re-clips it against its own terrain
   *  mirror, same as the flame jet). */
  @type("number") railgunCharge = 0;
  @type("boolean") railgunBeamActive = false;
  @type("number") railgunBeamLength = 0;
  @type("number") railgunBeamWidth = 0;
  @type("string") displayName = "";
  /** Which hero art the client picked on the select screen ("burrows" | "bristle" | "moss"). Synced
   *  so every client renders THIS vole with its owner's chosen art, not the local player's. Set once
   *  on join (see GameRoom.onJoin); the bot is always "burrows". */
  @type("string") heroId = "burrows";
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

/** A dropped proximity mine (see GameRoom's mine handling). x/y track it while it falls to the
 *  terrain, then stay put. `armed` flips true MINE_ARM_MS after it was dropped; the client shows a
 *  blinking indicator once armed. Removed from the map when it detonates. */
export class MineSchema extends Schema {
  @type("string") id = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("string") ownerId = "";
  @type("boolean") armed = false;
}

export class GameState extends Schema {
  @type({ map: VoleSchema }) voles = new MapSchema<VoleSchema>();
  @type({ map: CorpseSchema }) corpses = new MapSchema<CorpseSchema>();
  @type({ map: BurnSchema }) burns = new MapSchema<BurnSchema>();
  @type({ map: MineSchema }) mines = new MapSchema<MineSchema>();
  /** Empty until a player reaches the deathmatch win threshold; once set, the match is frozen. */
  @type("string") winnerId = "";
  /** Fraction (0..1) of the originally-generated destructible terrain (DIRT + STONE, not the
   *  indestructible rock border) still solid. Starts at 1 and drops as craters are dug; the client
   *  shows it as a percentage at the top-centre of the screen. Recomputed on a throttled cadence
   *  server-side (see GameRoom.update). Groundwork for a future "regrow terrain once enough is
   *  destroyed" feature. */
  @type("number") terrainRemaining = 1;
}
