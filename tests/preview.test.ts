import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";
import { Accounts } from "../src/relay/accounts.ts";
import { createRelay } from "../src/relay/server.ts";
import { RelayHost, allowedRemotePath } from "../src/relay/host.ts";
import { Sessions } from "../src/sessions/manager.ts";
import { FakeAdapter } from "./fixtures/fake-adapter.ts";
import { DeviceAuth } from "../src/security/devices.ts";
import { browserGateway } from "../src/browser/gateway.ts";
import { httpServer } from "../src/bridge/http.ts";
import { PreviewTargets } from "../src/preview/targets.ts";
import { PreviewCompanion } from "../src/preview/companion.ts";
import { approvedTarget, responseCookies } from "../src/preview/protocol.ts";
// @ts-ignore Shared browser encryption transport.
import { RelayTransport } from "../web/relay-client.mjs";
// @ts-ignore Shared browser cryptography.
import { deriveKey } from "../web/e2e.mjs";
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
async function until(check: () => boolean) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await delay(20);
  }
  throw Error("timed out");
}

test("target validation rejects infrastructure, LAN, URL tricks, privileged and bridge ports", () => {
  assert.deepEqual(approvedTarget("http://localhost:5173/"), {
    host: "127.0.0.1",
    port: 5173,
  });
  for (const url of [
    "http://127.0.0.1:22",
    "http://localhost:5432",
    "http://localhost:6379",
    "http://localhost:9229",
    "http://192.168.1.2:3000",
    "http://[::1]:3000",
    "http://127.0.0.2:3000",
    "http://localhost.evil:3000",
    "http://user@localhost:3000",
    "https://localhost:3000",
    "http://localhost:3000/path",
    "http://localhost:3000?port=22",
    "http://localhost:3000#x",
  ])
    assert.throws(() => approvedTarget(url), /invalid_target/, url);
  assert.throws(() => approvedTarget("http://localhost:3000", [3000]));
  assert.deepEqual(
    responseCookies([
      " __Host-pm-preview =bad; Path=/",
      "pm_preview=bad",
      "app=ok; Domain=localhost; Path=/",
    ]),
    ["app=ok; Path=/"],
  );
  for (const p of [
    "/api/previews?port=3000",
    "/preview?port=3000",
    "/api/previews/register",
    "/api/previews/../host/configure",
  ])
    for (const method of ["GET", "POST"])
      assert.equal(allowedRemotePath(p, method), false);
});

