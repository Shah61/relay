import {
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
export function acquireLock(path: string) {
  const create = () => {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeFileSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
  };
  try {
    create();
  } catch (e: any) {
    if (e.code !== "EEXIST") throw e;
    const pid = Number(readFileSync(path, "utf8"));
    if (!Number.isSafeInteger(pid) || pid < 1)
      throw new Error("Invalid bridge lock; inspect locally");
    try {
      process.kill(pid, 0);
      throw new Error("Another bridge process owns this state directory");
    } catch (probe: any) {
      if (probe.code !== "ESRCH") throw probe;
    }
    unlinkSync(path);
    create();
  }
  return () => {
    try {
      if (readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path);
    } catch {}
  };
}
