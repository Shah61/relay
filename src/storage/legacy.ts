import {
  existsSync,
  readFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import type { Store } from "./store.ts";
import type { Session } from "../agents/types.ts";
export function importLegacy(
  store: Store,
  dir: string,
  convert: (old: any) => Session,
) {
  if (store.meta("legacy_imported")) return;
  const path = existsSync(`${dir}/common-sessions.json`)
    ? `${dir}/common-sessions.json`
    : `${dir}/sessions.json`;
  const sessions: Session[] = [];
  if (existsSync(path)) {
    if (statSync(path).size > 16 * 1024 * 1024)
      throw new Error("Legacy metadata too large; offline migration required");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    for (const old of Object.values(parsed)) sessions.push(convert(old));
  }
  let sequence = 0;
  const log = `${dir}/events.jsonl`;
  if (existsSync(log)) {
    const fd = openSync(log, "r");
    try {
      const chunk = Buffer.alloc(65536);
      let pending = "";
      let n;
      while ((n = readSync(fd, chunk)) > 0) {
        pending += chunk.subarray(0, n).toString("utf8");
        let end;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (!line.trim()) continue;
          const e = JSON.parse(line);
          if (!Number.isSafeInteger(e.sequence) || e.sequence < 0)
            throw new Error("Invalid legacy sequence");
          sequence = Math.max(sequence, e.sequence);
        }
        if (Buffer.byteLength(pending) > store.policy.transportBytes)
          throw new Error("Oversized legacy event; offline migration required");
      }
      if (pending.trim())
        throw new Error(
          "Partial legacy journal tail; preserve and reconcile offline",
        );
    } finally {
      closeSync(fd);
    }
  }
  store.tx(() => {
    for (const s of sessions) {
      if (!s.id || !s.worktree || !s.process?.generation)
        throw new Error("Invalid legacy session");
      store.importSession(s);
    }
    store.setMeta("sequence", String(Math.max(sequence, store.sequence)));
    store.setMeta("pruned_through", String(store.sequence));
    store.setMeta("legacy_imported", new Date().toISOString());
    store.audit("legacy_import", null, {
      sessions: sessions.length,
      sequence,
      events:
        "Historical files untouched; legacy cursors require snapshot resync",
    });
  });
}
