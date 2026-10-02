import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
const cwd = resolve(import.meta.dirname, "../test-fixture");
if (existsSync(resolve(cwd, ".git")))
  throw new Error(
    "Fixture already initialized; refusing to overwrite evidence",
  );
writeFileSync(resolve(cwd, "math.cjs"), "exports.double = n => n;\n");
writeFileSync(
  resolve(cwd, "math.test.cjs"),
  "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { double } = require('./math.cjs');\ntest('baseline', () => assert.equal(double(0), 0));\n",
);
writeFileSync(
  resolve(cwd, "README.md"),
  "Disposable Codex integration fixture. No dependencies. Run node --test.\n",
);
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" });
git("init");
git("add", "README.md", "math.cjs", "math.test.cjs");
git(
  "-c",
  "user.name=Bridge Fixture",
  "-c",
  "user.email=fixture@localhost",
  "-c",
  "commit.gpgsign=false",
  "commit",
  "-m",
  "Disposable fixture baseline",
);
console.log("Fixture initialized");
