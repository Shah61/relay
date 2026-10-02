import { createServer, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import type { Sessions } from "../sessions/manager.ts";
import { clip } from "../storage/bounds.ts";
export function httpServer(
  sessions: Sessions,
  token: string,
  admin?: (
    req: import("node:http").IncomingMessage,
    res: ServerResponse,
    url: URL,
  ) => Promise<boolean>,
) {
  const started = Date.now();
  let streams = 0;
  return createServer(async (req, res) => {
    try {
      const actual = Buffer.from(req.headers.authorization ?? ""),
        expected = Buffer.from(`Bearer ${token}`);
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      ) {
        res.writeHead(401).end();
        return;
      }
      if (
        req.headers.origin ||
        !/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? "")
      ) {
        res.writeHead(403).end();
        return;
      }
      const url = new URL(req.url!, "http://127.0.0.1");
      if (admin && (await admin(req, res, url))) return;
      const json = (v: any, status = 200) => {
        res
          .writeHead(status, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          })
          .end(JSON.stringify(v));
      };
      if (req.method === "GET") {
        if (url.pathname === "/health") {
          json(
            {
              version: "0.7.0",
              schemaVersion: 3,
              status: sessions.fatal
                ? "storage_failed"
                : sessions.stopping
                  ? "stopping"
                  : "ok",
              uptimeMs: Date.now() - started,
            },
            sessions.fatal ? 503 : 200,
          );
          return;
        }
        if (url.pathname === "/diagnostics") {
          json({
            ...sessions.store.diagnostics(),
            version: "0.7.0",
            uptimeMs: Date.now() - started,
            activeSessions: Object.values(sessions.sessions).filter(
              (s) => s.lifecycle === "alive",
            ).length,
            reconciliation: Object.values(sessions.sessions)
              .filter((s) => s.reconciliationRequired)
              .map((s) => s.id),
            sseClients: streams,
            claudeRuntimeVerification: "unchanged; no Phase 4 inference",
          });
          return;
        }
        if (url.pathname === "/agents") {
          json(await sessions.agents());
          return;
        }
        if (url.pathname === "/sessions") {
          const offset = Number(url.searchParams.get("offset") ?? 0);
          if (!Number.isSafeInteger(offset) || offset < 0)
            throw new Error("Invalid offset");
          const all = Object.values(sessions.sessions);
          json({
            sessions: all
              .slice(offset, offset + sessions.store.policy.sessionPage)
              .map((s) => ({
                ...sessions.view(s),
                snapshotUrl: `/sessions/${s.id}`,
              })),
            nextOffset:
              offset + sessions.store.policy.sessionPage < all.length
                ? offset + sessions.store.policy.sessionPage
                : null,
            latestEventSequence: sessions.seq,
          });
          return;
        }
        const operation = url.pathname.match(
          /^\/operations\/([a-zA-Z0-9_-]{8,128})$/,
        );
        if (operation) {
          const op = sessions.store.operation(operation[1]);
          json(op ?? { error: "Unknown operation" }, op ? 200 : 404);
          return;
        }
      }
      const match = url.pathname.match(
        /^\/sessions\/([a-f0-9-]+)(?:\/(events|prompt|queue|steer|interrupt|approvals|stop|close|resume))?$/,
      );
      const id = match?.[1],
        action = match?.[2];
      if (req.method === "GET" && id) {
        sessions.get(id);
        if (!action) {
          json(sessions.snapshot(id));
          return;
        }
        if (action === "events") {
          const cursor =
            url.searchParams.get("after") ??
            req.headers["last-event-id"] ??
            "0";
          if (Array.isArray(cursor) || !/^\d+$/.test(cursor))
            throw new Error("Invalid cursor");
          let after = Number(cursor);
          const initial = sessions.store.replay(id, after);
          if (initial.resync) {
            json({ error: "resync_required", ...sessions.snapshot(id) }, 409);
            return;
          }
          if (streams >= 32) {
            json({ error: "Too many event streams" }, 429);
            return;
          }
          streams++;
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
          });
          res.flushHeaders();
          let closed = false,
            pumping = false,
            wanted = false;
          const cleanup = () => {
            if (closed) return;
            closed = true;
            streams--;
            clearInterval(timer);
            sessions.off("event", onEvent);
          };
          const write = async (frame: string) => {
            if (closed) return false;
            if (Buffer.byteLength(frame) > sessions.store.policy.sseBytes) {
              res.destroy();
              return false;
            }
            if (!res.write(frame)) {
              const timeout = setTimeout(() => res.destroy(), 5000);
              try {
                await Promise.race([once(res, "drain"), once(res, "close")]);
              } finally {
                clearTimeout(timeout);
              }
            }
            return !closed;
          };
          const pump = async () => {
            if (pumping) {
              wanted = true;
              return;
            }
            pumping = true;
            try {
              do {
                wanted = false;
                const high = sessions.seq;
                while (!closed) {
                  const batch = sessions.store.replay(id, after, high);
                  if (batch.resync) {
                    await write(
                      `event: resync_required\ndata: ${JSON.stringify({ error: "resync_required", snapshotUrl: `/sessions/${id}`, latestEventSequence: sessions.seq })}\n\n`,
                    );
                    res.end();
                    return;
                  }
                  for (const event of batch.events) {
                    if (
                      !(await write(
                        `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`,
                      ))
                    )
                      return;
                    after = event.sequence;
                  }
                  if (batch.events.length < sessions.store.policy.replayBatch) {
                    after = high;
                    await write(
                      `id: ${high}\nevent: cursor\ndata: {"latestEventSequence":${high}}\n\n`,
                    );
                    break;
                  }
                }
              } while (wanted && !closed);
            } catch {
              res.destroy();
            } finally {
              pumping = false;
            }
          };
          const onEvent = () => {
            void pump();
          };
          const timer = setInterval(() => {
            if (!res.write(": heartbeat\n\n")) res.destroy();
            void pump();
          }, sessions.store.policy.heartbeatMs);
          res.on("close", cleanup);
          res.on("error", cleanup);
          sessions.on("event", onEvent);
          void pump();
          return;
        }
      }
      if (
        req.method !== "POST" ||
        !(url.pathname === "/sessions" || (id && action && action !== "events"))
      ) {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 32768) {
          json({ error: "Body too large" }, 413);
          return;
        }
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("Invalid body");
      const kind = url.pathname === "/sessions" ? "start" : action!;
      const allowed: Record<string, string[]> = {
        start: ["project", "agent"],
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
        throw new Error("Unknown input fields");
      if (
        kind === "start" &&
        (typeof input.project !== "string" ||
          (input.agent !== undefined &&
            !["codex", "claude"].includes(input.agent)))
      )
        throw new Error("Invalid project/agent");
      if (
        kind === "approvals" &&
        (["approvalId", "generation", "decision"].some(
          (k) => typeof input[k] !== "string",
        ) ||
          (input.answers !== undefined &&
            (!input.answers ||
              typeof input.answers !== "object" ||
              Array.isArray(input.answers) ||
              Object.values(input.answers).some((v) => typeof v !== "string"))))
      )
        throw new Error("Invalid approval input");
      const key = req.headers["idempotency-key"];
      if (typeof key !== "string") throw new Error("Idempotency-Key required");
      const result = await sessions.operate(key, kind, id ?? null, input);
      json(
        result,
        ["failed", "delivery_uncertain"].includes(result.operation.state)
          ? 409
          : [
                "received",
                "accepted",
                "dispatched",
                "native_acknowledged",
              ].includes(result.operation.state)
            ? 202
            : 200,
      );
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res
        .writeHead(409, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        })
        .end(JSON.stringify({ error: clip(String(e), 4096) }));
    }
  });
}
