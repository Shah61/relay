import {
  randomUUID,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHash,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import QRCode from "qrcode";
import { DeviceAuth } from "../security/devices.ts";
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { AccountKey } from './accounts.ts';
// @ts-ignore Shared Web Crypto module.
import { wrapAccess } from '../../web/access-crypto.mjs';
// @ts-ignore Shared browser module uses native Web Crypto on Node 22.
import { cipher, deriveKey } from "../../web/e2e.mjs";

export type RelayConfig = {
  hostId: string;
  hostName: string;
  relayUrl: string;
  frontendUrl: string;
  hostToken: string;
  account?: AccountKey;
};
type Link = {
  channelId: string;
  secret: string;
  invite: boolean;
  cipher: any;
  receiving: Promise<void>;
  sending: Promise<void>;
  requests: Map<string, AbortController>;
};
export function allowedRemotePath(path: string, method: string) {
  if (method === "GET")
    return /^\/(?:auth\/me|api\/(?:contract|projects|agents|health|diagnostics|devices|approvals|sessions(?:\/[a-f0-9-]+(?:\/events)?)?|operations\/[a-zA-Z0-9_-]{8,80}))(?:\?(?:after|offset)=\d+)?$/.test(
      path,
    );
  return (
    method === "POST" &&
    /^\/(?:auth\/logout|api\/(?:sessions(?:\/[a-f0-9-]+\/(?:prompt|queue|steer|interrupt|approvals|stop|close|resume))?|devices\/[a-f0-9-]+\/revoke))$/.test(
      path,
    )
  );
}
export class RelayHost {
  auth: DeviceAuth;
  dir: string;
  gateway: string;
  config?: RelayConfig;
  socket?: WebSocket;
  state = "not_configured";
  stopped = false;
  retry?: NodeJS.Timeout;
  attempts = 0;
  links = new Map<string, Link>();
  invites = new Map<string, { code: string; expiresAt: number }>();
  secrets: Record<string, string> = {};
  master: Buffer;
  managed = false;
  accessRequests = new Map<string, { publicKey: string; challenge: string; expires: number }>();
  constructor(
    auth: DeviceAuth,
    dir: string,
    gateway: string,
    rootToken: string,
    managed = false,
  ) {
    this.auth = auth;
    this.managed = managed;
    this.dir = dir;
    this.gateway = gateway;
    this.master = createHash("sha256")
      .update("relay-at-rest-v1:" + rootToken)
      .digest();
    const file = join(dir, "relay-devices.json");
    if (existsSync(file)) {
      const sealed = JSON.parse(readFileSync(file, "utf8"));
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.master,
        Buffer.from(sealed.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
      this.secrets = JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(sealed.data, "base64")),
          decipher.final(),
        ]).toString(),
      );
    }
    if (!managed && existsSync(join(dir, "relay.json")))
      this.config = this.validate(
        JSON.parse(readFileSync(join(dir, "relay.json"), "utf8")),
      );
    auth.on("revoke", this.revoked);
  }
  revoked = (id: string) => {
    // The next message and every open stream also recheck authorization.
    delete this.secrets[id];
    this.saveSecrets();
    setTimeout(() => {
      for (const [linkId, link] of this.links)
        if (link.channelId === id) this.drop(linkId);
    }, 50).unref();
  };
  validate(input: any): RelayConfig {
    const relay = new URL(input.relayUrl),
      frontend = new URL(input.frontendUrl);
    const local = (u: URL) => ["127.0.0.1", "localhost"].includes(u.hostname);
    if (
      !(
        ["wss:"].includes(relay.protocol) ||
        (relay.protocol === "ws:" && local(relay))
      ) ||
      !(
        frontend.protocol === "https:" ||
        (frontend.protocol === "http:" && local(frontend))
      ) ||
      relay.username ||
      relay.password ||
      relay.search ||
      relay.hash ||
      !["/", ""].includes(relay.pathname) ||
      frontend.username ||
      frontend.password ||
      frontend.search ||
      frontend.hash ||
      frontend.pathname !== "/"
    )
      throw Error(
        "Use the relay wss:// origin and the dashboard https:// origin",
      );
    if (
      typeof input.hostToken !== "string" ||
      input.hostToken.length < 32 ||
      input.hostToken.length > 256 ||
      /[\r\n]/.test(input.hostToken)
    )
      throw Error("Invalid host enrollment token");
    if (
      typeof input.hostName !== "string" ||
      !input.hostName.trim() ||
      input.hostName.length > 80
    )
      throw Error("Computer name is required");
    return {
      hostId: /^[a-f0-9-]{36}$/.test(input.hostId ?? "")
        ? input.hostId
        : (this.config?.hostId ?? randomUUID()),
      hostName: input.hostName.trim(),
      relayUrl: relay.origin,
      frontendUrl: frontend.origin,
      hostToken: input.hostToken,
      ...(input.account ? { account: input.account } : {}),
    };
  }
  atomic(name: string, value: unknown) {
    const file = join(this.dir, name);
    writeFileSync(file + ".tmp", JSON.stringify(value), { mode: 0o600 });
    renameSync(file + ".tmp", file);
  }
  saveSecrets() {
    const iv = randomBytes(12),
      seal = createCipheriv("aes-256-gcm", this.master, iv);
    const data = Buffer.concat([
      seal.update(JSON.stringify(this.secrets)),
      seal.final(),
    ]);
    this.atomic("relay-devices.json", {
      iv: iv.toString("base64"),
      tag: seal.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    });
  }
  configure(input: unknown) {
    const config = this.validate(input);
    this.disconnect();
    this.config = config;
    if (!this.managed) this.atomic("relay.json", config);
    this.start();
    return this.status();
  }
  status() {
    return {
      state: this.state,
      hostName: this.config?.hostName,
      hostId: this.config?.hostId,
      relayUrl: this.config?.relayUrl,
      frontendUrl: this.config?.frontendUrl,
    };
  }
  async accountAccess(message: any) {
    const account = this.config?.account;
    if (!account || !this.config || !/^[a-f0-9-]{36}$/.test(message.id)) throw Error('Account access unavailable');
    for (const [id, request] of this.accessRequests) if (request.expires < Date.now()) this.accessRequests.delete(id);
    if (message.type === 'access-start') {
      if (message.ownerId !== account.ownerId || typeof message.publicKey !== 'string' || !/^[A-Za-z0-9_-]{87}$/.test(message.publicKey) || this.accessRequests.size >= 20 || this.accessRequests.has(message.id)) throw Error('Invalid access request');
      // The fresh challenge binds this exact computer, request and ephemeral encryption key.
      const challenge = createHash('sha256').update(JSON.stringify(['pm-access-v1', this.config.hostId, message.id, message.publicKey, randomBytes(32).toString('base64url')])).digest('base64url');
      this.accessRequests.set(message.id, { publicKey: message.publicKey, challenge, expires: Date.now() + 120000 });
      this.send({ type: 'access-challenge', id: message.id, options: { challenge, rpId: account.rpId, allowCredentials: [{ type: 'public-key', id: account.id }], timeout: 90000, userVerification: 'required' } });
    } else {
      const request = this.accessRequests.get(message.id); this.accessRequests.delete(message.id);
      if (!request || request.expires < Date.now()) throw Error('Access request expired');
      const check = await verifyAuthenticationResponse({ response: message.response, expectedChallenge: request.challenge, expectedOrigin: account.origin, expectedRPID: account.rpId, requireUserVerification: true, credential: { id: account.id, publicKey: Buffer.from(account.publicKey, 'base64url'), counter: 0 } });
      if (!check.verified) throw Error('Passkey verification failed');
      if (!this.auth.projects.length) throw Error('Choose at least one local project first');
      const invitation = this.auth.pairing('operator', this.auth.projects), paired = this.auth.exchange(invitation.code, 'Account-authorized browser');
      this.secrets[paired.device.id] = paired.secret;
      try { this.saveSecrets(); } catch (e) { this.auth.revoke(paired.device.id); throw e; }
      const encrypted = await wrapAccess(request.publicKey, `${this.config.hostId}:${message.id}`, { ...paired, hostId: this.config.hostId, hostName: this.config.hostName, relay: this.config.relayUrl });
      this.send({ type: 'access-result', id: message.id, encrypted });
    }
  }
  async invitation(role: "operator" | "viewer", projects: string[]) {
    if (!this.config || this.state !== "connected")
      throw Error("Connect the relay before pairing a phone");
    if (!["operator", "viewer"].includes(role))
      throw Error("Remote pairing supports operator or viewer");
    const pair = this.auth.pairing(role, projects);
    for (const [id, invite] of this.invites)
      if (invite.expiresAt < Date.now()) this.invites.delete(id);
    this.invites.set(pair.id, pair);
    const payload = {
      v: 1,
      relay: this.config.relayUrl,
      hostId: this.config.hostId,
      hostName: this.config.hostName,
      channelId: pair.id,
      code: pair.code,
    };
    const url = `${this.config.frontendUrl}/#pair=${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    return {
      id: pair.id,
      expiresAt: pair.expiresAt,
      role,
      projects,
      url,
      qr: await QRCode.toDataURL(url, {
        width: 360,
        margin: 3,
        errorCorrectionLevel: "M",
        color: { dark: "#30164fff", light: "#ffffffff" },
      }),
    };
  }
  cancel(id: string) {
    this.invites.delete(id);
    this.auth.store.tx(() =>
      this.auth.store.db
        .prepare(
          "DELETE FROM device_pairings WHERE id=? AND consumed_at IS NULL",
        )
        .run(id),
    );
    for (const [linkId, link] of this.links)
      if (link.channelId === id) this.drop(linkId);
  }
  send(value: unknown) {
    if (this.socket?.readyState !== WebSocket.OPEN)
      throw Error("Relay disconnected");
    if (this.socket.bufferedAmount > 1048576) {
      this.socket.terminate();
      throw Error("Relay backpressure");
    }
    this.socket.send(JSON.stringify(value));
  }
  drop(id: string) {
    const link = this.links.get(id);
    if (!link) return;
    this.links.delete(id);
    for (const request of link.requests.values()) request.abort();
    try {
      this.send({ type: "close", linkId: id });
    } catch {}
  }
  reply(id: string, value: any) {
    const link = this.links.get(id);
    if (!link) return Promise.resolve();
    const next = link.sending.then(async () => {
      const frame = await link.cipher.seal(value);
      if (this.links.get(id) === link)
        this.send({ type: "frame", linkId: id, frame });
    });
    link.sending = next.catch(() => this.drop(id));
    return next;
  }
  async open(linkId: string, channelId: string) {
    const socket = this.socket;
    if (!this.config || this.links.size >= 32 || this.links.has(linkId))
      throw Error("Capacity");
    const invitation = this.invites.get(channelId);
    const secret =
      invitation && invitation.expiresAt > Date.now()
        ? invitation.code
        : this.secrets[channelId];
    if (!secret) throw Error("Unknown channel");
    if (!invitation) this.auth.get(secret);
    const challenge = randomBytes(32).toString("base64url");
    const codec = cipher(
      await deriveKey(secret),
      { hostId: this.config.hostId, channelId, linkId, challenge },
      "host",
    );
    if (socket !== this.socket || socket?.readyState !== WebSocket.OPEN) return;
    this.links.set(linkId, {
      channelId,
      secret,
      invite: !!invitation,
      cipher: codec,
      receiving: Promise.resolve(),
      sending: Promise.resolve(),
      requests: new Map(),
    });
    this.send({ type: "challenge", linkId, challenge });
  }
  async request(linkId: string, m: any) {
    const link = this.links.get(linkId);
    if (!link) return;
    if (!m || typeof m.id !== "string" || !/^[a-f0-9-]{36}$/.test(m.id))
      throw Error("Invalid request");
    if (link.invite) {
      const invitation = this.invites.get(link.channelId);
      if (
        m.method !== "PAIR" ||
        !invitation ||
        invitation.expiresAt <= Date.now()
      )
        throw Error("Invalid invitation");
      const paired = this.auth.exchange(invitation.code, m.name);
      this.invites.delete(link.channelId);
      this.secrets[paired.device.id] = paired.secret;
      try {
        this.saveSecrets();
      } catch (e) {
        this.auth.revoke(paired.device.id);
        throw e;
      }
      await this.reply(linkId, { id: m.id, status: 200, body: paired });
      return;
    }
    this.auth.get(link.secret);
    if (m.method === "CANCEL") {
      link.requests.get(m.cancel)?.abort();
      return;
    }
    if (
      typeof m.path !== "string" ||
      !allowedRemotePath(m.path, m.method) ||
      link.requests.size >= 8 ||
      link.requests.has(m.id)
    )
      throw Error("Forbidden request");
    if (
      m.body !== undefined &&
      (typeof m.body !== "string" || m.body.length > 32768)
    )
      throw Error("Body too large");
    const controller = new AbortController();
    link.requests.set(m.id, controller);
    // Handle requests concurrently: a long-lived SSE request must not block commands.
    void (async () => {
      const expiry = setInterval(() => {
        try {
          this.auth.get(link.secret);
        } catch {
          controller.abort();
        }
      }, 10000);
      const deadline = setTimeout(
        () => controller.abort(),
        m.path.includes("/events") ? 3600000 : 35000,
      );
      try {
        const headers: Record<string, string> = {
          Cookie: `relay_local=${link.secret}`,
          Origin: this.gateway,
          "X-CSRF-Token": this.auth.csrf(link.secret),
          "Content-Type": "application/json",
        };
        if (
          typeof m.operationId === "string" &&
          /^[a-zA-Z0-9_-]{8,80}$/.test(m.operationId)
        )
          headers["Idempotency-Key"] = m.operationId;
        const response = await fetch(this.gateway + m.path, {
          method: m.method,
          headers,
          body: m.method === "POST" ? m.body : undefined,
          signal: controller.signal,
          redirect: "error",
        });
        if (
          response.headers
            .get("content-type")
            ?.startsWith("text/event-stream") &&
          response.body
        ) {
          await this.reply(linkId, {
            id: m.id,
            status: response.status,
            stream: "start",
          });
          const reader = response.body.getReader(),
            decoder = new TextDecoder();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              for (let offset = 0; offset < value.length; offset += 32768)
                await this.reply(linkId, {
                  id: m.id,
                  stream: "data",
                  chunk: decoder.decode(
                    value.subarray(offset, offset + 32768),
                    { stream: true },
                  ),
                });
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
          await this.reply(linkId, { id: m.id, stream: "end" });
        } else {
          const text = await response.text();
          if (Buffer.byteLength(text, "utf8") > 250000)
            throw Error("Response too large");
          const body = JSON.parse(text);
          if (m.path === "/auth/me" && response.ok)
            body.transport = "encrypted_relay";
          await this.reply(linkId, { id: m.id, status: response.status, body });
        }
      } catch {
        await this.reply(linkId, {
          id: m.id,
          status: 502,
          error: true,
          body: {
            error: "connection_interrupted",
            message:
              "Connection interrupted. Check pending operations before retrying.",
          },
        }).catch(() => {});
      } finally {
        clearInterval(expiry);
        clearTimeout(deadline);
        link.requests.delete(m.id);
      }
    })();
  }
  start() {
    if (!this.config || this.stopped) return;
    this.state = "connecting";
    const ws = new WebSocket(this.config.relayUrl + "/host", {
      headers: { Authorization: `Bearer ${this.config.hostToken}` },
      maxPayload: 524288,
      perMessageDeflate: false,
      handshakeTimeout: 10000,
    });
    this.socket = ws;
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
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", hostId: this.config!.hostId }));
    });
    ws.on("error", () => {});
    ws.on("message", (data) => {
      if (this.socket !== ws) return;
      try {
        const m = JSON.parse(data.toString());
        if (['access-start', 'access-finish'].includes(m.type)) {
          void this.accountAccess(m).catch(() => { try { this.send({ type: 'access-error', id: m.id }); } catch {} });
          return;
        }
        if (m.type === "ready") {
          this.state = "connected";
          this.attempts = 0;
        } else if (m.type === "open")
          void this.open(m.linkId, m.channelId).catch(() => {
            try {
              this.send({ type: "close", linkId: m.linkId });
            } catch {}
          });
        else if (m.type === "close") this.drop(m.linkId);
        else if (m.type === "frame") {
          const link = this.links.get(m.linkId);
          if (!link) return;
          link.receiving = link.receiving
            .then(async () =>
              this.request(m.linkId, await link.cipher.open(m.frame)),
            )
            .catch(() => this.drop(m.linkId));
        }
      } catch {
        ws.terminate();
      }
    });
    ws.on("close", () => {
      clearInterval(heartbeat);
      if (this.socket !== ws) return;
      this.state = "offline";
      for (const id of this.links.keys()) this.drop(id);
      if (!this.stopped)
        this.retry = setTimeout(
          () => this.start(),
          Math.min(30000, 1000 * 2 ** Math.min(this.attempts++, 5)) +
            Math.random() * 500,
        );
    });
  }
  disconnect() {
    clearTimeout(this.retry);
    for (const id of this.links.keys()) this.drop(id);
    const ws = this.socket;
    this.socket = undefined;
    ws?.close();
    this.state = "offline";
  }
  stop() {
    this.stopped = true;
    this.disconnect();
    this.auth.off("revoke", this.revoked);
  }
}
