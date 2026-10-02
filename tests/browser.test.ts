// Isolated real HTTP gateway tests. Fake adapters never contact a model provider.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import { AgentAdapter, type Agent } from "../src/agents/types.ts";
import { capabilities } from "../src/agents/capabilities.ts";
import { Sessions } from "../src/sessions/manager.ts";
import { DeviceAuth } from "../src/security/devices.ts";
import { browserGateway } from "../src/browser/gateway.ts";
import { httpServer } from "../src/bridge/http.ts";
import { localAdmin } from "../src/browser/admin.ts";
import { assertPrivateMapping } from "../src/remote/serve-policy.ts";
class TestAgent extends AgentAdapter {
  agent: Agent = "codex";
  generation = randomUUID();
  prompts = 0;
  capabilities() {
    return capabilities("codex");
  }
  async availability() {
    return {
      agent: this.agent,
      adapterInstalled: true,
      sdkAvailable: true,
      executableAvailable: true,
      authentication: "unknown" as const,
      state: "ready" as const,
      ready: true,
    };
  }
  async start() {
    this.emitEvent({
      type: "session.started",
      source: "bridge",
      raw: { testOnly: true },
      nativeSessionId: randomUUID(),
      state: {
        lifecycle: "alive",
        process: {
          state: "running",
          generation: this.generation,
          children: "unknown",
        },
      },
    });
  }
  async prompt() {
    this.prompts++;
    this.emitEvent({
      type: "turn.completed",
      source: "bridge",
      raw: { testOnly: true },
      turn: { state: "completed" },
    });
    return { testOnly: true };
  }
  async interrupt() {
    return { requested: true };
  }
  async respond() {
    return { sent: true };
  }
  async close() {
    this.emitEvent({
      type: "session.state_changed",
      source: "bridge",
      raw: { testOnly: true },
      state: {
        process: {
          state: "exited",
          generation: this.generation,
          children: "unknown",
        },
      },
    });
  }
}
async function setup(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "relay-browser-"));
  for (const p of ["a", "b"]) mkdirSync(join(dir, p));
  const agents: TestAgent[] = [];
  const s = new Sessions(
    () => {
      const a = new TestAgent();
      agents.push(a);
      return a;
    },
    join(dir, "state"),
    { a: join(dir, "a"), b: join(dir, "b") },
  );
  const auth = new DeviceAuth(s.store, ["a", "b"]);
  const core = httpServer(s, "test-root-token", localAdmin(auth));
  core.listen(0, "127.0.0.1");
  await once(core, "listening");
  const coreUrl = `http://127.0.0.1:${(core.address() as any).port}`;
  const gateway = browserGateway(s, auth, {
    port: 0,
    remoteOrigin: "https://test.tailtest.ts.net",
    coreUrl,
    coreToken: "test-root-token",
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const url = `http://127.0.0.1:${(gateway.address() as any).port}`;
  t.after(async () => {
    gateway.closeAllConnections();
    core.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => gateway.close(() => r())),
      new Promise<void>((r) => core.close(() => r())),
    ]);
    await s.shutdown();
    s.store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const transport = (target: string, options: any): Promise<Response> =>
    options.headers.Host
      ? new Promise((resolve, reject) => {
          const r = httpRequest(target, options, (response) =>
            resolve(
              new Response(Readable.toWeb(response) as any, {
                status: response.statusCode,
                headers: response.headers as any,
              }),
            ),
          );
          r.on("error", reject);
          r.end(options.body);
        })
      : fetch(target, options);
  const req = (path: string, body?: any, headers: any = {}) =>
    transport(url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined
          ? {}
          : { Origin: url, "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  async function pair(
    role: "owner" | "operator" | "viewer" = "operator",
    projects = ["a"],
  ) {
    const p = auth.pairing(role, projects);
    const response = await req("/auth/pair", {
      code: p.code,
      name: "Test browser",
    });
    assert.equal(response.status, 200);
    const data: any = await response.json();
    return {
      cookie: response.headers.get("set-cookie")!.split(";")[0],
      csrf: data.csrf,
      device: data.device,
      headers: {
        Cookie: response.headers.get("set-cookie")!.split(";")[0],
        "X-CSRF-Token": data.csrf,
      },
    };
  }
  return { s, auth, coreUrl, url, req, pair, agents, gateway };
}
test("Device credentials: single use, hashes only, expiry, idle timeout, durable revocation", async (t) => {
  const { auth, s } = await setup(t);
  const p = auth.pairing("operator", ["a"]);
  const d = auth.exchange(p.code, "Phone");
  assert.equal(auth.get(d.secret).id, d.device.id);
  assert.throws(() => auth.exchange(p.code, "Again"));
  assert.throws(() => auth.pairing("operator", ["elsewhere"]));
  const rows =
    JSON.stringify(s.store.db.prepare("SELECT * FROM browser_devices").all()) +
    JSON.stringify(s.store.db.prepare("SELECT * FROM device_pairings").all()) +
    JSON.stringify(s.store.db.prepare("SELECT * FROM security_audit").all());
  assert(!rows.includes(d.secret));
  assert(!rows.includes(p.code));
  auth.checkCsrf(d.secret, d.csrf);
  assert.throws(() => auth.checkCsrf(d.secret, "bad"));
  s.store.db
    .prepare("UPDATE browser_devices SET last_seen=? WHERE id=?")
    .run(Date.now() - 8 * 86400000, d.device.id);
  assert.throws(() => auth.get(d.secret));
  const second = auth.exchange(auth.pairing("viewer", ["a"]).code, "Second");
  auth.revoke(second.device.id);
  const fresh = new DeviceAuth(s.store, ["a"]);
  assert.throws(() => fresh.get(second.secret));
  const expired = auth.pairing("viewer", ["a"]);
  s.store.db
    .prepare("UPDATE device_pairings SET expires_at=0 WHERE id=?")
    .run(expired.id);
  assert.throws(() => auth.exchange(expired.code, "Expired"));
});
test("Gateway rejects unauthenticated, bearer, wrong Host/Origin, CSRF, forged identity, and admin routes", async (t) => {
  const { req, pair } = await setup(t);
  assert.equal((await req("/api/sessions")).status, 401);
  assert.equal(
    (
      await req("/api/sessions", undefined, {
        Authorization: "Bearer test-root-token",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await req("/api/sessions", undefined, {
        "Tailscale-User-Login": "owner@example.com",
      })
    ).status,
    401,
  );
  assert.equal((await req("/", undefined, { Host: "evil.test" })).status, 403);
  const d = await pair();
  assert.equal((await req("/api/sessions", {}, d.headers)).status, 403);
  assert.equal(
    (
      await req(
        "/api/sessions",
        { project: "a" },
        { ...d.headers, Origin: "https://evil.test" },
      )
    ).status,
    403,
  );
  assert.equal(
    (await req("/auth/logout", {}, { Cookie: d.cookie })).status,
    403,
  );
  assert.equal((await req("/admin/pairings", {}, d.headers)).status, 404);
  assert.equal(
    (
      await req("/api/projects", undefined, {
        ...d.headers,
        "Sec-Fetch-Site": "cross-site",
      })
    ).status,
    403,
  );
  const html = await req("/");
  assert.match(
    html.headers.get("content-security-policy")!,
    /frame-ancestors 'none'/,
  );
  assert(!html.headers.get("access-control-allow-origin"));
  assert.equal((await req("/app.mjs")).status, 200);
  assert.equal((await req("/style.css")).status, 200);
});
test("Role and project authorization precedes operation dispatch, including guessed session/event IDs", async (t) => {
  const { s, req, pair } = await setup(t);
  const session = await s.start("b", "codex");
  const viewer = await pair("viewer");
  const operator = await pair();
  assert.equal(
    (
      await req(
        "/api/sessions",
        { project: "a" },
        { ...viewer.headers, "Idempotency-Key": randomUUID() },
      )
    ).status,
    403,
  );
  for (const path of [
    `/api/sessions/${session.id}`,
    `/api/sessions/${session.id}/events`,
  ])
    assert.equal((await req(path, undefined, operator.headers)).status, 404);
  assert.equal(
    (
      await req(
        "/api/sessions",
        { project: "b" },
        { ...operator.headers, "Idempotency-Key": randomUUID() },
      )
    ).status,
    403,
  );
  assert.equal(
    (await req("/api/diagnostics", undefined, operator.headers)).status,
    403,
  );
  assert.equal(
    (await req(`/api/devices/${viewer.device.id}/revoke`, {}, operator.headers))
      .status,
    403,
  );
  const list: any = await (
    await req("/api/sessions", undefined, operator.headers)
  ).json();
  assert.equal(list.sessions.length, 0);
});
test("Durable idempotency namespaces isolate devices and block changed-payload replay", async (t) => {
  const { s, req, pair, agents } = await setup(t);
  const a = await pair(),
    b = await pair();
  const session = await s.start("a", "codex");
  const key = randomUUID(),
    path = `/api/sessions/${session.id}/prompt`;
  const first: any = await (
    await req(path, { text: "One" }, { ...a.headers, "Idempotency-Key": key })
  ).json();
  assert.equal(first.operation.state, "completed");
  const duplicate: any = await (
    await req(path, { text: "One" }, { ...a.headers, "Idempotency-Key": key })
  ).json();
  assert.equal(duplicate.replayed, true);
  assert.equal(agents.find((a) => a.prompts)?.prompts, 1);
  assert.equal(
    (
      await req(
        path,
        { text: "Changed" },
        { ...a.headers, "Idempotency-Key": key },
      )
    ).status,
    409,
  );
  assert.equal(
    (await req(`/api/operations/${key}`, undefined, b.headers)).status,
    404,
  );
  assert.equal(
    (await req(`/api/operations/${key}`, undefined, a.headers)).status,
    200,
  );
  await req(path, { text: "Two" }, { ...b.headers, "Idempotency-Key": key });
  assert.equal(agents.find((a) => a.prompts)?.prompts, 2);
});
test("Private HTTPS cookie is Secure, HttpOnly, strict, host-only; local cookie cannot authenticate remotely", async (t) => {
  const { auth, req, pair } = await setup(t);
  const local = await pair();
  const host = "test.tailtest.ts.net",
    origin = `https://${host}`;
  assert.equal(
    (await req("/auth/me", undefined, { Host: host, Cookie: local.cookie }))
      .status,
    401,
  );
  const r = await req(
    "/auth/pair",
    { code: auth.pairing("owner", ["a"]).code, name: "Phone" },
    { Host: host, Origin: origin },
  );
  assert.equal(r.status, 200);
  const cookie = r.headers.get("set-cookie")!;
  assert.match(cookie, /^__Host-relay=/);
  for (const marker of ["Secure", "HttpOnly", "SameSite=Strict", "Path=/"])
    assert(cookie.includes(marker));
  assert(!cookie.includes("Domain="));
  assert.equal(
    (await req("/auth/me", undefined, { Cookie: cookie.split(";")[0] })).status,
    401,
  );
});
test("Revoking a device immediately disconnects its real SSE stream and rejects further reads", async (t) => {
  const { s, req, pair, auth } = await setup(t);
  const d = await pair();
  const session = await s.start("a", "codex");
  const r = await req(
    `/api/sessions/${session.id}/events?after=0`,
    undefined,
    d.headers,
  );
  assert.equal(r.status, 200);
  const reader = r.body!.getReader();
  assert.equal((await reader.read()).done, false);
  auth.revoke(d.device.id);
  await Promise.race([
    (async () => {
      try {
        while (!(await reader.read()).done) {}
      } catch {}
    })(),
    new Promise((_, reject) =>
      setTimeout(() => reject(Error("Revoked stream remained open")), 1500),
    ),
  ]);
  assert.equal((await req("/auth/me", undefined, d.headers)).status, 401);
});
test("Gateway reports retention gaps and bounded malformed requests without dispatch", async (t) => {
  const { s, req, pair, url } = await setup(t);
  const d = await pair(),
    session = await s.start("a", "codex");
  s.store.setMeta("pruned_through", String(s.seq));
  const r = await req(
    `/api/sessions/${session.id}/events?after=0`,
    undefined,
    d.headers,
  );
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as any).error, "resync_required");
  const big = await req(
    "/api/sessions",
    { project: "a", extra: "x".repeat(40000) },
    { ...d.headers, "Idempotency-Key": randomUUID() },
  );
  assert.equal(big.status, 413);
  const invalid = await fetch(url + "/auth/pair", {
    method: "POST",
    headers: { Origin: url },
    body: "null",
  });
  assert.equal(invalid.status, 400);
});
test("Local admin requires the root token and refuses browser-origin pairing creation", async (t) => {
  const { coreUrl, url } = await setup(t);
  assert.equal(
    (await fetch(coreUrl + "/admin/pairings", { method: "POST", body: "{}" }))
      .status,
    401,
  );
  assert.equal(
    (
      await fetch(coreUrl + "/admin/pairings", {
        method: "POST",
        headers: { Authorization: "Bearer test-root-token", Origin: url },
        body: "{}",
      })
    ).status,
    403,
  );
  const r = await fetch(coreUrl + "/admin/pairings", {
    method: "POST",
    headers: { Authorization: "Bearer test-root-token" },
    body: JSON.stringify({ role: "viewer", projects: ["a"] }),
  });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as any).code.length, 32);
});
test("Pairing attempts are rate limited", async (t) => {
  const { req } = await setup(t);
  for (let i = 0; i < 20; i++)
    assert.equal(
      (await req("/auth/pair", { code: "x".repeat(32), name: "Bad" })).status,
      401,
    );
  assert.equal(
    (await req("/auth/pair", { code: "x".repeat(32), name: "Bad" })).status,
    429,
  );
});
test("Serve policy refuses Funnel and unrelated routes, allows only empty or exact private Relay mapping", () => {
  const host = "mac.tail.ts.net",
    port = 47832;
  assertPrivateMapping({}, host, port, true);
  const exact = {
    TCP: { 443: { HTTPS: true } },
    Web: {
      [host + ":443"]: {
        Handlers: { "/": { Proxy: "http://127.0.0.1:47832" } },
      },
    },
  };
  assertPrivateMapping(exact, host, port);
  assert.throws(() => assertPrivateMapping({}, host, port));
  assert.throws(() =>
    assertPrivateMapping(
      { ...exact, AllowFunnel: { [host + ":443"]: true } },
      host,
      port,
      true,
    ),
  );
  assert.throws(() =>
    assertPrivateMapping(
      {
        ...exact,
        TCP: { 443: { HTTPS: true }, 22: { TCPForward: "elsewhere" } },
      },
      host,
      port,
    ),
  );
  assert.throws(() => assertPrivateMapping(exact, host, 1234));
});

