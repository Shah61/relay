import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { Sessions, worktreeIdentity } from "../src/sessions/manager.ts";
import { FakeAdapter } from "./fixtures/fake-adapter.ts";
import { reconcile } from "../src/storage/reconcile.ts";
test("Real Git worktree roots: nested/symlink/alternate paths conflict; distinct worktree can run", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lease-git-"));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const git = (args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git(["init", "--quiet"]);
  git([
    "-c",
    "user.name=Bridge Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  const worktree = join(dir, "other");
  git(["worktree", "add", "--quiet", "--detach", worktree]);
  mkdirSync(join(repo, "nested"));
  symlinkSync(repo, join(dir, "alias"));
  const s = new Sessions((a) => new FakeAdapter(a, dir), join(dir, "state"), {
    root: repo,
    nested: join(repo, "nested"),
    alias: join(dir, "alias"),
    other: worktree,
  });
  t.after(async () => {
    await s.shutdown();
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(
    worktreeIdentity(join(repo, "nested")),
    worktreeIdentity(join(dir, "alias")),
  );
  const results = await Promise.all(
    ["root", "nested", "alias"].map((p, i) =>
      s.operate("lease_start_" + i, "start", null, {
        project: p,
        agent: i ? "claude" : "codex",
      }),
    ),
  );
  assert.equal(
    results.filter((r) => r.operation.state === "completed").length,
    1,
  );
  const other = await s.operate("separate_tree", "start", null, {
    project: "other",
    agent: "claude",
  });
  assert.equal(other.operation.state, "completed");
  assert.equal(s.store.diagnostics().leases.length, 2);
});
test("Legacy duplicate worktree claims migrate without dropping either blocker; reconciliation audited", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lease-legacy-"));
  mkdirSync(join(dir, "repo"));
  const worktree = worktreeIdentity(join(dir, "repo"));
  const state = join(dir, "state");
  mkdirSync(state);
  const legacy: any = {};
  for (const id of ["one", "two"])
    legacy[id] = {
      id,
      agent: "codex",
      project: "repo",
      worktree,
      nativeSessionId: id,
      lifecycle: "disconnected",
      currentTurn: {
        id: null,
        nativeId: null,
        idSource: "native",
        state: "unknown",
      },
      process: { generation: id, state: "unknown", children: "unknown" },
      queuedInputCount: 0,
      leaseHeld: true,
      capabilities: {},
    };
  writeFileSync(join(state, "common-sessions.json"), JSON.stringify(legacy));
  const s = new Sessions((a) => new FakeAdapter(a, dir), state, {
    repo: join(dir, "repo"),
  });
  t.after(() => {
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(
    s.store.db.prepare("SELECT * FROM lease_members").all().length,
    2,
  );
  reconcile(s.store, "one", "Test fixture has no native processes");
  assert(s.store.lease(worktree));
  reconcile(s.store, "two", "Test fixture has no native processes");
  assert.equal(s.store.lease(worktree), undefined);
  assert.equal(
    s.store.db
      .prepare("SELECT * FROM audit WHERE action=?")
      .all("local_operator_reconciliation").length,
    2,
  );
});
