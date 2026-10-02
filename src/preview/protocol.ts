import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

export const CHUNK = 32768;
export const BODY_LIMIT = 8 * 1024 * 1024;
export const RESPONSE_LIMIT = 64 * 1024 * 1024;
export const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const blockedPorts = new Set([
  2375, 2376, 3306, 5432, 6379, 11211, 27017, 9200, 9222, 9229,
]);
export function approvedTarget(value: unknown, excluded: number[] = []) {
  if (typeof value !== "string" || value.length > 256)
    throw Error("invalid_target");
  const u = new URL(value);
  const port = Number(u.port);
  if (
    u.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(u.hostname) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/" ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    blockedPorts.has(port) ||
    excluded.includes(port)
  )
    throw Error("invalid_target");
  return { host: "127.0.0.1" as const, port };
}
export function safePath(path: unknown): asserts path is string {
  if (
    typeof path !== "string" ||
    path.length > 8192 ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[\r\n\\\0]/.test(path)
  )
    throw Error("invalid_path");
}
export function bytes(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(CHUNK / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    throw Error("invalid_chunk");
  const b = Buffer.from(value, "base64");
  if (b.length > CHUNK) throw Error("invalid_chunk");
  return b;
}
const hop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-for",
  "set-cookie",
]);
export function headers(input: unknown): Record<string, string> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Buffer.byteLength(JSON.stringify(input)) > 32768
  )
    throw Error("invalid_headers");
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    const key = name.toLowerCase();
    if (
      !/^[a-z0-9-]+$/.test(key) ||
      typeof value !== "string" ||
      /[\r\n\0]/.test(value)
    )
      throw Error("invalid_headers");
    if (
      !hop.has(key) &&
      !key.startsWith("sec-websocket-") &&
      !key.startsWith("sec-fetch-")
    )
      result[key] = value;
  }
  return result;
}
// Preview authorization never reaches the local app. Each app has a host-only cookie jar.
export function appCookies(cookie = "") {
  return cookie
    .split(";")
    .map((v) => v.trim())
    .filter((v) => v && !reservedCookie(v))
    .join("; ");
}
function reservedCookie(value: string) {
  const name = value.split("=", 1)[0].trim();
  return [
    "__Host-pm",
    "__Host-pm-preview",
    "pm_development",
    "pm_preview",
  ].includes(name);
}
export function responseCookies(input: unknown) {
  if (
    !Array.isArray(input) ||
    input.length > 50 ||
    Buffer.byteLength(JSON.stringify(input)) > 32768
  )
    throw Error("invalid_cookies");
  return input
    .filter(
      (c): c is string =>
        typeof c === "string" &&
        c.length < 8192 &&
        !/[\r\n\0]/.test(c) &&
        !reservedCookie(c),
    )
    .map((c) => c.trimStart().replace(/;\s*Domain=[^;]*/gi, ""));
}
export class Wire {
  socket: WebSocket;
  pending = new Map<
    string,
    { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  constructor(socket: WebSocket) {
    this.socket = socket;
  }
  send(value: unknown) {
    if (
      this.socket.readyState !== WebSocket.OPEN ||
      this.socket.bufferedAmount > 1048576
    )
      throw Error("preview_connection_unavailable");
    this.socket.send(JSON.stringify(value));
  }
  chunk(value: Record<string, unknown>) {
    if (this.pending.size >= 64)
      return Promise.reject(Error("preview_capacity"));
    const ack = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(ack);
        reject(Error("preview_backpressure_timeout"));
      }, 15000);
      this.pending.set(ack, { resolve, reject, timer });
      try {
        this.send({ ...value, ack });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(ack);
        reject(e);
      }
    });
  }
  acknowledge(message: any) {
    if (message.type !== "ack") return false;
    const p = this.pending.get(message.ack);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(message.ack);
      p.resolve();
    }
    return true;
  }
  close() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error("preview_disconnected"));
    }
    this.pending.clear();
  }
}
