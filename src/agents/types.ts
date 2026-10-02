import { EventEmitter } from "node:events";
export type Agent = "codex" | "claude";
export type Feature =
  | "followup"
  | "queuedInput"
  | "activeSteering"
  | "turnInterrupt"
  | "processShutdown"
  | "processTermination"
  | "approval"
  | "approvalCancel"
  | "userInput"
  | "historyResume"
  | "processReconnect"
  | "streaming"
  | "fileChanges";
export type Capability = {
  supported: boolean | null;
  implemented: boolean;
  verification: "verified" | "unverified" | "unsupported" | "unknown";
  available: boolean;
  mechanism: string;
  source: string;
  evidence?: string;
  reason?: string;
};
export type Capabilities = Record<Feature, Capability>;
export type Availability = {
  agent: Agent;
  adapterInstalled: boolean;
  sdkAvailable: boolean;
  executableAvailable: boolean;
  executable?: string;
  executableSource?: string;
  version?: string;
  sdkVersion?: string;
  authentication: "authenticated" | "unauthenticated" | "unknown";
  state:
    | "ready"
    | "authentication_required"
    | "executable_unavailable"
    | "sdk_unavailable"
    | "configuration_blocked"
    | "unknown";
  ready: boolean;
  reason?: string;
};
export type Turn = {
  id: string | null;
  nativeId: string | null;
  idSource: "native" | "bridge";
  state:
    | "idle"
    | "submitted"
    | "running"
    | "waiting_approval"
    | "waiting_input"
    | "completed"
    | "failed"
    | "interrupted"
    | "unknown";
  interruptRequested?: boolean;
};
export type Session = {
  id: string;
  agent: Agent;
  project: string;
  worktree: string;
  nativeSessionId: string | null;
  lifecycle: "starting" | "alive" | "closed" | "disconnected";
  currentTurn: Turn;
  process: {
    generation: string;
    pid?: number;
    identity?: import("../supervision/process.ts").Identity;
    startedAt?: string;
    exitedAt?: string;
    exitObservedAt?: string;
    exitCode?: number | null;
    exitSignal?: string | null;
    expectedExit?: boolean;
    observation?: { state: string; checkedAt: string };
    state:
      | "not_started"
      | "running"
      | "closing"
      | "exited"
      | "unknown"
      | "reconciled";
    children: "unknown" | "operator_confirmed_quiet";
    reconciliation?: { source: "local_operator"; timestamp: string };
  };
  queuedInputCount: number;
  availability?: Availability;
  reconciliationRequired?: boolean;
  uncertainty?: string[];
  controlClosed?: boolean;
  queueUncertain?: boolean;
  leaseHeld: boolean;
  capabilities: Capabilities;
};
export type Pending = {
  id: string;
  sessionId: string;
  generation: string;
  turnId: string | null;
  kind: "approval" | "question";
  decisions: string[];
  raw: any;
  resolved: boolean;
  status?:
    | "pending"
    | "responding"
    | "resolved"
    | "invalidated"
    | "delivery_uncertain";
};
export type AdapterEvent = {
  type: string;
  source: "native" | "sdk_callback" | "bridge";
  raw: any;
  nativeSessionId?: string;
  turnId?: string | null;
  nativeTurnId?: string | null;
  itemId?: string | null;
  messageId?: string | null;
  legacyType?: string;
  pending?: Omit<Pending, "sessionId" | "generation" | "resolved">;
  state?: Partial<Session>;
  turn?: Partial<Turn>;
  resolvedId?: string;
};
export type AdapterStart = {
  cwd: string;
  project: string;
  bridgeSessionId: string;
  stateDir: string;
  resumeId?: string;
};
export abstract class AgentAdapter extends EventEmitter {
  abstract agent: Agent;
  abstract generation: string;
  abstract availability(): Promise<Availability>;
  abstract capabilities(): Capabilities;
  abstract start(options: AdapterStart): Promise<void>;
  abstract prompt(text: string): Promise<any>;
  async queue(_text: string): Promise<any> {
    throw new Error("Queued input unsupported");
  }
  async steer(_text: string): Promise<any> {
    throw new Error("Active steering unsupported");
  }
  abstract interrupt(): Promise<any>;
  abstract respond(
    id: string,
    decision: string,
    answers?: Record<string, string>,
  ): Promise<any>;
  abstract close(): Promise<void>;
  emitEvent(event: AdapterEvent) {
    this.emit("event", event);
  }
}
export function validateText(text: unknown): asserts text is string {
  if (typeof text !== "string" || !text.trim() || text.length > 16000)
    throw new Error("Invalid prompt");
}
