import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Accounts } from "../src/relay/accounts.ts";
import { createRelay } from "../src/relay/server.ts";

test("account relay keeps enrollment settings product-owned and bounds requests", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pm-accounts-"));
  const relay = createRelay(
    new Accounts(join(dir, "accounts.sqlite"), "https://app.example.com"),
    ["https://app.example.com"],
  );
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  const origin = `http://127.0.0.1:${(relay.server.address() as any).port}`;
  t.after(async () => {
    await relay.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const status = await fetch(origin + "/health");
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { status: "ok", protocol: 1 });
  const start = await fetch(origin + "/account-api/enrollment/start", {
    method: "POST",
    body: JSON.stringify({ name: "Office PC", platform: "win32" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(start.status, 200);
  const invitation = await start.json();
  assert.match(invitation.pollSecret, /^[A-Za-z0-9_-]{43}$/);
  assert.match(
    invitation.verificationUrl,
    /^https:\/\/app\.example\.com\/#authorize=/,
  );
  const pending = await fetch(origin + "/account-api/enrollment/poll", {
    method: "POST",
    body: JSON.stringify({
      id: invitation.id,
      pollSecret: invitation.pollSecret,
    }),
    headers: { "Content-Type": "application/json" },
  });
  assert.deepEqual(await pending.json(), { state: "pending" });
  const bad = await fetch(origin + "/account-api/enrollment/poll", {
    method: "POST",
    body: JSON.stringify({ id: invitation.id, pollSecret: "x".repeat(43) }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(bad.status, 400);
});
