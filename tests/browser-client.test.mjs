import test from "node:test";
import assert from "node:assert/strict";
import { Client, readEvents } from "../web/client.mjs";
function storage() {
  const m = new Map();
  return { getItem: (k) => m.get(k), setItem: (k, v) => m.set(k, v) };
}
test("Lost acknowledgement survives reload without persisting prompt or automatically retrying", async () => {
  const disk = storage();
  const a = new Client({
    storage: disk,
    fetcher: async () => {
      throw Error("connection lost");
    },
  });
  a.device = { id: "device" };
  a.csrf = "secret-csrf";
  await assert.rejects(
    a.mutate(
      "/api/sessions/test/prompt",
      { text: "private prompt" },
      "operation-123",
    ),
  );
  assert.equal(a.pending()[0].state, "delivery_unknown");
  assert(!JSON.stringify(a.pending()).includes("private prompt"));
  assert(!JSON.stringify(a.pending()).includes("secret-csrf"));
  const calls = [];
  const b = new Client({
    storage: disk,
    fetcher: async (path, options) => {
      calls.push({ path, options });
      return new Response(
        JSON.stringify({ id: "operation-123", state: "completed" }),
      );
    },
  });
  b.device = a.device;
  await b.reconcile();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, undefined);
  assert.equal(calls[0].path, "/api/operations/operation-123");
  assert.equal(b.pending().length, 0);
});
test("Unknown operations and uncertain delivery remain visible; no resend", async () => {
  const c = new Client({
    storage: storage(),
    fetcher: async () =>
      new Response(JSON.stringify({ error: "unknown_operation" }), {
        status: 404,
      }),
  });
  c.device = { id: "d" };
  c.remember({
    id: "operation-123",
    path: "/api/sessions",
    state: "delivery_unknown",
  });
  const rows = await c.reconcile();
  assert.equal(rows[0].state, "not_found_do_not_resend");
  assert.equal(c.pending().length, 1);
});
test("SSE parser handles fragmented frames and retained-history resync", async () => {
  const chunks = [
    "id: 4\nda",
    'ta: {"type":"test"}\n\n',
    'event: resync_required\ndata: {"error":"resync_required"}\n\n',
  ];
  const result = [];
  await readEvents(
    new Response(
      new ReadableStream({
        start(c) {
          for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
          c.close();
        },
      }),
    ),
    (e) => result.push(e),
  );
  assert.equal(result[0].id, 4);
  assert.equal(result[1].type, "resync_required");
});

test("Unknown contract versions refuse authentication setup", async () => {
  const c = new Client({
    storage: storage(),
    fetcher: async () =>
      new Response(
        JSON.stringify({ contractVersion: 2, device: { id: "d" }, csrf: "x" }),
      ),
  });
  await assert.rejects(c.connect(), /Unsupported bridge contract/);
  assert.equal(c.device, null);
});
test("Storage failure prevents mutation dispatch instead of losing its recovery ID", async () => {
  let calls = 0;
  const c = new Client({
    storage: {
      getItem: () => null,
      setItem: () => {
        throw Error("storage blocked");
      },
    },
    fetcher: async () => {
      calls++;
      return new Response("{}");
    },
  });
  c.device = { id: "d" };
  await assert.rejects(
    c.mutate("/api/sessions", { project: "a" }),
    /storage blocked/,
  );
  assert.equal(calls, 0);
});
test("Uncertain HTTP response remains in the outbox", async () => {
  const c = new Client({
    storage: storage(),
    fetcher: async () =>
      new Response(
        JSON.stringify({
          operation: { id: "uncertain-123", state: "delivery_uncertain" },
        }),
        { status: 409 },
      ),
  });
  c.device = { id: "d" };
  await c.mutate("/api/sessions", { project: "a" }, "uncertain-123");
  assert.equal(c.pending()[0].state, "delivery_uncertain");
});
