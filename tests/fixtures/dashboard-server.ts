// Disposable UI acceptance harness. No provider imports, credentials, or inference.
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentAdapter, type Agent } from "../../src/agents/types.ts";
import { capabilities } from "../../src/agents/capabilities.ts";
import { Sessions } from "../../src/sessions/manager.ts";
import { DeviceAuth } from "../../src/security/devices.ts";
import { httpServer } from "../../src/bridge/http.ts";
import { browserGateway } from "../../src/browser/gateway.ts";
import { once } from "node:events";
import { RelayHost } from "../../src/relay/host.ts";
import { createRelay } from "../../src/relay/server.ts";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
class Demo extends AgentAdapter {
  agent: Agent;
  generation = randomUUID();
  constructor(a: Agent) {
    super();
    this.agent = a;
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
      reason: "TEST HARNESS ONLY — no inference",
      models:
        this.agent === "codex"
          ? [
              {
                id: "test-model",
                model: "test-model",
                displayName: "Test model",
                isDefault: true,
                defaultReasoningEffort: "medium",
                supportedReasoningEfforts: [
                  {
                    reasoningEffort: "medium",
                    description: "Synthetic test only",
                  },
                ],
              },
            ]
          : undefined,
    };
  }
  capabilities() {
    return capabilities(this.agent);
  }
  async start() {
    this.emitEvent({
      type: "session.started",
      source: "bridge",
      raw: { testHarness: true },
      nativeSessionId: "test-" + randomUUID(),
      state: {
        lifecycle: "alive",
        process: {
          generation: this.generation,
          state: "running",
          children: "unknown",
        },
      },
    });
  }
  async prompt(text: string) {
    const id = randomUUID();
    this.emitEvent({
      type: "turn.started",
      source: "bridge",
      raw: { testHarness: true },
      turn: { id, state: "running" },
    });
    const reply = `## Simulated Codex reply\n\n**Markdown is ready.** This is a test response; no commands ran.\n\n- Formatted lists\n- Inline \`code\` and **bold text**\n\n\`\`\`js\nconst ready = true;\n\`\`\`\n\n| Feature | Status |\n| --- | --- |\n| Replies | Ready |\n| Markdown | Ready |\n\n> Please review the simulated approval below.\n\nYour prompt:\n\n${text}`;
    if (this.agent === "codex") {
      const itemId = id + "-reply";
      this.emitEvent({
        type: "agentMessage.started",
        source: "native",
        itemId,
        raw: {
          method: "item/started",
          params: {
            item: {
              type: "agentMessage",
              id: itemId,
              text: "",
              phase: "commentary",
            },
          },
        },
      });
      for (const delta of [reply.slice(0, 50), reply.slice(50)])
        this.emitEvent({
          type: "agent.message",
          source: "native",
          itemId,
          raw: { method: "item/agentMessage/delta", params: { itemId, delta } },
        });
      this.emitEvent({
        type: "agentMessage.completed",
        source: "native",
        itemId,
        raw: {
          method: "item/completed",
          params: {
            item: {
              type: "agentMessage",
              id: itemId,
              text: reply,
              phase: "commentary",
            },
          },
        },
      });
    } else
      this.emitEvent({
        type: "agent.message",
        source: "bridge",
        raw: { text: reply },
      });
    this.emitEvent({
      type: "approval.requested",
      source: "bridge",
      raw: { testHarness: true, command: 'echo "safe test only"' },
      turn: { state: "waiting_approval" },
      pending: {
        id,
        turnId: id,
        kind: "approval",
        decisions: ["accept", "decline", "cancel"],
        raw: {
          testHarness: true,
          command: 'echo "safe test only"',
          note: "This fake agent does not execute commands.",
        },
      },
    });
    return { testHarness: true };
  }
  async interrupt() {
    this.emitEvent({
      type: "turn.interrupted",
      source: "bridge",
      raw: { testHarness: true },
      turn: { state: "interrupted" },
    });
    return { testHarness: true };
  }
  async respond(id: string, decision: string) {
    this.emitEvent({
      type: "approval.resolved",
      source: "bridge",
      raw: { id, decision, testHarness: true },
      resolvedId: id,
    });
    this.emitEvent({
      type: "turn.completed",
      source: "bridge",
      raw: { testHarness: true },
      turn: { state: "completed" },
    });
    return { testHarness: true };
  }
  async close() {
    this.emitEvent({
      type: "process.exited",
      source: "bridge",
      raw: { testHarness: true },
      state: {
        process: {
          generation: this.generation,
          state: "exited",
          children: "unknown",
        },
      },
    });
  }
}
const dir = mkdtempSync(join(tmpdir(), "relay-ui-"));
mkdirSync(join(dir, "project"));
const sessions = new Sessions((a) => new Demo(a), join(dir, "state"), {
  "test-project": join(dir, "project"),
});
const auth = new DeviceAuth(sessions.store, ["test-project"]);
const core = httpServer(sessions, "test-only-token");
core.listen(0, "127.0.0.1");
await once(core, "listening");
const gateway = browserGateway(sessions, auth, {
  port: 47833,
  coreUrl: `http://127.0.0.1:${(core.address() as any).port}`,
  coreToken: "test-only-token",
  relay: () => relayHost,
});
let relayHost: RelayHost | undefined;
gateway.listen(47833, "127.0.0.1");
await once(gateway, "listening");
const relayServer = process.env.RELAY_TEST
  ? createRelay("test-enrollment-token-not-for-production", [
      "http://127.0.0.1:47834",
    ])
  : undefined;
