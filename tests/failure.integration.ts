// REAL LOCAL FAILURE INJECTION against our HTTP/SQLite bridge with a harmless fake adapter.
// No Codex/Claude imports, model requests, or provider credentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Store } from "../src/storage/store.ts";
import { reconcile } from "../src/storage/reconcile.ts";
import { identity, probe } from "../src/supervision/process.ts";
const fixtureServer = resolve(
  import.meta.dirname,
  "fixtures/failure-server.ts",
);
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, label: string) {
  const end = Date.now() + 10000;
  while (!fn()) {
    if (Date.now() > end) throw Error(`Timeout ${label}`);
    await delay(25);
  }
}
async function setup(t: any, extra: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "bridge-failure-"));
  mkdirSync(join(dir, "fixture"));
  symlinkSync(join(dir, "fixture"), join(dir, "alias"));
  let child: ChildProcess;
  let url = "";
  const parents = new Map<number, ReturnType<typeof identity>>();
  async function launch() {
    rmSync(join(dir, "test-connection.json"), { force: true });
    child = spawn(
      process.execPath,
      ["--experimental-strip-types", fixtureServer, dir, ...extra],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr!.on("data", (b) => (stderr = (stderr + b).slice(-4000)));
    await until(() => {
      if (child.exitCode !== null)
        throw Error(`Test server exited ${child.exitCode}: ${stderr}`);
      return existsSync(join(dir, "test-connection.json"));
    }, "server listen");
    url = JSON.parse(
      readFileSync(join(dir, "test-connection.json"), "utf8"),
    ).url;
  }
  async function kill(signal: NodeJS.Signals = "SIGKILL") {
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, "exit");
      child.kill(signal);
      await done;
    }
  }
  async function request(path: string, body?: any, key: string = randomUUID()) {
    const response = await fetch(url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer failure-test-token",
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data: any = await response.json();
    return { status: response.status, data };
  }
  async function start(project = "fixture", key: string = randomUUID()) {
    const r = await request("/sessions", { project, agent: "codex" }, key);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const s = r.data.operation.result;
    parents.set(s.process.pid, s.process.identity);
    return s;
  }
  t.after(async () => {
    await kill("SIGTERM");
    for (const [pid, saved] of parents)
      if (saved && probe(saved).state === "alive_identity_match")
        process.kill(pid, "SIGTERM");
    await delay(50);
    rmSync(dir, { recursive: true, force: true });
  });
  await launch();
  return {
    dir,
    request,
    start,
    kill,
    launch,
    get url() {
      return url;
    },
    get pid() {
      return child.pid!;
    },
    parents,
  };
}
function deliveries(dir: string) {
  const path = join(dir, "test-deliveries.jsonl");
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((x) => JSON.parse(x))
    : [];
}
async function sse(url: string, id: string, cursor: number) {
  const controller = new AbortController();
  const response = await fetch(`${url}/sessions/${id}/events`, {
    headers: {
      Authorization: "Bearer failure-test-token",
      "Last-Event-ID": String(cursor),
    },
    signal: controller.signal,
  });
  return { response, controller };
}
async function frameUntil(
  response: Response,
  predicate: (data: any) => boolean,
) {
  const reader = response.body!.getReader();
  let buffer = "";
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      let timer: any;
      const item = await Promise.race([
        reader.read(),
        new Promise<never>(
          (_, reject) =>
            (timer = setTimeout(() => reject(Error("SSE timeout")), 3000)),
        ),
      ]).finally(() => clearTimeout(timer));
      if (item.done) throw Error("SSE ended early");
      buffer += Buffer.from(item.value).toString();
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (line) {
          const data = JSON.parse(line.slice(6));
          if (predicate(data)) return data;
        }
      }
    }
    throw Error("SSE no matching frame");
  } finally {
    await reader.cancel();
  }
}
test("FAILURE: kill bridge after prompt dispatch; restart/retry never duplicates native delivery", async (t) => {
  const x = await setup(t);
  const s = await x.start();
  const key = "lost_ack_prompt";
  const pending = x
    .request(`/sessions/${s.id}/prompt`, { text: "hold" }, key)
    .catch(() => null);
  await until(() => deliveries(x.dir).length === 1, "dispatch evidence");
  await x.kill();
  await pending;
  await x.launch();
  const replay = await x.request(
    `/sessions/${s.id}/prompt`,
    { text: "hold" },
    key,
  );
  assert.equal(replay.status, 409);
  assert.equal(replay.data.operation.state, "delivery_uncertain");
  assert.equal(replay.data.replayed, true);
  assert.equal(deliveries(x.dir).length, 1);
  const snapshot = (await x.request(`/sessions/${s.id}`)).data;
  assert.equal(snapshot.session.currentTurn.state, "unknown");
  assert.equal(
    snapshot.session.process.observation.state,
    "alive_identity_match",
  );
  assert.equal(snapshot.reconciliationRequired, true);
  assert(snapshot.lease);
  const conflict = await x.request("/sessions", {
    project: "alias",
    agent: "claude",
  });
  assert.equal(conflict.status, 409);
});
test("FAILURE: lost HTTP response after completed dispatch is replayed, changed payload refused", async (t) => {
  const x = await setup(t);
  const s = await x.start();
  const key = "completed_prompt";
  await x.request(`/sessions/${s.id}/prompt`, { text: "hello" }, key);
  await x.kill();
  await x.launch();
  const replay = await x.request(
    `/sessions/${s.id}/prompt`,
    { text: "hello" },
    key,
  );
  assert.equal(replay.status, 200);
  assert.equal(replay.data.replayed, true);
  assert.equal(deliveries(x.dir).length, 1);
  const conflict = await x.request(
    `/sessions/${s.id}/prompt`,
    { text: "different" },
    key,
  );
  assert.equal(conflict.status, 409);
  assert.match(conflict.data.error, /conflict/);
});
test("FAILURE: kill owned test parent; report unexpected exit without releasing worktree", async (t) => {
  const x = await setup(t);
  const s = await x.start();
  process.kill(s.process.pid, "SIGTERM");
  let snapshot: any;
  await delay(200);
  snapshot = (await x.request(`/sessions/${s.id}`)).data;
  assert.equal(snapshot.session.process.state, "exited");
  assert.equal(snapshot.session.process.expectedExit, false);
  assert.equal(snapshot.session.process.children, "unknown");
  assert(snapshot.session.process.exitedAt);
  assert(snapshot.lease);
  const prompt = await x.request(`/sessions/${s.id}/prompt`, {
    text: "unsafe",
  });
  assert.equal(prompt.status, 409);
});
test("FAILURE: conflicting prompt/close/interrupt operations and worktree starts are authoritative", async (t) => {
  const x = await setup(t);
  const starts = await Promise.all([
    x.request("/sessions", { project: "fixture", agent: "codex" }),
    x.request("/sessions", { project: "alias", agent: "claude" }),
  ]);
  assert.deepEqual(starts.map((r) => r.status).sort(), [200, 409]);
  const s = starts.find((r) => r.status === 200)!.data.operation.result;
  x.parents.set(s.process.pid, s.process.identity);
  const holding = x
    .request(`/sessions/${s.id}/prompt`, { text: "hold" }, "holding_prompt")
    .catch(() => null);
  await until(() => deliveries(x.dir).length === 1, "first prompt");
  const results = await Promise.all(
    ["prompt", "close", "interrupt"].map((op) =>
      x.request(
        `/sessions/${s.id}/${op}`,
        op === "prompt" ? { text: "second" } : {},
      ),
    ),
  );
  assert(results.every((r) => r.status === 409));
  assert.equal(deliveries(x.dir).length, 1);
  await x.kill();
  await holding;
});
test("FAILURE: duplicate approval replies and restart invalidate native callbacks", async (t) => {
  const x = await setup(t);
  const s = await x.start();
  await x.request(`/sessions/${s.id}/prompt`, { text: "approval" });
  const p = (await x.request(`/sessions/${s.id}`)).data.approvals[0];
  assert(p);
  const body = {
    approvalId: p.id,
    generation: p.generation,
    decision: "accept",
  };
  const replies = await Promise.all([
    x.request(`/sessions/${s.id}/approvals`, body),
    x.request(`/sessions/${s.id}/approvals`, { ...body, decision: "decline" }),
  ]);
  assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    readFileSync(join(x.dir, "test-decisions.jsonl"), "utf8").trim().split("\n")
      .length,
    1,
  );
  await x.request(`/sessions/${s.id}/prompt`, { text: "approval" });
  const old = (await x.request(`/sessions/${s.id}`)).data.approvals[0];
  await x.kill();
  await x.launch();
  const late = await x.request(`/sessions/${s.id}/approvals`, {
    approvalId: old.id,
    generation: old.generation,
    decision: "accept",
  });
  assert.equal(late.status, 409);
  assert.equal((await x.request(`/sessions/${s.id}`)).data.approvals.length, 0);
  const db = new Store(join(x.dir, "bridge.sqlite"));
  assert.equal(
    (
      db.db
        .prepare("SELECT status FROM approvals WHERE id=?")
        .get(old.id) as any
    ).status,
    "invalidated",
  );
  db.close();
});
test("FAILURE: crash after decision send produces uncertainty, never sends it twice", async (t) => {
  const x = await setup(t, ["--hold-decision"]);
  const s = await x.start();
  await x.request(`/sessions/${s.id}/prompt`, { text: "approval-hold" });
  const p = (await x.request(`/sessions/${s.id}`)).data.approvals[0];
  const body = {
    approvalId: p.id,
    generation: p.generation,
    decision: "accept",
  };
  const key = "uncertain_decision";
  const pending = x
    .request(`/sessions/${s.id}/approvals`, body, key)
    .catch(() => null);
  await until(
    () => existsSync(join(x.dir, "test-decisions.jsonl")),
    "decision delivered",
  );
  await x.kill();
  await pending;
  await x.launch();
  const retried = await x.request(`/sessions/${s.id}/approvals`, body, key);
  assert.equal(retried.data.operation.state, "delivery_uncertain");
  assert.equal(
    readFileSync(join(x.dir, "test-decisions.jsonl"), "utf8").trim().split("\n")
      .length,
    1,
  );
  const db = new Store(join(x.dir, "bridge.sqlite"));
  assert.equal(
    (db.db.prepare("SELECT status FROM approvals WHERE id=?").get(p.id) as any)
      .status,
    "delivery_uncertain",
  );
  db.close();
});
test("FAILURE: actual SSE disconnect/reconnect replay, retention gap and snapshot resync", async (t) => {
  const x = await setup(t);
  const s = await x.start();
  let stream = await sse(x.url, s.id, 0);
  assert.equal(stream.response.status, 200);
  const first = await frameUntil(
    stream.response,
    (e) => e.type === "session.started",
  );
  stream.controller.abort();
  await x.request(`/sessions/${s.id}/prompt`, { text: "hello" });
  stream = await sse(x.url, s.id, first.sequence);
  const replay = await frameUntil(
    stream.response,
    (e) => e.type === "turn.completed",
  );
  assert(replay.sequence > first.sequence);
  stream.controller.abort();
  await x.request(`/sessions/${s.id}/prompt`, { text: "large" });
  const expired = await sse(x.url, s.id, 0);
  assert.equal(expired.response.status, 409);
  const snapshot: any = await expired.response.json();
  assert.equal(snapshot.error, "resync_required");
  assert.equal(snapshot.session.id, s.id);
  const next = await sse(x.url, s.id, snapshot.latestEventSequence);
  const cursor = await frameUntil(
    next.response,
    (e) => !!e.latestEventSequence,
  );
  assert(cursor.latestEventSequence >= snapshot.latestEventSequence);
  next.controller.abort();
  const diag = (await x.request("/diagnostics")).data;
  assert(diag.journal.events <= 20);
  assert(diag.journal.bytes <= diag.limits.journalBytes);
});
test("FAILURE: close is not stop, safe stop records expected exit; offline reconciliation is audited", async (t) => {
  const x = await setup(t);
  const s = await x.start();
  await x.request(`/sessions/${s.id}/close`, {});
  let snap = (await x.request(`/sessions/${s.id}`)).data;
  assert.equal(snap.session.lifecycle, "closed");
  assert.equal(snap.session.process.state, "running");
  await x.request(`/sessions/${s.id}/stop`, {});
  snap = (await x.request(`/sessions/${s.id}`)).data;
  assert.equal(snap.session.process.state, "exited");
  assert.equal(snap.session.process.expectedExit, true);
  assert(snap.lease);
  await x.kill("SIGTERM");
  const db = new Store(join(x.dir, "bridge.sqlite"));
  const unlock = db.claimOwner();
  reconcile(
    db,
    s.id,
    "Test observed owned parent exit and has no spawned shell children",
  );
  assert.equal(db.lease(s.worktree), undefined);
  assert.equal(
    (
      db.db
        .prepare(
          "SELECT count(*) n FROM audit WHERE action='local_operator_reconciliation'",
        )
        .get() as any
    ).n,
    1,
  );
  unlock();
  db.close();
  await x.launch();
  const next = await x.start("alias");
  assert.notEqual(next.id, s.id);
});

