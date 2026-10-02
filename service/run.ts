// launchd wrapper with bounded, rotated bridge logs. No provider credentials here.
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, ".."),
  dir = resolve(root, ".bridge/service-logs");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const path = resolve(dir, "bridge.log");
function log(chunk: Buffer) {
  if (existsSync(path) && statSync(path).size + chunk.length > 1024 * 1024) {
    rmSync(path + ".3", { force: true });
    for (let i = 2; i >= 1; i--)
      if (existsSync(path + "." + i))
        renameSync(path + "." + i, path + "." + (i + 1));
    renameSync(path, path + ".1");
  }
  appendFileSync(path, chunk.subarray(0, 65536), { mode: 0o600 });
  if (chunk.length > 65536)
    appendFileSync(path, "\n[service log chunk truncated]\n");
}
const child = spawn(
  process.execPath,
  ["--experimental-strip-types", resolve(root, "src/bridge/server.ts")],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
);
child.stdout.on("data", log);
child.stderr.on("data", log);
child.on("error", (err) => {
  log(Buffer.from(String(err)));
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill(signal);
  });
