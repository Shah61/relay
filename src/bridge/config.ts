import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
export function loadConfig(root: string) {
  const path = resolve(root, "config.local.json");
  const c = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const projects: Record<string, string> = Object.create(null);
  for (const [id, p] of Object.entries(
    c.projects ?? { fixture: "test-fixture" },
  )) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || typeof p !== "string")
      throw new Error("Invalid local project configuration");
    projects[id] = realpathSync(resolve(root, p));
  }
  const executable = c.claude?.executable;
  const codexExecutable = c.codex?.executable;
  if (
    codexExecutable !== undefined &&
    (typeof codexExecutable !== "string" || !isAbsolute(codexExecutable))
  )
    throw Error("Codex executable must be an absolute local path");
  if (
    executable !== undefined &&
    (typeof executable !== "string" || !isAbsolute(executable))
  )
    throw new Error(
      "Claude executable must be an absolute locally configured path",
    );
  const port = c.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid local port");
  const browserPort = c.browser?.port ?? 47832;
  if (
    !Number.isSafeInteger(browserPort) ||
    browserPort < 1024 ||
    browserPort > 65535
  )
    throw new Error("Invalid browser port");
  const remoteOrigin = c.browser?.remoteOrigin;
  if (remoteOrigin !== undefined) {
    const u = new URL(remoteOrigin);
    if (
      u.protocol !== "https:" ||
      !u.hostname.endsWith(".ts.net") ||
      u.port ||
      u.username ||
      u.password ||
      u.pathname !== "/" ||
      u.search ||
      u.hash ||
      u.origin !== remoteOrigin
    )
      throw new Error("Remote origin must be an exact Tailscale HTTPS origin");
  }
  return {
    projects,
    claudeExecutable: executable as string | undefined,
    codexExecutable: codexExecutable as string | undefined,
    port,
    limits: c.limits,
    browser: {
      port: browserPort,
      remoteOrigin: remoteOrigin as string | undefined,
    },
  };
}