async function fixture(t: any, platform: "darwin" | "win32" = "darwin") {
  const dir = mkdtempSync(join(tmpdir(), "pm-preview-"));
  mkdirSync(join(dir, "project"));
  const origin = "http://127.0.0.1:47834",
    user = randomUUID(),
    computer = randomUUID(),
    token = randomBytes(32).toString("base64url"),
    login = randomBytes(32).toString("base64url");
  const accounts = new Accounts(join(dir, "accounts.sqlite"), origin);
  accounts.db
    .prepare("INSERT INTO users VALUES(?,?,?,?)")
    .run(user, "owner", "{}", Date.now());
  accounts.db
    .prepare("INSERT INTO computers VALUES(?,?,?,?,?,NULL,?)")
    .run(
      computer,
      user,
      "Disposable computer",
      platform,
      hash(token),
      Date.now(),
    );
  accounts.db
    .prepare("INSERT INTO logins VALUES(?,?,?)")
    .run(hash(login), user, Date.now() + 3600000);
  const relay = createRelay(accounts, [origin], {
    previewOriginTemplate: "http://{id}.localhost:1",
  });
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  const port = (relay.server.address() as any).port,
    relayUrl = `http://127.0.0.1:${port}`;
  relay.previews!.template = `http://{id}.localhost:${port}`;
  const sessions = new Sessions(
    (a) => new FakeAdapter(a, dir),
    join(dir, "state"),
    { project: join(dir, "project") },
  );
  const auth = new DeviceAuth(sessions.store, ["project"]);
  const core = httpServer(sessions, "test-only");
  core.listen(0, "127.0.0.1");
  await once(core, "listening");
  const targets = new PreviewTargets(sessions, [(core.address() as any).port]);
  let host: RelayHost;
  const gateway = browserGateway(sessions, auth, {
    port: 0,
    coreUrl: `http://127.0.0.1:${(core.address() as any).port}`,
    coreToken: "test-only",
    previews: targets,
    relay: () => host,
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  host = new RelayHost(
    auth,
    dir,
    `http://127.0.0.1:${(gateway.address() as any).port}`,
    "test-root",
    true,
  );
  host.previews = new PreviewCompanion(targets);
  host.configure({
    hostId: computer,
    hostName: "Disposable computer",
    relayUrl: relayUrl.replace("http:", "ws:"),
    frontendUrl: origin,
    hostToken: token,
    account: {
      ownerId: user,
      id: "test",
      publicKey: "test",
      counter: 0,
      origin,
      rpId: "127.0.0.1",
    },
  });
  const traffic: any[] = [];
  const dev = createServer(async (req, res) => {
    traffic.push({
      url: req.url,
      host: req.headers.host,
      origin: req.headers.origin,
      cookie: req.headers.cookie,
    });
    const url = new URL(req.url!, "http://localhost");
    if (url.pathname === "/redirect") {
      res
        .writeHead(302, {
          Location: `http://localhost:${(dev.address() as any).port}/asset.js?q=redirect`,
        })
        .end();
      return;
    }
    if (url.pathname === "/bad-redirect") {
      res.writeHead(302, { Location: "http://localhost:5432/" }).end();
      return;
    }
    if (url.pathname === "/cookies") {
      res
        .writeHead(200, {
          "Set-Cookie": [
            "app=a; HttpOnly; Path=/; Domain=localhost",
            "second=b; Path=/",
            "pm_preview=evil; Path=/",
          ],
        })
        .end(req.headers.cookie ?? "");
      return;
    }
    if (url.pathname === "/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: first\n\n");
      setTimeout(() => res.end("data: second\n\n"), 100);
      return;
    }
    if (url.pathname === "/large") {
      res.end(Buffer.alloc(2 * 1024 * 1024, 7));
      return;
    }
    if (url.pathname === "/echo") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      res.end(Buffer.concat(chunks));
      return;
    }
    if (url.pathname === "/asset.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(`export const query = ${JSON.stringify(url.search)};`);
      return;
    }
    if (url.pathname === "/style.css") {
      res.setHeader("Content-Type", "text/css");
      res.end("body { color: purple; }");
      return;
    }
    if (url.pathname === "/image.png") {
      res.setHeader("Content-Type", "image/png");
      res.end(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<!doctype html><title>Disposable preview</title><link rel="stylesheet" href="/style.css"><script type="module" src="/asset.js?q=html"></script><img src="/image.png"><h1>Phone preview</h1>',
    );
  });
  dev.listen(0, "127.0.0.1");
  await once(dev, "listening");
  const wss = new WebSocketServer({ server: dev, perMessageDeflate: false });
  wss.on("connection", (ws, req) => {
    traffic.push({ websocket: true, origin: req.headers.origin, url: req.url });
    ws.on("message", (data, binary) => ws.send(data, { binary }));
  });
  const session = await sessions.start("project");
  const paired = auth.exchange(
    auth.pairing("operator", ["project"]).code,
    "Phone",
  );
  host.secrets[paired.device.id] = paired.secret;
  const original = globalThis.WebSocket;
  globalThis.WebSocket = class extends WebSocket {
    constructor(url: string) {
      super(url, { origin });
    }
  } as any;
  const browser = new RelayTransport({
    hostId: computer,
    channelId: paired.device.id,
    relay: relayUrl.replace("http:", "ws:"),
    key: await deriveKey(paired.secret),
  });
  const remote = async (path: string, body?: any) => {
    const response = await browser.fetch(
      path,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": paired.csrf,
            },
            body: JSON.stringify(body),
          },
    );
    return { status: response.status, body: await response.json() };
  };
  const http = (
    path: string,
    options: {
      id?: string;
      cookie?: string;
      method?: string;
      body?: Buffer;
      origin?: string;
    } = {},
  ) =>
    new Promise<{ status: number; headers: any; body: Buffer }>(
      (resolve, reject) => {
        const q = request(
          relayUrl + path,
          {
            method: options.method ?? "GET",
            headers: {
              ...(options.id
                ? { Host: `${options.id}.localhost:${port}` }
                : {}),
              ...(options.cookie ? { Cookie: options.cookie } : {}),
              ...(options.origin ? { Origin: options.origin } : {}),
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (c) => chunks.push(c));
            response.on("end", () =>
              resolve({
                status: response.statusCode!,
                headers: response.headers,
                body: Buffer.concat(chunks),
              }),
            );
            response.on("error", reject);
          },
        );
        q.on("error", reject);
        q.end(options.body);
      },
    );
  t.after(async () => {
    browser.socket?.close();
    globalThis.WebSocket = original;
    host.stop();
    targets.close();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    dev.closeAllConnections();
    await new Promise<void>((r) => dev.close(() => r()));
    await relay.close();
    accounts.close();
    gateway.closeAllConnections();
    gateway.close();
    core.closeAllConnections();
    core.close();
    await sessions.shutdown();
    sessions.store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await until(() => host.previews!.ready);
  const detect = () =>
    sessions.record(sessions.get(session.id), {
      type: "command.output",
      source: "native",
      raw: {
        params: {
          delta: `Local: http://localhost:${(dev.address() as any).port}\n`,
        },
      },
    });
  const enable = async () => {
    detect();
    const rows = (await remote("/api/previews")).body.previews;
    const localId = rows[0].id;
    assert.equal(
      (await remote(`/api/previews/${localId}/approve`, {})).status,
      200,
    );
    await until(() => !!targets.get(localId).previewId);
    return { localId, id: targets.get(localId).previewId! };
  };
  const launch = async (id: string, credential = login) => {
    const result = await http(`/account-api/previews/open?id=${id}`, {
      cookie: `pm_development=${credential}`,
    });
    if (result.status !== 200) return { status: result.status, cookie: "" };
    const url = new URL(JSON.parse(result.body.toString()).url);
    const connected = await http(url.pathname + url.search, { id });
    assert.equal(connected.status, 303);
    assert.equal(connected.headers.location, "/");
    assert.equal(
      (await http(url.pathname + url.search, { id })).status,
      401,
      "ticket is one-use",
    );
    return {
      status: connected.status,
      cookie: connected.headers["set-cookie"][0].split(";")[0],
    };
  };
  return {
    sessions,
    session,
    targets,
    host,
    relay,
    accounts,
    auth,
    gatewayUrl: `http://127.0.0.1:${(gateway.address() as any).port}`,
    user,
    computer,
    login,
    paired,
    origin,
    port,
    relayUrl,
    remote,
    http,
    detect,
    enable,
    launch,
    dev,
    traffic,
  };
}

test(
  "real remote preview: HTML/assets/query/redirects/cookies/streaming/uploads/WebSockets; session traffic remains intact",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const hosting = (await f.remote('/api/previews')).body;
    assert.equal(hosting.hostingStatus, 'ready');
    assert.equal(hosting.dashboardOrigin, f.origin);
    assert.equal(JSON.parse((await f.http('/health')).body.toString()).previewHosting, true);
    f.sessions.record(f.sessions.get(f.session.id), {
      type: "agent.message",
      source: "native",
      raw: { params: { delta: "http://localhost:5173" } },
    });
    assert.equal(f.targets.records.size, 0, "assistant text is not detection");
    f.detect();
    const candidate = (await f.remote("/api/previews")).body.previews[0];
    assert.equal(candidate.state, "candidate");
    assert.equal(candidate.previewId, undefined);
    const viewer = f.auth.exchange(
      f.auth.pairing("viewer", ["project"]).code,
      "Read-only phone",
    );
    const rejected = await fetch(
      f.gatewayUrl + `/api/previews/${candidate.id}/approve`,
      {
        method: "POST",
        headers: {
          Cookie: `relay_local=${viewer.secret}`,
          Origin: f.gatewayUrl,
          "X-CSRF-Token": viewer.csrf,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
    assert.equal(rejected.status, 403);
    assert.equal(
      (await f.remote(`/api/previews/${candidate.id}/approve`, { port: 5432 }))
        .status,
      400,
    );
    const p = await f.enable(),
      auth = await f.launch(p.id);
    const opts = { id: p.id, cookie: auth.cookie };
    const html = await f.http("/", opts);
    assert.equal(html.status, 200);
    assert.match(html.body.toString(), /Phone preview/);
    assert.match(
      (await f.http("/asset.js?q=mobile%20data", opts)).body.toString(),
      /mobile%20data/,
    );
    assert.match((await f.http("/style.css", opts)).body.toString(), /purple/);
    assert.equal((await f.http("/image.png", opts)).body[0], 137);
    const redirect = await f.http("/redirect", opts);
    assert.equal(redirect.status, 302);
    assert.equal(
      redirect.headers.location,
      `http://${p.id}.localhost:${f.port}/asset.js?q=redirect`,
    );
    assert.equal((await f.http("/bad-redirect", opts)).status, 502);
    const cookies = await f.http("/cookies", {
      ...opts,
      cookie: auth.cookie + "; app=own; second=two",
    });
    assert.equal(cookies.body.toString(), "app=own; second=two");
    assert.equal(cookies.headers["set-cookie"].length, 2);
    assert(
      cookies.headers["set-cookie"].every(
        (v: string) => !v.includes("Domain="),
      ),
    );
    assert.equal((await f.http("/large", opts)).body.length, 2 * 1024 * 1024);
    const payload = Buffer.alloc(150000, 9);
    assert.deepEqual(
      (
        await f.http("/echo?x=upload", {
          ...opts,
          method: "POST",
          body: payload,
          origin: `http://${p.id}.localhost:${f.port}`,
        })
      ).body,
      payload,
    );
    await new Promise<void>((resolve, reject) => {
      const q = request(
        f.relayUrl + "/stream",
        {
          headers: { Host: `${p.id}.localhost:${f.port}`, Cookie: auth.cookie },
        },
        (response) => {
          const chunks: string[] = [];
          response.on("data", (c) => chunks.push(c.toString()));
          response.on("end", () => {
            try {
              assert.equal(chunks.length, 2);
              assert.match(chunks[0], /first/);
              assert.match(chunks[1], /second/);
              resolve();
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      q.on("error", reject);
      q.end();
    });
    const ws = new WebSocket(
      f.relayUrl.replace("http:", "ws:") + "/hmr?token=fixture",
      "vite-hmr",
      {
        origin: `http://${p.id}.localhost:${f.port}`,
        headers: { Host: `${p.id}.localhost:${f.port}`, Cookie: auth.cookie },
      },
    );
    ws.on("error", () => {});
    await once(ws, "open");
    assert.equal(ws.protocol, "vite-hmr");
    const echoed = once(ws, "message");
    ws.send("hot update");
    assert.equal((await echoed)[0].toString(), "hot update");
    const binary = once(ws, "message");
    ws.send(Buffer.from([0, 255]));
    assert.deepEqual(
      Buffer.from((await binary)[0] as Buffer),
      Buffer.from([0, 255]),
    );
    ws.close();
    assert(
      f.traffic.some(
        (r) =>
          r.websocket &&
          r.origin === `http://127.0.0.1:${(f.dev.address() as any).port}`,
      ),
    );
    const op = await f.sessions.operate(
      "preview_session_prompt",
      "prompt",
      f.session.id,
      { text: "regular session still works" },
    );
    assert.equal(op.operation.state, "completed");
    assert.equal(
      (await f.http("/account-api/previews/open?id=" + p.id)).status,
      401,
    );
    assert.equal((await f.http("/", { id: p.id })).status, 401);
    assert.equal(
      (await f.http("/", { id: randomUUID(), cookie: auth.cookie })).status,
      404,
    );
    assert.equal(
      (await f.http("/", { ...opts, origin: "https://evil.example" })).status,
      404,
    );
    assert.equal(
      (
        await f.http("/preview?port=22", {
          cookie: `pm_development=${f.login}`,
        })
      ).status,
      404,
    );
    const foreignUser = randomUUID(),
      foreignLogin = randomBytes(32).toString("base64url");
    f.accounts.db
      .prepare("INSERT INTO users VALUES(?,?,?,?)")
      .run(foreignUser, "stranger", "{}", Date.now());
    f.accounts.db
      .prepare("INSERT INTO logins VALUES(?,?,?)")
      .run(hash(foreignLogin), foreignUser, Date.now() + 60000);
    assert.equal((await f.launch(p.id, foreignLogin)).status, 400);
    await f.remote(`/api/previews/${p.localId}/disable`, {});
    await until(() => !!f.relay.previews!.records.get(p.id)?.revokedAt);
    assert.equal((await f.http("/", opts)).status, 404);
  },
);

test(
  "preview lifecycle fails closed on expiry, login revocation, session close, disconnect/reconnect and port changes",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, "win32");
    let p = await f.enable(),
      auth = await f.launch(p.id);
    f.accounts.db
      .prepare("UPDATE logins SET expires=0 WHERE hash=?")
      .run(hash(f.login));
    assert.equal(
      (await f.http("/", { id: p.id, cookie: auth.cookie })).status,
      401,
    );
    f.accounts.db
      .prepare("UPDATE logins SET expires=? WHERE hash=?")
      .run(Date.now() + 600000, hash(f.login));
    f.relay.previews!.records.get(p.id)!.expiresAt = Date.now() - 1;
    assert.equal(
      (await f.http("/", { id: p.id, cookie: auth.cookie })).status,
      404,
    );
    f.relay.previews!.sweep();
    f.targets.revoke(p.localId);
    p = await f.enable();
    const old = p.id;
    const activeAuth = await f.launch(p.id);
    const activeSocket = new WebSocket(
      f.relayUrl.replace("http:", "ws:") + "/hmr",
      {
        origin: `http://${p.id}.localhost:${f.port}`,
        headers: {
          Host: `${p.id}.localhost:${f.port}`,
          Cookie: activeAuth.cookie,
        },
      },
    );
    activeSocket.on("error", () => {});
    await once(activeSocket, "open");
    const disconnected = once(activeSocket, "close");
    f.host.previews!.disconnect();
    await until(() => !f.relay.previews!.hosts.has(f.computer));
    await disconnected;
    assert.equal(
      (await f.http("/", { id: old, cookie: auth.cookie })).status,
      404,
    );
    f.host.previews!.connect(f.host.config!);
    await until(() => !!f.targets.get(p.localId).previewId);
    assert.notEqual(
      f.targets.get(p.localId).previewId,
      old,
      "reconnect assigns a fresh ID",
    );
    p.id = f.targets.get(p.localId).previewId!;
    auth = await f.launch(p.id);
    const second = createServer((_req, res) => res.end("new port"));
    second.listen(0, "127.0.0.1");
    await once(second, "listening");
    const next = f.targets.candidate(
      f.session.id,
      `http://localhost:${(second.address() as any).port}`,
    );
    assert.equal(next.state, "candidate");
    assert.equal(next.previewId, undefined);
    second.closeAllConnections();
    second.close();
    await f.sessions.operate("end_preview_session", "end", f.session.id, {});
    await until(() => !!f.relay.previews!.records.get(p.id)?.revokedAt);
    assert.equal(
      (await f.http("/", { id: p.id, cookie: auth.cookie })).status,
      404,
    );
    assert.equal((await f.remote("/api/previews")).body.previews.length, 0);
  },
);

test(
  "stopping an approved dev server revokes its ID without probing other ports",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      p = await f.enable(),
      auth = await f.launch(p.id);
    f.dev.closeAllConnections();
    await new Promise<void>((r) => f.dev.close(() => r()));
    await f.targets.sweep();
    await until(() => !!f.relay.previews!.records.get(p.id)?.revokedAt);
    assert.equal(
      (await f.http("/", { id: p.id, cookie: auth.cookie })).status,
      404,
    );
    assert.equal((await f.remote("/api/previews")).body.previews.length, 0);
  },
);

test('missing preview hosting is reported instead of waiting forever', { timeout: 10000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pm-preview-unconfigured-'));
  const accounts = new Accounts(join(dir, 'accounts.sqlite'), 'http://127.0.0.1:47834');
  const relay = createRelay(accounts, ['http://127.0.0.1:47834']);
  relay.server.listen(0, '127.0.0.1');
  await once(relay.server, 'listening');
  const targets = new (await import('node:events')).EventEmitter() as any;
  targets.records = new Map();
  const companion = new PreviewCompanion(targets);
  t.after(async () => {
    companion.close(); await relay.close(); accounts.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const port = (relay.server.address() as any).port;
  const health = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json());
  assert.equal(health.previewHosting, false);
  companion.connect({ relayUrl: `ws://127.0.0.1:${port}`, hostToken: 'test-only', hostId: randomUUID(), hostName: 'Test', frontendUrl: 'http://127.0.0.1:47834', account: {} as any });
  await until(() => companion.status === 'unavailable');
  assert.equal(companion.ready, false);
  companion.disconnect();
  assert.equal(companion.status, 'offline');
});
