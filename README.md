# Vole Wars

A real-time multiplayer Worms-style artillery game — destructible 2D terrain, two players digging craters and shooting each other. Built as an npm-workspaces monorepo:

- `packages/shared` — physics, terrain generation, and weapon data shared byte-for-byte between server and client
- `apps/server` — authoritative Colyseus game server (Node/WebSocket)
- `apps/client` — Pixi.js v8 + Vite browser client

See `CLAUDE.md` for a deeper architecture writeup (terrain/physics internals, networking model, rendering pipeline).

## Setup & running

Requires Node.js and npm (workspaces support), plus [Git LFS](https://git-lfs.com/) for the image assets.

```bash
git lfs install   # one-time per machine, if you haven't used Git LFS before
git clone https://github.com/Villev92/vole-wars.git
cd vole-wars
npm install
```

> If you cloned before installing Git LFS, the art files under `apps/client/public/art/` and `designs/` will be small text pointer files instead of images — run `git lfs pull` after installing Git LFS to fetch the real content.

Then run the server and client in two separate terminals (both must be running together — there's no combined dev script):

```bash
npm run dev:server   # Colyseus server on ws://localhost:2567
npm run dev:client   # Vite dev server, default http://localhost:5173
```

Open `http://localhost:5173` in two browser tabs/windows to play a match locally.

Other useful commands (run from repo root):

```bash
npm run build        # builds client then server
npm run typecheck     # tsc --noEmit across shared -> client -> server; the only automated check in the repo
```

> **Windows note:** `apps/server`'s `tsx watch` has a port-release race on rapid successive saves — a restart can fail with `EADDRINUSE` while the previous process is still releasing the port, silently leaving stale code running. If server behavior doesn't seem to reflect a just-saved change, check `netstat -ano | findstr :2567` for the listening PID, kill it, and restart `npm run dev:server`.

## Controls

| Action | Input |
| --- | --- |
| Move left / right | `A`/`D` or `←`/`→` |
| Jump | `W`, `↑`, or `Space` |
| Aim | Mouse position |
| Fire current weapon | Left click |
| Fire grappling hook | Hold right click |
| Reel grapple in / out | `W`/`↑` / `S`/`↓` (while attached) |
| Select weapon | `1`–`9`, `0` (10th slot), or scroll wheel |
| Zoom camera | Hold `Left Shift` + scroll wheel |
| Show scoreboard | Hold `Tab` |

Respawning is automatic in deathmatch mode — no button needed.

## To do

- **Weapon firing, bullets and animations** — expand beyond the current weapon set; more projectile behaviors, impact effects, and firing animations.
- **Super powers** — a secondary ability layer (double-jump is the leading idea, not yet designed — see project brainstorming notes before building).
- **Bridge and ladder creation** — player-placeable structures for traversing craters/gaps, as an alternative to digging and the grapple hook.
- **Terrain visual improvement** — further work on how carved/destroyed terrain reads visually (edges, shading, background parallax).
