import { Client, Room } from "colyseus.js";
import type { PlayerInput } from "@vole-wars/shared";

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "ws://localhost:2567";

export async function connect(): Promise<Room> {
  const client = new Client(SERVER_URL);
  return client.joinOrCreate("vole_wars");
}

export function sendInput(room: Room, input: PlayerInput): void {
  room.send("input", input);
}

/** `power` (0..1) is only meaningful for charge-thrown weapons (grenade) — the server maps it to a
 *  launch speed; omit it for every other weapon. */
export function sendFire(room: Room, weaponId: string, power?: number): void {
  room.send("fire", power === undefined ? { weaponId } : { weaponId, power });
}

/** Flamethrower hold state — sent on every change of "am I holding fire with the flamethrower out"
 *  (see GameRoom's `flame` handler). Not a per-shot message; the server runs the stream while true. */
export function sendFlame(room: Room, active: boolean): void {
  room.send("flame", { active });
}

export interface TerrainInitMessage {
  width: number;
  height: number;
  data: number[];
}

/**
 * Fetches the room's current terrain bytes — request/response rather than the server pushing it
 * from onJoin, so there's no race with this client still setting up its message handler: the
 * listener below is registered before the request is sent, so the response can't arrive early and
 * get dropped. Needed because the map isn't static — a client joining after damage has already
 * been dealt must see the terrain as it currently is, not the pristine version a seed alone would
 * regenerate.
 */
export function requestTerrain(room: Room): Promise<TerrainInitMessage> {
  return new Promise((resolve) => {
    room.onMessage("terrain-init", (msg: TerrainInitMessage) => resolve(msg));
    room.send("request-terrain");
  });
}
