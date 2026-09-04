import { Client, Room } from "@colyseus/core";
import {
  applyExplosion,
  circleHitsTerrain,
  DEFAULT_WEAPON_ID,
  DIG_RADIUS,
  DIG_REACH,
  GRAVITY,
  MAX_HEALTH,
  pointSegmentDistance,
  resolveDigDirection,
  PROJECTILE_OWNER_CLEARANCE,
  raycastTerrain,
  SIM_DT,
  SIM_TICK_RATE,
  TerrainField,
  VOLE_RADIUS,
  WEAPONS,
  stepCorpse,
  stepProjectile,
  stepVole,
  type CorpseSimState,
  type PlayerInput,
  type ProjectileSimState,
  type VoleHitTarget,
  type VoleSimState,
} from "@vole-wars/shared";
import { BurnSchema, CorpseSchema, GameState, MineSchema, VoleSchema } from "./state.js";

const TICK_RATE = SIM_TICK_RATE;
const DT = SIM_DT;
// 2x the original 480x270's total area (each dimension scaled by sqrt(2), so aspect ratio and
// every generation formula that already derives from width*height stay meaningful) rather than
// doubling both dimensions outright (which would be 4x the area).
export const ARENA_WIDTH = 679;
export const ARENA_HEIGHT = 382;
// Deathmatch supports 2-8 human players (see memory: project-deathmatch-mode) — the bot below
// doesn't occupy one of these client slots, it's injected straight into the schema.
const MAX_PLAYERS = 8;

// Fixed id (not a Colyseus sessionId, since it's never a real connected client) for the always-on
// dummy punching-bag player: takes damage/knockback like a real vole but never moves/aims/fires.
const BOT_ID = "bot";

// Selectable hero-art ids (mirrors apps/client/src/heroes.ts — kept as a plain list here rather than
// shared, since the server only needs to validate the join option, not know anything about the art).
const HERO_IDS = ["burrows", "bristle", "moss"] as const;
type HeroId = (typeof HERO_IDS)[number];

// Every vole (bot and human alike) auto-respawns this long after death — no client-triggered
// "Start Again" button anymore. A placeholder value the user expects to tune later.
const RESPAWN_DELAY_MS = 2000;

// Deathmatch scoring (see memory: project-deathmatch-mode) — +1 point per kill, -1 per death, first
// to WIN_SCORE freezes the match. A self-kill (splash damage from your own shot) only applies the
// death penalty, not a kill credit — otherwise firing at your own feet would be a free point.
const WIN_SCORE = 20;

// Fall damage: a drop shorter than this fraction of the arena height hurts nothing; at or above it
// the damage is that same fraction of full health (a 30%-of-height fall = 30 damage, an 80% fall =
// 80, etc — see update's fall-damage block).
const FALL_MIN_FRACTION = 0.15;

// --- Flamethrower (see weapons.ts flamethrower def) --------------------------------------------
// It's not a projectile weapon: while a player holds fire with the flamethrower selected the client
// streams a `flame` hold state, and each server tick this weapon lays down a short flame cone from
// the muzzle. The cone is blocked by (never destroys) terrain; where it meets terrain it lights a
// burn patch. Damage is dealt over time on a fixed per-tick cadence, not per frame.
const FLAME_MAX_MS = 10_000; // longest a single uninterrupted squeeze can flame for
const FLAME_DIRECT_TICK_S = 0.5; // cadence for a vole in the flame cone with line of sight
const FLAME_BURN_TICK_S = 0.2; // faster cadence for a vole standing in a burn patch
const FLAME_DIRECT_DMG = 5; // per FLAME_DIRECT_TICK_S
const FLAME_BURN_DMG = 3; // per FLAME_BURN_TICK_S
const BURN_DURATION_MS = 5_000;
const FLAME_MUZZLE_DIST = VOLE_RADIUS + 4; // matches handleFire's projectile spawnDist
const FLAME_TERRAIN_RAYS = 7; // rays fanned across the cone to find terrain to ignite
const BURN_MERGE_DIST = 3; // new burn within this of an existing one just refreshes it
const MAX_BURNS = 80; // hard cap on simultaneously-tracked burn patches
// Minimum gap between the "grunt" sounds a single vole triggers from fire/fall damage, so a burn
// patch's fast DoT doesn't machine-gun grunts.
const GRUNT_MIN_GAP_MS = 600;
// A vole takes burn-patch damage when its body edge reaches the patch: dist(centre, marker) <=
// VOLE_RADIUS + burnRadius, where burnRadius also sizes the client's fire visual. Keeps "am I
// standing in fire" matching what's actually drawn (that mismatch was the bug).
const BURN_CONTACT_RADIUS = VOLE_RADIUS + (WEAPONS.flamethrower.burnRadius ?? 4.5);

// --- Railgun (see weapons.ts railgun def) ----------------------------------------------------------
// Also not a projectile weapon: the client sends a `railgun` hold message ({charging:true} on
// press, {charging:false} on release). The server times the charge itself (railChargeStart), and on
// release spawns a beam whose damage-per-second / reach / half-width / lifetime / dig radius all
// scale with the charge fraction c. TERRAIN BLOCKS the beam — each tick it reaches only to the first
// solid cell along the aim (capped at its charge-scaled range), damages any vole that segment
// touches, and on a throttled cadence chews a `digRadius` bite out of the front (a capsule from the
// vole's own position to the front, so the ground under the player's feet goes too). Rock isn't
// carvable, so a rock front is a permanent stop until the aim moves off it.
const RAIL_MUZZLE_DIST = VOLE_RADIUS + 4; // beam origin for rendering/damage, matches FLAME_MUZZLE_DIST
const RAIL_DMG_TICK_S = 0.2; // DoT cadence — 5 hits/s, fractional damage carried between ticks
const RAIL_CARVE_TICK_S = 0.08; // dig + broadcast cadence; penetration ≈ digRadius / this
const RAIL_CHARGE_MS = WEAPONS.railgun.railgunChargeMs ?? 4000;
const RAIL_MAX_BEAM_MS = WEAPONS.railgun.railgunMaxBeamMs ?? 4000;
const RAIL_MIN_DPS = WEAPONS.railgun.railgunMinDps ?? 1;
const RAIL_MAX_DPS = WEAPONS.railgun.railgunMaxDps ?? 30;
const RAIL_MIN_RANGE = WEAPONS.railgun.railgunMinRange ?? 12;
const RAIL_MAX_RANGE = WEAPONS.railgun.railgunMaxRange ?? 75;
const RAIL_MIN_HALF_WIDTH = WEAPONS.railgun.railgunMinHalfWidth ?? 0.35;
const RAIL_MAX_HALF_WIDTH = WEAPONS.railgun.railgunMaxHalfWidth ?? 3;
const RAIL_MIN_BEAM_MS = WEAPONS.railgun.railgunMinBeamMs ?? 120;
const RAIL_DIG_MIN_R = WEAPONS.railgun.railgunDigMinRadius ?? 1;
const RAIL_DIG_MAX_R = WEAPONS.railgun.railgunDigMaxRadius ?? 4;

// --- Burrow (see physics.ts stepVole / BURROW_* constants) -------------------------------------------
// The one part of Burrow that isn't handled by stepVole itself: while a vole is mid-burrow, any OTHER
// vole whose body comes within reach takes a flat hit + knockback, like brushing a spinning drill.
// Radius is body-to-body contact (two VOLE_RADIUS circles touching). Once per burrow activation per
// victim (see burrowHitVictims) — otherwise a 1.2s animation at 30Hz would tick 40 dmg dozens of
// times before knockback has a chance to separate the two.
const BURROW_CONTACT_RADIUS = VOLE_RADIUS * 2;
const BURROW_CONTACT_DAMAGE = 40;
const BURROW_CONTACT_KNOCKBACK = 260; // matches applyExplosion's own knockback magnitude
// Burrow destroys the terrain it digs through — a circle this wide carved at the vole's own position
// every tick it's burrowing (activation tick through the completion/cancel tick inclusive). Wider than
// VOLE_RADIUS so the tunnel reads as "a body dug through here", not a bullet-thin bore; consecutive
// ticks' circles overlap heavily (only ~1.4 units of descent per tick) so the tunnel comes out smooth
// with no gaps, same reasoning as why a projectile's per-step terrain sampling doesn't need to be
// swept — the steps are already closer together than the radius.
const BURROW_CARVE_RADIUS = 5.4; // was 6, narrowed to 90% of that at the user's request

