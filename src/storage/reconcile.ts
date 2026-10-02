import type { Store } from "./store.ts";
import { probe } from "../supervision/process.ts";
export function reconcile(store: Store, id: string, reason: string) {
  if (!reason.trim() || reason.length > 1000)
    throw new Error("A local reconciliation reason is required");
  const s = store.sessions()[id];
  if (!s) throw new Error("Unknown session");
  const observation = probe(s.process.identity);
  if (observation.state === "alive_identity_match")
    throw new Error(
      "Recorded parent is still present; stop it before reconciliation",
    );
  store.tx(() => {
    s.leaseHeld = false;
    s.lifecycle = "closed";
    s.controlClosed = true;
    s.process.state = "reconciled";
    s.process.children = "operator_confirmed_quiet";
    s.process.reconciliation = {
      source: "local_operator",
      timestamp: new Date().toISOString(),
    };
    s.process.observation = observation;
    s.reconciliationRequired = false;
    s.uncertainty = [];
    s.queueUncertain = !!s.queuedInputCount;
    s.currentTurn.state = "unknown";
    store.saveSession(s);
    store.db
      .prepare(
        "UPDATE approvals SET status='invalidated' WHERE session_id=? AND status IN ('pending','responding')",
      )
      .run(id);
    store.audit("local_operator_reconciliation", id, {
      reason,
      observation,
      attestation: "Parent and descendants checked; no writers remain",
      priorNativeTurnNotClaimedCompleted: true,
    });
    store.append({
      schemaVersion: 3,
      bridgeSessionId: id,
      agent: s.agent,
      type: "worktree.released",
      source: "local_operator",
      raw: { reason, observation, attested: true },
    });
  });
  return s;
}
