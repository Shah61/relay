import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sessions } from "../src/codex/sessions.ts";
import { Codex } from "../src/codex/protocol.ts";
import { normalize } from "../src/events/events.ts";
class Fake extends EventEmitter {
  closed = false;
  sent: any[] = [];
  calls: any[] = [];
  handler: Function = async () => ({ thread: { id: "thread-1" } });
  request(m: string, p: any) {
    this.calls.push({ m, p });
    return this.handler(m, p);
  }
  send(m: any) {
    this.sent.push(m);
  }
}
function setup(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "bridge-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const c = new Fake();
  const s = new Sessions(c as unknown as Codex, dir, { fixture: "/fixture" });
  return { c, s, dir };
}
test("allowlist, early thread notification, persistence and monotonic sequence", async (t) => {
  const { c, s, dir } = setup(t);
  await assert.rejects(s.start("/tmp/arbitrary"));
  await assert.rejects(s.start("constructor"));
  assert.equal(c.calls.length, 0);
  c.handler = async () => {
    c.emit("native", {
      method: "thread/started",
      params: { thread: { id: "thread-1" } },
    });
    return { thread: { id: "thread-1" } };
  };
  const session = await s.start("fixture");
  const log = readFileSync(join(dir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(log[1].type, "session.started");
  assert.equal(log[1].bridgeSessionId, session.id);
  assert.ok(log[1].sequence > log[0].sequence);
  const after = new Sessions(new Fake() as unknown as Codex, dir, {
    fixture: "/fixture",
  });
  assert.equal(after.get(session.id).status, "disconnected");
  assert.throws(() => after.live(session.id));
  assert.equal(after.seq, s.seq);
});
test("approval native id zero, generation check, offered decision and duplicate protection", async (t) => {
  const { c, s } = setup(t);
  const session = await s.start("fixture");
  c.emit("native", {
    method: "turn/started",
    params: { threadId: session.threadId, turn: { id: "turn-1" } },
  });
  c.emit("native", {
    id: 0,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: session.threadId,
      turnId: "turn-1",
      availableDecisions: ["accept", "cancel"],
    },
  });
  const a = [...s.approvals.values()][0];
  assert.throws(() => s.approve(session.id, a.id, "old", "accept"));
  assert.throws(() => s.approve(session.id, a.id, s.generation, "decline"));
  s.approve(session.id, a.id, s.generation, "cancel");
  assert.deepEqual(c.sent[0], { id: 0, result: { decision: "cancel" } });
  assert.throws(() => s.approve(session.id, a.id, s.generation, "accept"));
});
test("interrupt receipt does not mean interrupted; terminal event expires approval", async (t) => {
  const { c, s } = setup(t);
  const session = await s.start("fixture");
  c.emit("native", {
    method: "turn/started",
    params: { threadId: session.threadId, turn: { id: "turn-1" } },
  });
  c.emit("native", {
    id: 1,
    method: "item/fileChange/requestApproval",
    params: { threadId: session.threadId, turnId: "turn-1" },
  });
  const a = [...s.approvals.values()][0];
  await s.interrupt(session.id);
  assert.notEqual(session.status, "interrupted");
  c.emit("native", {
    method: "turn/completed",
    params: {
      threadId: session.threadId,
      turn: { id: "turn-1", status: "interrupted" },
    },
  });
  assert.equal(session.status, "interrupted");
  assert.equal(session.activeTurnId, null);
  assert.throws(() => s.approve(session.id, a.id, s.generation, "accept"));
});
test("steer completion race never creates a replacement turn", async (t) => {
  const { c, s } = setup(t);
  const session = await s.start("fixture");
  assert.equal((await s.steer(session.id, "hello")).outcome, "raced");
  session.activeTurnId = "turn-1";
  c.handler = async () => {
    session.activeTurnId = null;
    throw new Error("Turn already completed");
  };
  assert.equal((await s.steer(session.id, "hello")).outcome, "raced");
  assert.equal(c.calls.filter((x) => x.m === "turn/start").length, 0);
});
test("concurrent prompts cannot start two turns", async (t) => {
  const { c, s } = setup(t);
  const session = await s.start("fixture");
  let release: Function = () => {};
  c.handler = () =>
    new Promise((r) => {
      release = r;
    });
  const pending = s.prompt(session.id, "one");
  await assert.rejects(s.prompt(session.id, "two"));
  release({ turn: { id: "1" } });
  await pending;
  assert.equal(c.calls.filter((x) => x.m === "turn/start").length, 1);
});
test("disconnect retains last active turn and refuses control", async (t) => {
  const { c, s } = setup(t);
  const session = await s.start("fixture");
  session.activeTurnId = "unfinished";
  c.emit("disconnected", "crash");
  assert.equal(session.status, "disconnected");
  assert.equal(session.activeTurnId, "unfinished");
  await assert.rejects(s.prompt(session.id, "retry"));
});
test("normalization preserves uncertainty and native failure", () => {
  assert.equal(normalize({ method: "unknown/new" }), "native.event");
  assert.equal(
    normalize({
      method: "turn/completed",
      params: { turn: { status: "failed" } },
    }),
    "turn.failed",
  );
});
test("RPC response correlation handles out-of-order replies and errors", () => {
  const resolved: any[] = [];
  const fake: any = { pending: new Map(), emit: () => {} };
  for (const id of [1, 2])
    fake.pending.set(id, {
      timer: setTimeout(() => {}, 1000),
      resolve: (v: any) => resolved.push([id, v]),
      reject: (e: any) => resolved.push([id, e.message]),
    });
  Codex.prototype.receive.call(fake, { id: 2, result: "second" });
  Codex.prototype.receive.call(fake, {
    id: 1,
    error: { code: 42, message: "failed" },
  });
  assert.equal(resolved[0][0], 2);
  assert.match(resolved[1][1], /failed/);
  assert.equal(fake.pending.size, 0);
});

test("late terminal notification cannot clear a newer turn", async (t) => {
  const { c, s } = setup(t);
  const session = await s.start("fixture");
  session.activeTurnId = "new-turn";
  session.status = "running";
  c.emit("native", {
    method: "turn/completed",
    params: {
      threadId: session.threadId,
      turn: { id: "old-turn", status: "completed" },
    },
  });
  assert.equal(session.activeTurnId, "new-turn");
  assert.equal(session.status, "running");
});
test("uncertain turn delivery blocks blind prompt retry", async (t) => {
  const { c, s } = setup(t);
  const session = await s.start("fixture");
  c.handler = async () => {
    throw new Error("transport timed out");
  };
  await assert.rejects(s.prompt(session.id, "one"));
  assert.equal(session.status, "delivery_uncertain");
  await assert.rejects(s.prompt(session.id, "retry"));
  assert.equal(c.calls.filter((x) => x.m === "turn/start").length, 1);
});
