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

export function sendFire(room: Room, weaponId: string): void {
  room.send("fire", { weaponId });
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
