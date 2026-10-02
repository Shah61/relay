import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../src/bridge/config.ts";
import { openBrowser } from "../src/platform/host.ts";
const root = resolve(import.meta.dirname, "..");
const config = loadConfig(root);
async function pairing() {
  const connectionPath = resolve(root, ".bridge/connection.json"),
    tokenPath = resolve(root, ".bridge/token");
  if (!existsSync(connectionPath) || !existsSync(tokenPath)) return null;
  try {
    const connection = JSON.parse(readFileSync(connectionPath, "utf8")),
      url = new URL(connection.url);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.pathname !== "/"
    )
      return null;
    const response = await fetch(url.origin + "/admin/pairings", {
      method: "POST",
      signal: AbortSignal.timeout(1500),
      headers: {
        Authorization: "Bearer " + readFileSync(tokenPath, "utf8").trim(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        role: "owner",
        projects: Object.keys(config.projects),
      }),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}
let pair = await pairing();
if (!pair) {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", resolve(root, "src/bridge/server.ts")],
    { cwd: root, stdio: "inherit", windowsHide: true },
  );
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  child.on("error", (error) => {
    console.error(error.message);
    exited = true;
  });
  for (let i = 0; i < 30 && !exited && !pair; i++) {
    await delay(500);
    pair = await pairing();
  }
  if (!pair)
    throw Error(
      "Bridge did not become ready. Review the error above; existing leases are never force-released.",
    );
  console.log("Keep this window open while using Relay. Press Ctrl+C to stop.");
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      if (!exited) child.kill(signal);
    });
}
await openBrowser(
  `http://127.0.0.1:${config.browser.port}/#local=${pair.code}`,
);
console.log("Dashboard opened. Choose Connect phone to pair your phone.");
