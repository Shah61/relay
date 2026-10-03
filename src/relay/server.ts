import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { pathToFileURL } from "node:url";
import { Accounts } from "./accounts.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PreviewRelay } from "../preview/relay.ts";

export function createRelay(token: string | Accounts, origins: string[], options: { previewOriginTemplate?: string } = {}) {
  const accounts = typeof token === "string" ? undefined : token;
  const previews = accounts && options.previewOriginTemplate ? new PreviewRelay(accounts, options.previewOriginTemplate) : undefined;
  if ((typeof token === "string" && token.length < 32) || !origins.length)
    throw Error(
      "RELAY_HOST_TOKEN (32+ characters) and FRONTEND_ORIGINS are required",
    );
  const hosts = new Map<string, WebSocket>();
  const clients = new Map<
    string,
    { socket: WebSocket; hostId: string; channelId: string }
  >();
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (previews && (await previews.handle(req, res))) return;
    if (accounts && (await accounts.handle(req, res))) return;
    res.writeHead(req.url === "/health" ? 200 : 404, {
      "Content-Type": "application/json",
    });
    res.end(
      JSON.stringify(
        req.url === "/health"
          ? { status: "ok", protocol: 1, previewHosting: !!previews }
          : { error: "not_found" },
      ),
    );
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 524288,
    perMessageDeflate: false,
  });
  const send = (ws: WebSocket, value: unknown) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1048576) {
      ws.close(1013, "Slow connection");
      return;
    }
    ws.send(JSON.stringify(value));
  };
  if (accounts) {
    accounts.online = (id) => hosts.get(id)?.readyState === WebSocket.OPEN;
    accounts.sendHost = (id, message) => {
      const ws = hosts.get(id);
      if (!ws) throw Error("computer_offline");
      send(ws, message);
    };
    accounts.revokeHost = (id) => {
      previews?.revokeComputer(id);
      hosts.get(id)?.close(1008, "Computer revoked");
    };
  }
  server.on("upgrade", (req, socket, head) => {
    if (previews?.upgrade(req, socket, head)) return;
    const host = req.url === "/host";
    const actual = Buffer.from(req.headers.authorization ?? "");
    const wanted = Buffer.from(
      `Bearer ${typeof token === "string" ? token : ""}`,
    );
    const enrolled = accounts?.hostAuth(
      String(req.headers.authorization ?? "").replace(/^Bearer /, ""),
    );
    const authorized = host
      ? !req.headers.origin &&
        (accounts
          ? !!enrolled
          : actual.length === wanted.length && timingSafeEqual(actual, wanted))
      : req.url === "/client" && origins.includes(req.headers.origin ?? "");
    if (!authorized || wss.clients.size >= 128) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, host, enrolled?.id),
    );
  });
  wss.on(
    "connection",
    (ws: WebSocket, isHost: boolean, enrolledId?: string) => {
      let hostId = "",
        linkId = "",
        initialized = false,
        alive = true,
        count = 0,
        window = Date.now();
      const timeout = setTimeout(
        () => ws.close(1008, "Handshake required"),
        10000,
      );
      ws.on("error", () => {});
      ws.on("pong", () => {
        alive = true;
      });
      const heartbeat = setInterval(() => {
        if (!alive) ws.terminate();
        else {
          alive = false;
          ws.ping();
        }
      }, 30000);
      ws.on("message", (data, binary) => {
        try {
          if (Date.now() - window > 10000) {
            window = Date.now();
            count = 0;
          }
          if (binary || ++count > (isHost ? 2000 : 200)) throw Error("rate");
          const m = JSON.parse(data.toString());
          if (!initialized) {
            if (m.type !== "hello" || !/^[a-f0-9-]{36}$/.test(m.hostId))
              throw Error("hello");
            hostId = m.hostId;
            if (isHost) {
              if (accounts && hostId !== enrolledId)
                throw Error("Credential belongs to another computer");
              if (hosts.has(hostId) || hosts.size >= 16)
                throw Error("host already connected");
              hosts.set(hostId, ws);
              send(ws, { type: "ready", protocol: 1 });
            } else {
              if (!/^[a-f0-9-]{36}$/.test(m.channelId)) throw Error("channel");
              const target = hosts.get(hostId);
              if (!target) {
                ws.close(1013, "Computer offline");
                return;
              }
              if (
                [...clients.values()].filter((c) => c.hostId === hostId)
                  .length >= 32
              )
                throw Error("capacity");
              linkId = randomUUID();
              clients.set(linkId, {
                socket: ws,
                hostId,
                channelId: m.channelId,
              });
              send(target, { type: "open", linkId, channelId: m.channelId });
            }
            initialized = true;
            clearTimeout(timeout);
            return;
          }
          if (isHost) {
            if (
              accounts &&
              ["access-challenge", "access-result", "access-error"].includes(
                m.type,
              )
            ) {
              accounts.receiveHost(hostId, m);
              return;
            }
            const client = clients.get(m.linkId);
            if (!client || client.hostId !== hostId) return;
            if (m.type === "close") client.socket.close(1008, "Channel closed");
            else if (m.type === "challenge" || m.type === "frame")
              send(client.socket, m);
            else throw Error("type");
          } else {
            if (m.type !== "frame") throw Error("type");
            const target = hosts.get(hostId);
            if (!target) {
              ws.close(1013, "Computer offline");
              return;
            }
            send(target, { type: "frame", linkId, frame: m.frame });
          }
        } catch {
          ws.close(1008, "Invalid relay message");
        }
      });
      ws.on("close", () => {
        clearTimeout(timeout);
        clearInterval(heartbeat);
        if (isHost && hosts.get(hostId) === ws) {
          hosts.delete(hostId);
          previews?.revokeComputer(hostId);
          for (const c of clients.values())
            if (c.hostId === hostId)
              c.socket.close(1013, "Computer disconnected");
        } else if (linkId) {
          clients.delete(linkId);
          const h = hosts.get(hostId);
          if (h) send(h, { type: "close", linkId });
        }
      });
    },
  );
  return {
    server,
    previews,
    close: async () => {
      previews?.close();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const origin = process.env.DASHBOARD_ORIGIN ?? "";
  const dir = process.env.RELAY_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (!dir)
    throw Error("Attach a persistent Railway volume (for example /data), or set RELAY_DATA_DIR to your persistent storage directory. Railway volume mount paths are detected automatically.");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const accounts = new Accounts(join(dir, "accounts.sqlite"), origin);
  const relay = createRelay(accounts, [origin], { previewOriginTemplate: process.env.PREVIEW_ORIGIN_TEMPLATE });
  relay.server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0", () =>
    console.log("Relay listening"),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => void relay.close());
}
