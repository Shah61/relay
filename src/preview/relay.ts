import { randomUUID, randomBytes, createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import type { Accounts } from "../relay/accounts.ts";
import {
  Wire,
  UUID,
  CHUNK,
  BODY_LIMIT,
  RESPONSE_LIMIT,
  approvedTarget,
  bytes,
  headers,
  safePath,
  appCookies,
  responseCookies,
} from "./protocol.ts";

type Preview = {
  id: string;
  localId: string;
  ownerId: string;
  computerId: string;
  sessionId: string;
  project: string;
  target: string;
  createdAt: number;
  lastActivity: number;
  expiresAt: number;
  revokedAt?: number;
};
type Grant = {
  previewId: string;
  userId: string;
  loginHash: string;
  expiresAt: number;
};
type Pending = {
  previewId: string;
  wire: Wire;
  response?: ServerResponse;
  browser?: WebSocket;
  queue: Promise<void>;
  head: boolean;
  grant: Grant;
  request?: IncomingMessage;
  timer: NodeJS.Timeout;
  queued: number;
  received: number;
  streaming: boolean;
};
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
export class PreviewRelay {
  accounts: Accounts;
  template: string;
  records = new Map<string, Preview>();
  hosts = new Map<string, { socket: WebSocket; wire: Wire }>();
  tickets = new Map<string, Grant>();
  grants = new Map<string, Grant>();
  pending = new Map<string, Pending>();
  selectedProtocols = new WeakMap<IncomingMessage, string>();
  wss = new WebSocketServer({
    noServer: true,
    maxPayload: 131072,
    perMessageDeflate: false,
  });
  apps = new WebSocketServer({
    noServer: true,
    maxPayload: CHUNK,
    perMessageDeflate: false,
    handleProtocols: (protocols, req) => {
      const selected = this.selectedProtocols.get(req);
      return selected && protocols.has(selected) ? selected : false;
    },
  });
  timer: NodeJS.Timeout;
  constructor(accounts: Accounts, template: string) {
    this.accounts = accounts;
    this.template = template;
    const u = new URL(template.replace("{id}", "test"));
    if (
      !template.includes("{id}") ||
      template.indexOf("{id}") !== template.lastIndexOf("{id}") ||
      !u.hostname.startsWith("test.") ||
      u.pathname !== "/" ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      !(
        u.protocol === "https:" ||
        (u.protocol === "http:" && u.hostname.endsWith(".localhost"))
      ) ||
      u.origin === accounts.origin ||
      new URL(accounts.origin).hostname.endsWith("." + u.hostname.slice(5))
    )
      throw Error("invalid_preview_origin_template");
    accounts.openPreview = (userId, token, id) => this.open(userId, token, id);
    this.timer = setInterval(() => this.sweep(), 5000);
    this.timer.unref();
  }
  origin(id: string) {
    return new URL(this.template.replace("{id}", id)).origin;
  }
  previewHost(req: IncomingMessage) {
    const u = new URL(this.template.replace("{id}", "test"));
    const host = req.headers.host ?? "";
    const suffix = u.host.slice(4); // includes the leading dot and optional development port
    if (!host.endsWith(suffix)) return undefined;
    const id = host.slice(0, -suffix.length);
    return UUID.test(id) && host === new URL(this.origin(id)).host
      ? id
      : "invalid";
  }
  active(id: string) {
    const p = this.records.get(id);
    if (
      !p ||
      p.revokedAt ||
      p.expiresAt <= Date.now() ||
      !this.hosts.has(p.computerId) ||
      !this.accounts.online(p.computerId)
    )
      throw Error("preview_unavailable");
    this.accounts.ownComputer(p.ownerId, p.computerId);
    approvedTarget(p.target);
    return p;
  }
  verify(g: Grant, id: string) {
    const p = this.active(id);
    const login = this.accounts.db
      .prepare("SELECT 1 FROM logins WHERE hash=? AND user_id=? AND expires>?")
      .get(g.loginHash, g.userId, Date.now());
    if (
      g.previewId !== id ||
      g.userId !== p.ownerId ||
      g.expiresAt <= Date.now() ||
      !login
    )
      throw Error("authentication_required");
    return p;
  }
  open(userId: string, token: string, id: string) {
    const p = this.active(id);
    if (p.ownerId !== userId) throw Error("preview_not_found");
    if (this.tickets.size >= 200) throw Error("preview_capacity");
    const ticket = randomBytes(32).toString("base64url");
    this.tickets.set(hash(ticket), {
      previewId: id,
      userId,
      loginHash: hash(token),
      expiresAt: Date.now() + 60000,
    });
    return { url: `${this.origin(id)}/_pm/connect?ticket=${ticket}` };
  }
  authorization(req: IncomingMessage, id: string) {
    const cookieName = this.origin(id).startsWith("https:")
      ? "__Host-pm-preview"
      : "pm_preview";
    const matches = (req.headers.cookie ?? "")
      .split(";")
      .map((v) => v.trim())
      .filter((v) => v.startsWith(cookieName + "="));
    const token =
      matches.length === 1 ? matches[0].slice(cookieName.length + 1) : "";
    const g = this.grants.get(hash(token));
    if (!g) throw Error("authentication_required");
    this.verify(g, id);
    return g;
  }
  async handle(req: IncomingMessage, res: ServerResponse) {
    const id = this.previewHost(req);
    if (id === undefined) return false;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      if (!UUID.test(id)) throw Error("preview_unavailable");
      this.active(id);
      const url = new URL(req.url ?? "/", this.origin(id));
      if (url.pathname === "/_pm/connect") {
        if (req.method !== "GET") throw Error("authentication_required");
        const key = hash(url.searchParams.get("ticket") ?? "");
        const g = this.tickets.get(key);
        this.tickets.delete(key);
        if (!g) throw Error("authentication_required");
        const p = this.verify(g, id);
        if (this.grants.size >= 500) throw Error("preview_capacity");
        const token = randomBytes(32).toString("base64url");
        const expiresAt = Math.min(Date.now() + 1800000, p.expiresAt);
        this.grants.set(hash(token), { ...g, expiresAt });
        const secure = this.origin(id).startsWith("https:");
        res.setHeader(
          "Set-Cookie",
          `${secure ? "__Host-pm-preview" : "pm_preview"}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor((expiresAt - Date.now()) / 1000)}${secure ? "; Secure" : ""}`,
        );
        res.writeHead(303, { Location: "/" }).end();
        return true;
      }
      const grant = this.authorization(req, id),
        p = this.verify(grant, id);
      this.accounts.rates.check("preview:" + grant.userId, 1200);
      if (req.headers.origin && req.headers.origin !== this.origin(id))
        throw Error("origin_forbidden");
      if (
        !["GET", "HEAD", "OPTIONS"].includes(req.method ?? "GET") &&
        req.headers.origin !== this.origin(id)
      )
        throw Error("origin_forbidden");
      const requestId = randomUUID();
      const wire = this.hosts.get(p.computerId)!.wire;
      this.track(requestId, {
        previewId: id,
        wire,
        response: res,
        request: req,
        queue: Promise.resolve(),
        head: false,
        grant,
      });
      res.on("close", () => this.cancel(requestId));
      safePath(req.url);
      const h = headers(
        Object.fromEntries(
          Object.entries(req.headers).filter(([, v]) => typeof v === "string"),
        ),
      );
      if (h.cookie) h.cookie = appCookies(h.cookie);
      wire.send({
        type: "http-open",
        id: requestId,
        localId: p.localId,
        previewId: id,
        origin: this.origin(id),
        method: req.method,
        path: req.url,
        headers: h,
      });
      let size = 0;
      for await (const data of req) {
        this.verify(grant, id);
        const buffer = Buffer.from(data);
        size += buffer.length;
        if (size > BODY_LIMIT) {
          this.cancel(requestId);
          if (!res.headersSent) res.writeHead(413).end();
          return true;
        }
        for (let offset = 0; offset < buffer.length; offset += CHUNK)
          await wire.chunk({
            type: "http-data",
            id: requestId,
            data: buffer.subarray(offset, offset + CHUNK).toString("base64"),
          });
      }
      wire.send({ type: "http-end", id: requestId });
      p.lastActivity = Date.now();
    } catch (e) {
      if (res.headersSent) res.destroy();
      else
        res
          .writeHead(
            (e as Error).message === "authentication_required" ? 401 : 404,
            { "Content-Type": "text/plain" },
          )
          .end("Preview unavailable. Open it again from Prompt Manager.");
    }
    return true;
  }
  track(
    id: string,
    p: Omit<Pending, "timer" | "queued" | "received" | "streaming">,
  ) {
    if (
      this.pending.size >= 128 ||
      [...this.pending.values()].filter(
        (q) =>
          this.records.get(q.previewId)?.computerId ===
          this.records.get(p.previewId)?.computerId,
      ).length >= 32
    )
      throw Error("preview_capacity");
    const timer = setTimeout(
      () => this.fail(id),
      p.response
        ? 300000
        : Math.max(1, Math.min(1800000, p.grant.expiresAt - Date.now())),
    );
    this.pending.set(id, {
      ...p,
      timer,
      queued: 0,
      received: 0,
      streaming: false,
    });
  }
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    if (req.url === "/preview-host" && this.previewHost(req) === undefined) {
      const computer = this.accounts.hostAuth(
        String(req.headers.authorization ?? "").replace(/^Bearer /, ""),
      );
      if (
        !computer ||
        req.headers.origin ||
        this.hosts.has(computer.id) ||
        this.hosts.size >= 16
      ) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return true;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) =>
        this.host(ws, computer.id, computer.user_id),
      );
      return true;
    }
    const id = this.previewHost(req);
    if (id === undefined) return false;
    try {
      const grant = this.authorization(req, id),
        p = this.verify(grant, id);
      if (
        req.headers.origin !== this.origin(id) ||
        this.apps.clients.size >= 128
      )
        throw Error("origin_forbidden");
      safePath(req.url);
      const protocols = String(req.headers["sec-websocket-protocol"] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (
        protocols.length > 8 ||
        protocols.some((v) => !/^[\w!#$%&'*+.^`|~-]{1,100}$/.test(v))
      )
        throw Error("invalid_protocols");
      const requestId = randomUUID(),
        wire = this.hosts.get(p.computerId)!.wire;
      // Track before opening; accept the browser only after the local app accepts.
      this.track(requestId, {
        previewId: id,
        wire,
        queue: Promise.resolve(),
        head: false,
        grant,
      });
      const handshake = setTimeout(() => {
        socket.destroy();
        this.cancel(requestId);
      }, 10000);
      socket.on("close", () => {
        clearTimeout(handshake);
        if (!this.pending.get(requestId)?.browser) this.cancel(requestId);
      });
      const ready = (m: any) => {
        if (m.id !== requestId || m.type !== "ws-ready") return;
        clearTimeout(handshake);
        try {
          this.verify(grant, id);
          if (m.protocol && !protocols.includes(m.protocol))
            throw Error("invalid_protocol");
          this.selectedProtocols.set(req, m.protocol || "");
          this.apps.handleUpgrade(req, socket, head, (browser) => {
            const q = this.pending.get(requestId);
            if (!q) {
              browser.terminate();
              return;
            }
            q.browser = browser;
            let sending = Promise.resolve();
            let queued = 0;
            browser.on("error", () => this.cancel(requestId));
            browser.on("close", () => this.cancel(requestId));
            browser.on("message", (data, binary) => {
              if (++queued > 32) {
                this.fail(requestId);
                return;
              }
              browser.pause();
              sending = sending
                .then(() => {
                  this.verify(grant, id);
                  return wire.chunk({
                    type: "ws-data",
                    id: requestId,
                    data: Buffer.from(data as Buffer).toString("base64"),
                    binary,
                  });
                })
                .then(() => {
                  queued--;
                  if (!queued) browser.resume();
                })
                .catch(() => this.fail(requestId));
            });
          });
        } catch {
          socket.destroy();
          this.cancel(requestId);
        }
      };
      const host = this.hosts.get(p.computerId)!.socket;
      const listener = (data: any) => {
        try {
          ready(JSON.parse(data.toString()));
        } catch {}
      };
      host.on("message", listener);
      socket.on("close", () => host.off("message", listener));
      const h = headers(
        Object.fromEntries(
          Object.entries(req.headers).filter(([, v]) => typeof v === "string"),
        ),
      );
      if (h.cookie) h.cookie = appCookies(h.cookie);
      wire.send({
        type: "ws-open",
        id: requestId,
        localId: p.localId,
        previewId: id,
        origin: this.origin(id),
        path: req.url,
        headers: h,
        protocols,
      });
    } catch {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
    return true;
  }
  host(ws: WebSocket, computerId: string, ownerId: string) {
    const wire = new Wire(ws);
    let initialized = false;
    let alive = true;
    const timeout = setTimeout(() => ws.close(1008), 10000);
    const heartbeat = setInterval(() => {
      if (!alive) ws.terminate();
      else {
        alive = false;
        ws.ping();
      }
    }, 30000);
    ws.on("pong", () => {
      alive = true;
    });
    ws.on("error", () => {});
    ws.on("message", (data) => {
      try {
        const m = JSON.parse(data.toString());
        if (!initialized) {
          if (
            m.type !== "hello" ||
            m.hostId !== computerId ||
            this.hosts.has(computerId) ||
            !this.accounts.online(computerId)
          )
            throw Error("invalid_hello");
          this.hosts.set(computerId, { socket: ws, wire });
          initialized = true;
          clearTimeout(timeout);
          wire.send({ type: "ready" });
          return;
        }
        if (wire.acknowledge(m)) return;
        if (m.type === "register") {
          if (
            !UUID.test(m.localId) ||
            !UUID.test(m.sessionId) ||
            typeof m.project !== "string" ||
            m.project.length > 256 ||
            !Number.isSafeInteger(m.createdAt) ||
            !Number.isSafeInteger(m.expiresAt) ||
            m.expiresAt <= Date.now() ||
            m.expiresAt > Date.now() + 3605000
          )
            throw Error("invalid_registration");
          approvedTarget(m.target);
          const existing = [...this.records.values()].find(
            (p) =>
              p.computerId === computerId &&
              p.localId === m.localId &&
              !p.revokedAt,
          );
          if (existing) {
            if (
              existing.target !== m.target ||
              existing.sessionId !== m.sessionId
            )
              throw Error("target_changed");
            wire.send({
              type: "registered",
              localId: m.localId,
              previewId: existing.id,
            });
            return;
          }
          if (
            [...this.records.values()].filter(
              (p) => p.computerId === computerId && !p.revokedAt,
            ).length >= 32
          )
            throw Error("preview_capacity");
          const id = randomUUID();
          this.records.set(id, {
            id,
            localId: m.localId,
            ownerId,
            computerId,
            sessionId: m.sessionId,
            project: m.project,
            target: m.target,
            createdAt: m.createdAt,
            expiresAt: m.expiresAt,
            lastActivity: Date.now(),
          });
          wire.send({ type: "registered", localId: m.localId, previewId: id });
          return;
        }
        if (m.type === "revoke") {
          for (const p of this.records.values())
            if (p.computerId === computerId && p.localId === m.localId)
              this.revoke(p.id);
          return;
        }
        const q = this.pending.get(m.id),
          p = q && this.records.get(q.previewId);
        if (!q || p?.computerId !== computerId || q.wire !== wire) return;
        if (m.type === "ws-ready") return; // The pending upgrade listener handles this.
        if (++q.queued > 64) throw Error("preview_backpressure");
        q.queue = q.queue
          .then(async () => {
            this.verify(q.grant, q.previewId);
            p!.lastActivity = Date.now();
            if (m.type === "http-head" && q.response && !q.head) {
              if (
                !Number.isInteger(m.status) ||
                m.status < 200 ||
                m.status > 599 ||
                !Array.isArray(m.cookies) ||
                m.cookies.length > 50
              )
                throw Error("invalid_response");
              const h = headers(m.headers);
              // Untrusted app responses cannot set dashboard/preview authentication cookies.
              const cookies = responseCookies(m.cookies);
              q.response.writeHead(m.status, {
                ...h,
                "Cache-Control": "no-store",
                "Referrer-Policy": "no-referrer",
                ...(cookies.length ? { "Set-Cookie": cookies } : {}),
              });
              q.response.flushHeaders();
              q.head = true;
              q.streaming =
                h["content-type"]?.startsWith("text/event-stream") ?? false;
            } else if (m.type === "http-data" && q.response && q.head) {
              const buffer = bytes(m.data);
              q.received += buffer.length;
              if (!q.streaming && q.received > RESPONSE_LIMIT)
                throw Error("response_too_large");
              if (!q.response.write(buffer)) await once(q.response, "drain");
              wire.send({ type: "ack", ack: m.ack });
            } else if (m.type === "ws-data" && q.browser) {
              await new Promise<void>((resolve, reject) =>
                q.browser!.send(bytes(m.data), { binary: !!m.binary }, (e) =>
                  e ? reject(e) : resolve(),
                ),
              );
              wire.send({ type: "ack", ack: m.ack });
            } else if (m.type === "end") {
              q.response?.end();
              q.browser?.close();
              this.cancel(m.id);
            } else if (m.type === "error") this.fail(m.id);
            else throw Error("invalid_message");
          })
          .catch(() => this.fail(m.id))
          .finally(() => {
            q.queued--;
          });
      } catch {
        ws.close(1008, "Invalid preview message");
      }
    });
    ws.on("close", () => {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      wire.close();
      if (this.hosts.get(computerId)?.socket === ws) {
        this.hosts.delete(computerId);
        for (const p of this.records.values())
          if (p.computerId === computerId) this.revoke(p.id);
      }
    });
  }
  cancel(id: string) {
    const q = this.pending.get(id);
    if (!q) return;
    this.pending.delete(id);
    clearTimeout(q.timer);
    try {
      q.wire.send({ type: "cancel", id });
    } catch {}
  }
  fail(id: string) {
    const q = this.pending.get(id);
    if (!q) return;
    if (q.response) {
      if (q.response.headersSent) q.response.destroy();
      else q.response.writeHead(502).end("Preview connection unavailable.");
    }
    q.browser?.terminate();
    this.cancel(id);
  }
  revoke(id: string) {
    const p = this.records.get(id);
    if (!p) return;
    p.revokedAt = Date.now();
    for (const [requestId, q] of this.pending)
      if (q.previewId === id) this.fail(requestId);
    for (const [key, g] of [...this.grants, ...this.tickets])
      if (g.previewId === id) {
        this.grants.delete(key);
        this.tickets.delete(key);
      }
  }
  revokeComputer(id: string) {
    this.hosts.get(id)?.socket.terminate();
    for (const p of this.records.values())
      if (p.computerId === id) this.revoke(p.id);
  }
  sweep() {
    for (const p of this.records.values()) {
      if (!p.revokedAt && p.expiresAt <= Date.now()) this.revoke(p.id);
      if (p.revokedAt && p.revokedAt < Date.now() - 60000)
        this.records.delete(p.id);
    }
    for (const [key, g] of this.tickets)
      if (g.expiresAt <= Date.now()) this.tickets.delete(key);
    for (const [key, g] of this.grants) {
      try {
        this.verify(g, g.previewId);
      } catch {
        this.grants.delete(key);
      }
    }
    for (const [id, q] of this.pending) {
      try {
        this.verify(q.grant, q.previewId);
      } catch {
        this.fail(id);
      }
    }
  }
  close() {
    clearInterval(this.timer);
    for (const id of this.pending.keys()) this.fail(id);
    for (const ws of this.wss.clients) ws.terminate();
    for (const ws of this.apps.clients) ws.terminate();
    this.wss.close();
    this.apps.close();
  }
}