let frontend: ReturnType<typeof createServer> | undefined;
if (relayServer) {
  relayServer.server.listen(47835, "127.0.0.1");
  await once(relayServer.server, "listening");
  frontend = createServer((req, res) => {
    const path = req.url === "/" ? "index.html" : req.url?.slice(1);
    if (
      !path ||
      ![
        "index.html",
        "app.mjs",
        "markdown.mjs",
        "replies.mjs",
        "vendor/marked.mjs",
        "vendor/purify.mjs",
        "client.mjs",
        "relay-client.mjs",
        "e2e.mjs",
        "style.css",
        "icon.svg",
        "manifest.webmanifest",
      ].includes(path)
    ) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader(
      "Content-Type",
      path.endsWith(".mjs")
        ? "text/javascript"
        : path.endsWith(".css")
          ? "text/css"
          : path.endsWith(".svg")
            ? "image/svg+xml"
            : path.endsWith(".html")
              ? "text/html"
              : "application/json",
    );
    const content = readFileSync(
      resolve(import.meta.dirname, "../../web", path),
    );
    res.end(
      path === "index.html"
        ? content
            .toString()
            .replace(
              "<head>",
              '<head><meta name="relay-hosted" content="true">',
            )
        : content,
    );
  });
  frontend.listen(47834, "127.0.0.1");
  await once(frontend, "listening");
  relayHost = new RelayHost(
    auth,
    dir,
    "http://127.0.0.1:47833",
    "test-root-token",
  );
  relayHost.configure({
    hostName: "Demo Windows PC",
    relayUrl: "ws://127.0.0.1:47835",
    frontendUrl: "http://127.0.0.1:47834",
    hostToken: "test-enrollment-token-not-for-production",
  });
}
console.log(
  JSON.stringify({
    url: "http://127.0.0.1:47833",
    code: auth.pairing("owner", ["test-project"]).code,
    testHarness: true,
  }),
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  relayHost?.stop();
  await relayServer?.close();
  frontend?.closeAllConnections();
  frontend?.close();
  gateway.closeAllConnections();
  core.closeAllConnections();
  gateway.close();
  core.close();
  await sessions.shutdown();
  sessions.store.close();
  rmSync(dir, { recursive: true, force: true });
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
