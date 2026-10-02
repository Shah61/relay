/** REAL integration harness. Never imported by unit tests. --preflight never constructs query(). */
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { discoverClaude } from "../src/claude/discovery.ts";
import { ClaudeAdapter } from "../src/claude/adapter.ts";
import { reconcile } from "../src/storage/reconcile.ts";
import { Sessions } from "../src/sessions/manager.ts";
import { loadConfig } from "../src/bridge/config.ts";
import { verificationPath } from "../src/agents/verification.ts";
const root = resolve(import.meta.dirname, "..");
const availability = await discoverClaude(loadConfig(root).claudeExecutable);
const preflight = process.argv.includes("--preflight");
console.log(
  JSON.stringify(
    {
      mode: preflight ? "preflight-no-inference" : "live-acceptance",
      availability,
    },
    null,
    2,
  ),
);
if (preflight || !availability.ready) {
  console.log(
    preflight
      ? "No inference attempted."
      : `SKIPPED: ${availability.state}; no alternative billing fallback.`,
  );
  process.exit(0);
}
const run = mkdtempSync(join(tmpdir(), "claude-live-"));
const cwd = join(run, "fixture"),
  state = join(run, "state");
mkdirSync(cwd);
mkdirSync(state);
execFileSync("git", ["init", "--quiet", cwd]);
writeFileSync(join(cwd, "math.cjs"), "exports.add = (a,b) => a-b;\n");
writeFileSync(
  join(cwd, "math.test.cjs"),
  "const assert=require('node:assert/strict');const {add}=require('./math.cjs');assert.equal(add(2,3),5);assert.equal(add(-2,3),1);require('node:fs').writeFileSync('test-ran.txt','passed');\n",
);
const testSource = readFileSync(join(cwd, "math.test.cjs"), "utf8");
const manager = new Sessions(
  () => new ClaudeAdapter(loadConfig(root).claudeExecutable),
  state,
  { fixture: cwd },
);
const events: any[] = [];
const checks: Record<string, boolean> = {};
let failure: unknown;
let id = "";
let mode = "edit";
const decisions: Promise<unknown>[] = [];
const inside = (p: unknown) => {
  if (typeof p !== "string") return false;
  const rel = relative(cwd, resolve(cwd, p));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};
