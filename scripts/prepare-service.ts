import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
const root = resolve(import.meta.dirname, "..");
const escape = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const values: Record<string, string> = {
  NODE: process.execPath,
  RUNNER: resolve(root, "service/run.ts"),
  ROOT: root,
  PATH: [
    dirname(process.execPath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":"),
};
const output = resolve(root, "service/local.agent-bridge.plist");
writeFileSync(
  output,
  readFileSync(resolve(root, "service/bridge.plist.template"), "utf8").replace(
    /\{\{(\w+)\}\}/g,
    (_, key) => escape(values[key]),
  ),
  { mode: 0o600 },
);
console.log(`Prepared ${output}. Nothing installed or started.`);
