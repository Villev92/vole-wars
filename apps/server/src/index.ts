import { createServer } from "node:http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { GameRoom } from "./GameRoom.js";

const port = Number(process.env.PORT) || 2567;
const httpServer = createServer();

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define("vole_wars", GameRoom);

await gameServer.listen(port);
console.log(`Vole Wars server listening on ws://localhost:${port}`);
