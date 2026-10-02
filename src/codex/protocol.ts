import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { BoundedLines } from "../supervision/framing.ts";
import { limits, type Limits } from "../storage/bounds.ts";
import { identity } from "../supervision/process.ts";
import { EventEmitter } from "node:events";
import { findExecutable } from "../platform/host.ts";
export type Native = {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
};
export class Codex extends EventEmitter {
  child: ChildProcessWithoutNullStreams;
  next = 0;
  pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  closed = false;
  constructor(config: Partial<Limits> = {}, executable?: string) {
    super();
    const policy = limits(config);
    const binary = findExecutable("codex", executable);
    if (!binary)
      throw Error(
        "Codex executable not found. Install the official CLI on this computer.",
      );
    this.child = spawn(binary, ["app-server", "--listen", "stdio://"], {
      stdio: "pipe",
      windowsHide: true,
    });
    const lines = new BoundedLines(
      policy.transportBytes,
      (line) => {
        let message: Native;
        try {
          message = JSON.parse(line);
        } catch {
          this.fail(new Error("Malformed native protocol message"));
          this.close();
          return;
        }
        this.receive(message);
      },
      (bytes) => {
        this.emit("diagnostic", {
          truncated: true,
          reason: "native_frame_limit",
          observedBytesAtLeast: bytes,
        });
        this.fail(new Error("Oversized native frame; delivery uncertain"));
        this.close();
      },
    );
    this.child.stdout.on("data", (chunk) => lines.push(chunk));
    this.child.on("spawn", () =>
      this.emit("process_spawn", {
        pid: this.child.pid,
        identity: identity(this.child.pid!),
        startedAt: new Date().toISOString(),
      }),
    );
    this.child.stderr.on("data", (b) =>
      this.emit(
        "diagnostic",
        b.subarray(0, policy.errorBytes).toString() +
          (b.length > policy.errorBytes ? " [TRUNCATED STDERR]" : ""),
      ),
    );
    this.child.on("error", (e) => this.fail(e));
    this.child.on("exit", (code, signal) => {
      this.emit("process_exit", { code, signal });
      this.fail(new Error(`Codex exited: ${code}/${signal}`));
    });
  }
  receive(m: Native) {
    if (m.method) {
      this.emit("native", m);
      return;
    }
    const p = this.pending.get(m.id as number);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(m.id as number);
    if (m.error) p.reject(new Error(JSON.stringify(m.error)));
    else p.resolve(m.result);
  }
  send(m: Native) {
    if (this.closed) throw new Error("Codex disconnected");
    this.child.stdin.write(JSON.stringify(m) + "\n");
  }
  request(method: string, params: any): Promise<any> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `${method} timed out; delivery uncertain; do not retry blindly`,
          ),
        );
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "local_agent_bridge_poc", version: "0.1.0" },
    });
    this.send({ method: "initialized", params: {} });
  }
  fail(e: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
    this.emit("disconnected", e.message);
  }
  close() {
    this.child.stdin.end();
    const t = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null)
        this.child.kill("SIGTERM");
    }, 3000);
    this.child.once("exit", () => clearTimeout(t));
    t.unref();
  }
}
