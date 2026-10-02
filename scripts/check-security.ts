import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
const { url } = JSON.parse(
  readFileSync(`${root}/.bridge/connection.json`, "utf8"),
);
const token = readFileSync(`${root}/.bridge/token`, "utf8");
const checks: any[] = [];
async function check(
  name: string,
  path: string,
  body: any,
  headers: any,
  expected: number,
) {
  const r = await fetch(url + path, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined
        ? headers
        : { ...headers, "Idempotency-Key": randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(r.status, expected, name);
  checks.push({ name, status: r.status });
}
const auth = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};
await check("authentication required", "/sessions", undefined, {}, 401);
await check(
  "bad token refused",
  "/sessions",
  undefined,
  { Authorization: "Bearer wrong" },
  401,
);
await check(
  "browser origin refused",
  "/sessions",
  undefined,
  { ...auth, Origin: "https://evil.example" },
  403,
);
await check(
  "arbitrary filesystem path refused",
  "/sessions",
  { project: "/tmp" },
  auth,
  409,
);
await check(
  "prototype property is not a project",
  "/sessions",
  { project: "constructor" },
  auth,
  409,
);
await check(
  "executable/flags not accepted",
  "/sessions",
  { project: "fixture", executable: "/bin/sh" },
  auth,
  409,
);
await check(
  "arbitrary native RPC unavailable",
  "/rpc",
  { method: "command/exec", params: { command: "anything" } },
  auth,
  404,
);
await check(
  "unauthorized event stream refused",
  "/sessions/0000/events",
  undefined,
  {},
  401,
);
await check(
  "unknown agent refused",
  "/sessions",
  { project: "fixture", agent: "shell" },
  auth,
  409,
);
await check(
  "client Claude executable override refused",
  "/sessions",
  { project: "fixture", agent: "claude", claudeExecutable: "/bin/sh" },
  auth,
  409,
);
await check(
  "client cwd override refused",
  "/sessions",
  { project: "fixture", cwd: "/tmp" },
  auth,
  409,
);
await check("malformed session body refused", "/sessions", [], auth, 409);
await check("health requires authentication", "/health", undefined, {}, 401);
await check(
  "diagnostics requires authentication",
  "/diagnostics",
  undefined,
  {},
  401,
);
await check(
  "operation lookup requires authentication",
  "/operations/operation123",
  undefined,
  {},
  401,
);
await check(
  "force release has no HTTP route",
  "/sessions/0000/release",
  {},
  auth,
  404,
);
await check(
  "browser cannot inspect diagnostics",
  "/diagnostics",
  undefined,
  { ...auth, Origin: "null" },
  403,
);
const missingKey = await fetch(url + "/sessions", {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ project: "fixture" }),
});
assert.equal(missingKey.status, 409);
assert.match(await missingKey.text(), /Idempotency-Key/);
checks.push({ name: "mutations require stable idempotency key", status: 409 });
const oversized = await fetch(url + "/sessions", {
  method: "POST",
  headers: { ...auth, "Idempotency-Key": randomUUID() },
  body: JSON.stringify({ project: "x".repeat(40000) }),
});
assert.equal(oversized.status, 413);
checks.push({ name: "oversized request refused", status: 413 });
const host = await new Promise<number>((resolve, reject) => {
  const req = httpRequest(
    url + "/health",
    { headers: { ...auth, Host: "evil.example" } },
    (res) => {
      res.resume();
      resolve(res.statusCode!);
    },
  );
  req.on("error", reject);
  req.end();
});
assert.equal(host, 403);
checks.push({ name: "invalid Host refused", status: 403 });
for (const path of ["/health", "/diagnostics"]) {
  const r = await fetch(url + path, { headers: auth });
  assert.equal(r.status, 200);
  const body = await r.text();
  assert(!body.includes(token));
  checks.push({
    name: `${path} is readable and excludes bearer token`,
    status: 200,
  });
}
const agentsResponse = await fetch(url + "/agents", { headers: auth });
assert.equal(agentsResponse.status, 200);
const agents: any = await agentsResponse.json();
const claude = agents.find((a: any) => a.agent === "claude");
assert(claude);
assert.equal(claude.availability.adapterInstalled, true);
writeFileSync(
  `${process.env.BRIDGE_EVIDENCE_DIR ?? `${root}/docs/evidence/phase567`}/availability.json`,
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      inferenceAttempted: false,
      ...claude,
    },
    null,
    2,
  ),
);
writeFileSync(
  `${process.env.BRIDGE_EVIDENCE_DIR ?? `${root}/docs/evidence/phase567`}/security.json`,
  JSON.stringify(checks, null, 2),
);
console.log(`${checks.length} security checks passed`);
