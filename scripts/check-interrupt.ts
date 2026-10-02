// Optional supplemental real test. Uses account quota; not part of unit tests.
// Distinguishes turn interruption from termination of a shell child.
import { DatabaseSync } from "node:sqlite";
import { api } from "../src/client.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const run = JSON.parse(
  readFileSync(`${root}/docs/evidence/latest-run.json`, "utf8"),
);
const session = run.session;
const events = () => {
  const db = new DatabaseSync(`${root}/.bridge/bridge.sqlite`, {
    readOnly: true,
  });
  try {
    return (
      db
        .prepare("SELECT data FROM events WHERE session_id=? ORDER BY sequence")
        .all(session.id) as any[]
    ).map((r) => JSON.parse(r.data));
  } finally {
    db.close();
  }
};
const pause = () => new Promise((r) => setTimeout(r, 200));
const result: any = {
  startedAt: new Date().toISOString(),
  sessionId: session.id,
};
try {
  const r = await api(`/sessions/${session.id}/prompt`, {
    text: "Run exactly sleep 30 in the fixture as a harmless cancellation test. Do not edit files. Wait for completion.",
  });
  const turnId = r.turn.id;
  result.turnId = turnId;
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    const st = await api(`/sessions/${session.id}`);
    for (const a of st.approvals) {
      if (
        a.raw.params.cwd !== resolve(root, "test-fixture") ||
        a.raw.params.command !== "/bin/zsh -lc 'sleep 30'"
      )
        throw new Error("Unexpected command requires manual review");
      result.approvalId = a.id;
      await api(`/sessions/${session.id}/approvals`, {
        approvalId: a.id,
        generation: a.generation,
        decision: "accept",
      });
    }
    const rows = events().filter((e) => e.turnId === turnId);
    const ended = rows.find((e) => e.raw.method === "turn/completed");
    if (ended) {
      result.terminal = ended;
      throw new Error(
        "Turn ended before interrupt: " + ended.raw.params.turn.status,
      );
    }
    const started = rows.find(
      (e) =>
        (e.type === "commandExecution.started" &&
          e.raw.params.item.processId) ||
        e.raw.method === "item/commandExecution/terminalInteraction",
    );
    if (started) {
      result.started = started;
      result.request = await api(`/sessions/${session.id}/interrupt`, {});
      const deadline = Date.now() + 40000;
      while (Date.now() < deadline) {
        const current = events().filter((e) => e.turnId === turnId);
        result.terminal = current.find(
          (e) => e.raw.method === "turn/completed",
        );
        result.command = current.find(
          (e) => e.type === "commandExecution.completed",
        );
        if (result.terminal && result.command) break;
        await pause();
      }
      result.childTerminalObserved = !!result.command;
      result.turnInterrupted =
        result.terminal?.raw.params.turn.status === "interrupted";
      if (!result.turnInterrupted)
        throw new Error("No native interrupted terminal evidence");
      break;
    }
    await pause();
  }
  if (!result.request)
    throw new Error("Timed out waiting for native process evidence");
} catch (e) {
  result.error = String(e);
  process.exitCode = 1;
} finally {
  result.finishedAt = new Date().toISOString();
  writeFileSync(
    `${root}/docs/evidence/interrupt-running.json`,
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
}
