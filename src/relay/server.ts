import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { pathToFileURL } from "node:url";

export function createRelay(token: string, origins: string[]) {
  if (token.length < 32 || !origins.length)
    throw Error(
      "RELAY_HOST_TOKEN (32+ characters) and FRONTEND_ORIGINS are required",
    );
  const hosts = new Map<string, WebSocket>();
  const clients = new Map<
    string,
    { socket: WebSocket; hostId: string; channelId: string }
  >();
  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.writeHead(req.url === "/health" ? 200 : 404, {
      "Content-Type": "application/json",
    });
    res.end(
      JSON.stringify(
        req.url === "/health"
          ? { status: "ok", protocol: 1 }
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
  server.on("upgrade", (req, socket, head) => {
    const host = req.url === "/host";
    const actual = Buffer.from(req.headers.authorization ?? "");
    const wanted = Buffer.from(`Bearer ${token}`);
    const authorized = host
      ? !req.headers.origin &&
        actual.length === wanted.length &&
        timingSafeEqual(actual, wanted)
      : req.url === "/client" && origins.includes(req.headers.origin ?? "");
    if (!authorized || wss.clients.size >= 128) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, host),
    );
  });
  wss.on("connection", (ws: WebSocket, isHost: boolean) => {
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
              [...clients.values()].filter((c) => c.hostId === hostId).length >=
              32
            )
              throw Error("capacity");
            linkId = randomUUID();
            clients.set(linkId, { socket: ws, hostId, channelId: m.channelId });
            send(target, { type: "open", linkId, channelId: m.channelId });
          }
          initialized = true;
          clearTimeout(timeout);
          return;
        }
        if (isHost) {
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
        for (const c of clients.values())
          if (c.hostId === hostId)
            c.socket.close(1013, "Computer disconnected");
      } else if (linkId) {
        clients.delete(linkId);
        const h = hosts.get(hostId);
        if (h) send(h, { type: "close", linkId });
      }
    });
  });
  return {
    server,
    close: async () => {
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
  const relay = createRelay(
    process.env.RELAY_HOST_TOKEN ?? "",
    (process.env.FRONTEND_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  relay.server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0", () =>
    console.log("Relay listening"),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => void relay.close());
}
