import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import { Codex, type Native } from "./protocol.ts";
import { normalize } from "../events/events.ts";
export type Session = {
  id: string;
  project: string;
  threadId: string;
  activeTurnId: string | null;
  generation: string;
  status: string;
  busy?: boolean;
};
export type Approval = {
  id: string;
  nativeId: number | string;
  sessionId: string;
  turnId: string;
  generation: string;
  resolved: boolean;
  raw: Native;
};
export class Sessions extends EventEmitter {
  starting = new Set<string>();
  earlyThreads = new Map<string, Native>();
  sessions: Record<string, Session> = {};
  approvals = new Map<string, Approval>();
  generation = randomUUID();
  seq = 0;
  codex: Codex;
  dir: string;
  disk: boolean;
  projects: Record<string, string>;
  constructor(
    codex: Codex,
    dir: string,
    projects: Record<string, string>,
    disk = true,
  ) {
    super();
    this.codex = codex;
    this.disk = disk;
    this.dir = dir;
    this.projects = projects;
    if (disk) mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (disk && existsSync(`${dir}/sessions.json`)) {
      this.sessions = JSON.parse(readFileSync(`${dir}/sessions.json`, "utf8"));
      for (const s of Object.values(this.sessions)) {
        s.status = "disconnected";
        s.busy = false;
      }
    }
    if (disk && existsSync(`${dir}/events.jsonl`)) {
      const lines = readFileSync(`${dir}/events.jsonl`, "utf8")
        .trim()
        .split("\n");
      for (const l of lines) {
        try {
          this.seq = Math.max(this.seq, JSON.parse(l).sequence);
        } catch {}
      }
    }
    codex.on("native", (m) => this.native(m));
    codex.on("disconnected", (message) => {
      for (const s of Object.values(this.sessions))
        if (s.generation === this.generation) s.status = "disconnected";
      this.persist();
      this.record(null, "bridge.disconnected", { message });
    });
  }
  persist() {
    if (!this.disk) return;
    writeFileSync(
      `${this.dir}/sessions.tmp`,
      JSON.stringify(this.sessions, null, 2),
      { mode: 0o600 },
    );
    renameSync(`${this.dir}/sessions.tmp`, `${this.dir}/sessions.json`);
  }
  record(s: Session | null, type: string, raw: any) {
    const p = raw.params ?? {};
    const event = {
      sequence: ++this.seq,
      timestamp: new Date().toISOString(),
      bridgeSessionId: s?.id ?? null,
      codexThreadId: s?.threadId ?? p.threadId ?? p.thread?.id ?? null,
      turnId: p.turnId ?? p.turn?.id ?? s?.activeTurnId ?? null,
      itemId: p.itemId ?? p.item?.id ?? null,
      processGeneration: this.generation,
      type,
      raw,
    };
    if (this.disk)
      appendFileSync(`${this.dir}/events.jsonl`, JSON.stringify(event) + "\n", {
        mode: 0o600,
      });
    this.emit("event", event);
    return event;
  }
  native(m: Native) {
    for (const [id, a] of this.approvals)
      if (a.resolved) this.approvals.delete(id);
    if (this.approvals.size >= 128)
      throw new Error("Too many pending native approvals");
    const p = m.params ?? {};
    const tid = p.threadId ?? p.thread?.id;
    const s = Object.values(this.sessions).find(
      (s) => s.threadId === tid && s.generation === this.generation,
    );
    if (!s && m.method === "thread/started") {
      this.earlyThreads.set(tid, m);
      return;
    }
    if (s && m.method === "turn/started") {
      s.activeTurnId = p.turn.id;
      s.status = "running";
    }
    if (s && m.method === "turn/completed") {
      if (s.activeTurnId === p.turn.id) {
        s.activeTurnId = null;
        s.status = p.turn.status;
      }
      for (const a of this.approvals.values())
        if (a.sessionId === s.id && a.turnId === p.turn.id) a.resolved = true;
    }
    let approvalId: string | undefined;
    if (m.id !== undefined && m.method) {
      if (
        s &&
        [
          "item/commandExecution/requestApproval",
          "item/fileChange/requestApproval",
        ].includes(m.method)
      ) {
        approvalId = randomUUID();
        this.approvals.set(approvalId, {
          id: approvalId,
          nativeId: m.id,
          sessionId: s.id,
          turnId: p.turnId,
          generation: this.generation,
          resolved: false,
          raw: m,
        });
        s.status = "waiting_approval";
      } else {
        this.codex.send({
          id: m.id,
          error: {
            code: -32601,
            message: "Unsupported server request; bridge fails closed",
          },
        });
      }
    }
    if (s) this.persist();
    const e = this.record(s ?? null, normalize(m), m);
    if (approvalId)
      this.record(s ?? null, "bridge.approval.pending", {
        approvalId,
        nativeSequence: e.sequence,
      });
  }
  get(id: string) {
    const s = this.sessions[id];
    if (!s) throw new Error("Unknown session");
    return s;
  }
  live(id: string) {
    const s = this.get(id);
    if (
      s.generation !== this.generation ||
      ["disconnected", "delivery_uncertain"].includes(s.status) ||
      this.codex.closed
    )
      throw new Error("Session disconnected; resume is outside this POC");
    return s;
  }
  async start(project: string) {
    const cwd = Object.hasOwn(this.projects, project)
      ? this.projects[project]
      : undefined;
    if (!cwd) throw new Error("Project not allowlisted");
    if (
      this.starting.has(project) ||
      Object.values(this.sessions).some(
        (s) => s.project === project && s.generation === this.generation,
      )
    )
      throw new Error("One session per fixture per bridge process");
    this.starting.add(project);
    try {
      const r = await this.codex.request("thread/start", {
        cwd,
        sandbox: "workspace-write",
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        developerInstructions:
          "This is a disposable integration fixture. Work only in the current repository. Do not spawn agents. Do not access unrelated projects, secrets, networks or user files. Do not change Git config. If an operation is denied, do not retry it by another mechanism.",
      });
      const s: Session = {
        id: randomUUID(),
        project,
        threadId: r.thread.id,
        activeTurnId: null,
        generation: this.generation,
        status: "idle",
      };
      this.sessions[s.id] = s;
      this.persist();
      this.record(s, "bridge.session.created", { threadId: s.threadId });
      const early = this.earlyThreads.get(s.threadId);
      if (early) {
        this.earlyThreads.delete(s.threadId);
        this.native(early);
      }
      return s;
    } finally {
      this.starting.delete(project);
    }
  }
  async prompt(id: string, text: string) {
    const s = this.live(id);
    if (s.activeTurnId || s.busy)
      throw new Error("Session already has an active operation");
    s.busy = true;
    this.persist();
    try {
      const r = await this.codex.request("turn/start", {
        threadId: s.threadId,
        input: [{ type: "text", text }],
      });
      return r;
    } catch (e) {
      s.status = "delivery_uncertain";
      throw e;
    } finally {
      s.busy = false;
      this.persist();
    }
  }
  async steer(id: string, text: string) {
    const s = this.live(id);
    const turnId = s.activeTurnId;
    if (!turnId) return { outcome: "raced", reason: "No active turn" };
    try {
      const r = await this.codex.request("turn/steer", {
        threadId: s.threadId,
        expectedTurnId: turnId,
        input: [{ type: "text", text }],
      });
      this.record(s, "bridge.steer.result", {
        outcome: "accepted",
        turnId,
        result: r,
      });
      return { outcome: "accepted", turnId, result: r };
    } catch (e) {
      const outcome = s.activeTurnId !== turnId ? "raced" : "failed";
      this.record(s, "bridge.steer.result", {
        outcome,
        turnId,
        error: String(e),
      });
      return { outcome, turnId, error: String(e) };
    }
  }
  async interrupt(id: string) {
    const s = this.live(id);
    if (!s.activeTurnId) throw new Error("No active turn");
    const turnId = s.activeTurnId;
    await this.codex.request("turn/interrupt", {
      threadId: s.threadId,
      turnId,
    });
    return { requested: true, turnId };
  }
  approve(
    id: string,
    approvalId: string,
    generation: string,
    decision: string,
  ) {
    const s = this.live(id);
    const a = this.approvals.get(approvalId);
    if (
      !a ||
      a.resolved ||
      a.sessionId !== id ||
      a.generation !== generation ||
      generation !== this.generation ||
      a.turnId !== s.activeTurnId
    )
      throw new Error("Stale, duplicate, or mismatched approval");
    if (!["accept", "decline", "cancel"].includes(decision))
      throw new Error("Invalid decision");
    if (
      a.raw.params?.availableDecisions &&
      !a.raw.params.availableDecisions.includes(decision)
    )
      throw new Error("Decision not offered by native request");
    a.resolved = true;
    this.codex.send({ id: a.nativeId, result: { decision } });
    s.status = "running";
    this.persist();
    this.record(s, "bridge.approval.responded", { approvalId, decision });
    return { sent: true };
  }
}
