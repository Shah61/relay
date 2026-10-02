import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { createRelay } from "../src/relay/server.ts";
import { RelayHost, allowedRemotePath } from "../src/relay/host.ts";
import { DeviceAuth } from "../src/security/devices.ts";
import { Sessions } from "../src/sessions/manager.ts";
import { FakeAdapter } from "./fixtures/fake-adapter.ts";
import { browserGateway } from "../src/browser/gateway.ts";
import { httpServer } from "../src/bridge/http.ts";
import { windowsCodexCandidates } from "../src/platform/host.ts";
import { windowsIdentityArgs } from "../src/supervision/process.ts";
// @ts-ignore Browser modules exercised over real WebSockets.
import { cipher, deriveKey } from "../web/e2e.mjs";
// @ts-ignore Browser modules exercised over real WebSockets.
import { RelayTransport, parseInvitation } from "../web/relay-client.mjs";
// @ts-ignore Browser modules exercised over real WebSockets.
import { Client } from "../web/client.mjs";

test("encryption rejects wrong keys, tampering, replay and cross-link replay", async () => {
  const context = {
    hostId: randomUUID(),
    channelId: randomUUID(),
    linkId: randomUUID(),
    challenge: "fresh",
  };
  const key = await deriveKey("secret"),
    sender = cipher(key, context, "client"),
    receiver = cipher(key, context, "host");
  const frame = await sender.seal({ prompt: "private task" });
  assert.equal(JSON.stringify(frame).includes("private task"), false);
  assert.deepEqual(await receiver.open(frame), { prompt: "private task" });
  await assert.rejects(receiver.open(frame));
  await assert.rejects(
    cipher(await deriveKey("wrong"), context, "host").open(frame),
  );
  await assert.rejects(
    cipher(key, { ...context, challenge: "new connection" }, "host").open(
      frame,
    ),
  );
  await assert.rejects(
    cipher(key, context, "host").open({
      ...frame,
      data: frame.data.slice(0, 8) + "AAAA" + frame.data.slice(12),
    }),
  );
});
test("remote route allowlist excludes local administration, URL tricks and arbitrary destinations", () => {
  for (const path of [
    "/api/host/configure",
    "/admin/pairings",
    "https://evil.test",
    "//evil.test",
    "/api/sessions/../host/configure",
    "/api/sessions?offset=1&url=evil",
    "/api/%68ost/status",
  ])
    for (const method of ["GET", "POST"])
      assert.equal(allowedRemotePath(path, method), false);
  assert.equal(allowedRemotePath("/api/sessions?offset=10", "GET"), true);
  assert.equal(allowedRemotePath("/api/sessions", "POST"), true);
  assert.throws(() => parseInvitation("#pair=invalid"));
});
test("Windows native executable candidates support spaces and PowerShell PID is validated", () => {
  assert.ok(
    windowsCodexCandidates(
      "C:\\Users\\Test User\\AppData\\Roaming\\npm",
      "x64",
    ).some((p) => p.endsWith("x86_64-pc-windows-msvc\\codex\\codex.exe")),
  );
  assert.ok(
    windowsCodexCandidates("C:\\bin", "arm64").some((p) =>
      p.includes("aarch64-pc-windows-msvc"),
    ),
  );
  assert.throws(() => windowsIdentityArgs(-1));
  assert.throws(() => windowsIdentityArgs(NaN));
  assert.ok(windowsIdentityArgs(123).at(-1)?.includes("Get-Process -Id 123"));
});

