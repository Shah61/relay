import type { Agent, Capabilities, Feature, Capability } from "./types.ts";
const keys: Feature[] = [
  "followup",
  "queuedInput",
  "activeSteering",
  "turnInterrupt",
  "processShutdown",
  "processTermination",
  "approval",
  "approvalCancel",
  "userInput",
  "historyResume",
  "processReconnect",
  "streaming",
  "fileChanges",
];
const sources = {
  codex: "https://developers.openai.com/codex/app-server/",
  claude: "https://code.claude.com/docs/en/agent-sdk/overview",
};
export function capabilities(agent: Agent): Capabilities {
  const result = {} as Capabilities;
  for (const key of keys)
    result[key] = {
      supported: null,
      implemented: false,
      verification: "unknown",
      available: false,
      mechanism: "Not established",
      source: sources[agent],
    };
  const set = (key: Feature, mechanism: string, verified = false) => {
    result[key] = {
      supported: true,
      implemented: true,
      verification: verified ? "verified" : "unverified",
      available: false,
      mechanism,
      source: sources[agent],
      ...(verified
        ? {
            evidence:
              "docs/evidence/latest-run.json (Phase 2; Codex 0.153.4, before common-layer refactor)",
          }
        : {}),
    };
  };
  if (agent === "codex") {
    set("followup", "turn/start on the same thread", true);
    set("activeSteering", "turn/steer with expectedTurnId", true);
    set(
      "turnInterrupt",
      "turn/interrupt; native turn terminal required; shell children may survive",
      true,
    );
    set("approval", "command/file requestApproval → accept", true);
    set(
      "approvalCancel",
      "offered cancel decision denies and interrupts",
      true,
    );
    set("streaming", "app-server notifications over stdio", true);
    set("fileChanges", "fileChange items and turn/diff/updated", true);
    set(
      "processShutdown",
      "stdin EOF then bounded SIGTERM; parent exit observed",
    );
    result.historyResume = {
      supported: true,
      implemented: false,
      verification: "unverified",
      available: false,
      mechanism: "thread/resume documented; not exposed by this adapter yet",
      source: sources.codex,
    };
  } else {
    set("followup", "same long-lived SDK query with streaming input");
    set(
      "queuedInput",
      "bridge FIFO; delivers the next input only after a native result",
    );
    set("turnInterrupt", "Query.interrupt(); receipt is not terminal evidence");
    set("processShutdown", "Query.close() + observed local child exit");
    set("approval", "canUseTool callback allow/deny");
    set("approvalCancel", "canUseTool deny with interrupt:true");
    set("userInput", "AskUserQuestion callback updatedInput.answers");
    set(
      "historyResume",
      "query options.resume with persisted explicit session ID",
    );
    set("streaming", "SDKMessage async iterator; includePartialMessages");
    set(
      "fileChanges",
      "successful Edit/Write tool result; tool-scoped, not complete filesystem audit",
    );
  }
  for (const key of (agent === "codex"
    ? ["queuedInput", "userInput"]
    : ["activeSteering"]) as Feature[])
    result[key] = {
      supported: false,
      implemented: false,
      verification: "unsupported",
      available: false,
      mechanism:
        "Not offered by this adapter; do not substitute another operation",
      source: sources[agent],
    };
  result.processTermination = {
    supported: null,
    implemented: false,
    verification: "unknown",
    available: false,
    mechanism: "No guarantee that every shell descendant has terminated",
    source: sources[agent],
  };
  result.processReconnect = {
    supported: false,
    implemented: false,
    verification: "unsupported",
    available: false,
    mechanism: "Cannot attach this adapter to an arbitrary existing process",
    source: sources[agent],
  };
  return result;
}
export function availabilityForSession(
  base: Capabilities,
  s: any,
  ready: boolean,
): Capabilities {
  const out = structuredClone(base);
  const live =
    ["alive", "starting"].includes(s?.lifecycle) &&
    ["running", "not_started"].includes(s?.process.state);
  const active = [
    "submitted",
    "running",
    "waiting_approval",
    "waiting_input",
  ].includes(s?.currentTurn.state);
  for (const [key, c] of Object.entries(out) as [Feature, Capability][]) {
    c.available = c.implemented && c.supported === true && ready && live;
    if (key === "followup")
      c.available &&= !active && s?.currentTurn.state !== "unknown";
    if (key === "approval" || key === "approvalCancel")
      c.available &&= s?.currentTurn.state === "waiting_approval";
    if (key === "userInput")
      c.available &&= s?.currentTurn.state === "waiting_input";
    if (
      key === "queuedInput" ||
      key === "activeSteering" ||
      key === "turnInterrupt"
    )
      c.available &&= active;
    if (key === "historyResume")
      c.available =
        c.implemented &&
        ready &&
        !!s?.nativeSessionId &&
        ["exited", "reconciled"].includes(s?.process.state);
    if (!c.available)
      c.reason = !ready
        ? "Agent not ready"
        : !c.implemented
          ? "Not implemented"
          : "Unavailable in current session state";
  }
  return out;
}
