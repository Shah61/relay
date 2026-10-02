import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { CodexAdapter } from "../codex/adapter.ts";
import { ClaudeAdapter } from "../claude/adapter.ts";
import { loadConfig } from "./config.ts";
import { Sessions } from "../sessions/manager.ts";
import { Store } from "../storage/store.ts";
import { GapMonitor } from "../supervision/process.ts";
import { DeviceAuth } from "../security/devices.ts";
import { browserGateway } from "../browser/gateway.ts";
import { localAdmin } from "../browser/admin.ts";
import { httpServer } from "./http.ts";
import { RelayHost } from "../relay/host.ts";
const root = resolve(import.meta.dirname, "../.."),
  dir = resolve(root, ".bridge");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const config = loadConfig(root),
  store = new Store(resolve(dir, "bridge.sqlite"), config.limits);
const unlock = store.claimOwner();
const tokenPath = resolve(dir, "token");
if (!existsSync(tokenPath))
  writeFileSync(tokenPath, randomBytes(32).toString("hex"), { mode: 0o600 });
const token = readFileSync(tokenPath, "utf8").trim();
if (!/^[a-f0-9]{64}$/.test(token))
  throw new Error("Invalid local bearer token file");
const sessions = new Sessions(
  (agent) =>
    agent === "codex"
      ? new CodexAdapter(undefined, config.limits, config.codexExecutable)
      : new ClaudeAdapter(config.claudeExecutable, undefined, config.limits),
  dir,
  config.projects,
  { store },
);
const auth = new DeviceAuth(store, Object.keys(config.projects));
const server = httpServer(sessions, token, localAdmin(auth));
let browser: ReturnType<typeof browserGateway> | undefined;
let relay: RelayHost | undefined;
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
writeFileSync(`${dir}/pid`, String(process.pid), { mode: 0o600 });
server.listen(config.port, "127.0.0.1", () => {
  const address = server.address() as any;
  writeFileSync(
    `${dir}/connection.json`,
    JSON.stringify({
      url: `http://127.0.0.1:${address.port}`,
      generation: sessions.generation,
    }),
    { mode: 0o600 },
  );
  browser = browserGateway(sessions, auth, {
    ...config.browser,
    coreUrl: `http://127.0.0.1:${address.port}`,
    coreToken: token,
    relay: () => relay,
  });
  browser.on("error", (e) => {
    console.error("Browser gateway failed:", String(e));
    void stop();
    process.exitCode = 1;
  });
  browser.listen(config.browser.port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${config.browser.port}`;
    relay = new RelayHost(auth, dir, url, token);
    relay.start();
    console.log(`Dashboard: ${url}`);
  });
  console.log(`Bridge listening on http://127.0.0.1:${address.port}`);
});
const gap = new GapMonitor(
  (elapsed) => sessions.markGap(elapsed),
  store.policy.gapMs,
);
const monitor = setInterval(() => {
  gap.tick();
  store.maintenance();
}, 10000);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  sessions.stopping = true;
  clearInterval(monitor);
  relay?.stop();
  browser?.close();
  browser?.closeAllConnections();
  server.close();
  server.closeAllConnections();
  const timeout = setTimeout(() => process.exit(1), 10000);
  timeout.unref();
  try {
    await sessions.shutdown();
    store.maintenance();
    unlock();
    store.close();
    clearTimeout(timeout);
  } catch (e) {
    console.error(
      "Shutdown incomplete; reconciliation required:",
      String(e).slice(0, 4096),
    );
    process.exitCode = 1;
  }
}
// Fatal persistence errors stop acceptance and exit. Recovery preserves uncertainty; no in-memory-only continuation.
const storageFailure = () => {
  relay?.stop();
  sessions.stopping = true;
  browser?.close();
  browser?.closeAllConnections();
  server.close();
  server.closeAllConnections();
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 100).unref();
};
sessions.on("storage_failure", storageFailure);
store.onFailure = storageFailure;
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
