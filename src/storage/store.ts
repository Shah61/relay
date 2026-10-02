import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { bounded, canonical, hash, limits, type Limits } from "./bounds.ts";
import { identity, probe } from "../supervision/process.ts";
import { randomUUID } from "node:crypto";
import type { Session, Pending } from "../agents/types.ts";
export type OpState =
  | "received"
  | "accepted"
  | "dispatched"
  | "native_acknowledged"
  | "completed"
  | "failed"
  | "delivery_uncertain";
const transitions: Record<OpState, OpState[]> = {
  received: ["accepted", "failed"],
  accepted: ["dispatched", "completed", "failed"],
  dispatched: ["native_acknowledged", "completed", "delivery_uncertain"],
  native_acknowledged: ["completed", "delivery_uncertain"],
  completed: [],
  failed: [],
  delivery_uncertain: [],
};
export class Store {
  db!: DatabaseSync;
  policy: Limits;
  path: string;
  depth = 0;
  failed = false;
  onFailure?: (error: unknown) => void;
  constructor(path: string, config: Partial<Limits> = {}) {
    this.path = path;
    this.policy = limits(config);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      if (existsSync(path) && statSync(path).size > this.policy.databaseBytes)
        throw new Error(
          "Database exceeds configured capacity; preserve and reconcile locally",
        );
      this.db = new DatabaseSync(path);
      chmodSync(path, 0o600);
      this.db.exec(
        "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL;",
      );
      const check = this.db.prepare("PRAGMA quick_check").get() as any;
      if (check.quick_check !== "ok")
        throw new Error("SQLite integrity check failed");
      const version = (this.db.prepare("PRAGMA user_version").get() as any)
        .user_version;
      if (version > 3)
        throw new Error("Database schema is newer than this bridge");
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=128; PRAGMA journal_size_limit=1048576;",
      );
      this.db.exec(
        `PRAGMA max_page_count=${Math.floor(this.policy.databaseBytes / Number((this.db.prepare("PRAGMA page_size").get() as any).page_size))}`,
      );
      if (version < 1)
        this.tx(() => {
          if (
            (this.db.prepare("PRAGMA user_version").get() as any)
              .user_version >= 1
          )
            return;
          this.db.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO meta VALUES('sequence','0'),('pruned_through','0');
    CREATE TABLE sessions(id TEXT PRIMARY KEY,agent TEXT NOT NULL,worktree TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
    CREATE TABLE leases(worktree TEXT PRIMARY KEY,session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),acquired_at INTEGER NOT NULL);
    CREATE TABLE lease_members(session_id TEXT PRIMARY KEY REFERENCES sessions(id),worktree TEXT NOT NULL REFERENCES leases(worktree));
    CREATE TABLE approvals(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),generation TEXT NOT NULL,native_session_id TEXT,native_request_id TEXT,turn_id TEXT,status TEXT NOT NULL CHECK(status IN ('pending','responding','resolved','invalidated','delivery_uncertain')),data TEXT NOT NULL CHECK(json_valid(data)));
    CREATE TABLE operations(id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,kind TEXT NOT NULL,session_id TEXT,state TEXT NOT NULL CHECK(state IN ('received','accepted','dispatched','native_acknowledged','completed','failed','delivery_uncertain')),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,result TEXT,error TEXT,native_ack_source TEXT);
    CREATE TABLE operation_steps(sequence INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL REFERENCES operations(id),state TEXT NOT NULL,at INTEGER NOT NULL);
    CREATE TABLE events(sequence INTEGER PRIMARY KEY,session_id TEXT,at INTEGER NOT NULL,bytes INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
    CREATE INDEX events_session ON events(session_id,sequence);
    CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,action TEXT NOT NULL,session_id TEXT,data TEXT NOT NULL);
    CREATE TABLE verification(agent TEXT PRIMARY KEY,reference TEXT NOT NULL,data TEXT NOT NULL);
    PRAGMA user_version=1;
   `);
        });
      if (version < 2)
        this.tx(() => {
          if (
            (this.db.prepare("PRAGMA user_version").get() as any)
              .user_version >= 2
          )
            return;
          this.db.exec(
            `CREATE TABLE process_generations(generation TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),data TEXT NOT NULL CHECK(json_valid(data)));CREATE INDEX operations_session ON operations(session_id);PRAGMA user_version=2;`,
          );
        });
      if(version<3)this.tx(()=>{this.db.exec(`
        CREATE TABLE IF NOT EXISTS device_pairings(id TEXT PRIMARY KEY,code_hash TEXT NOT NULL UNIQUE,role TEXT NOT NULL,projects TEXT NOT NULL,expires_at INTEGER NOT NULL,consumed_at INTEGER,created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS browser_devices(id TEXT PRIMARY KEY,secret_hash TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role TEXT NOT NULL,projects TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,last_seen INTEGER NOT NULL,revoked_at INTEGER);
        CREATE TABLE IF NOT EXISTS security_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,actor TEXT,action TEXT NOT NULL,detail TEXT NOT NULL);
        PRAGMA user_version=3;
      `);});
      this.validate();
    } catch (e) {
      try {
        this.db!.close();
      } catch {}
      throw new Error(
        `Storage unavailable; state preserved, no reset: ${String(e)}`,
      );
    }
  }
  tx<T>(fn: () => T): T {
    if (this.failed)
      throw new Error("Storage failed; bridge recovery required");
    if (this.depth) return fn();
    this.guardWal();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      if ((e as any)?.code?.startsWith("ERR_SQLITE")) {
        this.failed = true;
        this.onFailure?.(e);
      }
      throw e;
    } finally {
      this.depth--;
    }
  }
  guardWal() {
    const wal = this.path + "-wal";
    if (existsSync(wal) && statSync(wal).size > this.policy.walBytes) {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      if (existsSync(wal) && statSync(wal).size > this.policy.walBytes) {
        const error = new Error(
          "WAL budget exceeded, possibly pinned by an external reader; writes stopped",
        );
        this.failed = true;
        this.onFailure?.(error);
        throw error;
      }
    }
  }
  meta(key: string) {
    return (
      this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as any
    )?.value;
  }
  setMeta(key: string, value: string) {
    this.db
      .prepare(
        "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  get sequence() {
    return Number(this.meta("sequence"));
  }
  claimOwner() {
    const owner = { id: randomUUID(), identity: identity(process.pid) };
    if (!owner.identity)
      throw new Error("Cannot establish bridge process identity");
    this.tx(() => {
      const prior = this.meta("owner");
      if (prior) {
        const state = probe(JSON.parse(prior).identity).state;
        if (!["absent", "pid_reused"].includes(state))
          throw new Error(
            "Another bridge owns this state directory or ownership is uncertain",
          );
      }
      this.setMeta("owner", JSON.stringify(owner));
    });
    return () =>
      this.tx(() => {
        if (JSON.parse(this.meta("owner") ?? "null")?.id === owner.id)
          this.db.prepare("DELETE FROM meta WHERE key='owner'").run();
      });
  }
  validate() {
    if (this.db.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("Foreign key corruption");
    const seq = this.sequence,
      max =
        (this.db.prepare("SELECT max(sequence) n FROM events").get() as any)
          .n ?? 0;
    if (
      !Number.isSafeInteger(seq) ||
      seq < max ||
      Number(this.meta("pruned_through")) > seq
    )
      throw new Error("Invalid event sequence");
    for (const row of this.db
      .prepare("SELECT * FROM sessions")
      .all() as any[]) {
      const s = JSON.parse(row.data);
      if (
        s.id !== row.id ||
        s.agent !== row.agent ||
        !["codex", "claude"].includes(s.agent) ||
        s.worktree !== row.worktree ||
        !s.process?.generation ||
        !s.currentTurn
      )
        throw new Error("Invalid session snapshot");
    }
    for (const r of this.db
      .prepare("SELECT id,state FROM operations")
      .all() as any[]) {
      const steps = this.db
        .prepare(
          "SELECT state FROM operation_steps WHERE operation_id=? ORDER BY sequence",
        )
        .all(r.id) as any[];
      let prev: OpState | undefined;
      for (const s of steps) {
        if (
          (!prev && s.state !== "received") ||
          (prev && !transitions[prev]?.includes(s.state))
        )
          throw new Error("Invalid operation transition sequence");
        prev = s.state;
      }
      if (prev !== r.state) throw new Error("Operation journal state mismatch");
    }
  }
  saveSession(s: Session) {
    this.db
      .prepare(
        "INSERT INTO sessions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,worktree=excluded.worktree",
      )
      .run(s.id, s.agent, s.worktree, JSON.stringify(s));
    this.db
      .prepare(
        "INSERT INTO verification VALUES(?,?,?) ON CONFLICT(agent) DO UPDATE SET data=excluded.data,reference=excluded.reference",
      )
      .run(
        s.agent,
        "capability evidence references; no Phase 4 runtime promotion",
        JSON.stringify(s.capabilities),
      );
    this.db
      .prepare(
        "INSERT INTO process_generations VALUES(?,?,?) ON CONFLICT(generation) DO UPDATE SET data=excluded.data",
      )
      .run(s.process.generation, s.id, JSON.stringify(s.process));
    if (s.leaseHeld) {
      this.db
        .prepare(
          "INSERT INTO leases VALUES(?,?,?) ON CONFLICT(worktree) DO NOTHING",
        )
        .run(s.worktree, s.id, Date.now());
      const row = this.db
        .prepare("SELECT session_id FROM leases WHERE worktree=?")
        .get(s.worktree) as any;
      if (
        row.session_id !== s.id &&
        !this.db
          .prepare(
            "SELECT 1 FROM lease_members WHERE session_id=? AND worktree=?",
          )
          .get(s.id, s.worktree)
      )
        throw new Error("Worktree already leased");
      this.db
        .prepare("INSERT OR IGNORE INTO lease_members VALUES(?,?)")
        .run(s.id, s.worktree);
    } else this.releaseMember(s.id, s.worktree);
  }
  releaseMember(id: string, worktree: string) {
    this.db.prepare("DELETE FROM lease_members WHERE session_id=?").run(id);
    const next = this.db
      .prepare("SELECT session_id FROM lease_members WHERE worktree=? LIMIT 1")
      .get(worktree) as any;
    if (next)
      this.db
        .prepare("UPDATE leases SET session_id=? WHERE worktree=?")
        .run(next.session_id, worktree);
    else this.db.prepare("DELETE FROM leases WHERE worktree=?").run(worktree);
  }
  importSession(s: Session) {
    const prior = this.lease(s.worktree);
    if (prior && s.leaseHeld) {
      this.db
        .prepare("INSERT INTO sessions VALUES(?,?,?,?)")
        .run(s.id, s.agent, s.worktree, JSON.stringify(s));
      this.db
        .prepare("INSERT INTO lease_members VALUES(?,?)")
        .run(s.id, s.worktree);
    }
    this.saveSession(s);
  }
  sessions(): Record<string, Session> {
    return Object.fromEntries(
      (this.db.prepare("SELECT id,data FROM sessions").all() as any[]).map(
        (r) => [r.id, JSON.parse(r.data)],
      ),
    );
  }
  lease(worktree: string) {
    return this.db
      .prepare("SELECT * FROM leases WHERE worktree=?")
      .get(worktree) as any;
  }
  saveApproval(p: Pending, nativeSessionId: string | null) {
    const old = this.db
      .prepare("SELECT status FROM approvals WHERE id=?")
      .get(p.id) as any;
    const status = p.status ?? (p.resolved ? "resolved" : "pending");
    if (
      !old &&
      (this.db.prepare("SELECT count(*) n FROM approvals").get() as any).n >=
        this.policy.maxApprovals
    )
      throw new Error("Approval journal capacity reached");
    this.db
      .prepare(
        "INSERT INTO approvals VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data",
      )
      .run(
        p.id,
        p.sessionId,
        p.generation,
        nativeSessionId,
        String(p.raw?.id ?? p.raw?.requestId ?? p.raw?.toolUseID ?? ""),
        p.turnId,
        status,
        JSON.stringify({
          ...p,
          raw: bounded(p.raw, this.policy.rawBytes, this.policy),
        }),
      );
  }
  audit(action: string, sessionId: string | null, data: any) {
    this.db
      .prepare("INSERT INTO audit(at,action,session_id,data) VALUES(?,?,?,?)")
      .run(
        Date.now(),
        action,
        sessionId,
        JSON.stringify(bounded(data, 4096, this.policy)),
      );
  }
  createOperation(
    id: string,
    kind: string,
    sessionId: string | null,
    input: any,
  ) {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(id))
      throw new Error("Idempotency-Key required (8-128 safe characters)");
    const payloadHash = hash(canonical({ kind, sessionId, input }));
    const existing = this.operation(id);
    if (existing) {
      if (existing.payload_hash !== payloadHash)
        throw new Error("Idempotency key payload conflict");
      return { fresh: false, operation: existing };
    }
    if (
      (this.db.prepare("SELECT count(*) n FROM operations").get() as any).n >=
      this.policy.maxOperations
    )
      throw new Error("Operation journal capacity reached; no IDs forgotten");
    this.tx(() => {
      const now = Date.now();
      this.db
        .prepare(
          "INSERT INTO operations(id,payload_hash,kind,session_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(id, payloadHash, kind, sessionId, "received", now, now);
      this.db
        .prepare(
          "INSERT INTO operation_steps(operation_id,state,at) VALUES(?,?,?)",
        )
        .run(id, "received", now);
    });
    return { fresh: true, operation: this.operation(id) };
  }
  operation(id: string) {
    const r = this.db
      .prepare("SELECT * FROM operations WHERE id=?")
      .get(id) as any;
    return r
      ? { ...r, result: r.result ? JSON.parse(r.result) : null }
      : undefined;
  }
  transition(
    id: string,
    state: OpState,
    result?: any,
    error?: string,
    source?: string,
  ) {
    this.tx(() => {
      const row = this.operation(id);
      if (!row || !transitions[row.state as OpState].includes(state))
        throw new Error(
          `Invalid operation transition ${row?.state} -> ${state}`,
        );
      this.db
        .prepare(
          "UPDATE operations SET state=?,updated_at=?,result=?,error=?,native_ack_source=coalesce(?,native_ack_source) WHERE id=?",
        )
        .run(
          state,
          Date.now(),
          result === undefined
            ? null
            : JSON.stringify(
                bounded(result, this.policy.eventBytes, this.policy),
              ),
          error
            ? JSON.stringify(
                bounded(error, this.policy.errorBytes, this.policy),
              )
            : null,
          source ?? null,
          id,
        );
      this.db
        .prepare(
          "INSERT INTO operation_steps(operation_id,state,at) VALUES(?,?,?)",
        )
        .run(id, state, Date.now());
    });
  }
  recoverOperations() {
    this.tx(() => {
      for (const r of this.db
        .prepare(
          "SELECT id,state FROM operations WHERE state NOT IN ('completed','failed','delivery_uncertain')",
        )
        .all() as any[])
        this.transition(
          r.id,
          ["dispatched", "native_acknowledged"].includes(r.state)
            ? "delivery_uncertain"
            : "failed",
          undefined,
          "Bridge restarted; never automatically resent",
        );
      this.db.exec(
        "UPDATE approvals SET status=CASE WHEN status='responding' THEN 'delivery_uncertain' ELSE 'invalidated' END WHERE status IN ('pending','responding')",
      );
    });
  }
  append(event: any) {
    const sequence = this.sequence + 1;
    const e = { ...event, sequence, timestamp: new Date().toISOString() };
    e.raw = bounded(e.raw, this.policy.rawBytes, this.policy);
    let data = JSON.stringify(e);
    if (Buffer.byteLength(data) > this.policy.eventBytes) {
      e.raw = { truncated: true, reason: "event_envelope_limit" };
      data = JSON.stringify(e);
    }
    if (Buffer.byteLength(data) > this.policy.eventBytes)
      throw new Error("Oversized event metadata");
    this.db
      .prepare("INSERT INTO events VALUES(?,?,?,?,?)")
      .run(
        sequence,
        e.bridgeSessionId ?? null,
        Date.now(),
        Buffer.byteLength(data),
        data,
      );
    this.setMeta("sequence", String(sequence));
    this.prune();
    return e;
  }
  prune(now = Date.now()) {
    this.tx(() => {
      const rows = this.db
        .prepare(
          "SELECT sequence,session_id,at,bytes FROM events ORDER BY sequence DESC",
        )
        .all() as any[];
      const counts = new Map<string, number>();
      let bytes = 0,
        count = 0,
        cut = 0;
      for (const r of rows) {
        bytes += r.bytes;
        count++;
        const n = (counts.get(r.session_id) ?? 0) + 1;
        counts.set(r.session_id, n);
        if (
          bytes > this.policy.journalBytes ||
          count > this.policy.eventCount ||
          n > this.policy.sessionEvents ||
          r.at < now - this.policy.eventAgeMs
        )
          cut = Math.max(cut, r.sequence);
      }
      if (cut) {
        this.db.prepare("DELETE FROM events WHERE sequence<=?").run(cut);
        this.setMeta(
          "pruned_through",
          String(Math.max(cut, Number(this.meta("pruned_through")))),
        );
      }
    });
  }
  replay(sessionId: string, after: number, through = this.sequence) {
    if (!Number.isSafeInteger(after) || after < 0 || after > this.sequence)
      throw new Error("Invalid cursor");
    if (after < Number(this.meta("pruned_through")))
      return { resync: true, events: [] };
    return {
      resync: false,
      events: (
        this.db
          .prepare(
            "SELECT data FROM events WHERE session_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?",
          )
          .all(sessionId, after, through, this.policy.replayBatch) as any[]
      ).map((r) => JSON.parse(r.data)),
    };
  }
  diagnostics() {
    return {
      schemaVersion: 3,
      sequence: this.sequence,
      prunedThrough: Number(this.meta("pruned_through")),
      journal: this.db
        .prepare(
          "SELECT count(*) events,coalesce(sum(bytes),0) bytes,min(at) oldest FROM events",
        )
        .get(),
      operations: this.db
        .prepare("SELECT state,count(*) count FROM operations GROUP BY state")
        .all(),
      leaseCount: (
        this.db.prepare("SELECT count(*) n FROM leases").get() as any
      ).n,
      leases: this.db.prepare("SELECT * FROM leases LIMIT 100").all(),
      leasesTruncated:
        (this.db.prepare("SELECT count(*) n FROM leases").get() as any).n > 100,
      databaseHealth: "ok_at_open",
      limits: this.policy,
    };
  }
  maintenance() {
    this.prune();
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  close() {
    this.db.close();
  }
}
