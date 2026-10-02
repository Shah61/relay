import { decode, deriveKey, cipher } from "./e2e.mjs";
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
async function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("relay.computers.v1", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("computers", { keyPath: "hostId" });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}
async function records(action, value) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(
        "computers",
        action === "getAll" ? "readonly" : "readwrite",
      );
      const request = tx.objectStore("computers")[action](value);
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
export const storedComputers = () => records("getAll");
export async function forgetComputers() {
  const profiles = await records("getAll");
  for (const profile of profiles) await records("delete", profile.hostId);
}
export async function authorizedComputer(payload) {
  const profile = {
    hostId: payload.hostId,
    hostName: payload.hostName,
    relay: payload.relay,
    channelId: payload.device.id,
    key: await deriveKey(payload.secret),
  };
  await records("put", profile);
  localStorage.setItem("relay.activeComputer", profile.hostId);
}
export function parseInvitation(hash) {
  if (!hash.startsWith("#pair=")) return null;
  if (hash.length > 4096) throw Error("Invalid QR code");
  const p = JSON.parse(new TextDecoder().decode(decode(hash.slice(6))));
  const url = new URL(p.relay);
  if (
    p.v !== 1 ||
    !(
      url.protocol === "wss:" ||
      (url.protocol === "ws:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname))
    ) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !/^[a-f0-9-]{36}$/.test(p.hostId) ||
    !/^[a-f0-9-]{36}$/.test(p.channelId) ||
    !/^[A-Za-z0-9_-]{32}$/.test(p.code) ||
    typeof p.hostName !== "string" ||
    p.hostName.length > 80
  )
    throw Error("Invalid QR code");
  return p;
}
export class RelayTransport {
  constructor(profile, invite = null) {
    this.profile = profile;
    this.invite = invite;
    this.pending = new Map();
    this.connecting = null;
    this.socket = null;
    this.codec = null;
    this.sending = Promise.resolve();
  }
  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN && this.codec) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.profile.relay + "/client");
      this.socket = ws;
      let incoming = Promise.resolve();
      const timeout = setTimeout(() => {
        ws.close();
        reject(
          Error(
            "Computer unavailable. Check that it is awake and Relay is running.",
          ),
        );
      }, 12000);
      ws.onopen = () =>
        ws.send(
          JSON.stringify({
            type: "hello",
            hostId: this.profile.hostId,
            channelId: this.profile.channelId,
          }),
        );
      ws.onmessage = (event) => {
        incoming = incoming
          .then(async () => {
            const m = JSON.parse(event.data);
            if (m.type === "challenge" && !this.codec) {
              if (
                !/^[a-f0-9-]{36}$/.test(m.linkId) ||
                !/^[A-Za-z0-9_-]{43}$/.test(m.challenge)
              )
                throw Error("Invalid handshake");
              this.codec = cipher(
                this.profile.key,
                {
                  hostId: this.profile.hostId,
                  channelId: this.profile.channelId,
                  linkId: m.linkId,
                  challenge: m.challenge,
                },
                "client",
              );
              clearTimeout(timeout);
              resolve();
              return;
            }
            if (m.type !== "frame" || !this.codec)
              throw Error("Invalid response");
            const response = await this.codec.open(m.frame),
              p = this.pending.get(response.id);
            if (!p) return;
            if (response.stream === "start") {
              const stream = new ReadableStream({
                start: (c) => {
                  p.stream = c;
                },
                cancel: () => this.cancel(response.id),
              });
              p.resolve(
                new Response(stream, {
                  status: response.status,
                  headers: { "Content-Type": "text/event-stream" },
                }),
              );
            } else if (response.stream === "data") {
              if (!p.stream || p.stream.desiredSize < -128)
                throw Error("Stream consumer too slow");
              p.stream.enqueue(new TextEncoder().encode(response.chunk));
            } else if (response.stream === "end") {
              p.stream?.close();
              this.finish(response.id);
            } else {
              if (p.stream) p.stream.error(Error("Stream interrupted"));
              else p.resolve(json(response.body, response.status));
              this.finish(response.id);
            }
          })
          .catch(() => ws.close(1008, "Invalid encrypted response"));
      };
      ws.onerror = () => {};
      ws.onclose = () => {
        clearTimeout(timeout);
        if (this.socket !== ws) {
          reject(Error("Connection replaced"));
          return;
        }
        if (this.socket === ws) {
          this.socket = null;
          this.codec = null;
          this.connecting = null;
        }
        const error = Error(
          "Computer disconnected. Check pending operations before retrying.",
        );
        reject(error);
        for (const [id, p] of this.pending) {
          p.stream?.error(error);
          p.reject(error);
          this.finish(id);
        }
      };
    });
    try {
      await this.connecting;
    } catch (e) {
      this.connecting = null;
      throw e;
    }
  }
  finish(id) {
    const p = this.pending.get(id);
    p?.cleanup?.();
    this.pending.delete(id);
  }
  async send(message) {
    const socket = this.socket,
      codec = this.codec;
    const next = this.sending.then(async () => {
      if (
        !codec ||
        socket?.readyState !== WebSocket.OPEN ||
        socket !== this.socket
      )
        throw Error("Disconnected");
      const frame = await codec.seal(message);
      if (socket.bufferedAmount > 1048576) throw Error("Connection too slow");
      socket.send(JSON.stringify({ type: "frame", frame }));
    });
    this.sending = next.catch(() => {});
    return next;
  }
  cancel(id) {
    void this.send({
      id: crypto.randomUUID(),
      method: "CANCEL",
      cancel: id,
    }).catch(() => {});
    this.finish(id);
  }
  async rpc(message, signal) {
    signal?.throwIfAborted();
    await this.connect();
    signal?.throwIfAborted();
    if (this.pending.size >= 16) throw Error("Too many requests");
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => {
        const p = this.pending.get(id);
        p?.stream?.error(Error("Cancelled"));
        this.cancel(id);
        reject(signal.reason);
      };
      this.pending.set(id, {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", abort),
      });
      signal?.addEventListener("abort", abort, { once: true });
      void this.send({ ...message, id }).catch((e) => {
        this.finish(id);
        reject(e);
      });
    });
  }
  fetch = async (path, options = {}) => {
    if (this.invite) {
      if (path !== "/auth/pair")
        return json({ error: "authentication_required" }, 401);
      const input = JSON.parse(options.body ?? "{}");
      const response = await this.rpc(
        { method: "PAIR", name: input.name },
        options.signal,
      );
      if (!response.ok) return response;
      const paired = await response.json();
      const profile = {
        hostId: this.profile.hostId,
        hostName: this.profile.hostName,
        relay: this.profile.relay,
        channelId: paired.device.id,
        key: await deriveKey(paired.secret),
      };
      await records("put", profile);
      localStorage.setItem("relay.activeComputer", profile.hostId);
      this.socket?.close();
      this.socket = null;
      this.codec = null;
      this.connecting = null;
      this.profile = profile;
      this.invite = null;
      return json({ device: paired.device, csrf: paired.csrf });
    }
    const headers = new Headers(options.headers);
    const response = await this.rpc(
      {
        path,
        method: options.method ?? "GET",
        body: options.body,
        operationId: headers.get("Idempotency-Key"),
      },
      options.signal,
    );
    if (path === "/auth/logout") {
      await records("delete", this.profile.hostId);
      this.socket?.close();
    }
    return response;
  };
}
export async function browserTransport() {
  const invitation = parseInvitation(location.hash);
  if (invitation) {
    history.replaceState(null, "", location.pathname + location.search);
    const profile = { ...invitation, key: await deriveKey(invitation.code) };
    delete profile.code;
    return {
      remote: true,
      name: invitation.hostName,
      invitation: true,
      transport: new RelayTransport(profile, true),
    };
  }
  if (
    ["127.0.0.1", "localhost"].includes(location.hostname) &&
    !document.querySelector('meta[name="relay-hosted"]')
  )
    return { remote: false, transport: { fetch: fetch.bind(globalThis) } };
  const computers = await records("getAll");
  const selected =
    computers.find(
      (p) => p.hostId === localStorage.getItem("relay.activeComputer"),
    ) ?? computers[0];
  return {
    remote: true,
    computers,
    name: selected?.hostName,
    transport: selected
      ? new RelayTransport(selected)
      : {
          fetch: async () =>
            json(
              { error: "Scan a QR code from your computer to connect" },
              401,
            ),
        },
  };
}
