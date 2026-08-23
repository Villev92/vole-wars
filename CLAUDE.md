# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Vole Wars — a real-time multiplayer Worms-style artillery game (destructible 2D terrain, two players digging craters and shooting each other) built as an npm-workspaces monorepo:

- `packages/shared` — physics, terrain generation, and weapon data shared byte-for-byte between server and client (no build step; consumed straight from TS source).
- `apps/server` — authoritative Colyseus game server (Node/WebSocket).
- `apps/client` — Pixi.js v8 + Vite browser client.

## Commands

Run from the repo root (npm workspaces):

- `npm run dev:server` — starts the Colyseus server on `ws://localhost:2567` (`tsx watch`, auto-restarts on save).
- `npm run dev:client` — starts the Vite dev server (default `http://localhost:5173`).
- Both must be running together for the game to work; there's no combined dev script.
- `npm run build` — builds client then server.
- `npm run typecheck` — runs `tsc --noEmit` across `packages/shared`, `apps/client`, `apps/server` in that order (shared first, since the other two depend on it). Run this after any change — it's the only automated check in the repo (no lint script, no test framework/test files exist anywhere in the project).
- `npm run dev -w apps/server` / `-w apps/client` / `-w packages/shared` — run a single workspace's script directly.

`apps/server`'s `tsx watch` has a port-release race on rapid successive saves on Windows (a restart can fail with `EADDRINUSE` while the previous process is still releasing the port, silently leaving stale code running). If physics/server behavior doesn't seem to reflect a just-saved change, check `netstat -ano | grep :2567` for the listening PID and do a clean kill + `npm run dev:server` restart rather than trusting the watcher.

## Architecture

### Server-authoritative simulation

`apps/server/src/GameRoom.ts` is the only stateful piece server-side: it owns a `TerrainField`, a Colyseus schema (`apps/server/src/state.ts`) synced to clients, and a fixed-timestep loop (`SIM_TICK_RATE` = 30Hz, from `packages/shared/src/physics.ts`) that calls `stepVole`/`stepProjectile`/`applyExplosion` from `packages/shared/src/physics.ts` every tick. Clients only ever send `input`/`fire`/`respawn`/`request-terrain` messages and render whatever state Colyseus syncs back — no client-side prediction of vole position, only render-side smoothing (see below).

Projectiles are the one exception to "state is synced": the server never streams per-tick projectile positions. It broadcasts a `fire` event (spawn state) and, once the projectile resolves, a `terrain-carve` event. The client's `apps/client/src/bullets.ts` (`BulletLayer`) re-simulates the projectile locally with the *same* `stepProjectile` against its own mirrored terrain purely to render a flight path to the same impact point — it is not authoritative and never reports damage itself.

### Terrain

`packages/shared/src/terrain.ts`'s `TerrainField` is a flat `Uint8Array` grid of materials (`TERRAIN_EMPTY`/`DIRT`/`ROCK`/`STONE`). `TerrainField.generateCaves()` is a seeded (`mulberry32`) generator: solid dirt everywhere, with a few large stone patches, a few wide carved paths, and guaranteed-clear spawn rooms (`spawnPoints`) stamped in via a random-walk-and-stamp technique, then a rock border. Same seed → identical terrain on any machine.

A joining client does **not** regenerate terrain from a seed — it requests the server's *current* (possibly already-damaged) bytes via a `request-terrain`/`terrain-init` round trip (`apps/client/src/net.ts`), specifically to avoid two race conditions: a client joining mid-game must see existing craters, and a runtime `terrain-carve` broadcast sent before a client finishes registering its listener would otherwise be silently dropped. Ongoing damage is a `terrain-carve` message with a center/radius; both sides call `TerrainField.carveCircle` — the server carves as ground truth, the client carves the same circle into its own mirrored copy and re-renders (`TerrainRenderer.carve`).

### Physics (`packages/shared/src/physics.ts`)

Circle-vs-grid collision (`circleHitsTerrain` scans every cell whose center falls in the circle — not perimeter sampling, which can miss narrow ledges). Movement is axis-separated and sub-stepped (`sweepAxis`, 1-unit substeps) so a vole stops right at a surface instead of wherever it was at the start of the tick that hit it. `stepVole` also includes a Worms-style ledge-climb (`tryStepUp`): a blocked horizontal move while grounded retries from progressively higher starting points up to `STEP_HEIGHT` and takes the smallest lift that clears the whole move, so small bumps/gentle slopes don't stop the vole dead the way a real wall does.

**`VOLE_RADIUS` is not a free gameplay-tuning constant** — it's deliberately set to match the client's character art (see below), because the art has no separate leg piece to stretch between the torso and a ground-contact point. The two are cross-referenced in comments in both files; changing one without the other reintroduces a character that visually floats above, sinks into, or detaches from the terrain.

### Character rendering (`apps/client/src/voleArt.ts` + `main.ts`)

The vole is assembled at render time from 4 flat-shaded PNGs cut from `designs/HeroParts.png` (head+helmet, torso, gun+arm, one foot reused for both near/far leg — see `apps/client/public/art/`), not a single sprite sheet or hand-drawn vectors. Every part is a Pixi `Sprite`/`Container` positioned by `main.ts` at a shared per-vole origin `O` (the server's `vole.x/y`); most parts anchor at their own attach point (neck, shoulder) so leaving their local position at the Pixi default lands them exactly on `O` with no offset math. `ENTITY_SCALE` (in `voleArt.ts`) is the single fixed vole-local-unit → terrain-unit ratio every part shares — it is **not** counter-scaled against camera zoom; doing that previously was what let a part's position drift relative to the rest of the rig depending on window/arena size. Resizing the whole character means changing `ENTITY_SCALE` (and keeping `VOLE_RADIUS` in physics.ts matched to it, per above).

`main.ts` also owns: the camera (`applyCamera` scales/positions a `world` container to *cover* the window, cropping overflow rather than letterboxing — so terrain generation keeps a thick rock border to guarantee spawns/paths near an edge don't crop off-screen), render-side position/angle smoothing (server ticks at 30Hz; each view eases toward the latest server pose every animation frame so motion doesn't visibly step), the walk-cycle/head-bob animation (driven by the server-synced `vole.vx`, not local input), and the gun's aim rotation (mirroring via negative scale.x means the rotation fed in has to be `angle + π`, not `π - angle`, when facing left — Pixi composes a container's transform as scale-then-rotate, so those two formulas only agree at the boundary angles).

`terrainRenderer.ts` renders the `TerrainField` to a canvas-backed texture at 3x supersampling with bilinear-interpolated edges (so terrain reads as smooth curves, not blocky cells) and re-renders only the changed rect on each carve. `caveBackground.ts` draws a static, once-only backdrop behind it so carved-out areas read as "more rock behind you" instead of empty space.

### Networking (`apps/client/src/net.ts`, `apps/server/src/GameRoom.ts`)

Colyseus room name is `"vole_wars"`, `maxClients = 2`. Message types: client→server `input` (full `PlayerInput` snapshot, sent at a capped rate independent of render framerate), `fire`, `respawn`, `request-terrain`; server→client `terrain-init` (response), `terrain-carve`, `fire` (projectile spawn for local bullet rendering).
