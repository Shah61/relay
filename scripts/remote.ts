import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { remoteStatus, ts } from "../src/remote/tailscale.ts";
import { assertPrivateMapping } from "../src/remote/serve-policy.ts";
import { loadConfig } from "../src/bridge/config.ts";
const root = resolve(import.meta.dirname, "..");
const command = process.argv[2] ?? "status";
const status = await remoteStatus();
if (command === "status") {
  console.log(JSON.stringify(status, null, 2));
  process.exit(0);
}
if (command === "configure") {
  if (!status.ready || !("origin" in status))
    throw Error(
      `Tailscale ${status.state}. Install/sign in on this Mac and phone first.`,
    );
  const path = resolve(root, "config.local.json");
  const existing = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : {};
  existing.browser = {
    ...existing.browser,
    port: existing.browser?.port ?? 47832,
    remoteOrigin: status.origin,
  };
  writeFileSync(path, JSON.stringify(existing, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(
    `Configured private dashboard origin ${status.origin}. Restart the bridge, then run npm run remote:enable.`,
  );
} else if (command === "enable") {
  const config = loadConfig(root);
  if (
    !status.ready ||
    !("origin" in status) ||
    status.origin !== config.browser.remoteOrigin
  )
    throw Error(
      "Run remote:configure while Tailscale is connected, then restart the bridge.",
    );
  const r = await fetch(`http://127.0.0.1:${config.browser.port}/ready`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok || ((await r.json()) as any).application !== "Relay")
    throw Error("Browser gateway is not ready");
  const prior = JSON.parse((await ts(["serve", "status", "--json"])).stdout);
  assertPrivateMapping(prior, status.host!, config.browser.port, true);
  await ts([
    "serve",
    "--bg",
    "--https=443",
    `http://127.0.0.1:${config.browser.port}`,
  ]);
  const check = await fetch(status.origin + "/ready", {
    signal: AbortSignal.timeout(15000),
  });
  if (!check.ok || ((await check.json()) as any).application !== "Relay")
    throw Error("Private HTTPS probe failed; inspect Tailscale Serve status.");
  console.log(
    `Private HTTPS verified from this Mac: ${status.origin}\nOpen this address on your phone with Tailscale connected, then pair the browser. A phone test is still required.`,
  );
} else if (command === "disable") {
  const config = loadConfig(root);
  if (
    !status.ready ||
    !("host" in status) ||
    status.origin !== config.browser.remoteOrigin
  )
    throw Error("Connected host does not match Relay configuration");
  assertPrivateMapping(
    JSON.parse((await ts(["serve", "status", "--json"])).stdout),
    status.host!,
    config.browser.port,
  );
  await ts(["serve", "--https=443", "off"]);
  console.log(
    "Tailscale HTTPS Serve mapping disabled. No Funnel command was used.",
  );
} else throw Error("Use status, configure, enable, or disable");
