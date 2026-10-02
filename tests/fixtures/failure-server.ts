// Standalone LOCAL FAILURE TEST server, intentionally no production agent imports.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { GapMonitor } from "../../src/supervision/process.ts";
import { Store } from "../../src/storage/store.ts";
import { Sessions } from "../../src/sessions/manager.ts";
import { httpServer } from "../../src/bridge/http.ts";
import { FakeAdapter } from "./fake-adapter.ts";
const dir = process.argv[2];
if (!dir) throw Error("Isolated test directory required");
const store = new Store(join(dir, "bridge.sqlite"), {
  eventCount: 30,
  sessionEvents: 20,
  heartbeatMs: 200,
});
const release = store.claimOwner();
const sessions = new Sessions(
  (agent) => {
    const a = new FakeAdapter(agent, dir);
    if (process.argv.includes("--hold-decision"))
      a.on("decision_hold", () => {});
    return a;
  },
  dir,
  { fixture: join(dir, "fixture"), alias: join(dir, "alias") },
  { store },
);
const gap = new GapMonitor((ms) => sessions.markGap(ms), 500);
const monitor = setInterval(() => gap.tick(), 100);
const server = httpServer(sessions, "failure-test-token");
server.listen(0, "127.0.0.1", () =>
  writeFileSync(
    join(dir, "test-connection.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${(server.address() as any).port}`,
      pid: process.pid,
    }),
  ),
);
process.on("SIGTERM", async () => {
  clearInterval(monitor);
  server.close();
  server.closeAllConnections();
  await sessions.shutdown();
  release();
  store.close();
  process.exit(0);
});