// --- Mines (see weapons.ts mine def) ----------------------------------------------------------------
const MINE_ARM_MS = 5_000; // no proximity damage for this long after being dropped
const MINE_TRIGGER_RADIUS = 0.5; // a vole whose body comes this close to an armed mine sets it off
const MINE_RADIUS = 1.5; // the mine's own size, for its fall-to-terrain rest check
const MAX_MINES = 40; // hard cap; oldest is removed to make room

const IDLE_INPUT: PlayerInput = {
  left: false,
  right: false,
  jump: false,
  aimAngle: 0,
  fire: false,
  grapple: false,
  up: false,
  down: false,
  dash: false,
  burrow: false,
};

export class GameRoom extends Room<GameState> {
  maxClients = MAX_PLAYERS;

  private terrain!: TerrainField;
  private inputs = new Map<string, PlayerInput>();
  // `traveled` (terrain units) is server-only bookkeeping for weapon.maxRange — not part of the
  // synced ProjectileSimState since clients never see per-tick projectile state anyway (see
  // ProjectileSimState's own doc comment); BulletLayer tracks the same thing independently for its
  // local re-simulation.
  private projectiles: { proj: ProjectileSimState; traveled: number; terrainPierced: number }[] = [];
  private projectileSeq = 0;
  // Rate-of-fire enforcement (see WeaponDef.fireCooldown): last accepted "fire" timestamp per
  // player, per weapon (sessionId -> weaponId -> timestamp) — fireCooldown is a property of the
  // weapon, not the player, so switching from a fast weapon to a slow one (or vice versa) shouldn't
  // borrow against a cooldown that belongs to the weapon just put away. A single shared per-player
  // timestamp here previously meant firing the ak47 and immediately switching to the sniper made
  // that first sniper shot silently get dropped until the ak47's own recent shot aged out past the
  // sniper's much longer cooldown, even though the sniper itself had never been fired yet.
  private lastFireAt = new Map<string, Map<string, number>>();
  private nextPlayerNumber = 1;
  // Server-only fall state (vy/grounded) for each corpse, keyed the same as the synced CorpseSchema
  // map — same split as projectiles/ProjectileSimState: the schema syncs only what clients need to
  // render (x/y/facing), this map holds the rest of the simulation.
  private corpseSim = new Map<string, CorpseSimState>();
  private corpseSeq = 0;
  // Flamethrower hold state, sessionId -> when the current uninterrupted squeeze started (for the
  // FLAME_MAX_MS cap). Present only while actively flaming; the client drives it with `flame`
  // messages and re-presses to reset the budget.
  private flaming = new Map<string, number>();
  // Per-vole accumulated time toward the next FLAME_TICK_S damage tick, so flame DoT lands on a
  // steady 0.5s cadence regardless of frame rate. Cleared the moment a vole stops being burned.
  private flameDot = new Map<string, number>();
  // Active burn patches (terrain lit by a flame stream). Kept in lockstep with state.burns; expired
  // by wall-clock `until`. ownerId is who lit it, for kill attribution on burn-patch deaths.
  private burns: { id: string; x: number; y: number; until: number; ownerId: string }[] = [];
  private burnSeq = 0;
  // Railgun (see RAIL_* constants). railCharging: sessionId -> Date.now() the current charge began
  // (present only while holding). railBeams: sessionId -> an in-flight beam fired on release, its
  // dps/reach(`length`)/halfWidth/digRadius locked in from the charge, `endsAt` its wall-clock
  // expiry, `lastCarveAt` when it last chewed the terrain front. railDot: victimId -> { acc (time
  // toward next DoT tick), carry (fractional damage carried between ticks) }.
  private railCharging = new Map<string, number>();
  private railBeams = new Map<
    string,
    {
      dps: number;
      length: number;
      halfWidth: number;
      digRadius: number;
      endsAt: number;
      lastCarveAt: number;
    }
  >();
  private railDot = new Map<string, { acc: number; carry: number }>();
  // Server-only mine state (fall velocity, whether it's landed, when it was dropped for the arm
  // timer), keyed the same as the synced MineSchema map.
  private mineSim = new Map<string, { vy: number; grounded: boolean; deployedAt: number }>();
  private mineSeq = 0;
  // Fall-damage tracking: the highest point (smallest y) a vole has reached while airborne since it
  // last left the ground. On landing, the drop from that peak is turned into damage (see
  // FALL_MIN_FRACTION / update). fallSpawnGrace skips the first landing after a (re)spawn so the
  // drop from the spawn point never hurts.
  private fallPeakY = new Map<string, number>();
  private fallSpawnGrace = new Set<string>();
  // Last time each vole triggered a fire/fall grunt sound (see GRUNT_MIN_GAP_MS / applyDamage).
  private lastGruntAt = new Map<string, number>();
  // Burrow contact damage (see BURROW_CONTACT_* / updateBurrowContacts): burrowerId -> the set of
  // victim ids already hit during the CURRENT burrow activation, so the 1.2s animation doesn't
  // machine-gun the same hit every tick. Cleared the instant that vole stops burrowing.
  private burrowHitVictims = new Map<string, Set<string>>();
  // Terrain-remaining HUD figure (see GameState.terrainRemaining): the destructible-cell count of
  // the freshly-generated arena, captured once, is the 100% baseline. terrainStatTick throttles the
  // full-grid rescan that produces the current figure to a few times a second.
  private terrainInitialDestructible = 1;
  private terrainStatTick = 0;

  onCreate(): void {
    this.setState(new GameState());

    const seed = Math.floor(Math.random() * 0xffffffff);
    this.terrain = TerrainField.generateCaves(ARENA_WIDTH, ARENA_HEIGHT, seed);
    this.terrainInitialDestructible = Math.max(1, this.terrain.countDestructible());
    this.state.terrainRemaining = 1;
    this.spawnBot();

    this.onMessage("input", (client, message: PlayerInput) => {
      this.inputs.set(client.sessionId, message);
    });

    this.onMessage("fire", (client, message: { weaponId?: string; power?: number }) => {
      this.handleFire(client.sessionId, message?.weaponId, message?.power);
    });

    // Dig ability (see handleDig / physics.ts DIG_* + resolveDigDirection). One-shot, sent by the
    // client the instant it detects the gesture (hold a move key into a wall, tap the opposite key);
    // `dir` is the direction held INTO the wall (-1 left, +1 right).
    this.onMessage("dig", (client, message: { dir?: number }) => {
      this.handleDig(client.sessionId, message?.dir === -1 ? -1 : message?.dir === 1 ? 1 : 0);
    });

    // Flamethrower hold state (see the flaming map / FLAME_* constants). The client sends this on
    // every change of "am I holding fire with the flamethrower out": true starts (or, if already
    // flaming, does nothing — the squeeze continues), false stops and frees the 10s budget so the
    // next fresh press gets a full one.
    this.onMessage("flame", (client, message: { active?: boolean }) => {
      if (message?.active) {
        if (!this.flaming.has(client.sessionId)) this.flaming.set(client.sessionId, Date.now());
      } else {
        this.stopFlaming(client.sessionId);
      }
    });

    // Railgun charge/fire (see RAIL_* constants). {charging:true} starts timing a charge (ignored if
    // the weapon's still on fireCooldown, so a doomed charge isn't begun); {charging:false} releases
    // it — firing a beam sized by however long it was held. The server times the charge itself so a
    // client can't spoof a max-charge shot.
    this.onMessage("railgun", (client, message: { charging?: boolean; cancel?: boolean }) => {
      const sid = client.sessionId;
      if (message?.charging) {
        if (this.railCharging.has(sid)) return;
        const last = this.lastFireAt.get(sid)?.get("railgun") ?? 0;
        if (Date.now() - last < (WEAPONS.railgun.fireCooldown ?? 0) * 1000) return;
        this.railCharging.set(sid, Date.now());
      } else if (message?.cancel) {
        this.railCharging.delete(sid);
        const vole = this.state.voles.get(sid);
        if (vole) vole.railgunCharge = 0;
      } else {
        this.releaseRailgun(sid);
      }
    });

    // Request/response rather than pushing this from onJoin: a client only registers its
    // "terrain-init" handler after connect() resolves, so a push sent during onJoin could race
    // ahead of that and be silently dropped, leaving the client's terrain out of sync with the
    // server's (which is exactly how "player spawns inside terrain" kept happening — a client
    // joining after damage had already been dealt would fall back to regenerating the pristine,
    // undamaged terrain instead). The client sends this only after it's already listening, so the
    // response can't arrive early.
    this.onMessage("request-terrain", (client) => {
      client.send("terrain-init", { width: ARENA_WIDTH, height: ARENA_HEIGHT, data: Array.from(this.terrain.data) });
    });

    this.setSimulationInterval(() => this.update(), 1000 / TICK_RATE);
  }