const permittedCommands = new Set([
  "node math.test.cjs",
  'node -e "setTimeout(() => {}, 60000)"',
]);
manager.on("event", (e: any) => {
  events.push(e);
  if (e.type === "approval.requested" || e.type === "input.requested") {
    const p = [...manager.approvals.values()].find(
      (p) => !p.resolved && p.sessionId === e.bridgeSessionId,
    );
    if (!p) return;
    const { toolName, input } = p.raw;
    const safe =
      mode !== "deny" &&
      (toolName === "Bash"
        ? permittedCommands.has(input.command)
        : toolName === "Read"
          ? inside(input.file_path)
          : ["Edit", "Write"].includes(toolName) &&
            resolve(cwd, input.file_path ?? "") === join(cwd, "math.cjs"));
    const decision = safe ? "accept" : "decline";
    decisions.push(
      manager
        .approve(p.sessionId, p.id, p.generation, decision)
        .catch((err) => {
          failure = err;
        }),
    );
  }
});
async function waitFor(test: () => boolean, label: string, ms = 180000) {
  const end = Date.now() + ms;
  while (!test()) {
    if (failure) throw failure;
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function turn(text: string) {
  const from = events.length;
  await manager.prompt(id, text);
  await waitFor(
    () =>
      events
        .slice(from)
        .some((e) =>
          ["turn.completed", "turn.failed", "turn.interrupted"].includes(
            e.type,
          ),
        ),
    "native turn terminal",
  );
  const terminal = events
    .slice(from)
    .find((e) =>
      ["turn.completed", "turn.failed", "turn.interrupted"].includes(e.type),
    );
  assert.equal(terminal.type, "turn.completed", JSON.stringify(terminal.raw));
  return events.slice(from);
}
function textOf(es: any[]) {
  return es
    .filter((e) => e.type === "agent.message" || e.type === "turn.completed")
    .map((e) => JSON.stringify(e.raw))
    .join("\n");
}
try {
  const session = await manager.start("fixture", "claude");
  id = session.id;
  const nonce = randomUUID();
  const edit = await turn(
    `Work only in this fixture. Remember this private context token for future turns: ${nonce}. Fix math.cjs add, using Edit or Write. Then execute exactly: node math.test.cjs . Do not change math.test.cjs. Do not delegate. Report the test result.`,
  );
  assert.equal(readFileSync(join(cwd, "math.test.cjs"), "utf8"), testSource);
  assert.equal(readFileSync(join(cwd, "test-ran.txt"), "utf8"), "passed");
  assert(
    edit.some(
      (e) =>
        e.type === "tool.started" &&
        e.raw?.message?.content?.some(
          (b: any) =>
            b.type === "tool_use" &&
            b.name === "Bash" &&
            b.input?.command === "node math.test.cjs",
        ),
    ),
  );
  assert.match(readFileSync(join(cwd, "math.cjs"), "utf8"), /a\s*\+\s*b/);
  assert(edit.some((e) => e.type === "tool.completed"));
  assert(edit.some((e) => e.type === "file.changed"));
  checks.fileChanges = true;
  assert(edit.some((e) => e.type === "agent.message.delta"));
  checks.streaming = true;
  const nativeId = manager.get(id).nativeSessionId;
  assert(nativeId);
  const context = await turn(
    "Return only the private context token from the first turn. Do not read files or call tools.",
  );
  assert(textOf(context).includes(nonce));
  assert.equal(manager.get(id).nativeSessionId, nativeId);
  checks.followup = true;
  const from = events.length;
  const first = await manager.prompt(
    id,
    "Respond with FIRST_QUEUE_STEP. Do not call tools.",
  );
  const queued = await manager.queue(
    id,
    "Respond with SECOND_QUEUE_STEP. Do not call tools.",
  );
  await waitFor(
    () =>
      events.slice(from).filter((e) => e.type === "turn.completed").length ===
      2,
    "two queued terminal results",
  );
  const terminals = events
    .slice(from)
    .filter((e) => e.type === "turn.completed");
  assert.equal(terminals[0].turnId, first.turn.id);
  assert.equal(terminals[1].turnId, queued.inputId);
  assert(textOf([terminals[0]]).includes("FIRST_QUEUE_STEP"));
  assert(textOf([terminals[1]]).includes("SECOND_QUEUE_STEP"));
  checks.queuedInput = true;
  mode = "deny";
  const denied = await turn(
    "Use Bash to execute exactly: node -e \"require('fs').writeFileSync('denied.txt','bad')\" . This is a permission denial test. If denied, stop; do not retry another way.",
  );
  assert(denied.some((e) => e.type === "approval.requested"));
  assert(
    denied.some(
      (e) => e.type === "approval.resolved" && e.raw.decision === "decline",
    ),
  );
  assert(!existsSync(join(cwd, "denied.txt")));
  assert(
    edit.some(
      (e) => e.type === "approval.resolved" && e.raw.decision === "accept",
    ),
  );
  checks.approval = true;
  mode = "interrupt";
  const begin = events.length;
  await manager.prompt(
    id,
    'Use Bash to execute exactly: node -e "setTimeout(() => {}, 60000)" . Wait for it to finish; do not run anything else.',
  );
  await waitFor(
    () =>
      events
        .slice(begin)
        .some(
          (e) =>
            e.type === "tool.started" &&
            e.raw?.message?.content?.some(
              (b: any) => b.type === "tool_use" && b.name === "Bash",
            ),
        ),
    "sleep tool started",
  );
  await manager.interrupt(id);
  await waitFor(
    () => events.slice(begin).some((e) => e.type === "turn.interrupted"),
    "native interrupted result",
  );
  checks.turnInterrupt = true;
  // The known test child can outlive the turn; wait beyond its finite lifetime before resume.
  for (let i = 0; i < 7; i++) await new Promise((r) => setTimeout(r, 9000));
  await manager.stopAgent(id);
  assert.equal(manager.get(id).process.state, "exited");
  checks.processShutdown = true;
  reconcile(
    manager.store,
    id,
    "Live fixture harness: observed parent exit; finite known child wait elapsed; no delegated tools",
  );
  manager.sessions[id] = manager.store.sessions()[id];
  await manager.resume(id);
  const resumed = await turn(
    "Return only the private context token from our first turn. Do not use tools.",
  );
  assert.equal(manager.get(id).nativeSessionId, nativeId);
  assert(textOf(resumed).includes(nonce));
  checks.historyResume = true;
  await Promise.all(decisions);
} catch (e) {
  failure = e;
} finally {
  await manager.shutdown();
}
const eventsPath = join(state, "events.jsonl");
writeFileSync(
  eventsPath,
  events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  { mode: 0o600 },
);
const report = {
  kind: "claude-live-acceptance",
  status: failure ? "failed" : "passed",
  timestamp: new Date().toISOString(),
  version: availability.version,
  sdkVersion: availability.sdkVersion,
  checks,
  eventsPath,
  eventsSha256: createHash("sha256")
    .update(readFileSync(eventsPath))
    .digest("hex"),
  error: failure ? String(failure) : undefined,
  limitations: [
    "No full descendant termination proof",
    "No active steering support",
    "User-question and approval-cancel runtime checks remain unverified",
  ],
};
writeFileSync(join(run, "results.json"), JSON.stringify(report, null, 2), {
  mode: 0o600,
});
if (!failure) {
  mkdirSync(resolve(root, ".bridge"), { recursive: true, mode: 0o700 });
  writeFileSync(verificationPath, JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
}
console.log(
  JSON.stringify({ report: join(run, "results.json"), ...report }, null, 2),
);
if (failure) process.exitCode = 1;
