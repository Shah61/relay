import { execFileSync } from "node:child_process";
import { powershellPath } from "../platform/host.ts";
export function windowsIdentityArgs(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw Error("Invalid PID");
  return [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$p = Get-Process -Id ${pid} -ErrorAction Stop; [Console]::Write(('win:' + $p.StartTime.ToUniversalTime().Ticks + ':' + $p.SessionId))`,
  ];
}
export type Identity = { pid: number; fingerprint: string; observedAt: string };
export function identity(pid: number): Identity | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    const fingerprint = execFileSync(
      process.platform === "win32" ? powershellPath() : "/bin/ps",
      process.platform === "win32"
        ? windowsIdentityArgs(pid)
        : ["-p", String(pid), "-o", "lstart=", "-o", "uid="],
      {
        encoding: "utf8",
        timeout: process.platform === "win32" ? 10000 : 1500,
        maxBuffer: 4096,
        windowsHide: true,
      },
    ).trim();
    if (fingerprint)
      return { pid, fingerprint, observedAt: new Date().toISOString() };
  } catch {}
}
export function probe(saved?: Identity): {
  state: "alive_identity_match" | "absent" | "pid_reused" | "unknown";
  checkedAt: string;
} {
  const checkedAt = new Date().toISOString();
  if (!saved) return { state: "unknown", checkedAt };
  try {
    process.kill(saved.pid, 0);
  } catch (e: any) {
    return { state: e.code === "ESRCH" ? "absent" : "unknown", checkedAt };
  }
  const current = identity(saved.pid);
  return {
    state: !current
      ? "unknown"
      : current.fingerprint === saved.fingerprint
        ? "alive_identity_match"
        : "pid_reused",
    checkedAt,
  };
}
// Observations are NOT permission to signal a process after restart. Only current ChildProcess handles may be stopped.
export class GapMonitor {
  last: number;
  threshold: number;
  onGap: (elapsed: number) => void;
  constructor(
    onGap: (elapsed: number) => void,
    threshold = 45000,
    now = Date.now(),
  ) {
    this.last = now;
    this.threshold = threshold;
    this.onGap = onGap;
  }
  tick(now = Date.now()) {
    const elapsed = now - this.last;
    this.last = now;
    if (elapsed > this.threshold || elapsed < 0) this.onGap(elapsed);
  }
}
