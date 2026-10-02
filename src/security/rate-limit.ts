import { AccessError } from "./devices.ts";
export class RateLimit {
  buckets = new Map<string, { at: number; count: number }>();
  check(key: string, limit: number, windowMs = 60000) {
    const now = Date.now();
    let row = this.buckets.get(key);
    if (!row || now - row.at >= windowMs) {
      row = { at: now, count: 0 };
      this.buckets.set(key, row);
    }
    if (++row.count > limit) throw new AccessError("rate_limited", 429);
    if (this.buckets.size > 2000)
      for (const [k, r] of this.buckets)
        if (now - r.at >= windowMs) this.buckets.delete(k);
    if (this.buckets.size > 3000)
      throw new AccessError("rate_limit_capacity", 429);
  }
}
