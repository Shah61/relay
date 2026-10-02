import { createHash } from "node:crypto";
export const defaults = {
  eventBytes: 65536,
  rawBytes: 32768,
  outputBytes: 8192,
  diffBytes: 16384,
  errorBytes: 4096,
  journalBytes: 16 * 1024 * 1024,
  eventCount: 10000,
  sessionEvents: 2000,
  eventAgeMs: 7 * 86400000,
  databaseBytes: 256 * 1024 * 1024,
  walBytes: 8 * 1024 * 1024,
  maxOperations: 100000,
  maxSessions: 10000,
  maxApprovals: 100000,
  transportBytes: 2 * 1024 * 1024,
  replayBatch: 100,
  heartbeatMs: 15000,
  gapMs: 45000,
  pendingApprovals: 32,
  sseBytes: 66560,
  sessionPage: 20,
};
export type Limits = typeof defaults;
export function limits(input: Partial<Limits> = {}): Limits {
  const out = { ...defaults, ...input };
  for (const [k, v] of Object.entries(out))
    if (!(k in defaults) || !Number.isSafeInteger(v) || v < 1)
      throw new Error(`Invalid limit ${k}`);
  if (
    out.eventBytes < 2048 ||
    out.rawBytes > out.eventBytes / 2 ||
    out.journalBytes < out.eventBytes ||
    out.databaseBytes < 1024 * 1024 ||
    out.transportBytes < out.eventBytes ||
    out.sseBytes < out.eventBytes + 1024
  )
    throw new Error("Inconsistent output/storage limits");
  return out;
}
const sensitive =
  /^(authorization|cookie|token|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credential)$/i;
export function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export function canonical(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function clip(text: string, bytes: number) {
  const b = Buffer.from(text);
  return b.length <= bytes ? text : b.subarray(0, bytes).toString("utf8");
}
export function bounded(
  value: any,
  maxBytes: number,
  policy: Limits = defaults,
): any {
  const seen = new WeakSet();
  let nodes = 0;
  function visit(v: any, key = "", depth = 0): any {
    if (sensitive.test(key)) return "[REDACTED]";
    if (++nodes > 3000 || depth > 12)
      return { truncated: true, reason: "structure_limit" };
    if (typeof v === "string") {
      const clean = v
        .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
        .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "[REDACTED]");
      const cap = /diff|patch/i.test(key)
        ? policy.diffBytes
        : /error|stack/i.test(key)
          ? policy.errorBytes
          : /output|delta|content|text/i.test(key)
            ? policy.outputBytes
            : maxBytes;
      const bytes = Buffer.byteLength(clean);
      return bytes <= cap
        ? clean
        : {
            truncated: true,
            originalBytes: bytes,
            sha256: hash(clean),
            preview: clip(clean, cap),
          };
    }
    if (!v || typeof v !== "object") return v;
    if (seen.has(v)) return "[CIRCULAR]";
    seen.add(v);
    if (Array.isArray(v)) {
      const out = v.slice(0, 256).map((x) => visit(x, key, depth + 1));
      if (v.length > 256)
        out.push({ truncated: true, originalItems: v.length });
      return out;
    }
    const out: any = {};
    const keys = Object.keys(v);
    for (const k of keys.slice(0, 256))
      Object.defineProperty(out, k, {
        value: visit(v[k], k, depth + 1),
        enumerable: true,
      });
    if (keys.length > 256) out._truncation = { originalKeys: keys.length };
    return out;
  }
  const result = visit(value);
  const json = JSON.stringify(result) ?? "null";
  if (Buffer.byteLength(json) <= maxBytes) return result;
  return {
    truncated: true,
    originalBoundedBytes: Buffer.byteLength(json),
    sha256: hash(json),
    preview: clip(json, Math.floor(maxBytes / 4)),
  };
}
