import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  AgentAdapter,
  validateText,
  type Agent,
  type Session,
  type Pending,
  type AdapterEvent,
} from "../agents/types.ts";
import { availabilityForSession } from "../agents/capabilities.ts";
import { Store } from "../storage/store.ts";
import { importLegacy } from "../storage/legacy.ts";
import { bounded, type Limits } from "../storage/bounds.ts";
import { probe } from "../supervision/process.ts";
export type Factory = (agent: Agent) => AgentAdapter;
export function worktreeIdentity(cwd: string) {
  const real = realpathSync(cwd);
  try {
    return realpathSync(
      execFileSync("git", ["-C", real, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
        maxBuffer: 8192,
      }).trim(),
    );
  } catch {
    return real;
  }
}
export class Sessions extends EventEmitter {
  sessions: Record<string, Session> = {};
  approvals = new Map<string, Pending>();
  adapters = new Map<string, AgentAdapter>();
  generation = randomUUID();
  store: Store;
  dir: string;
  projects: Record<string, string>;
  factory: Factory;
  busy = new Map<string, string>();
  contexts = new Map<string, string>();
  stopping = false;
  fatal = false;
  constructor(
    factory: Factory,
    dir: string,
    projects: Record<string, string>,
    options: { store?: Store; limits?: Partial<Limits> } = {},
  ) {
    super();
    this.factory = factory;
    this.dir = dir;
    this.projects = projects;
    this.store =
      options.store ?? new Store(join(dir, "bridge.sqlite"), options.limits);
    importLegacy(this.store, dir, (old: any) =>
      old.agent
        ? old
        : {
            id: old.id,
            agent: "codex",
            project: old.project,
            worktree: worktreeIdentity(projects[old.project]),
            nativeSessionId: old.threadId,
            lifecycle: "disconnected",
            currentTurn: {
              id: old.activeTurnId ?? null,
              nativeId: old.activeTurnId ?? null,
              idSource: "native",
              state: "unknown",
            },
            process: {
              generation: old.generation,
              state: "unknown",
              children: "unknown",
            },
            queuedInputCount: 0,
            leaseHeld: true,
            capabilities: factory("codex").capabilities(),
          },
    );
    this.sessions = this.store.sessions();
    this.store.recoverOperations();
    this.store.tx(() => {
      for (const s of Object.values(this.sessions)) {
        const prior = {
          lifecycle: s.lifecycle,
          turn: s.currentTurn.state,
          process: s.process.state,
        };
        if (!["exited", "reconciled"].includes(s.process.state)) {
          const observation = probe(s.process.identity);
          s.process.observation = observation;
          s.process.state =
            observation.state === "absent" || observation.state === "pid_reused"
              ? "exited"
              : "unknown";
          if (s.process.state === "exited")
            s.process.exitObservedAt = observation.checkedAt;
        }
        if (s.availability)
          s.availability = {
            ...s.availability,
            ready: false,
            state: "unknown",
            reason: "Not rediscovered since bridge restart",
          };
        s.lifecycle = s.controlClosed ? "closed" : "disconnected";
        if (
          [
            "submitted",
            "running",
            "waiting_approval",
            "waiting_input",
          ].includes(s.currentTurn.state)
        )
          s.currentTurn.state = "unknown";
        s.queueUncertain = !!s.queuedInputCount;
        s.reconciliationRequired = s.leaseHeld;
        s.uncertainty = [
          ...new Set([
            ...(s.uncertainty ?? []),
            "bridge_restarted_no_process_reconnect",
          ]),
        ];
        s.capabilities = availabilityForSession(
          factory(s.agent).capabilities(),
          s,
          false,
        );
        this.store.saveSession(s);
        this.store.append({
          schemaVersion: 3,
          bridgeSessionId: s.id,
          agent: s.agent,
          nativeSessionId: s.nativeSessionId,
          processGeneration: s.process.generation,
          type: "session.recovery_required",
          source: "bridge",
          raw: { prior, observation: s.process.observation },
        });
      }
    });
  }
  get seq() {
    return this.store.sequence;
  }
  persist() {
    this.store.tx(() => {
      for (const s of Object.values(this.sessions)) this.store.saveSession(s);
    });
  }
  get(id: string) {
    if (!Object.hasOwn(this.sessions, id)) throw new Error("Unknown session");
    return this.sessions[id];
  }
  record(s: Session, e: AdapterEvent) {
    if (this.fatal) return;
    try {
      for (const value of [
        e.nativeSessionId,
        e.turnId,
        e.nativeTurnId,
        e.itemId,
        e.messageId,
        e.turn?.id,
      ])
        if (typeof value === "string" && Buffer.byteLength(value) > 512)
          throw new Error(
            "Oversized native identifier; reconciliation required",
          );
      const previousClosed = s.controlClosed;
      if (e.nativeSessionId) s.nativeSessionId = e.nativeSessionId;
      if (e.state) {
        const process = e.state.process
          ? { ...s.process, ...e.state.process }
          : s.process;
        Object.assign(s, e.state);
        s.process = process;
      }
      if (previousClosed) {
        s.controlClosed = true;
        s.lifecycle = "closed";
      }
      if (e.turn) {
        const terminal = ["completed", "failed", "interrupted"].includes(
          e.turn.state ?? "",
        );
        if (!terminal || !e.turn.id || s.currentTurn.id === e.turn.id)
          s.currentTurn = { ...s.currentTurn, ...e.turn };
      }
      if (e.pending) {
        if (
          [...this.approvals.values()].filter((a) => !a.resolved).length >=
          this.store.policy.pendingApprovals
        )
          throw new Error("Too many pending callbacks");
        this.approvals.set(e.pending.id, {
          ...e.pending,
          sessionId: s.id,
          generation: s.process.generation,
          resolved: false,
          status: "pending",
        });
      }
      if (e.resolvedId) {
        const a = this.approvals.get(e.resolvedId);
        if (a) {
          a.resolved = true;
          a.status = "resolved";
        }
      }
      if (
        ["turn.completed", "turn.failed", "turn.interrupted"].includes(e.type)
      )
        for (const a of this.approvals.values())
          if (a.sessionId === s.id && a.turnId === e.turnId) {
            a.resolved = true;
            if (a.status !== "resolved") a.status = "invalidated";
          }
      if (
        ["closed", "disconnected"].includes(s.lifecycle) ||
        s.process.state === "exited"
      ) {
        for (const a of this.approvals.values())
          if (a.sessionId === s.id && !a.resolved) {
            a.resolved = true;
            a.status =
              a.status === "responding" ? "delivery_uncertain" : "invalidated";
          }
        if (
          [
            "submitted",
            "running",
            "waiting_approval",
            "waiting_input",
          ].includes(s.currentTurn.state)
        )
          s.currentTurn.state = "unknown";
        s.reconciliationRequired = s.leaseHeld;
        s.queueUncertain = !!s.queuedInputCount;
      }
      s.capabilities = availabilityForSession(
        this.adapters.get(s.id)?.capabilities() ?? s.capabilities,
        s,
        !s.reconciliationRequired && !s.controlClosed,
      );
      let event: any;
      this.store.tx(() => {
        this.store.saveSession(s);
        for (const a of this.approvals.values())
          if (a.sessionId === s.id)
            this.store.saveApproval(a, s.nativeSessionId);
        event = this.store.append({
          schemaVersion: 3,
          bridgeSessionId: s.id,
          agent: s.agent,
          nativeSessionId: s.nativeSessionId,
          codexThreadId: s.agent === "codex" ? s.nativeSessionId : null,
          processGeneration: s.process.generation,
          turnId: e.turnId ?? s.currentTurn.id,
          nativeTurnId: e.nativeTurnId ?? null,
          itemId: e.itemId ?? null,
          messageId: e.messageId ?? null,
          source: e.source,
          type: e.type,
          legacyType: e.legacyType,
          raw: e.raw,
        });
      });
      for (const [id, a] of this.approvals)
        if (a.resolved) this.approvals.delete(id);
      this.emit("event", event);
      return event;
    } catch (err) {
      this.fatal = true;
      this.emit("storage_failure", err);
      throw err;
    }
  }
  view(s: Session) {
    return {
      ...s,
      threadId: s.nativeSessionId,
      generation: s.process.generation,
      activeTurnId: [
        "submitted",
        "running",
        "waiting_approval",
        "waiting_input",
      ].includes(s.currentTurn.state)
        ? s.currentTurn.id
        : null,
      status:
        s.lifecycle === "disconnected" ? "disconnected" : s.currentTurn.state,
    };
  }
  snapshot(id: string) {
    const s = this.get(id);
    return {
      session: this.view(s),
      availability: s.availability ?? {
        state: "unknown",
        ready: false,
        reason: "Refresh /agents for current discovery",
      },
      approvals: [...this.approvals.values()]
        .filter((a) => a.sessionId === id && !a.resolved)
        .map((a) => ({
          ...a,
          raw: bounded(
            a.raw,
            Math.min(this.store.policy.rawBytes, 2048),
            this.store.policy,
          ),
        })),
      lease: this.store.lease(s.worktree) ?? null,
      queue: {
        count: s.queuedInputCount,
        state: s.queueUncertain ? "unknown" : "bridge_reported",
      },
      latestEventSequence: this.seq,
      actions: {
        stopAgent: this.adapters.has(id) && s.process.state !== "exited",
        closeSession: !s.controlClosed,
        releaseWorktree: "offline_local_only",
      },
      reconciliationRequired: !!s.reconciliationRequired,
      uncertainty: s.uncertainty ?? [],
    };
  }
  async agents() {
    return Promise.all(
      (["codex", "claude"] as Agent[]).map(async (agent) => {
        const adapter = this.factory(agent),
          availability = await adapter.availability();
        return { agent, availability, capabilities: adapter.capabilities() };
      }),
    );
  }
  resolveProject(project: string) {
    if (!Object.hasOwn(this.projects, project))
      throw new Error("Project not allowlisted");
    const cwd = realpathSync(this.projects[project]);
    return { cwd, worktree: worktreeIdentity(cwd) };
  }
  lease(worktree: string, owner?: string) {
    const held = this.store.lease(worktree);
    if (held && held.session_id !== owner)
      throw new Error(
        "Worktree already leased by a writing session (including uncertain prior processes)",
      );
    if (owner) {
      const extra = this.store.db
        .prepare(
          "SELECT 1 FROM lease_members WHERE worktree=? AND session_id<>?",
        )
        .get(worktree, owner);
      if (extra) throw new Error("Worktree has unreconciled legacy writers");
    }
  }
  dispatch(id: string) {
    const op = this.contexts.get(id);
    if (op && this.store.operation(op).state === "accepted")
      this.store.transition(op, "dispatched");
  }
  async operate(
    operationId: string,
    kind: string,
    id: string | null,
    input: any,
  ) {
    const created = this.store.createOperation(operationId, kind, id, input);
    if (!created.fresh) return { operation: created.operation, replayed: true };
    let key = id ?? `start:${input.project}`;
    try {
      if (this.stopping || this.fatal)
        throw new Error("Bridge not accepting mutations");
      if (kind === "start")
        key = `worktree:${this.resolveProject(input.project).worktree}`;
      if (this.busy.has(key))
        throw new Error("Conflicting operation in progress");
      this.busy.set(key, operationId);
      this.store.transition(operationId, "accepted");
      if (id) this.contexts.set(id, operationId);
      let result: any;
      switch (kind) {
        case "start":
          result = await this.start(
            input.project,
            input.agent ?? "codex",
            operationId,
          );
          break;
        case "prompt":
          result = await this.prompt(id!, input.text);
          break;
        case "queue":
          result = await this.queue(id!, input.text);
          break;
        case "steer":
          result = await this.steer(id!, input.text);
          break;
        case "interrupt":
          result = await this.interrupt(id!);
          break;
        case "approvals":
          result = await this.approve(
            id!,
            input.approvalId,
            input.generation,
            input.decision,
            input.answers,
          );
          break;
        case "stop":
          result = await this.stopAgent(id!);
          break;
        case "close":
          result = await this.close(id!);
          break;
        case "resume":
          result = await this.resume(id!);
          break;
        default:
          throw new Error("Unknown operation");
      }
      // A completed operation is completed request handling, not a completed native turn.
      const session = id
        ? this.get(id)
        : result?.id
          ? this.get(result.id)
          : undefined;
      if (
        this.store.operation(operationId).state === "dispatched" &&
        session?.agent === "codex" &&
        ["start", "prompt", "steer", "interrupt"].includes(kind)
      )
        this.store.transition(
          operationId,
          "native_acknowledged",
          undefined,
          undefined,
          "codex_rpc_response",
        );
      if (this.store.operation(operationId).state !== "delivery_uncertain")
        this.store.transition(operationId, "completed", result);
    } catch (e) {
      const row = this.store.operation(operationId);
      if (
        row &&
        !["completed", "failed", "delivery_uncertain"].includes(row.state)
      ) {
        const uncertain = ["dispatched", "native_acknowledged"].includes(
          row.state,
        );
        this.store.transition(
          operationId,
          uncertain ? "delivery_uncertain" : "failed",
          undefined,
          String(e),
        );
        if (id && uncertain) {
          const s = this.get(id);
          s.reconciliationRequired = true;
          s.uncertainty = [
            ...new Set([...(s.uncertainty ?? []), "delivery_uncertain"]),
          ];
          this.record(s, {
            type: "operation.delivery_uncertain",
            source: "bridge",
            raw: { operationId },
            turn: { state: "unknown" },
          });
        }
      }
    } finally {
      if (this.busy.get(key) === operationId) this.busy.delete(key);
      if (id && this.contexts.get(id) === operationId) this.contexts.delete(id);
    }
    return { operation: this.store.operation(operationId), replayed: false };
  }
  async start(project: string, agent: Agent = "codex", operationId?: string) {
    if (!["codex", "claude"].includes(agent)) throw new Error("Unknown agent");
    const { cwd, worktree } = this.resolveProject(project);
    this.lease(worktree);
    const a = this.factory(agent),
      available = await a.availability();
    if (!available.ready)
      throw new Error(`${agent} not ready: ${available.state}`);
    if (this.stopping) throw new Error("Bridge stopping");
    this.lease(worktree);
    if (Object.keys(this.sessions).length >= this.store.policy.maxSessions)
      throw new Error("Session capacity reached");
    const s: Session = {
      id: randomUUID(),
      agent,
      project,
      worktree,
      nativeSessionId: null,
      lifecycle: "starting",
      currentTurn: {
        id: null,
        nativeId: null,
        idSource: agent === "codex" ? "native" : "bridge",
        state: "idle",
      },
      process: {
        generation: a.generation,
        state: "not_started",
        children: "unknown",
      },
      queuedInputCount: 0,
      leaseHeld: true,
      capabilities: a.capabilities(),
      availability: available,
      reconciliationRequired: false,
      uncertainty: [],
    };
    this.store.tx(() => {
      this.store.saveSession(s);
      if (operationId)
        this.store.db
          .prepare("UPDATE operations SET session_id=? WHERE id=?")
          .run(s.id, operationId);
    });
    this.sessions[s.id] = s;
    this.attach(s, a);
    if (operationId) this.contexts.set(s.id, operationId);
    try {
      this.dispatch(s.id);
      await a.start({
        cwd,
        project,
        bridgeSessionId: s.id,
        stateDir: join(this.dir, "adapters", s.id),
      });
      return this.view(s);
    } catch (e) {
      try {
        await a.close();
      } catch {}
      s.lifecycle = "disconnected";
      s.reconciliationRequired = true;
      this.record(s, {
        type: "session.start_failed",
        source: "bridge",
        raw: { message: String(e) },
      });
      throw e;
    } finally {
      this.contexts.delete(s.id);
    }
  }
  attach(s: Session, a: AgentAdapter) {
    this.adapters.set(s.id, a);
    const generation = a.generation;
    a.on("event", (e: AdapterEvent) => {
      if (s.process.generation !== generation) return;
      this.record(s, e);
    });
  }
  live(id: string) {
    const s = this.get(id),
      a = this.adapters.get(id);
    if (
      !a ||
      s.controlClosed ||
      s.reconciliationRequired ||
      ["closed", "disconnected"].includes(s.lifecycle) ||
      s.currentTurn.state === "unknown"
    )
      throw new Error("Session disconnected or uncertain; cannot control");
    return { s, a };
  }
  async prompt(id: string, text: string) {
    validateText(text);
    const { s, a } = this.live(id);
    if (
      ["submitted", "running", "waiting_approval", "waiting_input"].includes(
        s.currentTurn.state,
      )
    )
      throw new Error("Turn active; use supported queue or steer");
    s.currentTurn.state = "submitted";
    this.store.tx(() => this.store.saveSession(s));
    try {
      this.dispatch(id);
      return await a.prompt(text);
    } catch (e) {
      this.record(s, {
        type: "turn.delivery_uncertain",
        source: "bridge",
        raw: { message: String(e) },
        turn: { state: "unknown" },
      });
      throw e;
    }
  }
  async queue(id: string, text: string) {
    validateText(text);
    const { a } = this.live(id);
    if (!a.capabilities().queuedInput.implemented)
      throw new Error("Queued input unsupported");
    this.dispatch(id);
    return a.queue(text);
  }
  async steer(id: string, text: string) {
    validateText(text);
    const { a } = this.live(id);
    if (!a.capabilities().activeSteering.implemented)
      throw new Error("Active steering unsupported");
    this.dispatch(id);
    return a.steer(text);
  }
  async interrupt(id: string) {
    const { s, a } = this.live(id);
    if (
      !["submitted", "running", "waiting_approval", "waiting_input"].includes(
        s.currentTurn.state,
      )
    )
      throw new Error("No active turn");
    this.dispatch(id);
    const response = await a.interrupt();
    this.record(s, {
      type: "turn.interrupt_requested",
      source: "bridge",
      raw: response,
      turn: { interruptRequested: true },
    });
    return response;
  }
  async approve(
    id: string,
    approvalId: string,
    generation: string,
    decision: string,
    answers?: Record<string, string>,
  ) {
    const { s, a } = this.live(id),
      p = this.approvals.get(approvalId);
    if (
      !p ||
      p.resolved ||
      p.sessionId !== id ||
      p.generation !== generation ||
      generation !== s.process.generation ||
      p.turnId !== s.currentTurn.id
    )
      throw new Error("Stale, duplicate, or mismatched approval");
    if (!p.decisions.includes(decision))
      throw new Error("Decision not offered");
    if (decision === "answer") {
      const questions = p.raw?.input?.questions;
      if (
        !answers ||
        Object.values(answers).some(
          (v) => typeof v !== "string" || v.length > 8000,
        ) ||
        !Array.isArray(questions) ||
        questions.some(
          (q: any) =>
            typeof q?.question !== "string" ||
            !Object.hasOwn(answers, q.question),
        )
      )
        throw new Error("Invalid question answers");
    }
    p.resolved = true;
    p.status = "responding";
    this.store.tx(() => {
      this.store.saveApproval(p, s.nativeSessionId);
      this.store.audit("approval_decision", id, {
        approvalId,
        generation,
        turnId: p.turnId,
        decision,
        answers: answers ? bounded(answers, 2048) : undefined,
      });
      this.dispatch(id);
    });
    try {
      const result = await a.respond(approvalId, decision, answers);
      p.status = "resolved";
      this.store.saveApproval(p, s.nativeSessionId);
      this.approvals.delete(approvalId);
      return result;
    } catch (e) {
      p.status = "delivery_uncertain";
      this.store.saveApproval(p, s.nativeSessionId);
      throw e;
    }
  }
  async stopAgent(id: string) {
    const s = this.get(id),
      a = this.adapters.get(id);
    if (!a)
      throw new Error(
        "No owned current-generation process to stop; local reconciliation required",
      );
    if (s.process.state === "exited") return this.view(s);
    this.dispatch(id);
    this.record(s, {
      type: "process.stop_requested",
      source: "bridge",
      raw: { scope: "owned_parent_only" },
      state: {
        process: { ...s.process, state: "closing", expectedExit: true },
        reconciliationRequired: true,
      },
    });
    await a.close();
    this.record(s, {
      type: "process.stop_finished",
      source: "bridge",
      raw: { children: "unknown" },
      state: { lifecycle: s.controlClosed ? "closed" : "disconnected" },
    });
    return this.view(s);
  }
  async close(id: string) {
    const s = this.get(id);
    s.controlClosed = true;
    s.lifecycle = "closed";
    s.reconciliationRequired = s.leaseHeld;
    for (const p of this.approvals.values())
      if (p.sessionId === id) {
        p.resolved = true;
        p.status = "invalidated";
      }
    this.record(s, {
      type: "session.closed",
      source: "bridge",
      raw: { semantics: "control_closed; parent and worktree unchanged" },
    });
    return this.view(s);
  }
  async resume(id: string) {
    const s = this.get(id);
    if (
      !s.nativeSessionId ||
      !["exited", "reconciled"].includes(s.process.state)
    )
      throw new Error(
        "Explicit resume requires saved ID and observed parent exit or local reconciliation",
      );
    if (s.process.children !== "operator_confirmed_quiet")
      throw new Error("Local descendant reconciliation required before resume");
    const a = this.factory(s.agent);
    if (!a.capabilities().historyResume.implemented)
      throw new Error("History resume not implemented");
    const availability = await a.availability();
    if (!availability.ready || this.stopping)
      throw new Error("Agent not ready");
    const { cwd, worktree } = this.resolveProject(s.project);
    if (worktree !== s.worktree) throw new Error("Project worktree changed");
    this.lease(worktree, s.id);
    this.adapters.get(id)?.removeAllListeners("event");
    s.process = {
      generation: a.generation,
      state: "not_started",
      children: "unknown",
    };
    s.lifecycle = "starting";
    s.controlClosed = false;
    s.reconciliationRequired = false;
    s.uncertainty = [];
    s.availability = availability;
    s.leaseHeld = true;
    s.currentTurn = {
      id: null,
      nativeId: null,
      idSource: "bridge",
      state: "idle",
    };
    s.queuedInputCount = 0;
    s.queueUncertain = false;
    this.store.tx(() => this.store.saveSession(s));
    this.attach(s, a);
    this.dispatch(id);
    try {
      await a.start({
        cwd,
        project: s.project,
        bridgeSessionId: s.id,
        stateDir: join(this.dir, "adapters", s.id),
        resumeId: s.nativeSessionId,
      });
      return this.view(s);
    } catch (e) {
      s.lifecycle = "disconnected";
      s.reconciliationRequired = true;
      this.store.saveSession(s);
      throw e;
    }
  }
  markGap(elapsed: number) {
    this.store.audit("observation_gap", null, {
      elapsed,
      reason:
        "Possible sleep/wake, clock change or event-loop stall; not an OS sleep notification",
    });
    for (const s of Object.values(this.sessions))
      if (this.adapters.has(s.id) && s.process.state !== "exited") {
        s.process.observation = probe(s.process.identity);
        s.reconciliationRequired = true;
        s.uncertainty = [
          ...new Set([...(s.uncertainty ?? []), "observation_gap"]),
        ];
        this.record(s, {
          type: "session.reconciliation_required",
          source: "bridge",
          raw: { elapsed, observation: s.process.observation },
          turn: { state: "unknown" },
        });
      }
  }
  async shutdown() {
    this.stopping = true;
    await Promise.allSettled(
      [...this.adapters.keys()].map((id) => this.stopAgent(id)),
    );
  }
}
