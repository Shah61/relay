import {
  randomBytes,
  randomUUID,
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { EventEmitter } from "node:events";
import type { Store } from "../storage/store.ts";
export type Role = "owner" | "operator" | "viewer";
export type Device = {
  id: string;
  name: string;
  role: Role;
  projects: string[];
  createdAt: number;
  expiresAt: number;
  lastSeen: number;
  revokedAt: number | null;
};
export class AccessError extends Error {
  status: number;
  code: string;
  constructor(code: string, status = 403) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export class DeviceAuth extends EventEmitter {
  store: Store;
  projects: string[];
  constructor(store: Store, projects: string[]) {
    super();
    this.store = store;
    this.projects = projects;
  }
  audit(actor: string | null, action: string, detail: any) {
    this.store.tx(() => {
      this.store.db
        .prepare(
          "INSERT INTO security_audit(at,actor,action,detail) VALUES(?,?,?,?)",
        )
        .run(Date.now(), actor, action, JSON.stringify(detail));
      this.store.db.exec(
        "DELETE FROM security_audit WHERE id NOT IN (SELECT id FROM security_audit ORDER BY id DESC LIMIT 5000)",
      );
    });
  }
  pairing(role: Role, projects: string[]) {
    if (
      !["owner", "operator", "viewer"].includes(role) ||
      !Array.isArray(projects) ||
      !projects.length ||
      projects.some((p) => !this.projects.includes(p)) ||
      new Set(projects).size !== projects.length
    )
      throw new AccessError("invalid_pairing_scope", 400);
    const code = randomBytes(24).toString("base64url"),
      id = randomUUID(),
      expiresAt = Date.now() + 10 * 60000;
    this.store.tx(() => {
      this.store.db
        .prepare(
          "DELETE FROM device_pairings WHERE expires_at<? OR consumed_at IS NOT NULL",
        )
        .run(Date.now());
      if (
        (
          this.store.db
            .prepare("SELECT count(*) n FROM device_pairings")
            .get() as any
        ).n >= 20
      )
        throw new AccessError("pairing_limit", 429);
      this.store.db
        .prepare("INSERT INTO device_pairings VALUES(?,?,?,?,?,NULL,?)")
        .run(
          id,
          digest(code),
          role,
          JSON.stringify(projects),
          expiresAt,
          Date.now(),
        );
      this.audit("local-admin", "pairing_created", {
        id,
        role,
        projects,
        expiresAt,
      });
    });
    return { id, code, role, projects, expiresAt };
  }
  exchange(code: unknown, name: unknown) {
    if (
      typeof code !== "string" ||
      !/^[A-Za-z0-9_-]{32}$/.test(code) ||
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 80
    )
      throw new AccessError("invalid_pairing", 401);
    const secret = randomBytes(32).toString("base64url");
    let device!: Device;
    this.store.tx(() => {
      const p = this.store.db
        .prepare("SELECT * FROM device_pairings WHERE code_hash=?")
        .get(digest(code)) as any;
      if (!p || p.consumed_at || p.expires_at <= Date.now())
        throw new AccessError("invalid_or_expired_pairing", 401);
      if (
        (
          this.store.db
            .prepare("SELECT count(*) n FROM browser_devices")
            .get() as any
        ).n >= 1000
      )
        throw new AccessError("device_capacity", 429);
      const now = Date.now();
      device = {
        id: randomUUID(),
        name: name.trim(),
        role: p.role,
        projects: JSON.parse(p.projects),
        createdAt: now,
        expiresAt: now + 30 * 86400000,
        lastSeen: now,
        revokedAt: null,
      };
      this.store.db
        .prepare(
          "UPDATE device_pairings SET consumed_at=? WHERE id=? AND consumed_at IS NULL",
        )
        .run(now, p.id);
      this.store.db
        .prepare("INSERT INTO browser_devices VALUES(?,?,?,?,?,?,?,?,NULL)")
        .run(
          device.id,
          digest(secret),
          device.name,
          device.role,
          JSON.stringify(device.projects),
          now,
          device.expiresAt,
          now,
        );
      this.audit(device.id, "paired", {
        role: device.role,
        projects: device.projects,
      });
    });
    return { device, secret, csrf: this.csrf(secret) };
  }
  get(secret: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret))
      throw new AccessError("authentication_required", 401);
    const row = this.store.db
      .prepare("SELECT * FROM browser_devices WHERE secret_hash=?")
      .get(digest(secret)) as any;
    if (
      !row ||
      row.revoked_at ||
      row.expires_at <= Date.now() ||
      row.last_seen < Date.now() - 7 * 86400000
    )
      throw new AccessError("device_expired_or_revoked", 401);
    if (row.last_seen < Date.now() - 60000)
      this.store.tx(() =>
        this.store.db
          .prepare("UPDATE browser_devices SET last_seen=? WHERE id=?")
          .run(Date.now(), row.id),
      );
    return this.view(row);
  }
  csrf(secret: string) {
    return createHmac("sha256", secret)
      .update("relay-csrf-v1")
      .digest("base64url");
  }
  checkCsrf(secret: string, value: unknown) {
    const wanted = Buffer.from(this.csrf(secret)),
      got = Buffer.from(typeof value === "string" ? value : "");
    if (got.length !== wanted.length || !timingSafeEqual(got, wanted))
      throw new AccessError("csrf_invalid");
  }
  view(row: any): Device {
    return {
      id: row.id,
      name: row.name,
      role: row.role,
      projects: JSON.parse(row.projects),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastSeen: row.last_seen,
      revokedAt: row.revoked_at,
    };
  }
  canProject(device: Device, project: string) {
    if (!device.projects.includes(project))
      throw new AccessError("project_forbidden");
  }
  canWrite(device: Device) {
    if (device.role === "viewer") throw new AccessError("read_only_device");
  }
  owner(device: Device) {
    if (device.role !== "owner") throw new AccessError("owner_required");
  }
  list(device?: Device) {
    if (device) this.owner(device);
    return (
      this.store.db
        .prepare(
          "SELECT * FROM browser_devices ORDER BY created_at DESC LIMIT 1000",
        )
        .all() as any[]
    ).map((r) => this.view(r));
  }
  revoke(id: string, actor = "local-admin") {
    this.store.tx(() => {
      const r = this.store.db
        .prepare(
          "UPDATE browser_devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL",
        )
        .run(Date.now(), id);
      if (r.changes) this.audit(actor, "device_revoked", { id });
    });
    this.emit("revoke", id);
  }
}
