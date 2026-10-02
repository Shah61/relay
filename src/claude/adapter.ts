import { BoundedNativeStream } from "../supervision/framing.ts";
import { limits, type Limits } from "../storage/bounds.ts";
import { identity } from "../supervision/process.ts";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  query,
  type Query,
  type SDKUserMessage,
  type SDKMessage,
  type CanUseTool,
  type PermissionResult,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import {
  AgentAdapter,
  type AdapterStart,
  type Availability,
} from "../agents/types.ts";
import { applyLiveEvidence } from "../agents/verification.ts";
import { capabilities } from "../agents/capabilities.ts";
import { discoverClaude, subscriptionEnvironment } from "./discovery.ts";
export class InputStream implements AsyncIterable<SDKUserMessage> {
  values: SDKUserMessage[] = [];
  waiter?: (r: IteratorResult<SDKUserMessage>) => void;
  ended = false;
  push(v: SDKUserMessage) {
    if (this.ended) throw new Error("Input closed");
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      w({ value: v, done: false });
    } else this.values.push(v);
  }
  end() {
    this.ended = true;
    this.values = [];
    this.waiter?.({ value: undefined, done: true });
    this.waiter = undefined;
  }
  [Symbol.asyncIterator]() {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        if (this.values.length)
          return Promise.resolve({ value: this.values.shift()!, done: false });
        if (this.ended)
          return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => {
          this.waiter = r;
        });
      },
    };
  }
}
type Decision = {
  resolve: (r: PermissionResult) => void;
  input: Record<string, unknown>;
  tool: string;
  cleanup: () => void;
};
export type ClaudeDependencies = {
  query: typeof query;
  discover: () => Promise<Availability>;
};
export class ClaudeAdapter extends AgentAdapter {
  agent = "claude" as const;
  generation = randomUUID();
  input = new InputStream();
  stream?: Query;
  sessionId?: string;
  active?: string;
  queued: { id: string; text: string }[] = [];
  decisions = new Map<string, Decision>();
  toolNames = new Map<string, string>();
  closing = false;
  finished?: Promise<void>;
  processExit?: Promise<void>;
  private options?: AdapterStart;
  deps: ClaudeDependencies;
  lastAvailability?: Availability;
  policy: Limits;
  constructor(
    configuredPath?: string,
    deps?: ClaudeDependencies,
    config: Partial<Limits> = {},
  ) {
    super();
    this.policy = limits(config);
    this.deps = deps ?? {
      query,
      discover: () => discoverClaude(configuredPath),
    };
  }
  capabilities() {
    return applyLiveEvidence(capabilities(this.agent), this.lastAvailability);
  }
  async availability() {
    this.lastAvailability = await this.deps.discover();
    return this.lastAvailability;
  }
  async start(o: AdapterStart) {
    const a = await this.availability();
    if (!a.ready || a.authentication !== "authenticated" || !a.executable)
      throw new Error(`Claude not ready: ${a.state}. ${a.reason ?? ""}`);
    this.options = o;
    this.sessionId = o.resumeId;
    const options: Options = {
      cwd: o.cwd,
      pathToClaudeCodeExecutable: a.executable,
      env: subscriptionEnvironment(),
      settingSources: [],
      disallowedTools: ["Agent", "Task"],
      permissionMode: "default",
      permissionPrompts: "host",
      canUseTool: this.permission,
      includePartialMessages: true,
      persistSession: true,
      resume: o.resumeId,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append:
          "Operate only in the configured project. Do not delegate, use remote/cloud execution, or access unrelated repositories. If denied, do not retry by another mechanism.",
      },
      mcpServers: {},
      strictMcpConfig: true,
      spawnClaudeCodeProcess: (opts) => {
        // Called by the official SDK. The HTTP client cannot supply command/args/env.
        const child = spawn(opts.command, opts.args, {
          cwd: opts.cwd,
          env: opts.env,
          signal: opts.signal,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        this.processExit = new Promise((resolve) => {
          child.once("exit", (code, signal) => {
            this.emitEvent({
              type: "session.state_changed",
              source: "bridge",
              raw: { code, signal },
              state: {
                lifecycle: this.closing ? "closed" : "disconnected",
                process: {
                  generation: this.generation,
                  state: "exited",
                  children: "unknown",
                  exitedAt: new Date().toISOString(),
                  exitCode: code,
                  exitSignal: signal,
                  expectedExit: this.closing,
                },
              },
            });
            resolve();
          });
          child.once("error", (e) => {
            this.emitEvent({
              type: "agent.error",
              source: "bridge",
              raw: { message: e.message },
              state: {
                process: {
                  generation: this.generation,
                  state: "unknown",
                  children: "unknown",
                },
              },
            });
            resolve();
          });
        });
        this.emitEvent({
          type: "session.state_changed",
          source: "bridge",
          raw: { pid: child.pid },
          state: {
            process: {
              generation: this.generation,
              state: "running",
              children: "unknown",
              pid: child.pid,
              identity: child.pid ? identity(child.pid) : undefined,
              startedAt: new Date().toISOString(),
            },
          },
        });
        const stdout = child.stdout.pipe(
          new BoundedNativeStream(this.policy.transportBytes, (bytes) => {
            this.emitEvent({
              type: "native.frame_rejected",
              source: "bridge",
              raw: {
                truncated: true,
                observedBytesAtLeast: bytes,
                reason: "native_frame_limit",
              },
              turn: { state: "unknown" },
              state: { reconciliationRequired: true },
            });
            if (child.exitCode === null && child.signalCode === null)
              child.kill("SIGTERM");
          }),
        );
        // An SDK consumer observes stream failure; this listener also prevents an unhandled error during startup.
        stdout.on("error", () => {});
        child.stderr.on("data", (b) =>
          this.emitEvent({
            type: "native.diagnostic",
            source: "native",
            raw: {
              message: b.subarray(0, this.policy.errorBytes).toString(),
              truncated: b.length > this.policy.errorBytes,
              originalBytes: b.length,
            },
          }),
        );
        return {
          stdin: child.stdin,
          stdout,
          get killed() {
            return child.killed;
          },
          get exitCode() {
            return child.exitCode;
          },
          get signalCode() {
            return child.signalCode;
          },
          kill: child.kill.bind(child),
          on: child.on.bind(child),
          once: child.once.bind(child),
          off: child.off.bind(child),
        };
      },
    };
    this.stream = this.deps.query({ prompt: this.input, options });
    this.finished = this.consume();
    // query() construction is not proof of a session. Only native init marks it alive.
  }
  async consume() {
    try {
      for await (const m of this.stream!) this.receive(m);
    } catch (e) {
      this.emitEvent({
        type: "agent.error",
        source: "bridge",
        raw: { message: String(e) },
        turn: { state: "unknown" },
      });
    } finally {
      this.cancelDecisions();
      this.input.end();
      this.emitEvent({
        type: "session.state_changed",
        source: "bridge",
        raw: { reason: "sdk_stream_ended" },
        state: {
          lifecycle: this.closing ? "closed" : "disconnected",
          queuedInputCount: 0,
        },
        turn: this.active ? { state: "unknown" } : undefined,
      });
    }
  }
  receive(m: SDKMessage) {
    const raw: any = m;
    const common = {
      source: "native" as const,
      raw: m,
      nativeSessionId: raw.session_id ?? this.sessionId,
      turnId: this.active ?? null,
      nativeTurnId: null,
      messageId: raw.uuid ?? null,
    };
    if (raw.parent_tool_use_id) {
      this.emitEvent({ ...common, type: "native.subagent_event" });
      return;
    }
    if (raw.session_id) this.sessionId = raw.session_id;
    if (m.type === "system" && m.subtype === "init") {
      this.emitEvent({
        ...common,
        type: "session.started",
        state: { lifecycle: "alive", nativeSessionId: m.session_id },
      });
      return;
    }
    if (m.type === "result") {
      const interrupted = ["aborted_streaming", "aborted_tools"].includes(
        (m as any).terminal_reason,
      );
      const type = interrupted
        ? "turn.interrupted"
        : m.is_error || m.subtype !== "success"
          ? "turn.failed"
          : "turn.completed";
      this.cancelDecisions();
      this.emitEvent({
        ...common,
        type,
        turn: {
          id: this.active ?? null,
          nativeId: null,
          idSource: "bridge",
          state: interrupted
            ? "interrupted"
            : type === "turn.failed"
              ? "failed"
              : "completed",
        },
      });
      this.active = undefined;
      this.toolNames.clear();
      // Deliberately bridge-serialized queue. No native coalescing/steering claim.
      if (!this.closing && this.queued.length) {
        const next = this.queued.shift()!;
        this.dispatch(next.id, next.text);
      }
      return;
    }
    if (m.type === "assistant") {
      this.emitEvent({
        ...common,
        type: raw.error ? "agent.error" : "agent.message",
        turn: { state: "running" },
      });
      for (const block of m.message.content) {
        if (block.type === "tool_use") {
          if (this.toolNames.size >= 128)
            throw new Error(
              "Too many unresolved tool items; reconciliation required",
            );
          this.toolNames.set(block.id, block.name);
          this.emitEvent({ ...common, type: "tool.started", itemId: block.id });
        }
      }
      return;
    }
    if (m.type === "user" && Array.isArray(m.message.content)) {
      for (const b of m.message.content) {
        if (b.type === "tool_result") {
          this.emitEvent({
            ...common,
            type: "tool.completed",
            itemId: b.tool_use_id,
          });
          if (
            !b.is_error &&
            ["Edit", "Write", "NotebookEdit"].includes(
              this.toolNames.get(b.tool_use_id) ?? "",
            )
          )
            this.emitEvent({
              ...common,
              type: "file.changed",
              itemId: b.tool_use_id,
            });
          this.toolNames.delete(b.tool_use_id);
        }
      }
    }
    if (m.type === "stream_event") {
      const event: any = m.event;
      const delta = event.type === "content_block_delta" ? event.delta : null;
      this.emitEvent({
        ...common,
        type:
          delta?.type === "text_delta" ? "agent.message.delta" : "native.event",
        turn: { state: "running" },
      });
      return;
    }
    this.emitEvent({ ...common, type: "native.event" });
  }
  dispatch(id: string, text: string) {
    this.active = id;
    this.emitEvent({
      type: "turn.submitted",
      source: "bridge",
      raw: { inputId: id },
      turnId: id,
      turn: {
        id,
        nativeId: null,
        idSource: "bridge",
        state: "submitted",
        interruptRequested: false,
      },
      state: { queuedInputCount: this.queued.length },
    });
    this.input.push({
      type: "user",
      uuid: id as `${string}-${string}-${string}-${string}-${string}`,
      session_id: this.sessionId,
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    });
  }
  async prompt(text: string) {
    if (this.closing || !this.stream || this.input.ended)
      throw new Error("Claude session not available");
    if (this.active) throw new Error("Turn active; use explicit queue");
    const id = randomUUID();
    this.dispatch(id, text);
    return { turn: { id, status: "submitted", idSource: "bridge" } };
  }
  async queue(text: string) {
    if (!this.active || this.closing || this.input.ended)
      throw new Error("No active turn to queue behind");
    if (this.queued.length >= 16) throw new Error("Queue full");
    const id = randomUUID();
    this.queued.push({ id, text });
    this.emitEvent({
      type: "input.queued",
      source: "bridge",
      raw: { inputId: id, semantics: "bridge_fifo_after_native_result" },
      state: { queuedInputCount: this.queued.length },
    });
    return {
      inputId: id,
      outcome: "queued",
      semantics: "bridge_fifo_after_native_result",
    };
  }
  permission: CanUseTool = async (tool, input, options) => {
    if (this.closing || options.signal.aborted)
      return { behavior: "deny", message: "Session closed or request aborted" };
    const id = randomUUID();
    const question = tool === "AskUserQuestion";
    return new Promise<PermissionResult>((resolve) => {
      const abort = () => {
        if (!this.decisions.has(id)) return;
        this.decisions.delete(id);
        resolve({ behavior: "deny", message: "Permission request aborted" });
        this.emitEvent({
          type: "approval.resolved",
          source: "sdk_callback",
          raw: { id, reason: "aborted" },
          resolvedId: id,
        });
      };
      this.decisions.set(id, {
        resolve,
        input,
        tool,
        cleanup: () => options.signal.removeEventListener("abort", abort),
      });
      options.signal.addEventListener("abort", abort, { once: true });
      const raw = {
        toolName: tool,
        input,
        toolUseID: options.toolUseID,
        requestId: options.requestId,
        decisionReason: options.decisionReason,
      };
      this.emitEvent({
        type: question ? "input.requested" : "approval.requested",
        source: "sdk_callback",
        raw,
        turnId: this.active ?? null,
        itemId: options.toolUseID,
        turn: { state: question ? "waiting_input" : "waiting_approval" },
        pending: {
          id,
          turnId: this.active ?? null,
          kind: question ? "question" : "approval",
          decisions: question
            ? ["answer", "decline", "cancel"]
            : ["accept", "decline", "cancel"],
          raw,
        },
      });
    });
  };
  async respond(
    id: string,
    decision: string,
    answers?: Record<string, string>,
  ) {
    const p = this.decisions.get(id);
    if (!p) throw new Error("Stale or duplicate callback");
    if (decision === "answer") {
      if (
        p.tool !== "AskUserQuestion" ||
        !answers ||
        Object.values(answers).some(
          (v) => typeof v !== "string" || v.length > 8000,
        )
      )
        throw new Error("Invalid question answers");
      const questions = p.input.questions;
      if (
        !Array.isArray(questions) ||
        questions.some(
          (q) =>
            typeof q?.question !== "string" ||
            !Object.hasOwn(answers, q.question),
        )
      )
        throw new Error("Answers must cover the native questions");
    } else if (
      !["accept", "decline", "cancel"].includes(decision) ||
      (p.tool === "AskUserQuestion" && decision === "accept")
    )
      throw new Error("Invalid decision");
    this.decisions.delete(id);
    p.cleanup();
    p.resolve(
      decision === "accept"
        ? { behavior: "allow", updatedInput: p.input }
        : decision === "answer"
          ? { behavior: "allow", updatedInput: { ...p.input, answers } }
          : {
              behavior: "deny",
              message: "Denied by bridge user",
              interrupt: decision === "cancel",
            },
    );
    this.emitEvent({
      type: "approval.resolved",
      source: "bridge",
      raw: { id, decision },
      resolvedId: id,
      turn: { state: "running" },
    });
    return { sent: true };
  }
  async interrupt() {
    if (!this.active || !this.stream) throw new Error("No active turn");
    const receipt = await this.stream.interrupt();
    this.emitEvent({
      type: "turn.interrupt_requested",
      source: "bridge",
      raw: { receipt: receipt ?? null },
      turn: { interruptRequested: true },
    });
    return {
      requested: true,
      turnId: this.active,
      receipt: receipt ?? null,
      queuedInputRetained: this.queued.length,
    };
  }
  cancelDecisions() {
    for (const [id, p] of this.decisions) {
      p.cleanup();
      p.resolve({ behavior: "deny", message: "Session or turn ended" });
      this.emitEvent({
        type: "approval.resolved",
        source: "bridge",
        raw: { id, reason: "ended" },
        resolvedId: id,
      });
    }
    this.decisions.clear();
  }
  async close() {
    this.closing = true;
    this.queued = [];
    this.cancelDecisions();
    this.input.end();
    this.stream?.close();
    await Promise.race([
      Promise.all([this.finished, this.processExit]),
      new Promise((_, reject) => {
        const t = setTimeout(
          () => reject(new Error("Claude shutdown unconfirmed")),
          6000,
        );
        t.unref();
      }),
    ]);
  }
}
