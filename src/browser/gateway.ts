import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Sessions } from "../sessions/manager.ts";
import { DeviceAuth, AccessError, type Device } from "../security/devices.ts";
import { RateLimit } from "../security/rate-limit.ts";
import { contract, truncated } from "./contract.ts";
import type { RelayHost } from "../relay/host.ts";
export type BrowserOptions = {
  port: number;
  remoteOrigin?: string;
  coreUrl: string;
  coreToken: string;
  assetDir?: string;
  relay?: () => RelayHost | undefined;
};
export async function body(req: IncomingMessage, max = 32768) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new AccessError("body_too_large", 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error();
    return value;
  } catch {
    throw new AccessError("invalid_json", 400);
  }
}
export function browserGateway(
  sessions: Sessions,
  auth: DeviceAuth,
  options: BrowserOptions,
) {
  const rates = new RateLimit(),
    streams = new Map<string, number>();
  const root = options.assetDir ?? resolve(import.meta.dirname, "../../web");
  const remote = options.remoteOrigin
    ? new URL(options.remoteOrigin)
    : undefined;
  const server = createServer(async (req, res) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    res.setHeader("Cache-Control", "no-store");
    const json = (data: any, status = 200) => {
      res
        .writeHead(status, { "Content-Type": "application/json" })
        .end(JSON.stringify(data));
    };
    try {
      const address = server.address() as any;
      const localHost = `127.0.0.1:${address?.port ?? options.port}`;
      const host = req.headers.host;
      const isRemote = !!remote && host === remote.host;
      if (host !== localHost && !isRemote)
        throw new AccessError("host_forbidden");
      if (req.headers.authorization)
        throw new AccessError("bearer_not_accepted_on_browser_gateway");
      const origin = isRemote ? remote!.origin : `http://${localHost}`;
      if (isRemote)
        res.setHeader("Strict-Transport-Security", "max-age=31536000");
      if (req.headers.origin && req.headers.origin !== origin)
        throw new AccessError("origin_forbidden");
      if (req.headers["sec-fetch-site"] === "cross-site")
        throw new AccessError("origin_forbidden");
      const url = new URL(req.url!, origin);
      const mutating = !["GET", "HEAD"].includes(req.method ?? "GET");
      if (mutating && req.headers.origin !== origin)
        throw new AccessError("origin_required");
      const assets: Record<string, [string, string]> = {
        "/": ["index.html", "text/html; charset=utf-8"],
        "/app.mjs": ["app.mjs", "text/javascript; charset=utf-8"],
        "/client.mjs": ["client.mjs", "text/javascript; charset=utf-8"],
        "/markdown.mjs": ["markdown.mjs", "text/javascript; charset=utf-8"],
        "/replies.mjs": ["replies.mjs", "text/javascript; charset=utf-8"],
        "/vendor/marked.mjs": ["vendor/marked.mjs", "text/javascript; charset=utf-8"],
        "/vendor/purify.mjs": ["vendor/purify.mjs", "text/javascript; charset=utf-8"],
        "/relay-client.mjs": [
          "relay-client.mjs",
          "text/javascript; charset=utf-8",
        ],
        "/e2e.mjs": ["e2e.mjs", "text/javascript; charset=utf-8"],
        "/style.css": ["style.css", "text/css; charset=utf-8"],
        "/icon.svg": ["icon.svg", "image/svg+xml"],
        "/manifest.webmanifest": [
          "manifest.webmanifest",
          "application/manifest+json",
        ],
      };
      if (req.method === "GET" && assets[url.pathname]) {
        const [file, type] = assets[url.pathname];
        res
          .writeHead(200, { "Content-Type": type })
          .end(readFileSync(resolve(root, file)));
        return;
      }
      if (req.method === "GET" && url.pathname === "/ready") {
        json({ application: "Relay", contractVersion: 1, secure: isRemote });
        return;
      }
      const cookieName = isRemote ? "__Host-relay" : "relay_local";
      const cookies = (req.headers.cookie ?? "")
        .split(";")
        .map((v) => v.trim())
        .filter((v) => v.startsWith(cookieName + "="));
      const secret =
        cookies.length === 1 ? cookies[0].slice(cookieName.length + 1) : "";
      const cookie = (value: string, maxAge: number) =>
        `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isRemote ? "; Secure" : ""}`;
      if (req.method === "POST" && url.pathname === "/auth/pair") {
        rates.check("pair-global", 20);
        const input = await body(req, 4096);
        if (Object.keys(input).some((k) => !["code", "name"].includes(k)))
          throw new AccessError("invalid_pairing", 400);
        const paired = auth.exchange(input.code, input.name);
        if (secret) {
          try {
            auth.revoke(auth.get(secret).id, "replaced_on_pairing");
          } catch {}
        }
        res.setHeader("Set-Cookie", cookie(paired.secret, 30 * 86400));
        json({ device: paired.device, csrf: paired.csrf });
        return;
      }
      const device = auth.get(secret);
      rates.check(device.id, 240);
      if (mutating) {
        auth.checkCsrf(secret, req.headers["x-csrf-token"]);
        rates.check(device.id + ":write", 60);
      }
      if (req.method === "GET" && url.pathname === "/auth/me") {
        json({
          device,
          csrf: auth.csrf(secret),
          contractVersion: 1,
          transport: isRemote ? "private_https" : "local_loopback",
        });
        return;
      }
      if (url.pathname.startsWith("/api/host/")) {
        auth.owner(device);
        if (
          isRemote ||
          !["127.0.0.1", "::ffff:127.0.0.1"].includes(
            req.socket.remoteAddress ?? "",
          )
        )
          throw new AccessError("local_setup_only");
        const relay = options.relay?.();
        if (!relay) throw new AccessError("relay_unavailable", 503);
        if (req.method === "GET" && url.pathname === "/api/host/status") {
          json(relay.status());
          return;
        }
        if (req.method === "POST" && url.pathname === "/api/host/configure") {
          if (relay.managed) throw new AccessError('companion_manages_connection', 403);
          json(relay.configure(await body(req, 4096)));
          return;
        }
        if (req.method === "POST" && url.pathname === "/api/host/pairings") {
          const input = await body(req, 4096);
          const projects = input.projects ?? device.projects;
          if (!Array.isArray(projects))
            throw new AccessError("invalid_projects", 400);
          projects.forEach((p) => auth.canProject(device, p));
          json(await relay.invitation(input.role ?? "operator", projects));
          return;
        }
        if (req.method === "POST" && url.pathname === "/api/host/cancel") {
          const input = await body(req, 4096);
          relay.cancel(input.id);
          json({ cancelled: true });
          return;
        }
        throw new AccessError("not_found", 404);
      }
      if (req.method === "POST" && url.pathname === "/auth/logout") {
        auth.revoke(device.id, device.id);
        res.setHeader("Set-Cookie", cookie("", 0));
        json({ signedOut: true });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/contract") {
        json(contract);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/projects") {
        json({
          projects: device.projects
            .filter((p) => Object.hasOwn(sessions.projects, p))
            .map((id) => ({ id })),
          remote: { configured: !!remote, url: remote?.origin ?? null },
          role: device.role,
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/devices") {
        json({
          devices: device.role === "owner" ? auth.list(device) : [device],
        });
        return;
      }
      const revoke = url.pathname.match(
        /^\/api\/devices\/([a-f0-9-]+)\/revoke$/,
      );
      if (req.method === "POST" && revoke) {
        if (device.id !== revoke[1]) auth.owner(device);
        auth.revoke(revoke[1], device.id);
        json({ revoked: true });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/sessions") {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        if (!Number.isSafeInteger(offset) || offset < 0)
          throw new AccessError("invalid_offset", 400);
        const all = Object.values(sessions.sessions).filter((s) =>
          device.projects.includes(s.project),
        );
        const count = sessions.store.policy.sessionPage;
        json({
          sessions: all
            .slice(offset, offset + count)
            .map((s) => sessions.view(s)),
          nextOffset: offset + count < all.length ? offset + count : null,
          latestEventSequence: sessions.seq,
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/approvals") {
        json({
          approvals: Object.values(sessions.sessions)
            .filter((s) => device.projects.includes(s.project))
            .flatMap((s) => sessions.snapshot(s.id).approvals),
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/health") {
        json({
          status: sessions.fatal
            ? "storage_failed"
            : sessions.stopping
              ? "stopping"
              : "ok",
          version: "0.7.0",
          contractVersion: 1,
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/agents") {
        rates.check("agent-discovery", 30);
        json(await sessions.agents());
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/diagnostics") {
        auth.owner(device);
        const diagnostics = sessions.store.diagnostics();
        diagnostics.leases = diagnostics.leases.filter((l: any) =>
          Object.values(sessions.sessions).some(
            (s) =>
              s.worktree === l.worktree && device.projects.includes(s.project),
          ),
        );
        json({
          ...diagnostics,
          reconciliation: Object.values(sessions.sessions)
            .filter(
              (s) =>
                device.projects.includes(s.project) && s.reconciliationRequired,
            )
            .map((s) => s.id),
        });
        return;
      }
      const operation = url.pathname.match(
        /^\/api\/operations\/([a-zA-Z0-9_-]{8,80})$/,
      );
      if (req.method === "GET" && operation) {
        const op = sessions.store.operation(`${device.id}_${operation[1]}`);
        if (op?.session_id) {
          const s = sessions.sessions[op.session_id];
          if (s) auth.canProject(device, s.project);
        }
        json(
          op ? { ...op, id: operation[1] } : { error: "unknown_operation" },
          op ? 200 : 404,
        );
        return;
      }
      const match = url.pathname.match(
        /^\/api\/sessions\/([a-f0-9-]+)(?:\/(events|prompt|queue|steer|interrupt|approvals|stop|close|resume))?$/,
      );
      const id = match?.[1],
        action = match?.[2];
      if (id) {
        const s = sessions.sessions[id];
        if (!s || !device.projects.includes(s.project))
          throw new AccessError("session_not_found", 404);
      }
      if (req.method === "GET" && id && !action) {
        json(sessions.snapshot(id));
        return;
      }
      if (req.method === "GET" && id && action === "events") {
        if ((streams.get(device.id) ?? 0) >= 4)
          throw new AccessError("stream_limit", 429);
        streams.set(device.id, (streams.get(device.id) ?? 0) + 1);
        const target = new URL(`/sessions/${id}/events`, options.coreUrl);
        if (url.searchParams.has("after"))
          target.searchParams.set("after", url.searchParams.get("after")!);
        const headers: any = { Authorization: `Bearer ${options.coreToken}` };
        if (req.headers["last-event-id"])
          headers["Last-Event-ID"] = req.headers["last-event-id"];
        const upstream = httpRequest(target, { headers }, (response) => {
          res.writeHead(response.statusCode ?? 502, {
            "Content-Type":
              response.headers["content-type"] ?? "text/event-stream",
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
          });
          response.pipe(res);
          response.on("error", () => res.destroy());
        });
        upstream.on("error", () => res.destroy());
        const revokeListener = (revoked: string) => {
          if (revoked === device.id) res.destroy();
        };
        auth.on("revoke", revokeListener);
        const timer = setInterval(() => {
          try {
            auth.get(secret);
          } catch {
            res.destroy();
          }
        }, 10000);
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          clearInterval(timer);
          auth.off("revoke", revokeListener);
          streams.set(
            device.id,
            Math.max(0, (streams.get(device.id) ?? 1) - 1),
          );
          upstream.destroy();
        };
        res.on("close", cleanup);
        upstream.end();
        return;
      }
      if (
        req.method === "POST" &&
        (url.pathname === "/api/sessions" ||
          (id && action && action !== "events"))
      ) {
        auth.canWrite(device);
        const input = await body(req);
        const kind = url.pathname === "/api/sessions" ? "start" : action!;
        const allowed: Record<string, string[]> = {
          start: ["project", "agent", "model", "reasoningEffort"],
          prompt: ["text"],
          queue: ["text"],
          steer: ["text"],
          interrupt: [],
          stop: [],
          close: [],
          resume: [],
          approvals: ["approvalId", "generation", "decision", "answers"],
        };
        if (Object.keys(input).some((k) => !allowed[kind].includes(k)))
          throw new AccessError("unknown_fields", 400);
        if (kind === "start") auth.canProject(device, input.project);
        const key = req.headers["idempotency-key"];
        if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(key))
          throw new AccessError("idempotency_key_required", 400);
        if (
          kind === "approvals" &&
          (["approvalId", "generation", "decision"].some(
            (k) => typeof input[k] !== "string",
          ) ||
            (input.answers !== undefined &&
              (!input.answers ||
                typeof input.answers !== "object" ||
                Array.isArray(input.answers) ||
                Object.values(input.answers).some(
                  (v) => typeof v !== "string",
                ))))
        )
          throw new AccessError("invalid_approval", 400);
        if (
          kind === "approvals" &&
          !["decline", "cancel", "deny"].includes(input.decision)
        ) {
          const pending = sessions
            .snapshot(id!)
            .approvals.find((a) => a.id === input.approvalId);
          if (pending && truncated(pending.raw))
            throw new AccessError("approval_details_truncated", 409);
        }
        auth.audit(device.id, "operation_requested", {
          operationId: key,
          kind,
          sessionId: id ?? null,
          project: input.project,
        });
        const result = await sessions.operate(
          `${device.id}_${key}`,
          kind,
          id ?? null,
          input,
        );
        const value = {
          ...result,
          operation: { ...result.operation, id: key },
        };
        json(
          value,
          ["failed", "delivery_uncertain"].includes(value.operation.state)
            ? 409
            : ["completed"].includes(value.operation.state)
              ? 200
              : 202,
        );
        return;
      }
      throw new AccessError("not_found", 404);
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      json(
        {
          error: e instanceof AccessError ? e.code : "request_failed",
          message:
            e instanceof AccessError
              ? e.message
              : "Request could not be completed; refresh the snapshot or inspect the operation.",
        },
        e instanceof AccessError ? e.status : 409,
      );
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}
