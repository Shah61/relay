// Real local Codex acceptance runner. Requires a running bridge and initialized fixture.
// Never fabricates native events. Unknown approvals are left pending for manual review.
import { api, request } from "../src/client.ts";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, ".."),
  fixture = resolve(root, "test-fixture");
const evidence = resolve(root, "docs/evidence");
mkdirSync(evidence, { recursive: true });
const result: any = {
  startedAt: new Date().toISOString(),
  checks: {},
  turns: [],
};
let session: any, stream: any;
const events: any[] = [];
let streamError: unknown;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function status() {
  return api(`/sessions/${session.id}`);
}
async function decide(a: any, decision: string) {
  return api(`/sessions/${session.id}/approvals`, {
    approvalId: a.id,
    generation: a.generation,
    decision,
  });
}
const printed = new Set<string>();
async function permissions(mode = "allow") {
  const st = await status();
  for (const a of st.approvals) {
    const p = a.raw.params;
    if (!printed.has(a.id)) {
      console.log("REAL APPROVAL", a.id, JSON.stringify(p));
      printed.add(a.id);
    }
    if (mode === "deny") {
      await assert.rejects(() =>
        api(`/sessions/${session.id}/approvals`, {
          approvalId: a.id,
          generation: "stale-generation",
          decision: "accept",
        }),
      );
      result.checks.staleApprovalRejected = true;
      const decision = p.availableDecisions?.includes("decline")
        ? "decline"
        : "cancel";
      await decide(a, decision);
      await assert.rejects(() => decide(a, decision));
      result.checks.duplicateApprovalRejected = true;
      result.checks.deniedApproval = { id: a.id, decision };
      return;
    }
    const cmd = p.command;
    // These are exact fixed fixture test commands, not a general shell policy.
    const allowed = [
      "/bin/zsh -lc 'node --test'",
      '/bin/zsh -lc "node --test"',
      "/bin/zsh -lc 'sleep 12'",
      "/bin/zsh -lc 'sleep 30'",
      "node --test",
      "sleep 12",
      "sleep 30",
    ];
    if (p.cwd === fixture && allowed.includes(cmd)) {
      await decide(a, "accept");
      result.checks.allowedApproval = { id: a.id, command: cmd };
    }
  }
}
async function waitFor(predicate: () => any, mode = "allow", ms = 180000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (streamError) throw streamError;
    const v = predicate();
    if (v) return v;
    await permissions(mode);
    await pause(300);
  }
  throw new Error(
    "Timed out: review pending approvals with client status/approve",
  );
}
async function turn(prompt: string) {
  const r = await api(`/sessions/${session.id}/prompt`, { text: prompt });
  result.turns.push(r.turn.id);
  return r.turn.id;
}
const terminal = (id: string) =>
  events.find(
    (e) => e.raw.method === "turn/completed" && e.raw.params.turn.id === id,
  );
const agentText = (id: string) =>
  events
    .filter(
      (e) =>
        e.turnId === id &&
        e.raw.method === "item/completed" &&
        e.raw.params.item.type === "agentMessage",
    )
    .map((e) => e.raw.params.item.text)
    .join("\n");
