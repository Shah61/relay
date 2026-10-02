// UNIT TESTS ONLY: synthetic SDK messages do not prove Claude runtime behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAdapter, InputStream } from "../src/claude/adapter.ts";
import { capabilities } from "../src/agents/capabilities.ts";
import { subscriptionEnvironment } from "../src/claude/discovery.ts";
const ready: any = {
  agent: "claude",
  adapterInstalled: true,
  sdkAvailable: true,
  executableAvailable: true,
  executable: "/unit/claude",
  authentication: "authenticated",
  state: "ready",
  ready: true,
};
const start = {
  cwd: "/unit",
  project: "unit",
  bridgeSessionId: "unit",
  stateDir: "/unit",
};
function mock() {
  let options: any;
  const output = new InputStream();
  let interrupts = 0;
  const query: any = ({ options: o }: any) => {
    options = o;
    return Object.assign(output, {
      interrupt: async () => {
        interrupts++;
        return { still_queued: [] };
      },
      close: () => output.end(),
    });
  };
  const adapter = new ClaudeAdapter(undefined, {
    query,
    discover: async () => ready,
  });
  const events: any[] = [];
  adapter.on("event", (e) => events.push(e));
  return {
    adapter,
    events,
    get options() {
      return options;
    },
    get interrupts() {
      return interrupts;
    },
  };
}
test("UNIT: no ready auth means query is never constructed", async () => {
  let called = false;
  const a = new ClaudeAdapter(undefined, {
    query: (() => {
      called = true;
      throw Error();
    }) as any,
    discover: async () => ({
      ...ready,
      ready: false,
      authentication: "unauthenticated",
      state: "authentication_required",
    }),
  });
  await assert.rejects(a.start(start), /not ready/);
  assert.equal(called, false);
});
test("UNIT: API/provider credentials are refused, not silently reused", () => {
  for (const key of [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
  ])
    assert.throws(() => subscriptionEnvironment({ [key]: "fake" }), /refuses/);
  const e = subscriptionEnvironment({
    HOME: "/home/unit",
    PATH: "/bin",
    UNRELATED_SECRET: "secret",
  });
  assert.equal(e.HOME, "/home/unit");
  assert.equal(e.UNRELATED_SECRET, undefined);
});
test("UNIT: bridge FIFO only advances on native result; interrupt receipt is not terminal", async () => {
  const m = mock();
  await m.adapter.start(start);
  assert.equal(
    m.events.some((e) => e.type === "session.started"),
    false,
  );
  await m.adapter.prompt("one");
  const first = m.adapter.active;
  await m.adapter.queue("two");
  assert.equal(m.adapter.input.values.length, 1);
  await m.adapter.interrupt();
  assert.equal(m.adapter.active, first);
  assert.equal(
    m.events.some((e) => e.type === "turn.interrupted"),
    false,
  );
  m.adapter.receive({
    type: "result",
    subtype: "success",
    is_error: false,
    terminal_reason: "aborted_tools",
    session_id: "native",
    uuid: "result",
  } as any);
  assert.equal(
    m.events.some((e) => e.type === "turn.interrupted"),
    true,
  );
  assert.notEqual(m.adapter.active, first);
  assert.equal(m.adapter.input.values.length, 2);
  await m.adapter.close();
});
test("UNIT: native IDs, partial stream, errors, and explicit resume preserved", async () => {
  const m = mock();
  await m.adapter.start({ ...start, resumeId: "saved-id" });
  assert.equal(m.options.resume, "saved-id");
  assert.deepEqual(m.options.settingSources, []);
  assert.equal(m.options.permissionMode, "default");
  m.adapter.receive({
    type: "system",
    subtype: "init",
    session_id: "saved-id",
    uuid: "init",
  } as any);
  await m.adapter.prompt("hello");
  const raw = {
    type: "stream_event",
    session_id: "saved-id",
    uuid: "delta",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "Hi" },
    },
  };
  m.adapter.receive(raw as any);
  assert.equal(m.events.find((e) => e.type === "agent.message.delta").raw, raw);
  m.adapter.receive({
    type: "result",
    subtype: "success",
    is_error: true,
    session_id: "saved-id",
  } as any);
  assert.equal(m.events.at(-1).type, "turn.failed");
  await m.adapter.close();
});
test("UNIT: permission answers validate before consumption; duplicates/abort fail closed", async () => {
  const m = mock();
  await m.adapter.start(start);
  await m.adapter.prompt("question");
  const controller = new AbortController();
  const promise = m.adapter.permission(
    "AskUserQuestion",
    { questions: [{ question: "Which?" }] },
    { signal: controller.signal, toolUseID: "t" } as any,
  );
  const id = m.events.at(-1).pending.id;
  await assert.rejects(m.adapter.respond(id, "answer", {}), /cover/);
  await m.adapter.respond(id, "answer", { "Which?": "A" });
  assert.equal((await promise)?.behavior, "allow");
  await assert.rejects(
    m.adapter.respond(id, "answer", { "Which?": "B" }),
    /Stale/,
  );
  const denied = m.adapter.permission("Bash", { command: "unit" }, {
    signal: controller.signal,
    toolUseID: "t2",
  } as any);
  controller.abort();
  assert.equal((await denied)?.behavior, "deny");
  assert.equal(m.adapter.decisions.size, 0);
  await m.adapter.close();
});
test("UNIT: synthetic successes never promote documented Claude capabilities", () => {
  const c = capabilities("claude");
  for (const x of Object.values(c)) assert.notEqual(x.verification, "verified");
  assert.equal(c.activeSteering.verification, "unsupported");
  assert.equal(c.processTermination.verification, "unknown");
  assert.equal(c.queuedInput.verification, "unverified");
});
