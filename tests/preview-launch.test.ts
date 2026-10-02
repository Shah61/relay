import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
// @ts-ignore Vercel handler is shared JavaScript.
import handler from "../api/preview.mjs";

test("Vercel preview launch forwards account authentication only to the configured relay and validates redirects", async (t) => {
  const savedOrigin = process.env.DASHBOARD_ORIGIN,
    savedRelay = process.env.RELAY_PUBLIC_URL,
    original = globalThis.fetch;
  process.env.DASHBOARD_ORIGIN = "https://dashboard.example.com";
  process.env.RELAY_PUBLIC_URL = "wss://relay.example.com";
  t.after(() => {
    globalThis.fetch = original;
    if (savedOrigin === undefined) delete process.env.DASHBOARD_ORIGIN;
    else process.env.DASHBOARD_ORIGIN = savedOrigin;
    if (savedRelay === undefined) delete process.env.RELAY_PUBLIC_URL;
    else process.env.RELAY_PUBLIC_URL = savedRelay;
  });
  const id = randomUUID();
  let calls = 0,
    responseStatus = 200,
    redirect = `https://${id}.preview.example.com/_pm/connect?ticket=fixture`;
  globalThis.fetch = (async (url: string, options: any) => {
    calls++;
    assert.equal(
      url,
      `https://relay.example.com/account-api/previews/open?id=${id}`,
    );
    assert.equal(options.headers.Cookie, "__Host-pm=test-only");
    assert.equal(options.headers.Origin, "https://dashboard.example.com");
    assert.equal(options.redirect, "error");
    return new Response(
      JSON.stringify(
        responseStatus === 200
          ? { url: redirect }
          : { error: "authentication_required" },
      ),
      { status: responseStatus },
    );
  }) as typeof fetch;
  async function request(url: string, extra: any = {}) {
    const result = {
      status: 200,
      headers: {} as Record<string, string>,
      body: "",
    };
    const res: any = {
      setHeader: (key: string, value: string) => {
        result.headers[key] = value;
        return res;
      },
      status: (value: number) => {
        result.status = value;
        return res;
      },
      writeHead: (value: number, headers: Record<string, string>) => {
        result.status = value;
        Object.assign(result.headers, headers);
        return res;
      },
      end: (body = "") => {
        result.body = body;
        return res;
      },
    };
    await handler(
      {
        url,
        method: "GET",
        headers: {
          cookie: "__Host-pm=test-only",
          "sec-fetch-site": "same-origin",
        },
        ...extra,
      },
      res,
    );
    return result;
  }
  const direct = await request(`/p/${id}`);
  assert.equal(direct.status, 303);
  assert.equal(direct.headers.Location, redirect);
  assert.equal(direct.headers["Cache-Control"], "no-store");
  assert.equal(
    (await request(`/api/preview?id=${id}`)).status,
    303,
    "Vercel rewrite route works",
  );
  const before = calls;
  assert.equal((await request("/p/not-a-preview")).status, 404);
  assert.equal((await request(`/p/${id}`, { method: "POST" })).status, 404);
  assert.equal(
    (await request(`/p/${id}`, { headers: { "sec-fetch-site": "cross-site" } }))
      .status,
    403,
  );
  assert.equal(calls, before);
  responseStatus = 401;
  assert.equal((await request(`/p/${id}`)).status, 401);
  responseStatus = 200;
  for (const invalid of [
    "http://localhost:3000",
    "https://evil.example/_pm/connect",
    `https://${id}.preview.example.com/other`,
  ]) {
    redirect = invalid;
    const response = await request(`/p/${id}`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.Location, undefined);
  }
});