test(
  "real relay: pairing, scoped commands, live events, reconnect, idempotency and revocation",
  { timeout: 45000 },
  async (t) => {
    const origin = "http://127.0.0.1:47834",
      token = "test-enrollment-token-".repeat(3);
    const relay = createRelay(token, [origin]);
    relay.server.listen(0, "127.0.0.1");
    await once(relay.server, "listening");
    const relayUrl = `ws://127.0.0.1:${(relay.server.address() as any).port}`;
    const dir = mkdtempSync(join(tmpdir(), "relay-integration-"));
    mkdirSync(join(dir, "project"));
    mkdirSync(join(dir, "other"));
    const sessions = new Sessions(
      (agent) => new FakeAdapter(agent, dir),
      join(dir, "state"),
      { project: join(dir, "project"), other: join(dir, "other") },
    );
    const auth = new DeviceAuth(sessions.store, ["project", "other"]);
    let host: RelayHost;
    const core = httpServer(sessions, "root-test");
    core.listen(0, "127.0.0.1");
    await once(core, "listening");
    const gateway = browserGateway(sessions, auth, {
      port: 0,
      coreUrl: `http://127.0.0.1:${(core.address() as any).port}`,
      coreToken: "root-test",
      relay: () => host,
    });
    gateway.listen(0, "127.0.0.1");
    await once(gateway, "listening");
    const gatewayUrl = `http://127.0.0.1:${(gateway.address() as any).port}`;
    host = new RelayHost(auth, dir, gatewayUrl, "test-root-token");
    const transports: any[] = [];
    const original = globalThis.WebSocket;
    globalThis.WebSocket = class extends WebSocket {
      constructor(url: string) {
        super(url, { origin });
      }
    } as any;
    t.after(async () => {
      for (const transport of transports) transport.socket?.close();
      host.stop();
      await relay.close();
      gateway.closeAllConnections();
      gateway.close();
      core.closeAllConnections();
      core.close();
      await sessions.shutdown();
      sessions.store.close();
      globalThis.WebSocket = original;
      rmSync(dir, { recursive: true, force: true });
    });
    host.configure({
      relayUrl,
      frontendUrl: origin,
      hostToken: token,
      hostName: "Test PC",
    });
    for (let i = 0; i < 100 && host.state !== "connected"; i++) await delay(20);
    assert.equal(host.state, "connected");
    const invalid = new WebSocket(relayUrl + "/host", {
      headers: { Authorization: "Bearer wrong" },
    });
    invalid.on("error", () => {});
    const [, rejectedResponse] = await once(invalid, "unexpected-response");
    assert.equal(rejectedResponse.statusCode, 403);
    invalid.terminate();
    const wrongOrigin = new WebSocket(relayUrl + "/client", {
      origin: "https://unapproved.example",
    });
    wrongOrigin.on("error", () => {});
    const [, originResponse] = await once(wrongOrigin, "unexpected-response");
    assert.equal(originResponse.statusCode, 403);
    wrongOrigin.terminate();
    const cancelled = await host.invitation("operator", ["project"]);
    const cancelledPayload = parseInvitation(new URL(cancelled.url).hash);
    host.cancel(cancelled.id);
    assert.throws(() => auth.exchange(cancelledPayload.code, "cancelled"));
    const owner = auth.exchange(
      auth.pairing("owner", ["project"]).code,
      "local owner",
    );
    const ownerStatus = await fetch(gatewayUrl + "/api/host/status", {
      headers: { Cookie: `relay_local=${owner.secret}` },
    });
    assert.equal(ownerStatus.status, 200);
    assert.equal((await ownerStatus.text()).includes(token), false);
    const invalidSetup = await fetch(gatewayUrl + "/api/host/configure", {
      method: "POST",
      headers: {
        Cookie: `relay_local=${owner.secret}`,
        Origin: "https://evil.example",
        "X-CSRF-Token": owner.csrf,
      },
      body: "{}",
    });
    assert.equal(invalidSetup.status, 403);
    async function pair(role: "operator" | "viewer") {
      const invitation = await host.invitation(role, ["project"]);
      assert.ok(invitation.qr.startsWith("data:image/png;base64,"));
      const p = parseInvitation(new URL(invitation.url).hash);
      const transport = new RelayTransport({
        ...p,
        key: await deriveKey(p.code),
      });
      transports.push(transport);
      const paired = await (
        await transport.rpc(
          { method: "PAIR", name: role },
          AbortSignal.timeout(5000),
        )
      ).json();
      transport.socket.close();
      await delay(30);
      const profile = {
        ...p,
        channelId: paired.device.id,
        key: await deriveKey(paired.secret),
      };
      const device = new RelayTransport(profile);
      transports.push(device);
      return { transport: device, paired, invitation, profile };
    }
    const operator = await pair("operator");
    const memory = new Map();
    const client = new Client({
      fetcher: operator.transport.fetch,
      storage: {
        getItem: (k: any) => memory.get(k),
        setItem: (k: any, v: any) => memory.set(k, v),
      },
    });
    const me = await client.connect();
    assert.equal(me.transport, "encrypted_relay");
    assert.deepEqual((await client.get("/api/projects")).projects, [
      { id: "project" },
    ]);
    const start = await client.mutate("/api/sessions", {
      project: "project",
      agent: "codex",
    });
    const sessionId = start.operation.session_id;
    assert.ok(sessionId);
    const abort = new AbortController();
    const events = await operator.transport.fetch(
      `/api/sessions/${sessionId}/events?after=0`,
      { signal: abort.signal },
    );
    const reader = events.body.getReader();
    assert.ok((await reader.read()).value.length);
    await reader.cancel();
    abort.abort();
    const operationId = randomUUID(),
      message = "encrypted-private-prompt";
    const first = await client.mutate(
      `/api/sessions/${sessionId}/prompt`,
      { text: message },
      operationId,
    );
    assert.equal(first.operation.state, "completed");
    await client.mutate(
      `/api/sessions/${sessionId}/prompt`,
      { text: message },
      operationId,
    );
    assert.equal(
      readFileSync(join(dir, "test-deliveries.jsonl"), "utf8")
        .trim()
        .split("\n").length,
      1,
    );
    const originalReply = host.reply.bind(host),
      lostId = randomUUID();
    let dropped = false;
    host.reply = async (linkId: string, message: any) => {
      if (!dropped && message.body?.operation?.id === lostId) {
        dropped = true;
        host.drop(linkId);
        return;
      }
      return originalReply(linkId, message);
    };
    await assert.rejects(
      client.mutate(
        `/api/sessions/${sessionId}/prompt`,
        { text: "lost acknowledgement" },
        lostId,
      ),
    );
    assert.equal(
      client.pending().find((p: any) => p.id === lostId).state,
      "delivery_unknown",
    );
    host.reply = originalReply;
    await client.connect();
    await client.reconcile();
    assert.equal(client.pending().length, 0);
    assert.equal(
      readFileSync(join(dir, "test-deliveries.jsonl"), "utf8")
        .trim()
        .split("\n").length,
      2,
    );
    assert.equal(
      readFileSync(join(dir, "relay-devices.json"), "utf8").includes(
        operator.paired.secret,
      ),
      false,
    );
    const viewer = await pair("viewer");
    const denied = await viewer.transport.fetch("/api/sessions", {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ project: "project", agent: "codex" }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(denied.status, 403);
    const forbidden = await operator.transport.fetch("/api/sessions", {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ project: "other", agent: "codex" }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(forbidden.status, 403);
    host.stop();
    await delay(100);
    host = new RelayHost(auth, dir, gatewayUrl, "test-root-token");
    host.start();
    for (let i = 0; i < 100 && host.state !== "connected"; i++) await delay(20);
    assert.equal((await client.connect()).device.id, operator.paired.device.id);
    assert.equal(
      (await client.get(`/api/operations/${operationId}`)).state,
      "completed",
    );
    const pendingClosed = once(operator.transport.socket, "close");
    auth.revoke(operator.paired.device.id);
    await pendingClosed;
    await assert.rejects(
      operator.transport.fetch("/auth/me", {
        signal: AbortSignal.timeout(2000),
      }),
    );
    await assert.rejects(
      viewer.transport.fetch("/api/host/status", {
        signal: AbortSignal.timeout(2000),
      }),
    );
  },
);