  /** Turns a client-supplied nickname into a safe display name, or null if it's unusable. Strips
   *  control chars and HTML-significant characters (the scoreboard renders displayName via innerHTML
   *  — see main.ts), collapses whitespace, trims, and caps length. The client also enforces
   *  maxlength=16, but this is the authoritative guard. */
  private sanitizeName(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const cleaned = raw
      .split("")
      .filter((ch) => {
        const code = ch.charCodeAt(0);
        return code >= 0x20 && code !== 0x7f && !"<>&\"'`".includes(ch);
      })
      .join("")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 16);
    return cleaned.length > 0 ? cleaned : null;
  }

  onJoin(client: Client, options?: { name?: string; hero?: string }): void {
    const vole = new VoleSchema();
    vole.id = client.sessionId;
    // Join order still advances even when a nickname was given, so a later player who skips gets a
    // number matching when they actually joined.
    const playerNumber = this.nextPlayerNumber++;
    vole.displayName = this.sanitizeName(options?.name) ?? `Player ${playerNumber}`;
    // Per-player hero art — synced so every client renders this vole with its owner's pick. Unknown
    // / missing (e.g. the "Skip" button) falls back to the built-in Burrows set.
    vole.heroId = HERO_IDS.includes(options?.hero as HeroId) ? (options!.hero as HeroId) : "burrows";
    const spawn = this.findClearSpawn();
    vole.x = spawn.x;
    vole.y = spawn.y;
    vole.health = MAX_HEALTH;
    vole.alive = true;
    this.state.voles.set(client.sessionId, vole);
    this.inputs.set(client.sessionId, { ...IDLE_INPUT });
    this.fallSpawnGrace.add(client.sessionId);
    // Terrain isn't pushed here — the client fetches it itself via "request-terrain" once it's
    // ready to receive the response (see that handler's comment for why).
  }

  onLeave(client: Client): void {
    this.state.voles.delete(client.sessionId);
    this.inputs.delete(client.sessionId);
    this.lastFireAt.delete(client.sessionId);
    this.stopFlaming(client.sessionId);
    this.flameDot.delete(client.sessionId);
    this.stopRailgun(client.sessionId);
    this.railDot.delete(client.sessionId);
    this.fallPeakY.delete(client.sessionId);
    this.fallSpawnGrace.delete(client.sessionId);
    this.lastGruntAt.delete(client.sessionId);
    this.burrowHitVictims.delete(client.sessionId);
  }

  /** Ends a flamethrower squeeze: drops the hold state (freeing the FLAME_MAX_MS budget) and clears
   *  the synced `flaming` flag so the client stops drawing the stream. Safe to call unconditionally. */
  private stopFlaming(sessionId: string): void {
    this.flaming.delete(sessionId);
    const vole = this.state.voles.get(sessionId);
    if (vole) vole.flaming = false;
  }

  /** Fires a railgun beam sized by however long `sessionId` has been charging, then clears the
   *  charge. No-op if they weren't charging. The beam itself lives in railBeams and is resolved each
   *  tick by updateRailgun. */
  private releaseRailgun(sessionId: string): void {
    const startedAt = this.railCharging.get(sessionId);
    this.railCharging.delete(sessionId);
    if (startedAt === undefined) return;
    const vole = this.state.voles.get(sessionId);
    if (!vole || !vole.alive) {
      if (vole) vole.railgunCharge = 0;
      return;
    }
    const chargeMs = Math.min(Date.now() - startedAt, RAIL_CHARGE_MS);
    const c = chargeMs / RAIL_CHARGE_MS;
    this.railBeams.set(sessionId, {
      dps: RAIL_MIN_DPS + (RAIL_MAX_DPS - RAIL_MIN_DPS) * c,
      length: RAIL_MIN_RANGE + (RAIL_MAX_RANGE - RAIL_MIN_RANGE) * c,
      halfWidth: RAIL_MIN_HALF_WIDTH + (RAIL_MAX_HALF_WIDTH - RAIL_MIN_HALF_WIDTH) * c,
      digRadius: RAIL_DIG_MIN_R + (RAIL_DIG_MAX_R - RAIL_DIG_MIN_R) * c,
      // Beam duration follows the charge held, but never exceeds RAIL_MAX_BEAM_MS (so the last stretch
      // of charge maxes power without also maxing how long the beam lingers).
      endsAt: Date.now() + Math.min(RAIL_MAX_BEAM_MS, Math.max(RAIL_MIN_BEAM_MS, chargeMs)),
      lastCarveAt: 0,
    });
    vole.railgunCharge = 0;
    let fireTimes = this.lastFireAt.get(sessionId);
    if (!fireTimes) {
      fireTimes = new Map();
      this.lastFireAt.set(sessionId, fireTimes);
    }
    fireTimes.set("railgun", Date.now());
  }

  /** Clears any railgun charge/beam state for a vole and the synced fields the client renders from.
   *  Safe to call unconditionally (death, leave, respawn, weapon switch). */
  private stopRailgun(sessionId: string): void {
    this.railCharging.delete(sessionId);
    this.railBeams.delete(sessionId);
    const vole = this.state.voles.get(sessionId);
    if (vole) {
      vole.railgunCharge = 0;
      vole.railgunBeamActive = false;
      vole.railgunBeamLength = 0;
      vole.railgunBeamWidth = 0;
    }
  }

  /** Adds the always-on dummy bot vole — see BOT_ID's own comment for what it's for. Called once
   *  from onCreate, not onJoin, since it's never a real connected client. */
  private spawnBot(): void {
    const vole = new VoleSchema();
    vole.id = BOT_ID;
    vole.displayName = "Bot";
    vole.heroId = "burrows"; // the bot always wears the built-in Burrows art
    vole.isBot = true;
    const spawn = this.findClearSpawn();
    vole.x = spawn.x;
    vole.y = spawn.y;
    vole.health = MAX_HEALTH;
    vole.alive = true;
    this.state.voles.set(BOT_ID, vole);
    this.fallSpawnGrace.add(BOT_ID);
  }

  private handleRespawn(sessionId: string): void {
    // Match is over — frozen until a server restart (see memory: project-deathmatch-mode).
    if (this.state.winnerId) return;

    const vole = this.state.voles.get(sessionId);
    // Only a dead vole can respawn — otherwise a live player could spam this into a free full heal.
    if (!vole || vole.alive) return;

    const spawn = this.findClearSpawn();
    vole.x = spawn.x;
    vole.y = spawn.y;
    vole.vx = 0;
    vole.vy = 0;
    vole.grounded = false;
    vole.health = MAX_HEALTH;
    vole.alive = true;
    vole.jumpHeld = false;
    vole.jumpCooldown = 0;
    vole.coyoteTimer = 0;
    vole.jumpBufferTimer = 0;
    vole.doubleJumpAvailable = true;
    vole.ropeActive = false;
    vole.dashCharges = 2;
    vole.dashRechargeTimer = 0;
    vole.dashHeld = false;
    vole.burrowActive = false;
    vole.burrowElapsed = 0;
    vole.burrowStartY = 0;
    vole.burrowCooldownTimer = 0;
    vole.burrowHeld = false;
    this.burrowHitVictims.delete(sessionId);
    this.stopFlaming(sessionId);
    this.flameDot.delete(sessionId);
    this.stopRailgun(sessionId);
    this.railDot.delete(sessionId);
    this.fallPeakY.delete(sessionId);
    this.fallSpawnGrace.add(sessionId);
    // Reset rather than leave whatever was last received — otherwise a key still held down at the
    // moment of death would carry straight into the new spawn.
    this.inputs.set(sessionId, { ...IDLE_INPUT });
  }

  private findClearSpawn(): { x: number; y: number } {
    // Bigger than the VOLE_RADIUS physics hitbox on purpose: the drawn character (tail, gun,
    // helmet) reaches well past its collision circle, and a spawn that's only physics-clear can
    // still visibly clip into nearby dirt. This clearance covers the full character silhouette.
    const clearance = 20;
    for (let attempt = 0; attempt < 60; attempt++) {
      const x = 20 + Math.random() * (ARENA_WIDTH - 40);
      const y = 20 + Math.random() * (ARENA_HEIGHT - 40);
      if (!circleHitsTerrain(this.terrain, x, y, clearance)) return { x, y };
    }
    // No naturally clear spot found in 60 tries (the arena is mostly solid ground by design, so
    // this isn't rare): fall back to one of the always-clear rooms terrain generation guarantees.
    // Deliberately NOT a runtime carve+broadcast here — a client only registers its
    // "terrain-carve" handler after it finishes connecting, so a carve broadcast sent from onJoin
    // could arrive before that and get silently dropped, leaving that client's local terrain still
    // solid where the server (and everyone else) already sees it as clear. spawnPoints are baked
    // into the deterministic seed-based generation instead, so every client already agrees.
    const zone = this.terrain.spawnPoints[Math.floor(Math.random() * this.terrain.spawnPoints.length)];
    return zone;
  }

  private handleFire(sessionId: string, weaponId: string | undefined, power?: number): void {
    // Match is over — frozen until a server restart (see memory: project-deathmatch-mode).
    if (this.state.winnerId) return;

    const vole = this.state.voles.get(sessionId);
    if (!vole || !vole.alive) return;

    // Falls back to the default for any weapon slot the client can select but that isn't actually
    // implemented server-side yet (most of WEAPON_IDS — see weaponIcons.ts) rather than silently not
    // firing at all.
    const weapon = (weaponId && WEAPONS[weaponId]) || WEAPONS[DEFAULT_WEAPON_ID];

    // The flamethrower isn't a projectile weapon — it's driven by the `flame` hold message, not
    // "fire". Ignore any stray "fire" for it rather than lobbing a fallback rocket.
    if (weapon.id === "flamethrower") return;

    // Rate-of-fire cap (see WeaponDef.fireCooldown) — authoritative here since the client can send
    // "fire" as fast as it likes; a request inside the cooldown window is just silently dropped.
    // Tracked per weapon (see lastFireAt's own comment), not just per player.
    const now = Date.now();
    let playerFireTimes = this.lastFireAt.get(sessionId);
    const lastFire = playerFireTimes?.get(weapon.id) ?? 0;
    if (now - lastFire < weapon.fireCooldown * 1000) return;
    if (!playerFireTimes) {
      playerFireTimes = new Map();
      this.lastFireAt.set(sessionId, playerFireTimes);
    }
    playerFireTimes.set(weapon.id, now);

    // Mine: not thrown — dropped at the vole's exact position, then it falls to the terrain.
    if (weapon.id === "mine") {
      this.deployMine(sessionId, vole.x, vole.y, now);
      return;
    }

    const spawnDist = VOLE_RADIUS + 4;

    // Charge-thrown weapons (grenade): the client sends a 0..1 `power` built up while LMB was held.
    // Map it to a launch speed; a near-zero power (short click) plops it at the feet.
    const launchSpeed = weapon.chargeThrow
      ? (weapon.minThrowSpeed ?? 0) +
        Math.max(0, Math.min(1, power ?? 0)) * ((weapon.maxThrowSpeed ?? 0) - (weapon.minThrowSpeed ?? 0))
      : weapon.projectileSpeed;

    // pelletCount > 1 (shotgun) fires a whole volley at once; spreadRadians scatters the aim of every
    // shot (a wide fan for shotgun, a slight wobble for minigun's rapid single rounds); spawnSpread
    // offsets each round perpendicular to the aim so minigun's stream is a band, not one flat line.
    const pelletCount = weapon.pelletCount ?? 1;
    const spread = weapon.spreadRadians ?? 0;
    const spawnSpread = weapon.spawnSpread ?? 0;
    // A multi-pellet volley leaves from ONE muzzle point (along aimAngle) and only the pellet
    // VELOCITIES are scattered — so the pattern is tight at point-blank and blooms with distance.
    // Single-shot weapons spawn along their own (jittered) angle as before.
    const converge = pelletCount > 1;
    const muzzleAngle = converge ? vole.aimAngle : null;
    for (let i = 0; i < pelletCount; i++) {
      const angle = vole.aimAngle + (spread > 0 ? (Math.random() - 0.5) * spread : 0);
      const dirX = Math.cos(angle);
      const dirY = Math.sin(angle);
      // Perpendicular (-dirY, dirX) spawn offset — moves the muzzle point up/down across the aim
      // line without changing the direction the round travels.
      const perp = spawnSpread > 0 ? (Math.random() - 0.5) * 2 * spawnSpread : 0;

      const spawnAngle = muzzleAngle ?? angle;
      const sdx = Math.cos(spawnAngle);
      const sdy = Math.sin(spawnAngle);
      // Normally the projectile spawns a little ahead of the vole (spawnDist) so it clears its own
      // hitbox. But if there's solid terrain between the vole and that spawn point — i.e. the vole is
      // hugging a wall it's shooting at — spawn it right at the near face of that wall instead, so it
      // carves the wall the player is touching rather than magically appearing on the far side of it.
      const blocked = raycastTerrain(this.terrain, vole.x, vole.y, spawnAngle, spawnDist);

      const projectile: ProjectileSimState = {
        id: `p${this.projectileSeq++}`,
        ownerId: sessionId,
        weaponId: weapon.id,
        x: (blocked ? blocked.x : vole.x + sdx * spawnDist) - sdy * perp,
        y: (blocked ? blocked.y : vole.y + sdy * spawnDist) + sdx * perp,
        vx: dirX * launchSpeed,
        vy: dirY * launchSpeed,
        bounces: 0,
      };
      this.projectiles.push({ proj: projectile, traveled: 0, terrainPierced: 0 });
      // Clients don't receive per-tick projectile positions — they run the same shared
      // stepProjectile() simulation locally from this spawn state purely to render a bullet, so it
      // stays in lockstep with the eventual terrain-carve broadcast without per-tick network traffic.
      this.broadcast("fire", projectile);
    }
    // One volley = one bang. A dedicated event (not per-pellet) so the client plays the shot sound
    // once; carries ownerId so only the shooter also hears their own reload.
    if (weapon.id === "shotgun") this.broadcast("shotgun-fire", { ownerId: sessionId });
  }

  /** Dig ability (see physics.ts DIG_* / resolveDigDirection). Bores one DIG_REACH-long,
   *  DIG_RADIUS-wide tunnel from the vole along its (slope-clamped) aim — but only if it's genuinely
   *  pressed against a wall on `intoDir` and actually looking that way. No cooldown; carves nothing
   *  and costs nothing when the checks fail ("nothing happens"). Own `dig-carve` broadcast, same
   *  reasoning as burrow-carve (not "terrain-carve", to skip that event's per-impact sound path). */
  private handleDig(sessionId: string, intoDir: -1 | 1 | 0): void {
    if (this.state.winnerId || intoDir === 0) return;
    const vole = this.state.voles.get(sessionId);
    if (!vole || !vole.alive || vole.burrowActive || vole.ropeActive) return;
    // Must actually be up against a wall on that side — i.e. a small nudge that way would put the
    // body into terrain. A full circle test (not a single point) so it matches whatever the walk's
    // own collision would treat as "blocked", including a wall met at chest height over open floor.
    if (!circleHitsTerrain(this.terrain, vole.x + intoDir * 2, vole.y, VOLE_RADIUS)) return;
    const dir = resolveDigDirection(vole.aimAngle, intoDir);
    if (!dir) return; // looking away from the wall — nothing happens
    const x2 = vole.x + dir.x * DIG_REACH;
    const y2 = vole.y + dir.y * DIG_REACH;
    this.terrain.carveCapsule(vole.x, vole.y, x2, y2, DIG_RADIUS);
    this.broadcast("dig-carve", { ownerId: sessionId, x: vole.x, y: vole.y, x2, y2, radius: DIG_RADIUS });
  }

  private update(): void {
    const simVoles: VoleSimState[] = [];
    this.state.voles.forEach((vole, sessionId) => {
      const input = this.inputs.get(sessionId) ?? IDLE_INPUT;
      const sim: VoleSimState = {
        id: sessionId,
        x: vole.x,
        y: vole.y,
        vx: vole.vx,
        vy: vole.vy,
        aimAngle: vole.aimAngle,
        health: vole.health,
        grounded: vole.grounded,
        alive: vole.alive,
        jumpHeld: vole.jumpHeld,
        jumpCooldown: vole.jumpCooldown,
        coyoteTimer: vole.coyoteTimer,
        jumpBufferTimer: vole.jumpBufferTimer,
        doubleJumpAvailable: vole.doubleJumpAvailable,
        ropeActive: vole.ropeActive,
        ropeAnchorX: vole.ropeAnchorX,
        ropeAnchorY: vole.ropeAnchorY,
        ropeLength: vole.ropeLength,
        dashCharges: vole.dashCharges,
        dashRechargeTimer: vole.dashRechargeTimer,
        dashHeld: vole.dashHeld,
        burrowActive: vole.burrowActive,
        burrowElapsed: vole.burrowElapsed,
        burrowStartY: vole.burrowStartY,
        burrowCooldownTimer: vole.burrowCooldownTimer,
        burrowHeld: vole.burrowHeld,
      };
      // Captured pre-step so a dash this tick (charge count drops) can be broadcast with the exact
      // point the vole left from — the client spawns a smoke trail from there to where it lands.
      const preDashX = sim.x;
      const preDashY = sim.y;
      const preDashCharges = sim.dashCharges;
      // Captured pre-step so the burrow-carve check below (after stepVole mutates sim.burrowActive)
      // still knows whether this was the activation tick / a mid-burrow tick / the completion or
      // cancel tick — all four need a carve, only "wasn't and still isn't burrowing" doesn't.
      const preBurrowActive = sim.burrowActive;
      stepVole(sim, input, this.terrain, DT);
      vole.x = sim.x;
      vole.y = sim.y;
      vole.vx = sim.vx;
      vole.vy = sim.vy;
      vole.aimAngle = sim.aimAngle;
      vole.grounded = sim.grounded;
      vole.jumpHeld = sim.jumpHeld;
      vole.jumpCooldown = sim.jumpCooldown;
      vole.coyoteTimer = sim.coyoteTimer;
      vole.jumpBufferTimer = sim.jumpBufferTimer;
      vole.doubleJumpAvailable = sim.doubleJumpAvailable;
      vole.ropeActive = sim.ropeActive;
      vole.ropeAnchorX = sim.ropeAnchorX;
      vole.ropeAnchorY = sim.ropeAnchorY;
      vole.ropeLength = sim.ropeLength;
      vole.dashCharges = sim.dashCharges;
      vole.dashRechargeTimer = sim.dashRechargeTimer;
      vole.dashHeld = sim.dashHeld;
      vole.burrowActive = sim.burrowActive;
      vole.burrowElapsed = sim.burrowElapsed;
      vole.burrowStartY = sim.burrowStartY;
      vole.burrowCooldownTimer = sim.burrowCooldownTimer;
      vole.burrowHeld = sim.burrowHeld;
      // Burrow destroys terrain as it digs (see BURROW_CARVE_RADIUS) — carve at the vole's new
      // position on the activation tick, every tick still burrowing, and the completion/cancel tick
      // (preBurrowActive || sim.burrowActive covers all four; only "never burrowing" is excluded).
      // Own message (not "terrain-carve") so it doesn't trip that event's per-impact sound/bullet-
      // resolve path every tick — same reasoning as the railgun's own "railgun-carve".
      if (preBurrowActive || sim.burrowActive) {
        this.terrain.carveCircle(sim.x, sim.y, BURROW_CARVE_RADIUS);
        this.broadcast("burrow-carve", { x: sim.x, y: sim.y, radius: BURROW_CARVE_RADIUS });
      }
      // Dash fired this tick — tell clients so they can play the smoke effect (see main.ts's "dash"
      // handler). from/to spans the blink so the trail matches wherever terrain cut it short.
      if (sim.dashCharges < preDashCharges) {
        this.broadcast("dash", {
          id: sessionId,
          fromX: preDashX,
          fromY: preDashY,
          x: sim.x,
          y: sim.y,
          angle: sim.aimAngle,
        });
      }
      simVoles.push(sim);

      // Fall damage: while genuinely airborne (not on the rope — swinging isn't falling), remember
      // the highest point reached (smallest y). On landing, the drop from that peak, as a fraction
      // of the arena height, becomes damage 1:1 with full health once it clears FALL_MIN_FRACTION (a
      // 30%-of-height drop = 30 damage). The first landing after a (re)spawn is skipped so the fall
      // to the spawn floor never hurts.
      if (!vole.alive || vole.ropeActive || vole.grounded) {
        const peak = this.fallPeakY.get(sessionId);
        this.fallPeakY.delete(sessionId);
        if (vole.alive && vole.grounded && !vole.ropeActive) {
          if (this.fallSpawnGrace.has(sessionId)) {
            this.fallSpawnGrace.delete(sessionId);
          } else if (peak !== undefined && vole.y > peak) {
            const fraction = (vole.y - peak) / ARENA_HEIGHT;
            if (fraction >= FALL_MIN_FRACTION) {
              this.applyDamage(sessionId, Math.round(fraction * MAX_HEALTH), sessionId, 0, 0, true);
            }
          }
        }
      } else {
        const peak = this.fallPeakY.get(sessionId);
        this.fallPeakY.set(sessionId, peak === undefined ? vole.y : Math.min(peak, vole.y));
      }
    });

    this.updateBurrowContacts(simVoles);

    // Mines are hit-test targets for projectiles too (shooting one detonates it) — feed them into
    // stepProjectile alongside the voles, tagged so the result can be told apart.
    const mineTargets: VoleHitTarget[] = [];
    this.state.mines.forEach((m, id) => mineTargets.push({ id: `mine:${id}`, x: m.x, y: m.y, alive: true }));
    const projTargets: VoleHitTarget[] = mineTargets.length ? [...simVoles, ...mineTargets] : simVoles;

    const remaining: { proj: ProjectileSimState; traveled: number; terrainPierced: number }[] = [];
    for (const item of this.projectiles) {
      const proj = item.proj;
      const weapon = WEAPONS[proj.weaponId];
      const prevX = proj.x;
      const prevY = proj.y;
      // Piercing (see WeaponDef.piercing) turns off for the rest of this projectile's flight once
      // EITHER cap is exhausted: pierceRange (total distance traveled, tick-granular, same coarse
      // cutoff maxRange already has) or pierceTerrainLimit (distance actually spent inside solid
      // material — see below, enforced precisely via pierceBudget rather than only at tick
      // boundaries, since it's the tighter/more sensitive of the two). stepProjectile only reads
      // weapon.piercing, so a shallow override is enough; every other field (damage, carveRadius,
      // etc.) stays the real weapon's.
      const piercingActive =
        weapon.piercing &&
        (weapon.pierceRange === undefined || item.traveled < weapon.pierceRange) &&
        (weapon.pierceTerrainLimit === undefined || item.terrainPierced < weapon.pierceTerrainLimit);
      const effectiveWeapon = piercingActive ? weapon : { ...weapon, piercing: false };
      const pierceBudget = weapon.pierceTerrainLimit === undefined ? Infinity : weapon.pierceTerrainLimit - item.terrainPierced;
      // Ignore the shooter's own hitbox until the projectile has cleared the barrel (see
      // PROJECTILE_OWNER_CLEARANCE) — matters now that a wall-blocked shot spawns right next to them.
      const ignoreOwner = item.traveled < PROJECTILE_OWNER_CLEARANCE ? proj.ownerId : undefined;
      const prevBounces = proj.bounces ?? 0;
      const result = stepProjectile(proj, effectiveWeapon, this.terrain, DT, projTargets, pierceBudget, ignoreOwner);
      item.traveled += Math.hypot(result.x - prevX, result.y - prevY);
      item.terrainPierced += result.pierceDistance;
      if ((proj.bounces ?? 0) > prevBounces) this.broadcast("grenade-bounce", { x: proj.x, y: proj.y });

      // Hit a mine — detonate it and consume this projectile (the mine's blast is the payload).
      if (result.hit && result.hit.targetId.startsWith("mine:")) {
        this.detonateMine(result.hit.targetId.slice(5), proj.ownerId, simVoles);
        continue;
      }

      // A piercing weapon (sniper) doesn't stop at dirt/stone (see stepProjectile), so it can cover
      // this whole tick's travel distance in one go even through solid material — carve a capsule
      // along whatever it actually swept, regardless of what happens next (kept flying, hit rock/a
      // vole, ran out of range), so nothing destructible in its path survives untouched. Gated on
      // pierceDistance > 0 (not just piercingActive) so a tick spent entirely in open air — common
      // once it's flown clear of whatever it was piercing — doesn't send a pointless empty carve.
      if (result.pierceDistance > 0) {
        this.terrain.carveCapsule(prevX, prevY, result.x, result.y, weapon.carveRadius);
        // id lets the client recognize every carve from this one projectile (a piercing shot sends
        // several, one per tick, plus its own final circle below) as a single bullet — see main.ts's
        // terrain-carve handler, which plays the terrain-impact sound at most once per id instead of
        // once per message. weaponId lets it pick a weapon-specific impact sound (e.g. bazooka's own
        // recorded explosion) instead of the generic one.
        this.broadcast("terrain-carve", {
          id: proj.id,
          weaponId: proj.weaponId,
          x: prevX,
          y: prevY,
          x2: result.x,
          y2: result.y,
          radius: weapon.carveRadius,
        });
      }

      const outOfBounds = !this.terrain.inBounds(Math.floor(proj.x), Math.floor(proj.y));
      // Ran out of range (see WeaponDef.maxRange) without hitting anything — fizzles out silently,
      // no explosion/damage/carve, same as a shot that just missed and flew off into the distance.
      const outOfRange = !result.exploded && weapon.maxRange !== undefined && item.traveled >= weapon.maxRange;

      if (outOfRange) {
        continue;
      }

      if (result.exploded || outOfBounds) {
        const { damageEvents } = applyExplosion(this.terrain, result.x, result.y, weapon, simVoles, result.hit);
        this.broadcast("terrain-carve", { id: proj.id, weaponId: proj.weaponId, x: result.x, y: result.y, radius: weapon.carveRadius });

        for (const dmg of damageEvents) {
          this.applyDamage(dmg.targetId, dmg.amount, proj.ownerId, dmg.knockbackX, dmg.knockbackY);
        }
      } else {
        remaining.push(item);
      }
    }
    this.projectiles = remaining;

    this.updateFlames(simVoles);
    this.updateRailgun(simVoles);
    this.updateMines(simVoles);

    this.corpseSim.forEach((sim, id) => {
      stepCorpse(sim, this.terrain, DT);
      const schema = this.state.corpses.get(id);
      if (schema) {
        schema.x = sim.x;
        schema.y = sim.y;
        schema.angle = sim.angle;
      }
    });

    // Terrain-remaining figure for the top-centre HUD (see GameState.terrainRemaining). It only
    // moves when something carves, so a full-grid rescan every 30Hz tick is wasted work — every 6th
    // tick (5Hz) is plenty responsive for a readout.
    if (++this.terrainStatTick % 6 === 0) {
      this.state.terrainRemaining = this.terrain.countDestructible() / this.terrainInitialDestructible;
    }
  }

  /** Spawns a persistent, purely cosmetic corpse at a vole's death position — see memory/CLAUDE.md:
   *  skeletons stay until the match ends, react to terrain destruction (stepCorpse), but are never
   *  targetable and never block movement (simply never added to any collision/hit-test list). */
  private spawnCorpse(x: number, y: number, aimAngle: number): void {
    const id = `corpse${this.corpseSeq++}`;
    const corpse = new CorpseSchema();
    corpse.id = id;
    corpse.x = x;
    corpse.y = y;
    // Same facing rule the client's own renderVole uses, so the skeleton doesn't visibly flip
    // relative to how the vole was last facing when it died.
    corpse.facing = Math.cos(aimAngle) >= 0 ? 1 : -1;
    this.state.corpses.set(id, corpse);
    this.corpseSim.set(id, { id, x, y, vy: 0, grounded: false, angle: 0 });
  }

  /**
   * Applies `amount` damage (plus optional knockback) to one vole and runs the full death path if it
   * drops — blood broadcast, corpse, respawn timer, and deathmatch scoring (a hit from `attackerId`
   * === `targetId`, i.e. your own splash or your own fire, takes the death penalty but credits no
   * kill). Shared by every damage source: projectile explosions, flamethrower DoT, fall damage.
   * `grunt` (fire/fall only) triggers a throttled random vole grunt sound on all clients. A no-op
   * once the match is frozen (winnerId set) or against an already-dead / missing vole — the latter
   * also covers a vole killed earlier in the same tick by an earlier projectile.
   */
  private applyDamage(
    targetId: string,
    amount: number,
    attackerId: string,
    knockbackX = 0,
    knockbackY = 0,
    grunt = false
  ): void {
    if (this.state.winnerId) return;
    const vole = this.state.voles.get(targetId);
    if (!vole || !vole.alive) return;

    // Victim's own position, not the impact point — splash/flame can land a little off to the side.
    this.broadcast("blood", { x: vole.x, y: vole.y, amount });
    // Fire / fall damage plays a random vole grunt on the client (see sound.ts). Throttled per vole
    // so standing in a burn patch (DoT every FLAME_BURN_TICK_S) grunts every ~GRUNT_MIN_GAP_MS
    // instead of stuttering.
    if (grunt) {
      const now = Date.now();
      if (now - (this.lastGruntAt.get(targetId) ?? 0) >= GRUNT_MIN_GAP_MS) {
        this.lastGruntAt.set(targetId, now);
        this.broadcast("grunt");
      }
    }
    vole.health = Math.max(0, vole.health - amount);
    vole.vx += knockbackX;
    vole.vy += knockbackY;
    if (vole.health > 0) return;

    vole.alive = false;
    vole.ropeActive = false;
    vole.flaming = false;
    this.flaming.delete(targetId);
    this.flameDot.delete(targetId);
    this.stopRailgun(targetId);
    this.railDot.delete(targetId);
    vole.deaths += 1;
    vole.score -= 1;
    this.spawnCorpse(vole.x, vole.y, vole.aimAngle);
    this.clock.setTimeout(() => this.handleRespawn(targetId), RESPAWN_DELAY_MS);

    let killerName = "";
    if (attackerId !== targetId) {
      const killer = this.state.voles.get(attackerId);
      if (killer) {
        killer.kills += 1;
        killer.score += 1;
        killerName = killer.displayName;
        if (killer.score >= WIN_SCORE) this.state.winnerId = killer.id;
      }
    }
    // Top-right kill feed on every client (see main.ts pushKillFeed). No killerName ⇒ an
    // environmental death or a self-kill (selfKill distinguishes the two for the wording).
    this.broadcast("kill", {
      killerName,
      victimName: vole.displayName,
      selfKill: attackerId === targetId,
    });
  }

  /**
   * One tick of flamethrower resolution (see the FLAME_* constants). For every vole currently
   * flaming and still within its FLAME_MAX_MS budget: fan rays out across the spray cone from the
   * muzzle and light a burn patch wherever one meets terrain, and mark any vole caught in the cone
   * with clear line of sight as directly burned. Then deal DoT to every vole that's either directly
   * burned (FLAME_DIRECT_DMG every FLAME_DIRECT_TICK_S) or standing in a burn patch (FLAME_BURN_DMG
   * every FLAME_BURN_TICK_S). Expired burn patches are cleared here too.
   */
  private updateFlames(simVoles: VoleSimState[]): void {
    const now = Date.now();
    const range = WEAPONS.flamethrower.flameRange ?? 15;
    const coneHalf = WEAPONS.flamethrower.flameConeHalfRadians ?? 0.34;

    // Drop burn patches that have burned out.
    if (this.burns.some((b) => b.until <= now)) {
      for (const b of this.burns) {
        if (b.until <= now) this.state.burns.delete(b.id);
      }
      this.burns = this.burns.filter((b) => b.until > now);
    }

    // victimId -> attackerId for voles being hit by a stream directly this tick.
    const directBurn = new Map<string, string>();

    this.flaming.forEach((startedAt, sid) => {
      const vole = this.state.voles.get(sid);
      if (!vole || !vole.alive || now - startedAt >= FLAME_MAX_MS) {
        this.stopFlaming(sid);
        return;
      }
      vole.flaming = true;

      const mx = vole.x + Math.cos(vole.aimAngle) * FLAME_MUZZLE_DIST;
      const my = vole.y + Math.sin(vole.aimAngle) * FLAME_MUZZLE_DIST;

      // Light terrain the stream lands on.
      for (let i = 0; i < FLAME_TERRAIN_RAYS; i++) {
        const frac = i / (FLAME_TERRAIN_RAYS - 1); // 0..1 across the cone
        const a = vole.aimAngle + (frac - 0.5) * 2 * coneHalf;
        const hit = raycastTerrain(this.terrain, mx, my, a, range);
        if (hit) this.addBurn(hit.x, hit.y, sid, now);
      }

      // Voles caught in the cone with clear line of sight take direct DoT.
      for (const target of simVoles) {
        if (target.id === sid || !target.alive) continue;
        const dx = target.x - mx;
        const dy = target.y - my;
        const dist = Math.hypot(dx, dy);
        if (dist > range + VOLE_RADIUS) continue;
        let rel = Math.atan2(dy, dx) - vole.aimAngle;
        while (rel > Math.PI) rel -= Math.PI * 2;
        while (rel < -Math.PI) rel += Math.PI * 2;
        // Widen the effective cone at point-blank so it isn't a needle right at the muzzle.
        const effHalf = coneHalf + Math.min(0.6, VOLE_RADIUS / Math.max(dist, 1));
        if (Math.abs(rel) > effHalf) continue;
        if (raycastTerrain(this.terrain, mx, my, Math.atan2(dy, dx), dist)) continue; // wall in the way
        directBurn.set(target.id, sid);
      }
    });

    // Fixed-cadence DoT for anyone burning (directly, or by standing in a patch).
    this.state.voles.forEach((vole, sid) => {
      if (!vole.alive) {
        this.flameDot.delete(sid);
        return;
      }
      const directAttacker = directBurn.get(sid);
      let attacker = directAttacker;
      if (!attacker) {
        for (const b of this.burns) {
          const dx = b.x - vole.x;
          const dy = b.y - vole.y;
          if (dx * dx + dy * dy <= BURN_CONTACT_RADIUS * BURN_CONTACT_RADIUS) {
            attacker = b.ownerId;
            break;
          }
        }
      }
      if (!attacker) {
        this.flameDot.delete(sid);
        return;
      }

      // Standing in a burn patch ticks faster (FLAME_BURN_TICK_S) than taking the stream head-on
      // (FLAME_DIRECT_TICK_S); a direct hit takes precedence when both apply. One accumulator, with
      // the cadence chosen per tick — a mid-accumulation switch just lands one tick a little early.
      const tick = directAttacker ? FLAME_DIRECT_TICK_S : FLAME_BURN_TICK_S;
      let acc = (this.flameDot.get(sid) ?? 0) + DT;
      if (acc >= tick) {
        acc -= tick;
        this.applyDamage(sid, directAttacker ? FLAME_DIRECT_DMG : FLAME_BURN_DMG, attacker, 0, 0, true);
        if (!vole.alive) {
          this.flameDot.delete(sid);
          return;
        }
      }
      this.flameDot.set(sid, acc);
    });
  }

  /**
   * One tick of railgun resolution (see the RAIL_* constants). Syncs the 0..1 charge meter for
   * anyone winding one up. For every live beam: raycast from the owner's muzzle along their aim to
   * the first SOLID cell (terrain BLOCKS the beam now), capped at the charge-scaled range; that's
   * the beam's front. Sync front distance + half-width for the client renderer, deal DoT
   * (dps × elapsed, fractional damage carried) to any vole the muzzle→front segment touches, and —
   * on the RAIL_CARVE_TICK_S cadence — chew a `digRadius` capsule from the OWNER'S position to the
   * front (so the ground under the player's feet goes too; carveCapsule leaves rock alone, so a
   * rock front is a permanent stop). Expired beams are dropped.
   */
  private updateRailgun(simVoles: VoleSimState[]): void {
    const now = Date.now();

    this.railCharging.forEach((startedAt, sid) => {
      const vole = this.state.voles.get(sid);
      if (!vole || !vole.alive) {
        this.railCharging.delete(sid);
        if (vole) vole.railgunCharge = 0;
        return;
      }
      vole.railgunCharge = Math.min(1, (now - startedAt) / RAIL_CHARGE_MS);
    });

    // victimId -> ownerId for voles touched by a beam this tick, so stale DoT accumulators can be
    // dropped once a vole steps out of every beam.
    const beamed = new Map<string, string>();

    this.railBeams.forEach((beam, ownerId) => {
      const owner = this.state.voles.get(ownerId);
      if (!owner || !owner.alive || now >= beam.endsAt) {
        this.railBeams.delete(ownerId);
        if (owner) {
          owner.railgunBeamActive = false;
          owner.railgunBeamLength = 0;
          owner.railgunBeamWidth = 0;
        }
        return;
      }

      const dirX = Math.cos(owner.aimAngle);
      const dirY = Math.sin(owner.aimAngle);
      const mx = owner.x + dirX * RAIL_MUZZLE_DIST;
      const my = owner.y + dirY * RAIL_MUZZLE_DIST;
      // Front = first solid cell along the aim (terrain blocks the beam), capped at the beam's reach.
      const hit = raycastTerrain(this.terrain, mx, my, owner.aimAngle, beam.length);
      const len = hit ? Math.hypot(hit.x - mx, hit.y - my) : beam.length;
      const fx = mx + dirX * len;
      const fy = my + dirY * len;

      owner.railgunBeamActive = true;
      owner.railgunBeamLength = len;
      owner.railgunBeamWidth = beam.halfWidth;

      // On the RAIL_CARVE_TICK_S cadence, chew a digRadius bite out of the front. The capsule runs
      // from the OWNER'S own position (not the offset muzzle) so the terrain the player is standing
      // on gets cleared too — everything between is open air, so this only removes the footing near
      // the vole and the digRadius bite at the front. carveCapsule leaves rock alone, so a rock
      // front just stops the beam. Own message, mirrored 1:1 by the client's terrain.
      if (now - beam.lastCarveAt >= RAIL_CARVE_TICK_S * 1000) {
        beam.lastCarveAt = now;
        this.terrain.carveCapsule(owner.x, owner.y, fx, fy, beam.digRadius);
        this.broadcast("railgun-carve", { x1: owner.x, y1: owner.y, x2: fx, y2: fy, radius: beam.digRadius });
      }

      // DoT to any vole whose body touches the beam segment (muzzle → terrain-clipped front).
      const reach = beam.halfWidth + VOLE_RADIUS;
      for (const target of simVoles) {
        if (target.id === ownerId || !target.alive) continue;
        if (pointSegmentDistance(target.x, target.y, mx, my, fx, fy) > reach) continue;
        beamed.set(target.id, ownerId);
        const dot = this.railDot.get(target.id) ?? { acc: 0, carry: 0 };
        dot.acc += DT;
        if (dot.acc >= RAIL_DMG_TICK_S) {
          dot.acc -= RAIL_DMG_TICK_S;
          dot.carry += beam.dps * RAIL_DMG_TICK_S;
          const whole = Math.floor(dot.carry);
          if (whole > 0) {
            dot.carry -= whole;
            this.applyDamage(target.id, whole, ownerId, 0, 0, true);
          }
        }
        this.railDot.set(target.id, dot);
        const tv = this.state.voles.get(target.id);
        if (tv && !tv.alive) this.railDot.delete(target.id);
      }
    });

    this.railDot.forEach((_v, victimId) => {
      if (!beamed.has(victimId)) this.railDot.delete(victimId);
    });
  }

  /** Records (or refreshes) a burn patch at (x, y), lit by `ownerId`. Patches close to an existing
   *  one just extend its timer instead of piling up; the list is hard-capped at MAX_BURNS with the
   *  oldest dropped first. Kept in lockstep with state.burns for the client. */
  private addBurn(x: number, y: number, ownerId: string, now: number): void {
    for (const b of this.burns) {
      if (Math.abs(b.x - x) <= BURN_MERGE_DIST && Math.abs(b.y - y) <= BURN_MERGE_DIST) {
        b.until = now + BURN_DURATION_MS;
        b.ownerId = ownerId;
        return;
      }
    }
    if (this.burns.length >= MAX_BURNS) {
      const oldest = this.burns.shift();
      if (oldest) this.state.burns.delete(oldest.id);
    }
    const id = `burn${this.burnSeq++}`;
    this.burns.push({ id, x, y, until: now + BURN_DURATION_MS, ownerId });
    const schema = new BurnSchema();
    schema.id = id;
    schema.x = x;
    schema.y = y;
    this.state.burns.set(id, schema);
  }

  /** Drops a mine at (x, y) — it falls to the terrain in update() and arms after MINE_ARM_MS. */
  private deployMine(ownerId: string, x: number, y: number, now: number): void {
    if (this.state.mines.size >= MAX_MINES) {
      const oldest = this.state.mines.keys().next().value as string | undefined;
      if (oldest) this.removeMine(oldest);
    }
    const id = `mine${this.mineSeq++}`;
    const schema = new MineSchema();
    schema.id = id;
    schema.x = x;
    schema.y = y;
    schema.ownerId = ownerId;
    schema.armed = false;
    this.state.mines.set(id, schema);
    // If it spawned already touching solid ground, it's grounded straight away.
    const grounded = circleHitsTerrain(this.terrain, x, y, MINE_RADIUS);
    this.mineSim.set(id, { vy: 0, grounded, deployedAt: now });
  }

  private removeMine(id: string): void {
    this.state.mines.delete(id);
    this.mineSim.delete(id);
  }

  /** Blows a mine up: carve + linear-falloff blast (the vole that set it off, if any, takes the full
   *  `damage`). `attackerId` gets the kill credit. Then the mine is removed. */
  private detonateMine(id: string, attackerId: string, simVoles: VoleSimState[], triggeredBy?: string): void {
    const mine = this.state.mines.get(id);
    if (!mine) return;
    const x = mine.x;
    const y = mine.y;
    this.removeMine(id);

    const weapon = WEAPONS.mine;
    const directHit = triggeredBy ? { targetId: triggeredBy, part: "body" as const } : null;
    const { damageEvents } = applyExplosion(this.terrain, x, y, weapon, simVoles, directHit);
    this.broadcast("terrain-carve", { weaponId: "mine", x, y, radius: weapon.carveRadius });
    for (const dmg of damageEvents) {
      this.applyDamage(dmg.targetId, dmg.amount, attackerId, dmg.knockbackX, dmg.knockbackY);
    }
  }

  /** One tick of mine physics: fall to the terrain, arm after MINE_ARM_MS, and (once armed and
   *  landed) detonate on any vole that comes within MINE_TRIGGER_RADIUS. */
  private updateMines(simVoles: VoleSimState[]): void {
    const now = Date.now();
    const triggers: { id: string; ownerId: string; by: string }[] = [];

    this.state.mines.forEach((mine, id) => {
      const sim = this.mineSim.get(id);
      if (!sim) return;

      if (!sim.grounded) {
        sim.vy += GRAVITY * DT;
        const drop = sim.vy * DT;
        const steps = Math.max(1, Math.ceil(Math.abs(drop)));
        let ny = mine.y;
        for (let s = 0; s < steps; s++) {
          const step = ny + drop / steps;
          if (circleHitsTerrain(this.terrain, mine.x, step, MINE_RADIUS)) {
            sim.grounded = true;
            sim.vy = 0;
            break;
          }
          ny = step;
        }
        mine.y = ny;
      }

      if (!mine.armed && now - sim.deployedAt >= MINE_ARM_MS) mine.armed = true;

      if (mine.armed && sim.grounded) {
        const reach = VOLE_RADIUS + MINE_TRIGGER_RADIUS;
        for (const v of simVoles) {
          if (!v.alive) continue;
          const dx = v.x - mine.x;
          const dy = v.y - mine.y;
          if (dx * dx + dy * dy <= reach * reach) {
            triggers.push({ id, ownerId: mine.ownerId, by: v.id });
            break;
          }
        }
      }
    });

    for (const t of triggers) this.detonateMine(t.id, t.ownerId, simVoles, t.by);
  }

  /** One tick of Burrow's contact damage (see BURROW_CONTACT_* — the descent itself is entirely
   *  handled by stepVole). Any live vole whose body comes within BURROW_CONTACT_RADIUS of a currently
   *  burrowing vole takes a flat hit + knockback away from it, once per burrow activation (tracked in
   *  burrowHitVictims, reset the instant that vole stops burrowing). */
  private updateBurrowContacts(simVoles: VoleSimState[]): void {
    for (const burrower of simVoles) {
      if (!burrower.burrowActive) {
        this.burrowHitVictims.delete(burrower.id);
        continue;
      }
      let victims = this.burrowHitVictims.get(burrower.id);
      if (!victims) {
        victims = new Set();
        this.burrowHitVictims.set(burrower.id, victims);
      }
      for (const other of simVoles) {
        if (other.id === burrower.id || !other.alive || victims.has(other.id)) continue;
        const dx = other.x - burrower.x;
        const dy = other.y - burrower.y;
        const dist = Math.hypot(dx, dy);
        if (dist > BURROW_CONTACT_RADIUS) continue;
        victims.add(other.id);
        const nx = dist > 0.001 ? dx / dist : 1;
        const ny = dist > 0.001 ? dy / dist : 0;
        this.applyDamage(
          other.id,
          BURROW_CONTACT_DAMAGE,
          burrower.id,
          nx * BURROW_CONTACT_KNOCKBACK,
          ny * BURROW_CONTACT_KNOCKBACK
        );
      }
    }
  }
}
