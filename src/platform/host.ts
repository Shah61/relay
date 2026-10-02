import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, win32 } from "node:path";
import { execFile } from "node:child_process";

export function windowsCodexCandidates(directory: string, arch = process.arch) {
  const triplet =
    arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const packageName = `codex-win32-${arch === "arm64" ? "arm64" : "x64"}`;
  return [
    win32.join(directory, "codex.exe"),
    win32.join(
      directory,
      "node_modules",
      "@openai",
      "codex",
      "node_modules",
      "@openai",
      packageName,
      "vendor",
      triplet,
      "codex",
      "codex.exe",
    ),
    win32.join(
      directory,
      "node_modules",
      "@openai",
      packageName,
      "vendor",
      triplet,
      "codex",
      "codex.exe",
    ),
    win32.join(
      directory,
      "node_modules",
      "@openai",
      "codex",
      "vendor",
      triplet,
      "codex",
      "codex.exe",
    ),
  ];
}
export function findExecutable(
  name: "codex" | "claude" | "tailscale",
  configured?: string,
) {
  const windows = process.platform === "win32";
  const paths = (process.env.PATH ?? process.env.Path ?? "")
    .split(delimiter)
    .filter(Boolean);
  const candidates = configured
    ? [configured]
    : [
        ...paths.flatMap((p) =>
          windows && name === "codex"
            ? windowsCodexCandidates(p)
            : [join(p, name + (windows ? ".exe" : ""))],
        ),
        join(homedir(), ".local", "bin", name + (windows ? ".exe" : "")),
        ...(windows && name === "codex"
          ? [
              join(
                process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
                "Microsoft",
                "WinGet",
                "Links",
                "codex.exe",
              ),
              ...windowsCodexCandidates(
                join(
                  process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
                  "npm",
                ),
              ),
            ]
          : []),
        ...(windows && name === "tailscale"
          ? [
              join(
                process.env.ProgramFiles ?? "C:\\Program Files",
                "Tailscale",
                "tailscale.exe",
              ),
            ]
          : []),
        ...(!windows
          ? [
              `/usr/local/bin/${name}`,
              `/opt/homebrew/bin/${name}`,
              `/usr/bin/${name}`,
            ]
          : []),
        ...(process.platform === "darwin" && name === "tailscale"
          ? ["/Applications/Tailscale.app/Contents/MacOS/Tailscale"]
          : []),
      ];
  for (const candidate of candidates)
    try {
      const path = realpathSync(candidate);
      if (!statSync(path).isFile()) continue;
      if (windows && !path.toLowerCase().endsWith(".exe")) continue;
      accessSync(path, windows ? constants.F_OK : constants.X_OK);
      return path;
    } catch {}
  return null;
}
export function powershellPath() {
  return win32.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}
export function openBrowser(url: string) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol))
    throw Error("Unsupported browser URL");
  const windows = process.platform === "win32";
  // Arguments are passed directly; no shell interpolation, cmd.exe, or prompt content.
  const command = windows
    ? powershellPath()
    : process.platform === "darwin"
      ? "/usr/bin/open"
      : "xdg-open";
  const args = windows
    ? [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Start-Process -FilePath '${url.replaceAll("'", "''")}'`,
      ]
    : [url];
  return new Promise<void>((resolve, reject) =>
    execFile(command, args, { timeout: 10000, windowsHide: true }, (error) =>
      error ? reject(error) : resolve(),
    ),
  );
}
