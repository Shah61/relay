// UNIT regression: replay historical real evidence through a fake transport. No new model call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexAdapter } from "../src/codex/adapter.ts";
test("UNIT: common Codex adapter retains Phase 2 raw tool events and native IDs", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "codex-replay-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const historical = readFileSync(
    resolve(import.meta.dirname, "../docs/evidence/latest-events.jsonl"),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const sample = historical.find((e) => e.type === "commandExecution.started");
  assert(sample);
  const thread = sample.codexThreadId;
  class Transport extends EventEmitter {
    closed = false;
    async initialize() {}
    async request() {
      return { thread: { id: thread } };
    }
    send() {}
    close() {
      this.closed = true;
      this.emit("disconnected", "unit close");
    }
  }
  const transport = new Transport();
  const adapter = new CodexAdapter(transport as any);
  const output: any[] = [];
  adapter.on("event", (e) => output.push(e));
  await adapter.start({
    cwd: dir,
    project: "fixture",
    bridgeSessionId: "unit",
    stateDir: join(dir, "state"),
  });
  transport.emit("native", sample.raw);
  const event = output.find((e) => e.type === "tool.started");
  assert(event);
  assert.deepEqual(event.raw, sample.raw);
  assert.equal(event.nativeSessionId, thread);
  assert.equal(event.nativeTurnId, sample.turnId);
  assert.equal(event.legacyType, "commandExecution.started");
  await adapter.close();
  assert.equal(output.at(-1).state.process.state, "unknown");
});

test("REGRESSION: transport-disconnected parent must still be stopped using its owned handle", async (t) => {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "pipe",
  });
  await once(child, "spawn");
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
  });
  const transport = new EventEmitter() as any;
  transport.closed = true;
  transport.child = child;
  transport.close = () => child.kill("SIGTERM");
  child.on("exit", (code, signal) =>
    transport.emit("process_exit", { code, signal }),
  );
  const adapter = new CodexAdapter(transport);
  await adapter.close();
  assert.notEqual(child.signalCode, null);
});
