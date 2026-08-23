import { Client, Room } from "@colyseus/core";
import {
  applyExplosion,
  circleHitsTerrain,
  DEFAULT_WEAPON_ID,
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
import { CorpseSchema, GameState, VoleSchema } from "./state.js";

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
  private projectiles: ProjectileSimState[] = [];
  private projectileSeq = 0;
  private nextPlayerNumber = 1;
  // Server-only fall state (vy/grounded) for each corpse, keyed the same as the synced CorpseSchema
  // map — same split as projectiles/ProjectileSimState: the schema syncs only what clients need to
  // render (x/y/facing), this map holds the rest of the simulation.
  private corpseSim = new Map<string, CorpseSimState>();
  private corpseSeq = 0;

  onCreate(): void {
    this.setState(new GameState());

    const seed = Math.floor(Math.random() * 0xffffffff);
    this.terrain = TerrainField.generateCaves(ARENA_WIDTH, ARENA_HEIGHT, seed);
    this.spawnBot();

    this.onMessage("input", (client, message: PlayerInput) => {
      this.inputs.set(client.sessionId, message);
    });

    this.onMessage("fire", (client, message: { weaponId?: string }) => {
      this.handleFire(client.sessionId, message?.weaponId);
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
    vole.health = 100;
    vole.alive = true;
    this.state.voles.set(client.sessionId, vole);
    this.inputs.set(client.sessionId, { ...IDLE_INPUT });
    // Terrain isn't pushed here — the client fetches it itself via "request-terrain" once it's
    // ready to receive the response (see that handler's comment for why).
  }

  onLeave(client: Client): void {
    this.state.voles.delete(client.sessionId);
    this.inputs.delete(client.sessionId);
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
    vole.health = 100;
    vole.alive = true;
    this.state.voles.set(BOT_ID, vole);
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
    vole.health = 100;
    vole.alive = true;
    vole.jumpHeld = false;
    vole.jumpCooldown = 0;
    vole.ropeActive = false;
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

  private handleFire(sessionId: string, weaponId: string | undefined): void {
    // Match is over — frozen until a server restart (see memory: project-deathmatch-mode).
    if (this.state.winnerId) return;

    const vole = this.state.voles.get(sessionId);
    if (!vole || !vole.alive) return;

    // Falls back to the default for any weapon slot the client can select but that isn't actually
    // implemented server-side yet (most of WEAPON_IDS — see weaponIcons.ts) rather than silently not
    // firing at all.
    const weapon = (weaponId && WEAPONS[weaponId]) || WEAPONS[DEFAULT_WEAPON_ID];
    const spawnDist = VOLE_RADIUS + 4;

    // pelletCount > 1 (currently just flamethrower) fans multiple projectiles out across
    // spreadRadians of random aim jitter instead of firing one straight shot.
    const pelletCount = weapon.pelletCount ?? 1;
    const spread = weapon.spreadRadians ?? 0;
    for (let i = 0; i < pelletCount; i++) {
      const angle = vole.aimAngle + (pelletCount > 1 ? (Math.random() - 0.5) * spread : 0);
      const dirX = Math.cos(angle);
      const dirY = Math.sin(angle);

      const projectile: ProjectileSimState = {
        id: `p${this.projectileSeq++}`,
        ownerId: sessionId,
        weaponId: weapon.id,
        x: vole.x + dirX * spawnDist,
        y: vole.y + dirY * spawnDist,
        vx: dirX * weapon.projectileSpeed,
        vy: dirY * weapon.projectileSpeed,
      };
      this.projectiles.push(projectile);
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
      vole.ropeActive = sim.ropeActive;
      vole.ropeAnchorX = sim.ropeAnchorX;
      vole.ropeAnchorY = sim.ropeAnchorY;
      vole.ropeLength = sim.ropeLength;
      simVoles.push(sim);
    });

    const remaining: ProjectileSimState[] = [];
    for (const proj of this.projectiles) {
      const weapon = WEAPONS[proj.weaponId];
      const result = stepProjectile(proj, weapon, this.terrain, DT, simVoles);
      const outOfBounds = !this.terrain.inBounds(Math.floor(proj.x), Math.floor(proj.y));

      if (result.exploded || outOfBounds) {
        const { damageEvents } = applyExplosion(this.terrain, result.x, result.y, weapon, simVoles, result.hit);
        this.broadcast("terrain-carve", { x: result.x, y: result.y, radius: weapon.carveRadius });

        // Match already decided (frozen) — terrain still carves above, but no further scoring or
        // deaths get applied.
        if (!this.state.winnerId) {
          for (const dmg of damageEvents) {
            const vole = this.state.voles.get(dmg.targetId);
            // Also skips a vole already killed earlier this same tick: damageEvents comes from the
            // simVoles snapshot taken at the top of update(), which doesn't see deaths applied by an
            // earlier projectile in this same tick, so without this guard a second explosion could
            // "kill" an already-dead vole a second time.
            if (!vole || !vole.alive) continue;
            // Broadcast at the victim's own position (not the explosion's impact point, which for
            // splash damage can land a few units off to the side) — every hit bleeds, splash-only
            // chip damage included.
            this.broadcast("blood", { x: vole.x, y: vole.y, amount: dmg.amount });
            vole.health = Math.max(0, vole.health - dmg.amount);
            vole.vx += dmg.knockbackX;
            vole.vy += dmg.knockbackY;
            if (vole.health <= 0) {
              vole.alive = false;
              vole.ropeActive = false;
              vole.deaths += 1;
              vole.score -= 1;
              this.spawnCorpse(vole.x, vole.y, vole.aimAngle);
              // dmg.targetId (not a captured reference to `vole`) so the lookup is fresh when the
              // timeout fires — the player may have left in the meantime, which handleRespawn's own
              // `!vole` guard already handles.
              this.clock.setTimeout(() => this.handleRespawn(dmg.targetId), RESPAWN_DELAY_MS);

              // Self-splash doesn't credit a kill, just the death penalty above.
              if (proj.ownerId !== dmg.targetId) {
                const killer = this.state.voles.get(proj.ownerId);
                if (killer) {
                  killer.kills += 1;
                  killer.score += 1;
                  if (killer.score >= WIN_SCORE) this.state.winnerId = killer.id;
                }
              }
            }
          }
        }
      } else {
        remaining.push(proj);
      }
    }
    this.projectiles = remaining;

    this.corpseSim.forEach((sim, id) => {
      stepCorpse(sim, this.terrain, DT);
      const schema = this.state.corpses.get(id);
      if (schema) {
        schema.x = sim.x;
        schema.y = sim.y;
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
    this.corpseSim.set(id, { id, x, y, vy: 0, grounded: false });
  }
}