test("FAILURE: SIGSTOP/SIGCONT observation gap enters reconciliation without resending prompts", async (t) => {
  const x = await setup(t);
  const s = await x.start();
  await x.request(`/sessions/${s.id}/prompt`, { text: "hello" });
  process.kill(x.pid, "SIGSTOP");
  await delay(850);
  process.kill(x.pid, "SIGCONT");
  await delay(150);
  const snapshot = (await x.request(`/sessions/${s.id}`)).data;
  assert(snapshot.reconciliationRequired);
  assert(snapshot.uncertainty.includes("observation_gap"));
  assert.equal(snapshot.session.currentTurn.state, "unknown");
  assert.equal(deliveries(x.dir).length, 1);
  assert.equal(
    (await x.request(`/sessions/${s.id}/prompt`, { text: "new" })).status,
    409,
  );
});
test("FAILURE: startup distinguishes an absent recorded parent from an unobserved exit result", async (t) => {
  const x = await setup(t);
  const s = await x.start();
  await x.kill();
  process.kill(s.process.pid, "SIGTERM");
  await until(
    () => probe(s.process.identity).state === "absent",
    "orphan parent exit",
  );
  await x.launch();
  const snapshot = (await x.request(`/sessions/${s.id}`)).data;
  assert.equal(snapshot.session.process.state, "exited");
  assert.equal(snapshot.session.process.observation.state, "absent");
  assert.equal(snapshot.session.process.exitCode, undefined);
  assert(snapshot.lease);
});
test("FAILURE: deliberately inconsistent test operation journal prevents server startup", async (t) => {
  const x = await setup(t);
  const s = await x.start();
  await x.request(
    `/sessions/${s.id}/prompt`,
    { text: "hello" },
    "corrupt_sequence",
  );
  await x.kill("SIGTERM");
  const db = new Store(join(x.dir, "bridge.sqlite"));
  db.db
    .prepare(
      "DELETE FROM operation_steps WHERE operation_id=? AND state='dispatched'",
    )
    .run("corrupt_sequence");
  db.close();
  await assert.rejects(x.launch(), /Invalid operation transition/);
});

test("FAILURE: an established SSE stream reports a gap when burst output overtakes its cursor", async (t) => {
  const x = await setup(t);
  const s = await x.start();
  const snapshot = (await x.request(`/sessions/${s.id}`)).data;
  const stream = await sse(x.url, s.id, snapshot.latestEventSequence);
  assert.equal(stream.response.status, 200);
  await x.request(`/sessions/${s.id}/prompt`, { text: "large" });
  const gap = await frameUntil(
    stream.response,
    (e) => e.error === "resync_required",
  );
  assert.equal(gap.snapshotUrl, `/sessions/${s.id}`);
  assert.equal(gap.session, undefined);
  stream.controller.abort();
  const current = (await x.request(gap.snapshotUrl)).data;
  assert(current.latestEventSequence >= gap.latestEventSequence);
});
