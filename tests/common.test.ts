// UNIT TESTS ONLY: fake adapters test bridge bookkeeping, not model integration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentAdapter, type Agent } from "../src/agents/types.ts";
import { capabilities } from "../src/agents/capabilities.ts";
import { Sessions } from "../src/sessions/manager.ts";
import { acquireLock } from "../src/bridge/lock.ts";
class Fake extends AgentAdapter {
  agent: Agent;
  generation = randomUUID();
  constructor(agent: Agent) {
    super();
    this.agent = agent;
  }
  async availability() {
    return {
      agent: this.agent,
      adapterInstalled: true,
      sdkAvailable: true,
      executableAvailable: true,
      authentication: "unknown" as const,
      state: "ready" as const,
      ready: true,
    };
  }
  capabilities() {
    return capabilities(this.agent);
  }
  async start() {
    this.emitEvent({
      type: "session.started",
      source: "bridge",
      raw: { unit: true },
      nativeSessionId: "native",
      state: {
        lifecycle: "alive",
        process: {
          generation: this.generation,
          state: "running",
          children: "unknown",
        },
      },
    });
  }
  async prompt() {
    this.emitEvent({
      type: "turn.submitted",
      source: "bridge",
      raw: {},
      turn: { id: "t", state: "running" },
    });
  }
  async interrupt() {
    return { requested: true };
  }
  async respond() {
    return { sent: true };
  }
  async close() {
    this.emitEvent({
      type: "session.state_changed",
      source: "bridge",
      raw: {},
      state: {
        lifecycle: "closed",
        process: {
          generation: this.generation,
          state: "exited",
          children: "unknown",
        },
      },
    });
  }
}
function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "bridge-unit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "project"));
  symlinkSync(join(dir, "project"), join(dir, "alias"));
  return {
    dir,
    s: new Sessions((a) => new Fake(a), join(dir, "state"), {
      p: join(dir, "project"),
      alias: join(dir, "alias"),
    }),
  };
}
test("UNIT: simultaneous cross-agent and symlink starts acquire only one lease", async (t) => {
  const { s } = fixture(t);
  const r = await Promise.allSettled([
    s.start("p", "codex"),
    s.start("alias", "claude"),
  ]);
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(Object.keys(s.sessions).length, 1);
  await s.close(Object.keys(s.sessions)[0]);
  await assert.rejects(s.start("p", "claude"), /leased/);
});
test("UNIT: allowlist, malformed input, unsupported queue and stale approvals", async (t) => {
  const { s } = fixture(t);
  await assert.rejects(s.start("constructor"), /allowlisted/);
  await assert.rejects(s.start("/tmp"), /allowlisted/);
  const session = await s.start("p");
  await assert.rejects(s.prompt(session.id, ""), /Invalid/);
  await assert.rejects(s.queue(session.id, "x"), /unsupported/);
  await s.prompt(session.id, "x");
  await assert.rejects(s.prompt(session.id, "y"), /active/);
  await assert.rejects(
    s.approve(session.id, "missing", session.generation, "accept"),
    /Stale/,
  );
});
test("UNIT: restart retains uncertain leases and invalidates current controls", async (t) => {
  const { s, dir } = fixture(t);
  const old = await s.start("p");
  const restored = new Sessions(
    (a) => new Fake(a),
    join(dir, "state"),
    s.projects,
  );
  assert.equal(restored.get(old.id).process.state, "unknown");
  await assert.rejects(restored.prompt(old.id, "x"), /uncertain/);
  await assert.rejects(restored.start("alias", "claude"), /leased/);
});
test("UNIT: singleton lock prevents competing bridge instances", (t) => {
  const { dir } = fixture(t);
  const path = join(dir, "lock");
  const release = acquireLock(path);
  assert.throws(() => acquireLock(path), /Another bridge/);
  release();
  acquireLock(path)();
});

test("UNIT: resume serializes concurrent requests, renews generation, close is idempotent", async (t) => {
  const { s } = fixture(t);
  const session = await s.start("p", "claude");
  const generation = session.generation;
  await s.close(session.id);
  await s.close(session.id);
  assert.equal(s.get(session.id).process.state, "running");
  await s.stopAgent(session.id);
  assert.equal(s.get(session.id).process.state, "exited");
  s.get(session.id).process.children = "operator_confirmed_quiet";
  const results = await Promise.allSettled([
    s.operate("resume_first", "resume", session.id, {}).then((r) => {
      if (r.operation.state !== "completed") throw new Error(r.operation.error);
      return r;
    }),
    s.operate("resume_second", "resume", session.id, {}).then((r) => {
      if (r.operation.state !== "completed") throw new Error(r.operation.error);
      return r;
    }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.notEqual(s.get(session.id).process.generation, generation);
  assert.equal(s.get(session.id).leaseHeld, true);
});
test("UNIT: malformed question response does not consume callback; stale generation refused", async (t) => {
  const { s } = fixture(t);
  const session = await s.start("p", "claude");
  await s.prompt(session.id, "question");
  s.record(s.get(session.id), {
    type: "input.requested",
    source: "sdk_callback",
    raw: {},
    pending: {
      id: "q",
      turnId: "t",
      kind: "question",
      decisions: ["answer"],
      raw: { input: { questions: [{ question: "Which?" }] } },
    },
    turn: { state: "waiting_input" },
  });
  await assert.rejects(
    s.approve(session.id, "q", "old", "answer", { "Which?": "A" }),
    /Stale/,
  );
  await assert.rejects(
    s.approve(session.id, "q", session.generation, "answer", {}),
    /Invalid/,
  );
  assert.equal(s.approvals.get("q")?.resolved, false);
  await s.approve(session.id, "q", session.generation, "answer", {
    "Which?": "A",
  });
  await assert.rejects(
    s.approve(session.id, "q", session.generation, "answer", { "Which?": "B" }),
    /Stale/,
  );
});
