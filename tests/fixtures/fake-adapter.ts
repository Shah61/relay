// Explicit test-only adapter. Never loaded by the production server. No models/providers.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  AgentAdapter,
  type Agent,
  type AdapterStart,
} from "../../src/agents/types.ts";
import { capabilities } from "../../src/agents/capabilities.ts";
import { identity } from "../../src/supervision/process.ts";
export class FakeAdapter extends AgentAdapter {
  agent: Agent;
  generation = randomUUID();
  child?: ChildProcessWithoutNullStreams;
  dir: string;
  active?: string;
  closing = false;
  constructor(agent: Agent, dir: string) {
    super();
    this.agent = agent;
    this.dir = dir;
  }
  async availability() {
    return {
      agent: this.agent,
      adapterInstalled: true,
      sdkAvailable: true,
      executableAvailable: true,
      ready: true,
      state: "ready" as const,
      authentication: "unknown" as const,
    };
  }
  capabilities() {
    return capabilities(this.agent);
  }
  async start(o: AdapterStart) {
    this.child = spawn(
      process.execPath,
      [
        "-e",
        'process.stdin.resume();setInterval(()=>{},1000);process.on("SIGTERM",()=>process.exit(0));',
      ],
      { stdio: "pipe", cwd: o.cwd },
    );
    await once(this.child, "spawn");
    const meta = {
      pid: this.child.pid,
      identity: identity(this.child.pid!),
      startedAt: new Date().toISOString(),
    };
    this.child.on("exit", (exitCode, exitSignal) =>
      this.emitEvent({
        type: "process.exited",
        source: "bridge",
        raw: { testOnly: true },
        state: {
          lifecycle: this.closing ? "closed" : "disconnected",
          process: {
            generation: this.generation,
            state: "exited",
            children: "unknown",
            ...meta,
            exitedAt: new Date().toISOString(),
            exitCode,
            exitSignal,
            expectedExit: this.closing,
          },
        },
      }),
    );
    this.emitEvent({
      type: "session.started",
      source: "native",
      raw: { testOnly: true },
      nativeSessionId: o.resumeId ?? randomUUID(),
      state: {
        lifecycle: "alive",
        process: {
          generation: this.generation,
          state: "running",
          children: "unknown",
          ...meta,
        },
      },
    });
  }
  async prompt(text: string) {
    this.active = randomUUID();
    appendFileSync(
      join(this.dir, "test-deliveries.jsonl"),
      JSON.stringify({
        text,
        generation: this.generation,
        pid: this.child?.pid,
      }) + "\n",
    );
    this.emitEvent({
      type: "turn.started",
      source: "native",
      raw: { testOnly: true },
      turnId: this.active,
      turn: { id: this.active, nativeId: this.active, state: "running" },
    });
    if (text === "hold") return new Promise(() => {});
    if (text === "approval" || text === "approval-hold") {
      this.emitEvent({
        type: "approval.requested",
        source: "native",
        raw: { testOnly: true },
        turnId: this.active,
        pending: {
          id: randomUUID(),
          turnId: this.active,
          kind: "approval",
          decisions: ["accept", "decline"],
          raw: { id: 7, testOnly: true, hold: text === "approval-hold" },
        },
        turn: { state: "waiting_approval" },
      });
      return { turn: { id: this.active } };
    }
    if (text === "large")
      for (let i = 0; i < 60; i++)
        this.emitEvent({
          type: "tool.output",
          source: "native",
          raw: { output: "x".repeat(100000), testOnly: true },
          turnId: this.active,
        });
    this.emitEvent({
      type: "turn.completed",
      source: "native",
      raw: { testOnly: true },
      turnId: this.active,
      turn: { id: this.active, state: "completed" },
    });
    return { turn: { id: this.active } };
  }
  async interrupt() {
    if (this.active)
      this.emitEvent({
        type: "turn.interrupted",
        source: "native",
        raw: { testOnly: true },
        turnId: this.active,
        turn: { id: this.active, state: "interrupted" },
      });
    return { requested: true };
  }
  async respond(id: string, decision: string) {
    appendFileSync(
      join(this.dir, "test-decisions.jsonl"),
      JSON.stringify({ id, decision }) + "\n",
    );
    if (this.listenerCount("decision_hold")) {
      this.emit("decision_hold");
      return new Promise(() => {});
    }
    this.emitEvent({
      type: "approval.resolved",
      source: "bridge",
      raw: { id, decision },
      resolvedId: id,
    });
    this.emitEvent({
      type: "turn.completed",
      source: "native",
      raw: { testOnly: true },
      turnId: this.active,
      turn: { id: this.active, state: "completed" },
    });
    return { sent: true };
  }
  async close() {
    this.closing = true;
    if (
      !this.child ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    )
      return;
    const exited = once(this.child, "exit");
    this.child.kill("SIGTERM");
    await exited;
  }
}
