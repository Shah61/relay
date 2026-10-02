import { once } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/storage/store.ts";
import { bounded, defaults } from "../src/storage/bounds.ts";
import { BoundedLines } from "../src/supervision/framing.ts";
import { GapMonitor, identity, probe } from "../src/supervision/process.ts";
function setup(t: any, limits = {}) {
  const dir = mkdtempSync(join(tmpdir(), "storage-unit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "test.sqlite");
  const store = new Store(path, limits);
  t.after(() => {
    try {
      store.close();
    } catch {}
  });
  return { dir, path, store };
}
test("SQLite migrations preserve data and reject future versions without reset", (t) => {
  const { store, path } = setup(t);
  store.createOperation("migration_op", "prompt", "session", { text: "same" });
  store.db.exec(
    "DROP TABLE process_generations;DROP INDEX operations_session;PRAGMA user_version=1;",
  );
  store.close();
  const upgraded = new Store(path);
  assert.equal(upgraded.operation("migration_op").state, "received");
  assert.equal(upgraded.diagnostics().schemaVersion, 3);
  upgraded.db.exec("PRAGMA user_version=999");
  upgraded.close();
  assert.throws(() => new Store(path), /newer/);
  const direct = new DatabaseSync(path);
  assert.equal(
    (direct.prepare("SELECT count(*) n FROM operations").get() as any).n,
    1,
  );
  direct.close();
});
test("SQLite corruption and invalid operation transitions fail safely", (t) => {
  const { store, path, dir } = setup(t);
  store.createOperation("corrupt_op", "prompt", "s", {});
  store.db
    .prepare("UPDATE operations SET state='completed' WHERE id=?")
    .run("corrupt_op");
  store.close();
  assert.throws(() => new Store(path), /journal state mismatch/);
  const bad = join(dir, "bad.sqlite");
  writeFileSync(bad, "not a database");
  assert.throws(() => new Store(bad), /state preserved/);
});
test("Idempotency canonical hashes, conflicting payloads, and all crash stages", (t) => {
  const { store } = setup(t);
  for (const state of [
    "received",
    "accepted",
    "dispatched",
    "native_acknowledged",
  ] as const) {
    const id = `stage_${state}`;
    store.createOperation(id, "prompt", "s", { b: 2, a: 1 });
    assert.equal(
      store.createOperation(id, "prompt", "s", { a: 1, b: 2 }).fresh,
      false,
    );
    assert.throws(
      () => store.createOperation(id, "prompt", "s", { a: 3 }),
      /conflict/,
    );
    if (state !== "received") store.transition(id, "accepted");
    if (["dispatched", "native_acknowledged"].includes(state))
      store.transition(id, "dispatched");
    if (state === "native_acknowledged")
      store.transition(id, "native_acknowledged");
  }
  store.recoverOperations();
  assert.equal(store.operation("stage_received").state, "failed");
  assert.equal(store.operation("stage_accepted").state, "failed");
  assert.equal(store.operation("stage_dispatched").state, "delivery_uncertain");
  assert.equal(
    store.operation("stage_native_acknowledged").state,
    "delivery_uncertain",
  );
  assert.throws(
    () => store.transition("stage_dispatched", "dispatched"),
    /Invalid/,
  );
});
test("Event bounds, global/per-session retention, age expiry and monotonic sequence across reopen", (t) => {
  const { store, path } = setup(t, { eventCount: 8, sessionEvents: 3 });
  for (let i = 0; i < 10; i++)
    store.tx(() =>
      store.append({
        bridgeSessionId: "s",
        type: "tool.output",
        raw: { output: "a".repeat(100000) },
      }),
    );
  assert.equal(store.replay("s", 0).resync, true);
  const row = store.replay("s", 7);
  assert.equal(row.events.length, 3);
  assert.equal(row.events[0].raw.output.truncated, true);
  assert(
    Buffer.byteLength(JSON.stringify(row.events[0])) < defaults.eventBytes,
  );
  store.prune(Date.now() + defaults.eventAgeMs + 100);
  assert.equal(store.replay("s", 9).resync, true);
  store.close();
  const reopened = new Store(path);
  assert.equal(reopened.sequence, 10);
  reopened.tx(() => reopened.append({ bridgeSessionId: "s", raw: {} }));
  assert.equal(reopened.sequence, 11);
  reopened.close();
});
test("Durable operation capacity refuses new IDs but retains deduplication tombstones", (t) => {
  const { store } = setup(t, { maxOperations: 1 });
  store.createOperation("one_only", "prompt", "s", {});
  store.transition("one_only", "failed");
  assert.throws(
    () => store.createOperation("two_only", "prompt", "s", {}),
    /capacity/,
  );
  assert.equal(
    store.createOperation("one_only", "prompt", "s", {}).fresh,
    false,
  );
});
test("bounded payloads redact known secret fields and clearly mark truncation", () => {
  const value = bounded(
    {
      token: "secret",
      text: "Bearer abc123456 sk-abcdefghijklmnop",
      error: "e".repeat(10000),
      diff: "d".repeat(20000),
    },
    32768,
  );
  assert.equal(value.token, "[REDACTED]");
  assert(!JSON.stringify(value).includes("abc123456"));
  assert(value.error.truncated);
  assert(value.diff.truncated);
});
test("native framing handles UTF-8 chunks and refuses oversized frames without parsing", () => {
  const lines: string[] = [];
  let overflow = 0;
  const parser = new BoundedLines(
    30,
    (l) => lines.push(l),
    (n) => (overflow = n),
  );
  const input = Buffer.from('"🙂"\n');
  parser.push(input.subarray(0, 3));
  parser.push(input.subarray(3));
  assert.equal(lines[0], '"🙂"');
  parser.push(Buffer.alloc(100));
  assert(overflow >= 100);
  assert.equal(parser.buffer.length, 0);
  parser.push(Buffer.from("{}\n"));
  assert.equal(lines.length, 1);
});
test("process identity detects mismatched start fingerprint; observation-gap monitor is conservative", () => {
  const own = identity(process.pid);
  assert(own);
  assert.equal(probe(own).state, "alive_identity_match");
  assert.equal(
    probe({ ...own, fingerprint: "not this process" }).state,
    "pid_reused",
  );
  assert.equal(probe().state, "unknown");
  const gaps: number[] = [];
  const m = new GapMonitor((n) => gaps.push(n), 100, 0);
  m.tick(50);
  m.tick(500);
  m.tick(400);
  assert.deepEqual(gaps, [450, -100]);
});
test("SQLite ownership is exclusive while process lives and releases explicitly", (t) => {
  const { store, path } = setup(t);
  const release = store.claimOwner();
  const second = new Store(path);
  assert.throws(() => second.claimOwner(), /Another bridge/);
  release();
  second.claimOwner()();
  second.close();
});

test("Pre-SDK stream bound rejects oversized native output before JSON decoding", async () => {
  const { BoundedNativeStream } = await import("../src/supervision/framing.ts");
  let overflow = 0;
  const stream = new BoundedNativeStream(1024, (n) => (overflow = n));
  const error = once(stream, "error");
  stream.write(Buffer.alloc(2048));
  const [err] = await error;
  assert.match(err.message, /exceeds/);
  assert.equal(overflow, 2048);
  assert.equal(stream.readableLength, 0);
});

test("SQLite full database rolls back without delivery and marks storage failed", (t) => {
  const { store } = setup(t, { databaseBytes: 1024 * 1024 });
  assert.throws(
    () =>
      store.tx(() =>
        store.setMeta("oversized-test", "x".repeat(2 * 1024 * 1024)),
      ),
    /full/,
  );
  assert.equal(store.meta("oversized-test"), undefined);
  assert.equal(store.failed, true);
  assert.throws(
    () => store.tx(() => store.setMeta("later", "no")),
    /Storage failed/,
  );
});
test("Pinned external SQLite reader triggers a bounded WAL stop, not endless growth", (t) => {
  const { store, path } = setup(t, { walBytes: 65536 });
  store.maintenance();
  store.db.exec("PRAGMA busy_timeout=0;PRAGMA wal_autocheckpoint=0");
  const reader = new DatabaseSync(path);
  reader.exec("BEGIN");
  reader.prepare("SELECT * FROM meta").all();
  try {
    let stopped = false;
    for (let i = 0; i < 100; i++) {
      try {
        store.tx(() =>
          store.setMeta("wal-test", String(i) + "x".repeat(10000)),
        );
      } catch (e) {
        assert.match(String(e), /WAL budget/);
        stopped = true;
        break;
      }
    }
    assert(stopped);
    assert.equal(store.failed, true);
  } finally {
    reader.exec("ROLLBACK");
    reader.close();
  }
});
