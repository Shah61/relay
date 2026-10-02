import { request, type ClientRequest, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import type { RelayConfig } from "../relay/host.ts";
import { PreviewTargets, type Target } from "./targets.ts";
import {
  Wire,
  CHUNK,
  BODY_LIMIT,
  RESPONSE_LIMIT,
  UUID,
  bytes,
  headers,
  safePath,
  appCookies,
  responseCookies,
} from "./protocol.ts";

type Http = {
  request: ClientRequest;
  response?: IncomingMessage;
  targetId: string;
  uploaded: number;
  queue: Promise<void>;
  timer: NodeJS.Timeout;
};
type Socket = { socket: WebSocket; targetId: string; queue: Promise<void> };
export class PreviewCompanion {
  targets: PreviewTargets;
  socket?: WebSocket;
  wire?: Wire;
  config?: RelayConfig;
  retry?: NodeJS.Timeout;
  stopped = false;
  ready = false;
  requests = new Map<string, Http>();
  sockets = new Map<string, Socket>();
  constructor(targets: PreviewTargets) {
    this.targets = targets;
    targets.on("change", this.changed);
  }
  changed = (r: Target) => {
    if (r.state === "revoked") {
      for (const [id, q] of this.requests)
        if (q.targetId === r.id) this.cancel(id);
      for (const [id, q] of this.sockets)
        if (q.targetId === r.id) this.cancel(id);
      try {
        if (this.ready) this.wire?.send({ type: "revoke", localId: r.id });
      } catch {}
    } else if (r.state === "approved" && this.ready) {
      try {
        this.register(r);
      } catch {
        this.socket?.terminate();
      }
    }
  };
  register(r: Target) {
    this.wire?.send({
      type: "register",
      localId: r.id,
      sessionId: r.sessionId,
      project: r.project,
      target: `http://127.0.0.1:${r.port}`,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
    });
  }
  connect(config: RelayConfig) {
    this.disconnect();
    this.config = config;
    this.stopped = false;
    this.start();
  }
  start() {
    if (this.stopped || !this.config?.account) return;
    const ws = new WebSocket(this.config.relayUrl + "/preview-host", {
      headers: { Authorization: `Bearer ${this.config.hostToken}` },
      maxPayload: 131072,
      perMessageDeflate: false,
      handshakeTimeout: 10000,
    });
    this.socket = ws;
    const wire = new Wire(ws);
    this.wire = wire;
    let alive = true;
    ws.on("pong", () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) ws.terminate();
      else if (ws.readyState === WebSocket.OPEN) {
        alive = false;
        ws.ping();
      }
    }, 30000);
    ws.on("open", () =>
      wire.send({ type: "hello", hostId: this.config!.hostId }),
    );
    ws.on("error", () => {});
    ws.on("message", (data) => {
      if (this.socket !== ws) return;
      try {
        const m = JSON.parse(data.toString());
        if (wire.acknowledge(m)) return;
        if (m.type === "ready") {
          this.ready = true;
          for (const r of this.targets.records.values())
            if (r.state === "approved" && r.expiresAt > Date.now())
              this.register(r);
          return;
        }
        if (m.type === "registered") {
          const r = this.targets.records.get(m.localId);
          if (r?.state === "approved" && UUID.test(m.previewId))
            r.previewId = m.previewId;
          return;
        }
        if (!UUID.test(m.id ?? "")) throw Error("invalid_request");
        if (m.type === "http-open" || m.type === "ws-open") {
          try {
            this.open(m);
          } catch {
            wire.send({ type: "error", id: m.id });
          }
        } else if (m.type === "cancel") this.cancel(m.id);
        else if (m.type === "http-data" || m.type === "http-end") {
          const q = this.requests.get(m.id);
          if (!q) return;
          q.queue = q.queue
            .then(async () => {
              this.targets.active(q.targetId);
              if (m.type === "http-end") {
                q.request.end();
                return;
              }
              const b = bytes(m.data);
              q.uploaded += b.length;
              if (q.uploaded > BODY_LIMIT) throw Error("body_too_large");
              if (!q.request.write(b)) await once(q.request, "drain");
              wire.send({ type: "ack", ack: m.ack });
            })
            .catch(() => {
              this.cancel(m.id);
              try {
                wire.send({ type: "error", id: m.id });
              } catch {}
            });
        } else if (m.type === "ws-data") {
          const q = this.sockets.get(m.id);
          if (!q) return;
          q.queue = q.queue
            .then(async () => {
              this.targets.active(q.targetId);
              const b = bytes(m.data);
              await new Promise<void>((resolve, reject) =>
                q.socket.send(b, { binary: !!m.binary }, (e) =>
                  e ? reject(e) : resolve(),
                ),
              );
              wire.send({ type: "ack", ack: m.ack });
            })
            .catch(() => this.cancel(m.id));
        }
      } catch {
        ws.close(1008, "Invalid preview message");
      }
    });
    ws.on("close", () => {
      clearInterval(heartbeat);
      wire.close();
      if (this.socket !== ws) return;
      this.ready = false;
      for (const id of [...this.requests.keys(), ...this.sockets.keys()])
        this.cancel(id);
      for (const r of this.targets.records.values()) r.previewId = undefined;
      if (!this.stopped) this.retry = setTimeout(() => this.start(), 3000);
    });
  }
  open(m: any) {
    if (
      this.requests.size + this.sockets.size >= 32 ||
      this.requests.has(m.id) ||
      this.sockets.has(m.id)
    )
      throw Error("preview_capacity");
    const r = this.targets.active(m.localId);
    if (r.previewId !== m.previewId) throw Error("preview_unavailable");
    safePath(m.path);
    const origin = new URL(m.origin).origin;
    const local = `http://127.0.0.1:${r.port}`;
    const h = headers(m.headers);
    if (h.origin) h.origin = local;
    if (h.referer) h.referer = local + "/";
    if (h.cookie) h.cookie = appCookies(h.cookie);
    h.host = `127.0.0.1:${r.port}`;
    const wire = this.wire!;
    r.lastActivity = Date.now();
    if (m.type === "ws-open") {
      if (
        !Array.isArray(m.protocols) ||
        m.protocols.length > 8 ||
        m.protocols.some(
          (v: any) =>
            typeof v !== "string" || !/^[\w!#$%&'*+.^`|~-]{1,100}$/.test(v),
        )
      )
        throw Error("invalid_protocols");
      const ws = new WebSocket(
        `ws://127.0.0.1:${r.port}${m.path}`,
        m.protocols,
        {
          headers: h,
          maxPayload: CHUNK,
          perMessageDeflate: false,
          handshakeTimeout: 10000,
          followRedirects: false,
        },
      );
      this.sockets.set(m.id, {
        socket: ws,
        targetId: r.id,
        queue: Promise.resolve(),
      });
      ws.on("open", () => {
        try {
          this.targets.active(r.id);
          wire.send({ type: "ws-ready", id: m.id, protocol: ws.protocol });
        } catch {
          this.cancel(m.id);
        }
      });
      let sending = Promise.resolve();
      let queued = 0;
      ws.on("message", (data, binary) => {
        if (++queued > 32) {
          this.cancel(m.id);
          return;
        }
        ws.pause();
        sending = sending
          .then(() =>
            wire.chunk({
              type: "ws-data",
              id: m.id,
              data: Buffer.from(data as Buffer).toString("base64"),
              binary,
            }),
          )
          .then(() => {
            queued--;
            if (!queued) ws.resume();
          })
          .catch(() => this.cancel(m.id));
      });
      ws.on("error", () => {
        try {
          wire.send({ type: "error", id: m.id });
        } catch {}
        this.cancel(m.id);
      });
      ws.on("close", () => {
        this.sockets.delete(m.id);
        try {
          wire.send({ type: "end", id: m.id });
        } catch {}
      });
      return;
    }
    if (
      !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(
        m.method,
      )
    )
      throw Error("invalid_method");
    const q = request({
      hostname: "127.0.0.1",
      port: r.port,
      path: m.path,
      method: m.method,
      headers: h,
      agent: false,
    });
    const timer = setTimeout(() => {
      this.cancel(m.id);
      try {
        wire.send({ type: "error", id: m.id });
      } catch {}
    }, 300000);
    const state: Http = {
      request: q,
      targetId: r.id,
      uploaded: 0,
      queue: Promise.resolve(),
      timer,
    };
    this.requests.set(m.id, state);
    q.on("response", (response) => {
      state.response = response;
      void (async () => {
        this.targets.active(r.id);
        const out: Record<string, string> = headers(
          Object.fromEntries(
            Object.entries(response.headers).filter(
              ([, v]) => typeof v === "string",
            ),
          ),
        );
        // Loopback redirects stay on this preview. No redirect is followed on the computer.
        if (out.location) {
          const redirect = new URL(out.location, local);
          if (["localhost", "127.0.0.1"].includes(redirect.hostname)) {
            if (
              Number(redirect.port) !== r.port ||
              redirect.protocol !== "http:"
            )
              throw Error("unapproved_redirect");
            out.location =
              origin + redirect.pathname + redirect.search + redirect.hash;
          }
        }
        const cookies = responseCookies(response.headers["set-cookie"] ?? []);
        wire.send({
          type: "http-head",
          id: m.id,
          status: response.statusCode,
          headers: out,
          cookies,
        });
        let size = 0;
        for await (const data of response) {
          this.targets.active(r.id);
          const buffer = Buffer.from(data);
          size += buffer.length;
          if (
            size > RESPONSE_LIMIT &&
            !out["content-type"]?.startsWith("text/event-stream")
          )
            throw Error("response_too_large");
          for (let offset = 0; offset < buffer.length; offset += CHUNK)
            await wire.chunk({
              type: "http-data",
              id: m.id,
              data: buffer.subarray(offset, offset + CHUNK).toString("base64"),
            });
        }
        wire.send({ type: "end", id: m.id });
      })()
        .catch(() => {
          try {
            wire.send({ type: "error", id: m.id });
          } catch {}
        })
        .finally(() => this.cancel(m.id));
    });
    q.on("error", (e: any) => {
      if (e.code === "ECONNREFUSED")
        this.targets.revoke(r.id, "server_stopped");
      try {
        wire.send({ type: "error", id: m.id });
      } catch {}
      this.cancel(m.id);
    });
  }
  cancel(id: string) {
    const q = this.requests.get(id);
    if (q) {
      this.requests.delete(id);
      clearTimeout(q.timer);
      q.response?.destroy();
      q.request.destroy();
    }
    const w = this.sockets.get(id);
    if (w) {
      this.sockets.delete(id);
      w.socket.terminate();
    }
  }
  disconnect() {
    this.stopped = true;
    this.ready = false;
    clearTimeout(this.retry);
    for (const id of [...this.requests.keys(), ...this.sockets.keys()])
      this.cancel(id);
    for (const r of this.targets.records.values()) r.previewId = undefined;
    this.wire?.close();
    this.socket?.terminate();
    this.socket = undefined;
  }
  close() {
    this.disconnect();
    this.targets.off("change", this.changed);
  }
}
