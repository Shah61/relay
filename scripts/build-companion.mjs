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
let product = JSON.parse(readFileSync("companion/product.json", "utf8"));
if (dashboard || relay) {
  if (!dashboard || !relay)
    throw Error(
      "Set both PM_DASHBOARD_ORIGIN and PM_RELAY_ORIGIN, or leave both unset for a development build.",
    );
  product = {
    configured: true,
    dashboardOrigin: dashboard,
    relayOrigin: relay,
  };
}
if (release && product.configured !== true)
  throw Error("Configure companion/product.json or set both PM_DASHBOARD_ORIGIN and PM_RELAY_ORIGIN before building a release.");
if (product.configured === true) {
  for (const value of [product.dashboardOrigin, product.relayOrigin]) {
    const u = new URL(value ?? "");
    if (u.protocol !== "https:" || u.origin !== value)
      throw Error("Release URLs must be exact HTTPS origins");
  }
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