try {
  session = process.argv[2]
    ? (await api(`/sessions/${process.argv[2]}`)).session
    : await api("/sessions", { project: "fixture" });
  result.session = session;
  const snapshot = await api(`/sessions/${session.id}`);
  const response = await request(
    `/sessions/${session.id}/events?after=${snapshot.latestEventSequence}`,
  );
  stream = response.body!.getReader();
  const consume = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await stream.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = block.split("\n").find((x) => x.startsWith("data: "));
        if (!line) continue;
        const e = JSON.parse(line.slice(6));
        if (block.includes("event: resync_required"))
          throw new Error(
            "Native evidence gap; restart acceptance with explicit snapshot reconciliation",
          );
        if (!e.type) continue;
        events.push(e);
        if (e.type !== "agent.message" && e.type !== "native.event")
          console.log(e.sequence, e.type, e.turnId ?? "");
      }
    }
  })().catch((e) => {
    streamError = e;
  });
  const first =
    session.activeTurnId ??
    (await turn(
      "Work only in this disposable repository. Remember public synthetic test value fixture-color-orange-42 in conversation only, not files. Fix double(n) in math.cjs to return n * 2. Add tests for double(3)=6 and double(-2)=-4 in math.test.cjs. Run exactly node --test. Do not commit, use network or delegate.",
    ));
  if (!result.turns.includes(first)) result.turns.push(first);
  const firstEnd = await waitFor(() => terminal(first));
  assert.equal(firstEnd.raw.params.turn.status, "completed");
  assert.match(readFileSync(`${fixture}/math.cjs`, "utf8"), /\*\s*2|2\s*\*/);
  assert.ok(
    events.some(
      (e) =>
        e.turnId === first &&
        e.legacyType === "commandExecution.completed" &&
        e.raw.params.item.command.includes("node --test") &&
        e.raw.params.item.exitCode === 0,
    ),
  );
  for (const file of ["math.cjs", "math.test.cjs", "README.md"])
    assert.ok(
      !readFileSync(`${fixture}/${file}`, "utf8").includes(
        "fixture-color-orange-42",
      ),
    );
  result.checks.realTask = true;
  const second = await turn(
    "Without reading any files or running tools, repeat the public synthetic test value I asked you to remember in the first task. Do not guess a new value.",
  );
  await waitFor(() => terminal(second));
  assert.ok(agentText(second).includes("fixture-color-orange-42"));
  result.checks.sameThreadMemory = {
    threadId: session.threadId,
    response: agentText(second),
  };
  const steering = await turn(
    "Run exactly sleep 12 as a harmless timing test in this fixture. Wait for it to finish before responding. Do not edit files.",
  );
  await waitFor(() =>
    events.find(
      (e) =>
        e.turnId === steering && e.legacyType === "commandExecution.started",
    ),
  );
  await permissions();
  result.checks.steering = await api(`/sessions/${session.id}/steer`, {
    text: "Also include STEER_OBSERVED in your final response. Do not write it to a file.",
  });
  await waitFor(() => terminal(steering));
  result.checks.steering.response = agentText(steering);
  if (result.checks.steering.outcome === "accepted")
    assert.ok(agentText(steering).includes("STEER_OBSERVED"));
  result.checks.steeringAfterCompletion = await api(
    `/sessions/${session.id}/steer`,
    { text: "This is a completion-race probe; do not start a new turn." },
  );
  assert.equal(result.checks.steeringAfterCompletion.outcome, "raced");
  const interruption = await turn(
    "Run exactly sleep 30 as a harmless interrupt test in this fixture. Do not edit files. Wait for it to finish.",
  );
  await waitFor(() =>
    events.find(
      (e) =>
        e.turnId === interruption &&
        e.legacyType === "commandExecution.started",
    ),
  );
  await permissions();
  result.checks.interruptRequest = await api(
    `/sessions/${session.id}/interrupt`,
    {},
  );
  const interrupted = await waitFor(() => terminal(interruption));
  assert.equal(interrupted.raw.params.turn.status, "interrupted");
  result.checks.interruptedNative = true;
  assert.equal(existsSync(`${fixture}/denied.txt`), false);
  const denied = await turn(
    "Approval-denial test in this disposable fixture: attempt exactly touch denied.txt using your shell tool once. If permission is denied or cancelled, do not retry or use another tool.",
  );
  await waitFor(() => terminal(denied), "deny");
  assert.ok(result.checks.deniedApproval);
  assert.equal(existsSync(`${fixture}/denied.txt`), false);
  result.checks.deniedFileAbsent = true;
  result.checks.tests = execFileSync(process.execPath, ["--test"], {
    cwd: fixture,
    encoding: "utf8",
  });
  result.checks.gitDiff = execFileSync(
    "git",
    ["--no-pager", "diff", "--no-ext-diff", "--no-textconv"],
    { cwd: fixture, encoding: "utf8" },
  );
  assert.ok(result.checks.gitDiff.includes("math.cjs"));
  result.checks.streaming = {
    events: events.length,
    types: [...new Set(events.map((e) => e.type))],
  };
  result.success = true;
} catch (e) {
  result.success = false;
  result.error = String(e);
  console.error(e);
  process.exitCode = 1;
} finally {
  result.finishedAt = new Date().toISOString();
  writeFileSync(`${evidence}/latest-run.json`, JSON.stringify(result, null, 2));
  writeFileSync(
    `${evidence}/latest-events.jsonl`,
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  await stream?.cancel();
  console.log("Evidence: docs/evidence/latest-run.json");
}
