import { Client, Room } from "@colyseus/core";
import {
  applyExplosion,
  circleHitsTerrain,
  DEFAULT_WEAPON_ID,
  MAX_HEALTH,
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
  type VoleSimState,
} from "@vole-wars/shared";
import { BurnSchema, CorpseSchema, GameState, VoleSchema } from "./state.js";

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
const BURN_CONTACT_RADIUS = VOLE_RADIUS + 3; // how close a vole must be to a burn patch to be burned by it

const IDLE_INPUT: PlayerInput = {
  left: false,
  right: false,
  jump: false,
  aimAngle: 0,
  fire: false,
  grapple: false,
  up: false,
  down: false,
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
  // Fall-damage tracking: the highest point (smallest y) a vole has reached while airborne since it
  // last left the ground. On landing, the drop from that peak is turned into damage (see
  // FALL_MIN_FRACTION / update). fallSpawnGrace skips the first landing after a (re)spawn so the
  // drop from the spawn point never hurts.
  private fallPeakY = new Map<string, number>();
  private fallSpawnGrace = new Set<string>();
  // Last time each vole triggered a fire/fall grunt sound (see GRUNT_MIN_GAP_MS / applyDamage).
  private lastGruntAt = new Map<string, number>();

  onCreate(): void {
    this.setState(new GameState());

    const seed = Math.floor(Math.random() * 0xffffffff);
    this.terrain = TerrainField.generateCaves(ARENA_WIDTH, ARENA_HEIGHT, seed);
    this.spawnBot();

    this.onMessage("input", (client, message: PlayerInput) => {
      this.inputs.set(client.sessionId, message);
    });

    this.onMessage("fire", (client, message: { weaponId?: string; power?: number }) => {
      this.handleFire(client.sessionId, message?.weaponId, message?.power);
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

  onJoin(client: Client): void {
    const vole = new VoleSchema();
    vole.id = client.sessionId;
    vole.displayName = `Player ${this.nextPlayerNumber++}`;
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
    this.fallPeakY.delete(client.sessionId);
    this.fallSpawnGrace.delete(client.sessionId);
    this.lastGruntAt.delete(client.sessionId);
  }

  /** Ends a flamethrower squeeze: drops the hold state (freeing the FLAME_MAX_MS budget) and clears
   *  the synced `flaming` flag so the client stops drawing the stream. Safe to call unconditionally. */
  private stopFlaming(sessionId: string): void {
    this.flaming.delete(sessionId);
    const vole = this.state.voles.get(sessionId);
    if (vole) vole.flaming = false;
  }

  /** Adds the always-on dummy bot vole — see BOT_ID's own comment for what it's for. Called once
   *  from onCreate, not onJoin, since it's never a real connected client. */
  private spawnBot(): void {
    const vole = new VoleSchema();
    vole.id = BOT_ID;
    vole.displayName = "Bot";
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
    vole.ropeActive = false;
    this.stopFlaming(sessionId);
    this.flameDot.delete(sessionId);
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

    const spawnDist = VOLE_RADIUS + 4;

    // Charge-thrown weapons (grenade): the client sends a 0..1 `power` built up while LMB was held.
    // Map it to a launch speed; a near-zero power (short click) plops it at the feet.
    const launchSpeed = weapon.chargeThrow
      ? (weapon.minThrowSpeed ?? 0) +
        Math.max(0, Math.min(1, power ?? 0)) * ((weapon.maxThrowSpeed ?? 0) - (weapon.minThrowSpeed ?? 0))
      : weapon.projectileSpeed;

    // pelletCount > 1 (shotgun/minigun) fans multiple projectiles out across spreadRadians of random
    // aim jitter instead of firing one straight shot.
    const pelletCount = weapon.pelletCount ?? 1;
    const spread = weapon.spreadRadians ?? 0;
    for (let i = 0; i < pelletCount; i++) {
      const angle = vole.aimAngle + (pelletCount > 1 ? (Math.random() - 0.5) * spread : 0);
      const dirX = Math.cos(angle);
      const dirY = Math.sin(angle);

      // Normally the projectile spawns a little ahead of the vole (spawnDist) so it clears its own
      // hitbox. But if there's solid terrain between the vole and that spawn point — i.e. the vole is
      // hugging a wall it's shooting at — spawn it right at the near face of that wall instead, so it
      // carves the wall the player is touching rather than magically appearing on the far side of it.
      const blocked = raycastTerrain(this.terrain, vole.x, vole.y, angle, spawnDist);

      const projectile: ProjectileSimState = {
        id: `p${this.projectileSeq++}`,
        ownerId: sessionId,
        weaponId: weapon.id,
        x: blocked ? blocked.x : vole.x + dirX * spawnDist,
        y: blocked ? blocked.y : vole.y + dirY * spawnDist,
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
        ropeActive: vole.ropeActive,
        ropeAnchorX: vole.ropeAnchorX,
        ropeAnchorY: vole.ropeAnchorY,
        ropeLength: vole.ropeLength,
      };
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
      vole.ropeActive = sim.ropeActive;
      vole.ropeAnchorX = sim.ropeAnchorX;
      vole.ropeAnchorY = sim.ropeAnchorY;
      vole.ropeLength = sim.ropeLength;
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
      const result = stepProjectile(proj, effectiveWeapon, this.terrain, DT, simVoles, pierceBudget, ignoreOwner);
      item.traveled += Math.hypot(result.x - prevX, result.y - prevY);
      item.terrainPierced += result.pierceDistance;
      if ((proj.bounces ?? 0) > prevBounces) this.broadcast("grenade-bounce", { x: proj.x, y: proj.y });

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

    this.corpseSim.forEach((sim, id) => {
      stepCorpse(sim, this.terrain, DT);
      const schema = this.state.corpses.get(id);
      if (schema) {
        schema.x = sim.x;
        schema.y = sim.y;
        schema.angle = sim.angle;
      }
    });
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
    vole.deaths += 1;
    vole.score -= 1;
    this.spawnCorpse(vole.x, vole.y, vole.aimAngle);
    this.clock.setTimeout(() => this.handleRespawn(targetId), RESPAWN_DELAY_MS);

    if (attackerId !== targetId) {
      const killer = this.state.voles.get(attackerId);
      if (killer) {
        killer.kills += 1;
        killer.score += 1;
        if (killer.score >= WIN_SCORE) this.state.winnerId = killer.id;
      }
    }
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
}
