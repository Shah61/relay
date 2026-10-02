import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findExecutable } from "../platform/host.ts";
const run = promisify(execFile);
export async function tailscale() {
  return findExecutable("tailscale");
}
export async function ts(command: string[]) {
  const executable = await tailscale();
  if (!executable)
    throw Error(
      "Legacy private-network mode requires Tailscale on both devices. New installations should use the hosted relay setup guide.",
    );
  return run(executable, command, {
    env: { ...process.env, TAILSCALE_BE_CLI: "1" },
    timeout: 20000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
}
export async function remoteStatus() {
  const executable = await tailscale();
  if (!executable) return { state: "not_installed", ready: false };
  try {
    const { stdout } = await ts(["status", "--json"]);
    const status = JSON.parse(stdout);
    const host = String(status.Self?.DNSName ?? "").replace(/\.$/, "");
    if (status.BackendState !== "Running" || !host.endsWith(".ts.net"))
      return { state: "login_required", ready: false };
    return {
      state: "connected",
      ready: true,
      origin: `https://${host}`,
      host,
      executable,
    };
  } catch {
    return { state: "unavailable", ready: false };
  }
}