test("Truncated approval content cannot be accepted through the browser API", async (t) => {
  const { s, req, pair, agents } = await setup(t);
  const d = await pair(),
    session = await s.start("a", "codex");
  const agent = agents.find(
    (a) => a.generation === session.process.generation,
  )!;
  const id = randomUUID();
  agent.emitEvent({
    type: "approval.requested",
    source: "bridge",
    raw: { test: true },
    turn: { id: "turn", state: "waiting_approval" },
    pending: {
      id,
      turnId: "turn",
      kind: "approval",
      decisions: ["accept", "decline"],
      raw: { command: "x".repeat(5000) },
    },
  });
  const response = await req(
    `/api/sessions/${session.id}/approvals`,
    { approvalId: id, generation: agent.generation, decision: "accept" },
    { ...d.headers, "Idempotency-Key": randomUUID() },
  );
  assert.equal(response.status, 409);
  assert.equal(
    ((await response.json()) as any).error,
    "approval_details_truncated",
  );
  const decline = await req(
    `/api/sessions/${session.id}/approvals`,
    { approvalId: id, generation: agent.generation, decision: "decline" },
    { ...d.headers, "Idempotency-Key": randomUUID() },
  );
  assert.equal(decline.status, 200);
  assert.equal(
    (await req(`/api/sessions/${session.id}/release`, {}, d.headers)).status,
    404,
  );
});
