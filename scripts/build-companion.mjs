import {
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
const release = process.argv.includes("--release");
const dashboard = process.env.PM_DASHBOARD_ORIGIN,
  relay = process.env.PM_RELAY_ORIGIN;
let product = { configured: false, dashboardOrigin: null, relayOrigin: null };
if (release && (!dashboard || !relay)) {
  throw Error(
    "Release builds require PM_DASHBOARD_ORIGIN and PM_RELAY_ORIGIN (exact HTTPS origins).",
  );
}
if (dashboard || relay) {
  if (!dashboard || !relay)
    throw Error(
      "Set both PM_DASHBOARD_ORIGIN and PM_RELAY_ORIGIN, or leave both unset for a development build.",
    );
  for (const value of [dashboard, relay]) {
    const u = new URL(value ?? "");
    if (u.protocol !== "https:" || u.origin !== value)
      throw Error("Release URLs must be exact HTTPS origins");
  }
  product = {
    configured: true,
    dashboardOrigin: dashboard,
    relayOrigin: relay,
  };
}
rmSync(".companion", { recursive: true, force: true });
mkdirSync(".companion", { recursive: true });
execFileSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "tsconfig.companion.json"],
  { stdio: "inherit" },
);
cpSync("companion", ".companion/companion", { recursive: true });
cpSync("web", ".companion/runtime/web", { recursive: true });
writeFileSync(".companion/companion/product.json", JSON.stringify(product));
writeFileSync(
  ".companion/runtime/package.json",
  JSON.stringify({ type: "module" }),
);
const root = JSON.parse(readFileSync("package.json", "utf8"));
cpSync("package-lock.json", ".companion/package-lock.json");
writeFileSync(
  ".companion/package.json",
  JSON.stringify(
    {
      name: "prompt-manager-companion",
      version: "0.8.0",
      description: "Prompt Manager Companion",
      author: "Prompt Manager",
      private: true,
      main: "companion/main.cjs",
      dependencies: root.dependencies,
    },
    null,
    2,
  ),
);
console.log(
  product.configured
    ? "Companion built with public release configuration; no shared credentials."
    : "Development companion built: service not configured.",
);
