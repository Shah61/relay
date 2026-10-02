import { type Limits } from "../storage/bounds.ts";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  AgentAdapter,
  type AdapterStart,
  type Availability,
} from "../agents/types.ts";
import { capabilities } from "../agents/capabilities.ts";
import { Codex } from "./protocol.ts";
import { Sessions } from "./sessions.ts";
import { findExecutable } from "../platform/host.ts";
import { discoverModels, listModels, selectModel } from './models.ts';
export class CodexAdapter extends AgentAdapter {
  agent = "codex" as const;
  generation = randomUUID();
  engine?: Sessions;
  rpc?: Codex;
  id?: string;
  config: Partial<Limits>;
  closing = false;
  executable?: string;
  constructor(
    privateTransport?: Codex,
    config: Partial<Limits> = {},
    executable?: string,
  ) {
    super();
    this.rpc = privateTransport;
    this.config = config;
    this.executable = executable;
  }
  capabilities() {
    return capabilities(this.agent);
  }
  async availability(): Promise<Availability> {
    try {
      const executable = findExecutable("codex", this.executable);
      if (!executable) throw Error("Codex not installed");
      const { stdout } = await promisify(execFile)(executable, ["--version"], {
        timeout: 10000,
        windowsHide: true,
      });
      let models, modelError;
      try { models = await discoverModels(executable); }
      catch (error) { modelError = error instanceof Error ? error.message : String(error); }
      return {
        models, modelError,
        agent: "codex",
        adapterInstalled: true,
        sdkAvailable: true,
        executableAvailable: true,
        version: stdout.trim(),
        authentication: "unknown",
        state: "ready",
        ready: true,
        reason:
          "Models come from this computer’s Codex catalog; account access is checked when a task runs.",
      };
    } catch {
      return {
        agent: "codex",
        adapterInstalled: true,
        sdkAvailable: true,
        executableAvailable: false,
        authentication: "unknown",
        state: "executable_unavailable",
        ready: false,
      };
    }
  }
  async start(o: AdapterStart) {
    if (o.resumeId)
      throw new Error(
        "Codex history resume is documented but not implemented in this adapter",
      );
    this.rpc ??= new Codex(this.config, this.executable);
    const rpc = this.rpc;
    this.emitEvent({
      type: "session.state_changed",
      source: "bridge",
      raw: { reason: "app_server_spawn_requested" },
      state: {
        process: {
          generation: this.generation,
          state: "running",
          children: "unknown",
        },
      },
    });
    const engine = (this.engine = new Sessions(
      rpc,
      o.stateDir,
      {
        [o.project]: o.cwd,
      },
      false,
    ));
    engine.generation = this.generation;
    rpc.on("process_spawn", (meta) =>
      this.emitEvent({
        type: "process.started",
        source: "bridge",
        raw: meta,
        state: {
          process: {
            generation: this.generation,
            state: "running",
            children: "unknown",
            ...meta,
          },
        },
      }),
    );
    rpc.on("diagnostic", (message) =>
      this.emitEvent({
        type: "native.diagnostic",
        source: "native",
        raw: { message },
      }),
    );
    rpc.on("disconnected", (message) =>
      this.emitEvent({
        type: "session.state_changed",
        source: "bridge",
        raw: { message },
        state: {
          lifecycle: "disconnected",
          process: {
            generation: this.generation,
            state:
              rpc.child?.exitCode != null || rpc.child?.signalCode != null
                ? "exited"
                : "unknown",
            children: "unknown",
          },
        },
      }),
    );
    rpc.on("process_exit", (raw) =>
      this.emitEvent({
        type: "session.state_changed",
        source: "bridge",
        raw,
        state: {
          process: {
            generation: this.generation,
            state: "exited",
            children: "unknown",
            exitedAt: new Date().toISOString(),
            exitCode: raw.code,
            exitSignal: raw.signal,
            expectedExit: this.closing,
          },
        },
      }),
    );
    engine.on("event", (e) => {
      const p = e.raw.params ?? {};
      const ev: any = {
        type: e.type,
        legacyType: e.type,
        source: e.raw.method ? "native" : "bridge",
        raw: e.raw,
        nativeSessionId: e.codexThreadId ?? undefined,
        turnId: e.turnId,
        nativeTurnId: e.turnId,
        itemId: e.itemId,
      };
      const mapping: Record<string, string> = {
        "commandExecution.started": "tool.started",
        "commandExecution.completed": "tool.completed",
        "command.output": "tool.output",
        "fileChange.completed": "file.changed",
        "native.event": "native.event",
      };
      ev.type = mapping[e.type] ?? e.type;
      if (e.type === "session.started")
        ev.state = {
          lifecycle: "alive",
          nativeSessionId: e.codexThreadId,
          process: {
            generation: this.generation,
            state: "running",
            children: "unknown",
          },
        };
      if (e.type === "turn.started")
        ev.turn = {
          id: e.turnId,
          nativeId: e.turnId,
          idSource: "native",
          state: "running",
          interruptRequested: false,
        };
      if (
        ["turn.completed", "turn.failed", "turn.interrupted"].includes(e.type)
      )
        ev.turn = {
          id: e.turnId,
          nativeId: e.turnId,
          idSource: "native",
          state: e.type.slice(5),
        };
      if (e.type === "bridge.approval.pending") {
        const a = engine.approvals.get(e.raw.approvalId)!;
        ev.type = "approval.requested";
        ev.source = "native";
        ev.raw = a.raw;
        ev.pending = {
          id: a.id,
          turnId: a.turnId,
          kind: "approval",
          decisions: (
            a.raw.params?.availableDecisions ?? ["accept", "decline", "cancel"]
          ).filter(
            (d: any) =>
              typeof d === "string" &&
              ["accept", "decline", "cancel"].includes(d),
          ),
          raw: a.raw,
        };
        ev.turn = { state: "waiting_approval" };
      }
      // The raw request is retained once, with the bridge correlation ID added above.
      if (e.type === "approval.requested") return;
      if (e.type === "bridge.approval.responded") {
        ev.type = "approval.resolved";
        ev.resolvedId = e.raw.approvalId;
        ev.turn = { state: "running" };
      }
      this.emitEvent(ev);
    });
    await rpc.initialize();
    const settings = selectModel(await listModels(rpc), o.model, o.reasoningEffort);
    const s = await engine.start(o.project, settings);
    this.id = s.id;
    this.emitEvent({
      type: "session.state_changed",
      source: "bridge",
      raw: { reason: "adapter_ready" },
      nativeSessionId: s.threadId,
      state: {
        lifecycle: "alive",
        nativeSessionId: s.threadId,
        process: {
          generation: this.generation,
          state: "running",
          children: "unknown",
        },
      },
    });
  }
  prompt(text: string) {
    return this.engine!.prompt(this.id!, text);
  }
  steer(text: string) {
    return this.engine!.steer(this.id!, text);
  }
  interrupt() {
    return this.engine!.interrupt(this.id!);
  }
  async respond(id: string, decision: string) {
    return this.engine!.approve(this.id!, id, this.generation, decision);
  }
  async close() {
    this.closing = true;
    if (!this.rpc) return;
    const rpc = this.rpc;
    if (
      rpc.child
        ? rpc.child.exitCode !== null || rpc.child.signalCode !== null
        : rpc.closed
    )
      return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Codex shutdown unconfirmed")),
        6000,
      );
      timer.unref();
      rpc.once(rpc.child ? "process_exit" : "disconnected", () => {
        clearTimeout(timer);
        resolve();
      });
      rpc.close();
    });
  }
}
