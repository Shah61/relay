import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, realpath, stat, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, dirname, delimiter } from "node:path";
import { createRequire } from "node:module";
import type { Availability } from "../agents/types.ts";
const run = promisify(execFile),
  require = createRequire(import.meta.url);
export const billingKeys = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_API_KEY_HELPER",
  "CLAUDE_CODE_CLIENT_DATA_URL",
];
export function subscriptionEnvironment(
  input: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (billingKeys.some((k) => !!input[k]))
    throw new Error(
      "Alternative credential/provider environment configured; subscription-only adapter refuses to run",
    );
  const env: NodeJS.ProcessEnv = {};
  // Explicit undefined values also override SDK environment merging.
  for (const k of Object.keys(input)) env[k] = undefined;
  for (const k of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "Path",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "COMSPEC",
    "PATHEXT",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "CLAUDE_CODE_GIT_BASH_PATH",
  ])
    if (input[k]) env[k] = input[k];
  return env;
}
export async function discoverClaude(
  configuredPath?: string,
): Promise<Availability> {
  const a: Availability = {
    agent: "claude",
    adapterInstalled: true,
    sdkAvailable: false,
    executableAvailable: false,
    authentication: "unknown",
    state: "unknown",
    ready: false,
  };
  try {
    const pkg = require("@anthropic-ai/claude-agent-sdk/package.json");
    a.sdkVersion = pkg.version;
    a.sdkAvailable = true;
  } catch {
    try {
      const file = require.resolve("@anthropic-ai/claude-agent-sdk");
      a.sdkAvailable = !!file;
      a.sdkVersion = JSON.parse(
        await readFile(join(dirname(file), "package.json"), "utf8"),
      ).version;
    } catch {
      a.state = "sdk_unavailable";
      return a;
    }
  }
  let env: NodeJS.ProcessEnv;
  try {
    env = subscriptionEnvironment();
  } catch (e) {
    a.state = "configuration_blocked";
    a.reason = String(e);
    return a;
  }
  const candidates: { path: string; source: string }[] = [];
  if (configuredPath) {
    if (!isAbsolute(configuredPath)) {
      a.state = "configuration_blocked";
      a.reason = "Configured Claude executable must be absolute";
      return a;
    }
    candidates.push({ path: configuredPath, source: "local_config" });
  } else {
    for (const p of (process.env.PATH ?? process.env.Path ?? "")
      .split(delimiter)
      .filter(isAbsolute))
      candidates.push({
        path: join(p, process.platform === "win32" ? "claude.exe" : "claude"),
        source: "installed_cli",
      });
    for (const p of [
      join(
        homedir(),
        ".local/bin",
        process.platform === "win32" ? "claude.exe" : "claude",
      ),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ])
      candidates.push({ path: p, source: "installed_cli" });
    const desktop = join(
      homedir(),
      "Library/Application Support/Claude/claude-code",
    );
    try {
      for (const v of (await readdir(desktop))
        .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true })))
        candidates.push({
          path: join(desktop, v, "claude.app/Contents/MacOS/claude"),
          source: "desktop_managed",
        });
    } catch {}
  }
  for (const candidate of candidates) {
    try {
      const path = await realpath(candidate.path);
      const info = await stat(path);
      if (!info.isFile() || (process.platform !== "win32" && info.mode & 0o002))
        continue;
      if (process.platform === "win32" && !path.toLowerCase().endsWith(".exe"))
        continue;
      await access(
        path,
        process.platform === "win32" ? constants.F_OK : constants.X_OK,
      );
      const { stdout } = await run(path, ["--version"], {
        env,
        timeout: 10000,
        maxBuffer: 65536,
        windowsHide: true,
      });
      if (!/Claude Code/.test(stdout)) continue;
      a.executable = path;
      a.executableSource = candidate.source;
      a.executableAvailable = true;
      a.version = stdout.trim();
      break;
    } catch {}
  }
  if (!a.executable) {
    a.state = configuredPath
      ? "configuration_blocked"
      : "executable_unavailable";
    a.reason = "No validated Claude Code executable found";
    return a;
  }
  try {
    let stdout = "";
    try {
      ({ stdout } = await run(
        a.executable,
        ["--setting-sources", "", "auth", "status"],
        { env, timeout: 15000, maxBuffer: 65536, cwd: homedir() },
      ));
    } catch (e: any) {
      if (e.code === 1 && typeof e.stdout === "string") stdout = e.stdout;
      else throw e;
    }
    const status = JSON.parse(stdout);
    if (status.loggedIn === false) {
      a.authentication = "unauthenticated";
      a.state = "authentication_required";
      a.reason =
        "Claude Code is installed but official subscription authentication is required";
    } else if (
      status.loggedIn === true &&
      status.authMethod === "claude.ai" &&
      status.apiProvider === "firstParty" &&
      ["pro", "max", "team", "enterprise"].includes(
        String(status.subscriptionType).toLowerCase(),
      )
    ) {
      a.authentication = "authenticated";
      a.state = "ready";
      a.ready = true;
    } else {
      a.state = "configuration_blocked";
      a.reason =
        "Subscription authentication could not be established; no API/provider fallback allowed";
    }
  } catch {
    a.state = "unknown";
    a.reason = "Official CLI auth status could not be determined safely";
  }
  return a;
}
