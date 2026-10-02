import type { Native } from "../codex/protocol.ts";
export function normalize(m: Native): string {
  const p = m.params ?? {};
  const direct: Record<string, string> = {
    error: "agent.error",
    "thread/started": "session.started",
    "turn/started": "turn.started",
    "item/agentMessage/delta": "agent.message",
    "item/reasoning/summaryTextDelta": "agent.thinking",
    "item/commandExecution/outputDelta": "command.output",
    "turn/diff/updated": "diff.updated",
  };
  if (m.method === "turn/completed")
    return `turn.${p.turn?.status ?? "unknown"}`;
  if (m.method?.endsWith("/requestApproval")) return "approval.requested";
  if (m.method === "item/started" || m.method === "item/completed")
    return `${p.item?.type ?? "item"}.${m.method.split("/")[1]}`;
  return direct[m.method ?? ""] ?? "native.event";
}
