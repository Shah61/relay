// Deliberate offline local action. No HTTP route imports this function.
import { resolve } from "node:path";
import { Store } from "../src/storage/store.ts";
import { reconcile } from "../src/storage/reconcile.ts";
import { loadConfig } from "../src/bridge/config.ts";
const [id, confirmation, ...reason] = process.argv.slice(2);
if (!id || confirmation !== "--confirm-no-writers" || !reason.length)
  throw new Error(
    'Stop bridge, inspect parent/descendants, then: npm run release-lease -- SESSION_ID --confirm-no-writers "reason and checks performed"',
  );
const root = resolve(import.meta.dirname, "..");
const store = new Store(
  resolve(root, ".bridge/bridge.sqlite"),
  loadConfig(root).limits,
);
const unlock = store.claimOwner();
try {
  reconcile(store, id, reason.join(" "));
  console.log(
    "Local reconciliation audited. Lease released for this session only; other legacy holders may still block the worktree.",
  );
} finally {
  unlock();
  store.close();
}
