import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { Sessions } from "../src/sessions/manager.ts";
import { FakeAdapter } from "./fixtures/fake-adapter.ts";
import { DeviceAuth } from "../src/security/devices.ts";
import { browserGateway } from "../src/browser/gateway.ts";

test("mobile session API: isolated sessions in one project, close/clear/delete, durable history and authorization", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pm-session-controls-")),
    repo = join(dir, "project");
  mkdirSync(repo);
  const git = (args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git(["init", "--quiet"]);
  writeFileSync(join(repo, "source.txt"), "committed");
  git(["add", "."]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  writeFileSync(join(repo, "source.txt"), "uncommitted work is preserved");
  const sessions = new Sessions(
    (a) => new FakeAdapter(a, dir),
    join(dir, "state"),
    { project: repo },
  );
  const auth = new DeviceAuth(sessions.store, ["project"]),
    paired = auth.exchange(auth.pairing("operator", ["project"]).code, "Phone");
  const viewer = auth.exchange(
    auth.pairing("viewer", ["project"]).code,
    "Viewer",
  );
  const gateway = browserGateway(sessions, auth, {
    port: 0,
    coreUrl: "http://127.0.0.1:1",
    coreToken: "test-only",
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const url = `http://127.0.0.1:${(gateway.address() as any).port}`;
  const call = async (
    path: string,
    body?: any,
    device = paired,
    key = randomUUID(),
  ) => {
    const r = await fetch(url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Cookie: `relay_local=${device.secret}`,
        Origin: url,
        "X-CSRF-Token": device.csrf,
        "Idempotency-Key": key,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  t.after(async () => {
    gateway.closeAllConnections();
    gateway.close();
    await sessions.shutdown();
    sessions.store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const first = await call("/api/sessions", {
    project: "project",
    isolated: true,
  });
  const second = await call("/api/sessions", {
    project: "project",
    isolated: true,
    agent: "claude",
  });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const one = sessions.get(first.body.operation.session_id),
    two = sessions.get(second.body.operation.session_id);
  assert.notEqual(one.worktree, two.worktree);
  assert(one.isolatedWorkspace && two.isolatedWorkspace);
  assert.equal(
    readFileSync(join(one.workspaceCwd!, "source.txt"), "utf8"),
    "committed",
  );
  assert.equal(
    readFileSync(join(repo, "source.txt"), "utf8"),
    "uncommitted work is preserved",
  );
  await call(`/api/sessions/${one.id}/prompt`, { text: "hello" });
  const prior = sessions.seq,
    retained = sessions.store.replay(one.id, 0).events.length;
  assert.equal((await call(`/api/sessions/${one.id}/clear`, {})).status, 200);
  const snapshot = (await call(`/api/sessions/${one.id}`)).body;
  assert.equal(snapshot.historyStartCursor, prior);
  assert(
    sessions.store.replay(one.id, 0).events.length >= retained,
    "audited history remains available",
  );
  for (const action of ["clear", "delete", "end"])
    assert.equal(
      (await call(`/api/sessions/${one.id}/${action}`, {}, viewer)).status,
      403,
    );
  assert.equal((await call(`/api/sessions/${one.id}/end`, {})).status, 200);
  assert.equal(one.process.state, "exited");
  assert(one.controlClosed);
  assert(one.leaseHeld);
  const deletionKey = randomUUID();
  const deletion = await call(
    `/api/sessions/${one.id}/delete`,
    {},
    paired,
    deletionKey,
  );
  assert.equal(deletion.status, 200);
  const replay = await call(
    `/api/sessions/${one.id}/delete`,
    {},
    paired,
    deletionKey,
  );
  assert.equal(replay.body.replayed, true);
  assert.deepEqual(
    (await call("/api/sessions")).body.sessions.map((s: any) => s.id),
    [two.id],
  );
  assert(sessions.store.sessions()[one.id].archivedAt, "delete is durable");
  assert(
    sessions.store.lease(one.worktree),
    "hiding a session never releases unknown descendants",
  );
  const third = await call("/api/sessions", {
    project: "project",
    isolated: true,
  });
  assert.equal(third.status, 200);
});

test("errored adapter can be closed/deleted while uncertain reservations remain", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pm-failed-close-"));
  mkdirSync(join(dir, "project"));
  const sessions = new Sessions(
    (a) => new FakeAdapter(a, dir),
    join(dir, "state"),
    { project: join(dir, "project") },
  );
  const s = await sessions.start("project"),
    adapter = sessions.adapters.get(s.id)!;
  const close = adapter.close.bind(adapter);
  adapter.close = async () => {
    throw Error("test adapter shutdown failure");
  };
  t.after(async () => {
    adapter.close = close;
    await sessions.shutdown();
    sessions.store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  sessions.get(s.id).reconciliationRequired = true;
  const deletion = await sessions.operate(
    "delete_failed_session",
    "delete",
    s.id,
    {},
  );
  assert.equal(deletion.operation.state, "completed");
  assert(sessions.get(s.id).archivedAt);
  assert(sessions.get(s.id).controlClosed);
  assert(sessions.store.lease(s.worktree));
});
