import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  randomUUID,
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { RateLimit } from "../security/rate-limit.ts";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const same = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export type AccountKey = {
  ownerId: string;
  id: string;
  publicKey: string;
  counter: number;
  rpId: string;
  origin: string;
};
export class Accounts {
  db: DatabaseSync;
  origin: string;
  rpId: string;
  rates = new RateLimit();
  online: (id: string) => boolean = () => false;
  sendHost: (id: string, message: unknown) => void = () => {
    throw Error("computer_offline");
  };
  revokeHost: (id: string) => void = () => {};
  openPreview: (userId: string, token: string, id: string) => { url: string } = () => { throw Error("preview_hosting_unavailable"); };
  access = new Map<
    string,
    { ownerId: string; hostId: string; expires: number; result: any }
  >();
  constructor(file: string, origin: string) {
    this.origin = new URL(origin).origin;
    this.rpId = new URL(origin).hostname;
    if (
      this.origin !== origin ||
      !(
        origin.startsWith("https://") ||
        this.rpId === "127.0.0.1" ||
        this.rpId === "localhost"
      )
    )
      throw Error("Invalid dashboard origin");
    this.db = new DatabaseSync(file);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,credential TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS flows(id TEXT PRIMARY KEY,kind TEXT NOT NULL,name TEXT NOT NULL,user_id TEXT NOT NULL,challenge TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS logins(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS computers(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,platform TEXT NOT NULL,credential_hash TEXT UNIQUE,revoked INTEGER,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS enrollments(id TEXT PRIMARY KEY,poll_hash TEXT NOT NULL,name TEXT NOT NULL,platform TEXT NOT NULL,expires INTEGER NOT NULL,owner_id TEXT,host_id TEXT);`);
  }
  sweep() {
    const now = Date.now();
    for (const table of ["flows", "logins", "enrollments"])
      this.db.prepare(`DELETE FROM ${table} WHERE expires < ?`).run(now);
    for (const [id, a] of this.access)
      if (a.expires < now) this.access.delete(id);
  }
  publicKey(userId: string): AccountKey {
    const user = this.db
      .prepare("SELECT * FROM users WHERE id=?")
      .get(userId) as any;
    if (!user) throw Error("account_not_found");
    return {
      ...JSON.parse(user.credential),
      ownerId: user.id,
      rpId: this.rpId,
      origin: this.origin,
    };
  }
  hostAuth(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return this.db
      .prepare(
        "SELECT id,user_id FROM computers WHERE credential_hash=? AND revoked IS NULL",
      )
      .get(hash(token)) as { id: string; user_id: string } | undefined;
  }
  session(req: IncomingMessage) {
    const name = this.origin.startsWith("https:")
      ? "__Host-pm"
      : "pm_development";
    const matches = (req.headers.cookie ?? "")
      .split(";")
      .map((v) => v.trim())
      .filter((v) => v.startsWith(name + "="));
    const token = matches.length === 1 ? matches[0].slice(name.length + 1) : "";
    const row = this.db
      .prepare("SELECT user_id FROM logins WHERE hash=? AND expires>?")
      .get(hash(token), Date.now()) as any;
    if (!row) throw Error("authentication_required");
    return {
      userId: row.user_id as string,
      token,
      csrf: createHmac("sha256", token)
        .update("pm-account-csrf-v1")
        .digest("base64url"),
    };
  }
  cookie(token: string, seconds: number) {
    return `${this.origin.startsWith("https:") ? "__Host-pm" : "pm_development"}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${seconds}${this.origin.startsWith("https:") ? "; Secure" : ""}`;
  }
  ownComputer(ownerId: string, id: string) {
    const computer = this.db
      .prepare(
        "SELECT id,name,platform,created FROM computers WHERE id=? AND user_id=? AND revoked IS NULL",
      )
      .get(id, ownerId) as any;
    if (!computer) throw Error("computer_not_found");
    return computer;
  }
  enrollmentStart(name: unknown, platform: unknown) {
    this.sweep();
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 80 ||
      !["darwin", "win32"].includes(String(platform))
    )
      throw Error("invalid_computer");
    if (
      (this.db.prepare("SELECT count(*) n FROM enrollments").get() as any).n >=
      200
    )
      throw Error("enrollment_capacity");
    const id = randomUUID(),
      pollSecret = secret(),
      expires = Date.now() + 300000;
    this.db
      .prepare("INSERT INTO enrollments VALUES(?,?,?,?,?,NULL,NULL)")
      .run(id, hash(pollSecret), name.trim(), String(platform), expires);
    return {
      id,
      pollSecret,
      expires,
      verificationUrl: `${this.origin}/#authorize=${id}`,
      interval: 3,
    };
  }
  enrollmentPoll(id: string, pollSecret: string) {
    const row = this.db
      .prepare("SELECT * FROM enrollments WHERE id=? AND expires>?")
      .get(id, Date.now()) as any;
    if (
      !row ||
      typeof pollSecret !== "string" ||
      !same(row.poll_hash, hash(pollSecret))
    )
      throw Error("invalid_enrollment");
    if (!row.owner_id) return { state: "pending" };
    this.ownComputer(row.owner_id, row.host_id);
    // Deterministic for this secret/request only: a lost poll reply can safely be recovered.
    const credential = createHmac("sha256", pollSecret)
      .update("pm-computer-v1:" + row.host_id)
      .digest("base64url");
    this.db
      .prepare(
        "UPDATE computers SET credential_hash=? WHERE id=? AND revoked IS NULL",
      )
      .run(hash(credential), row.host_id);
    return {
      state: "authorized",
      hostId: row.host_id,
      hostName: row.name,
      credential,
      account: this.publicKey(row.owner_id),
    };
  }
  approveEnrollment(ownerId: string, id: string) {
    const row = this.db
      .prepare("SELECT * FROM enrollments WHERE id=? AND expires>?")
      .get(id, Date.now()) as any;
    if (!row || row.owner_id) throw Error("invalid_enrollment");
    if (
      (
        this.db
          .prepare(
            "SELECT count(*) n FROM computers WHERE user_id=? AND revoked IS NULL",
          )
          .get(ownerId) as any
      ).n >= 20
    )
      throw Error("computer_capacity");
    const hostId = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO computers VALUES(?,?,?,?,NULL,NULL,?)")
        .run(hostId, ownerId, row.name, row.platform, Date.now());
      const changed = this.db
        .prepare(
          "UPDATE enrollments SET owner_id=?,host_id=? WHERE id=? AND owner_id IS NULL",
        )
        .run(ownerId, hostId, id);
      if (!changed.changes) throw Error("already_consumed");
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { authorized: true, hostId };
  }
  receiveHost(hostId: string, message: any) {
    const request = this.access.get(message.id);
    if (!request || request.hostId !== hostId || request.expires < Date.now())
      return;
    if (
      message.type === "access-challenge" &&
      request.result.state === "waiting"
    )
      request.result = { state: "challenge", options: message.options };
    if (
      message.type === "access-result" &&
      request.result.state === "verifying"
    )
      request.result = { state: "ready", encrypted: message.encrypted };
    if (message.type === "access-error") request.result = { state: "failed" };
  }
  async handle(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? "/", this.origin).pathname;
    if (!path.startsWith("/account-api/")) return false;
    const send = (value: any, status = 200) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    try {
      this.sweep();
      this.rates.check("account-global", 1200);
      if (!["GET", "POST"].includes(req.method ?? ""))
        throw Error("method_not_allowed");
      const deviceRoute = [
        "/account-api/enrollment/start",
        "/account-api/enrollment/poll",
        "/account-api/enrollment/ack",
      ].includes(path);
      if (deviceRoute && req.headers.origin) throw Error("origin_forbidden");
      if (
        !deviceRoute &&
        req.headers.origin &&
        req.headers.origin !== this.origin
      )
        throw Error("origin_forbidden");
      if (
        !deviceRoute &&
        req.method === "POST" &&
        req.headers.origin !== this.origin
      )
        throw Error("origin_required");
      let input: any = {};
      if (req.method === "POST") {
        let text = "";
        for await (const chunk of req) {
          text += chunk;
          if (Buffer.byteLength(text) > 32768) throw Error("body_too_large");
        }
        input = JSON.parse(text || "{}");
        if (!input || typeof input !== "object" || Array.isArray(input))
          throw Error("invalid_json");
      }
      if (deviceRoute && req.method === "POST") {
        if (path.endsWith("/start")) {
          this.rates.check("enrollment-start", 30);
          send(this.enrollmentStart(input.name, input.platform));
        } else if (path.endsWith("/poll")) {
          this.rates.check("poll:" + String(input.id).slice(0, 40), 30);
          send(this.enrollmentPoll(input.id, input.pollSecret));
        } else {
          this.enrollmentPoll(input.id, input.pollSecret);
          this.db.prepare("DELETE FROM enrollments WHERE id=?").run(input.id);
          send({ acknowledged: true });
        }
        return true;
      }
      if (path === "/account-api/auth/options" && req.method === "POST") {
        this.rates.check("auth-options", 30);
        if (
          !["register", "login"].includes(input.mode) ||
          typeof input.name !== "string" ||
          !/^[a-zA-Z0-9_.-]{3,40}$/.test(input.name)
        )
          throw Error("invalid_account_name");
        const name = input.name.toLowerCase(),
          user = this.db
            .prepare("SELECT * FROM users WHERE name=?")
            .get(name) as any;
        if (input.mode === "register" && user)
          throw Error("account_name_unavailable");
        if (
          (this.db.prepare("SELECT count(*) n FROM flows").get() as any).n >=
          200
        )
          throw Error("auth_capacity");
        const userId = user?.id ?? randomUUID(),
          credential = user ? JSON.parse(user.credential) : null;
        const options =
          input.mode === "register"
            ? await generateRegistrationOptions({
                rpName: "Prompt Manager",
                rpID: this.rpId,
                userName: name,
                userID: new TextEncoder().encode(userId),
                attestationType: "none",
                authenticatorSelection: {
                  residentKey: "required",
                  userVerification: "required",
                },
              })
            : await generateAuthenticationOptions({
                rpID: this.rpId,
                userVerification: "required",
                allowCredentials: credential
                  ? [{ id: credential.id }]
                  : [{ id: secret() }],
              });
        const id = randomUUID();
        this.db
          .prepare("INSERT INTO flows VALUES(?,?,?,?,?,?)")
          .run(
            id,
            input.mode,
            name,
            userId,
            options.challenge,
            Date.now() + 120000,
          );
        send({ id, options });
        return true;
      }
      if (path === "/account-api/auth/verify" && req.method === "POST") {
        this.rates.check("auth-verify", 30);
        const flow = this.db
          .prepare("SELECT * FROM flows WHERE id=? AND expires>?")
          .get(input.id, Date.now()) as any;
        if (!flow) throw Error("authentication_failed");
        this.db.prepare("DELETE FROM flows WHERE id=?").run(flow.id);
        if (flow.kind === "register") {
          const check = await verifyRegistrationResponse({
            response: input.response,
            expectedChallenge: flow.challenge,
            expectedOrigin: this.origin,
            expectedRPID: this.rpId,
            requireUserVerification: true,
          });
          if (!check.verified || !check.registrationInfo)
            throw Error("authentication_failed");
          const c = check.registrationInfo.credential;
          this.db
            .prepare("INSERT INTO users VALUES(?,?,?,?)")
            .run(
              flow.user_id,
              flow.name,
              JSON.stringify({
                id: c.id,
                publicKey: Buffer.from(c.publicKey).toString("base64url"),
                counter: c.counter,
              }),
              Date.now(),
            );
        } else {
          const c = this.publicKey(flow.user_id);
          const check = await verifyAuthenticationResponse({
            response: input.response,
            expectedChallenge: flow.challenge,
            expectedOrigin: this.origin,
            expectedRPID: this.rpId,
            requireUserVerification: true,
            credential: {
              id: c.id,
              publicKey: Buffer.from(c.publicKey, "base64url"),
              counter: c.counter,
            },
          });
          if (!check.verified) throw Error("authentication_failed");
          this.db
            .prepare("UPDATE users SET credential=? WHERE id=?")
            .run(
              JSON.stringify({
                id: c.id,
                publicKey: c.publicKey,
                counter: check.authenticationInfo.newCounter,
              }),
              flow.user_id,
            );
        }
        const token = secret();
        this.db
          .prepare("INSERT INTO logins VALUES(?,?,?)")
          .run(hash(token), flow.user_id, Date.now() + 7 * 86400000);
        res.setHeader("Set-Cookie", this.cookie(token, 7 * 86400));
        send({ signedIn: true });
        return true;
      }
      const session = this.session(req);
      this.rates.check("user:" + session.userId, 240);
      if (
        req.method === "POST" &&
        !same(String(req.headers["x-csrf-token"] ?? ""), session.csrf)
      )
        throw Error("csrf_invalid");
      if (path === "/account-api/me" && req.method === "GET") {
        send({
          csrf: session.csrf,
          name: (
            this.db
              .prepare("SELECT name FROM users WHERE id=?")
              .get(session.userId) as any
          ).name,
        });
        return true;
      }
      if (path === "/account-api/previews/open" && req.method === "GET") {
        const url = new URL(req.url ?? "/", this.origin);
        if ([...url.searchParams.keys()].some(k => k !== "id")) throw Error("invalid_preview_request");
        send(this.openPreview(session.userId, session.token, url.searchParams.get("id") ?? ""));
        return true;
      }
      if (path === "/account-api/logout" && req.method === "POST") {
        this.db
          .prepare("DELETE FROM logins WHERE hash=?")
          .run(hash(session.token));
        res.setHeader("Set-Cookie", this.cookie("", 0));
        send({ signedOut: true });
        return true;
      }
      if (path === "/account-api/computers" && req.method === "GET") {
        const computers = this.db
          .prepare(
            "SELECT id,name,platform FROM computers WHERE user_id=? AND revoked IS NULL ORDER BY created",
          )
          .all(session.userId) as any[];
        send({
          computers: computers.map((c) => ({
            ...c,
            online: this.online(c.id),
          })),
        });
        return true;
      }
      if (path === "/account-api/enrollment/details" && req.method === "POST") {
        const row = this.db
          .prepare(
            "SELECT id,name,platform FROM enrollments WHERE id=? AND expires>? AND owner_id IS NULL",
          )
          .get(input.id, Date.now());
        if (!row) throw Error("invalid_enrollment");
        send(row);
        return true;
      }
      if (path === "/account-api/enrollment/approve" && req.method === "POST") {
        send(this.approveEnrollment(session.userId, input.id));
        return true;
      }
      if (path === "/account-api/computers/revoke" && req.method === "POST") {
        this.ownComputer(session.userId, input.id);
        this.db
          .prepare(
            "UPDATE computers SET revoked=?,credential_hash=NULL WHERE id=?",
          )
          .run(Date.now(), input.id);
        this.revokeHost(input.id);
        send({ revoked: true });
        return true;
      }
      if (path === "/account-api/access/start" && req.method === "POST") {
        this.ownComputer(session.userId, input.hostId);
        if (
          !this.online(input.hostId) ||
          this.access.size >= 200 ||
          typeof input.publicKey !== "string" ||
          input.publicKey.length > 200
        )
          throw Error("computer_unavailable");
        const id = randomUUID();
        this.access.set(id, {
          ownerId: session.userId,
          hostId: input.hostId,
          expires: Date.now() + 120000,
          result: { state: "waiting" },
        });
        this.sendHost(input.hostId, {
          type: "access-start",
          id,
          ownerId: session.userId,
          publicKey: input.publicKey,
        });
        send({ id });
        return true;
      }
      if (
        ["/account-api/access/status", "/account-api/access/finish"].includes(
          path,
        ) &&
        req.method === "POST"
      ) {
        const access = this.access.get(input.id);
        if (
          !access ||
          access.ownerId !== session.userId ||
          access.expires <= Date.now()
        )
          throw Error("access_expired");
        this.ownComputer(session.userId, access.hostId);
        if (path.endsWith("/finish")) {
          if (access.result.state !== "challenge")
            throw Error("invalid_access_state");
          access.result = { state: "verifying" };
          this.sendHost(access.hostId, {
            type: "access-finish",
            id: input.id,
            response: input.response,
          });
        }
        send(access.result);
        return true;
      }
      send({ error: "not_found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "request_failed";
      const allowed = /^[a-z_]+$/.test(message) ? message : "request_failed";
      send(
        { error: allowed },
        allowed === "authentication_required" ? 401 : 400,
      );
    }
    return true;
  }
  close() {
    this.db.close();
  }
}
