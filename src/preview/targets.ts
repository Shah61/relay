import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import type { Sessions } from "../sessions/manager.ts";
import { approvedTarget } from "./protocol.ts";

export type Target = {
  id: string;
  sessionId: string;
  project: string;
  host: "127.0.0.1";
  port: number;
  state: "candidate" | "approved" | "revoked";
  createdAt: number;
  lastActivity: number;
  expiresAt: number;
  previewId?: string;
  reason?: string;
};
export class PreviewTargets extends EventEmitter {
  records = new Map<string, Target>();
  sessions: Sessions;
  excluded: number[];
  tails = new Map<string, string>();
  bash = new Map<string, Set<string>>();
  timer: NodeJS.Timeout;
  constructor(sessions: Sessions, excluded: number[] = []) {
    super();
    this.sessions = sessions;
    this.excluded = excluded;
    sessions.on("event", this.observe);
    this.timer = setInterval(() => void this.sweep(), 10000);
    this.timer.unref();
  }
  observe = (event: any) => {
    const s = this.sessions.sessions[event.bridgeSessionId];
    if (!s) return;
    if (
      s.controlClosed ||
      s.archivedAt ||
      s.lifecycle !== "alive" ||
      s.process.state === "exited"
    ) {
      for (const target of this.records.values())
        if (target.sessionId === s.id) this.revoke(target.id, "session_closed");
      this.tails.delete(s.id);
      this.bash.delete(s.id);
      return;
    }
    // Only actual command output is a detection source. Assistant prose is ignored.
    let output = "";
    const p = event.raw?.params;
    if (event.type === "command.output") output = p?.delta ?? "";
    if (event.type === "commandExecution.completed")
      output = p?.item?.aggregatedOutput ?? "";
    const content = event.raw?.message?.content;
    if (s.agent === "claude" && Array.isArray(content)) {
      const tools = this.bash.get(s.id) ?? new Set<string>();
      for (const b of content) {
        if (b.type === "tool_use" && b.name === "Bash" && tools.size < 128)
          tools.add(b.id);
        if (b.type === "tool_result" && tools.has(b.tool_use_id)) {
          output +=
            typeof b.content === "string"
              ? b.content
              : Array.isArray(b.content)
                ? b.content
                    .filter((c: any) => c.type === "text")
                    .map((c: any) => c.text)
                    .join("\n")
                : "";
          tools.delete(b.tool_use_id);
        }
      }
      this.bash.set(s.id, tools);
    }
    if (typeof output !== "string" || !output) return;
    const text = ((this.tails.get(s.id) ?? "") + output.slice(-16384)).replace(
      /\x1b\[[0-9;]*m/g,
      "",
    );
    this.tails.set(s.id, text.slice(-512));
    for (const match of text.matchAll(
      /\bhttp:\/\/(?:localhost|127\.0\.0\.1):[0-9]{2,5}(?:\/)?(?=[\s\x1b]|$)/g,
    )) {
      try {
        this.candidate(s.id, match[0]);
      } catch {}
    }
  };
  candidate(sessionId: string, url: string) {
    const s = this.sessions.get(sessionId);
    if (s.controlClosed || s.archivedAt || s.lifecycle !== "alive")
      throw Error("session_unavailable");
    const target = approvedTarget(url, this.excluded);
    const prior = [...this.records.values()].find(
      (r) =>
        r.sessionId === sessionId &&
        r.port === target.port &&
        r.state !== "revoked" &&
        r.expiresAt > Date.now(),
    );
    if (prior) return prior;
    for (const [id, r] of this.records)
      if (r.state === "revoked" || r.expiresAt <= Date.now())
        this.records.delete(id);
    if (this.records.size >= 32) throw Error("preview_capacity");
    const now = Date.now();
    const r: Target = {
      id: randomUUID(),
      sessionId,
      project: s.project,
      ...target,
      state: "candidate",
      createdAt: now,
      lastActivity: now,
      expiresAt: now + 3600000,
    };
    this.records.set(r.id, r);
    this.emit("change", r);
    return r;
  }
  get(id: string) {
    const r = this.records.get(id);
    if (!r) throw Error("preview_not_found");
    return r;
  }
  active(id: string) {
    const r = this.get(id),
      s = this.sessions.get(r.sessionId);
    approvedTarget(`http://${r.host}:${r.port}`, this.excluded);
    if (
      r.state !== "approved" ||
      r.expiresAt <= Date.now() ||
      s.controlClosed ||
      s.archivedAt ||
      s.lifecycle !== "alive"
    )
      throw Error("preview_unavailable");
    return r;
  }
  probe(r: Target) {
    return new Promise<boolean>((resolve) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: r.port,
          path: "/",
          method: "HEAD",
          agent: false,
          timeout: 1500,
        },
        (response) => {
          response.destroy();
          resolve(true);
        },
      );
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve(false));
      req.end();
    });
  }
  async approve(id: string) {
    const r = this.get(id),
      s = this.sessions.get(r.sessionId);
    if (
      r.state !== "candidate" ||
      r.expiresAt <= Date.now() ||
      s.controlClosed ||
      s.lifecycle !== "alive"
    )
      throw Error("preview_unavailable");
    if (!(await this.probe(r))) throw Error("dev_server_unavailable");
    if (
      r.state !== "candidate" ||
      r.expiresAt <= Date.now() ||
      s.controlClosed ||
      s.lifecycle !== "alive"
    )
      throw Error("preview_unavailable");
    r.state = "approved";
    r.expiresAt = Date.now() + 3600000;
    this.sessions.store.audit("preview_approved", r.sessionId, {
      id,
      port: r.port,
    });
    this.emit("change", r);
    return r;
  }
  revoke(id: string, reason = "disabled") {
    const r = this.records.get(id);
    if (!r || r.state === "revoked") return;
    r.state = "revoked";
    r.reason = reason;
    r.previewId = undefined;
    this.tails.delete(r.sessionId);
    this.emit("change", r);
  }
  async sweep() {
    for (const r of this.records.values()) {
      if (r.state === "revoked") continue;
      const s = this.sessions.sessions[r.sessionId];
      if (
        r.expiresAt <= Date.now() ||
        !s ||
        s.controlClosed ||
        s.lifecycle !== "alive"
      )
        this.revoke(r.id, "expired_or_closed");
      else if (r.state === "approved" && !(await this.probe(r)))
        this.revoke(r.id, "server_stopped");
    }
  }
  view(projects: string[]) {
    return [...this.records.values()]
      .filter(
        (r) =>
          projects.includes(r.project) &&
          r.state !== "revoked" &&
          r.expiresAt > Date.now(),
      )
      .map((r) => ({
        id: r.id,
        previewId: r.previewId,
        sessionId: r.sessionId,
        project: r.project,
        label: `localhost:${r.port}`,
        state:
          r.state === "approved"
            ? r.previewId
              ? "running"
              : "connecting"
            : "candidate",
        expiresAt: r.expiresAt,
      }));
  }
  close() {
    clearInterval(this.timer);
    this.sessions.off("event", this.observe);
  }
}
