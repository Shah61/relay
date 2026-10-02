# Relay — private agent workspace

A durable local bridge and responsive purple dashboard for Codex and Claude Code, with an **own-hosted encrypted relay and QR phone pairing**. Railway hosts the WebSocket routing service; Vercel hosts the static dashboard. Your phone needs only a browser. Codex retains Phase 2 runtime proof; Claude remains implemented and runtime-unverified. Native Windows/Linux launch support is implemented but awaits real platform acceptance; the relay has been tested locally on macOS.

Start with the [companion account setup guide](docs/hosted-relay-setup.md). Users install Prompt Manager Companion, choose Connect this computer, authorize with a passkey in the Vercel dashboard, and then see that computer in the dashboard. Users never enter Railway/Vercel URLs or host tokens. Deployment and physical-phone acceptance remain pending. Earlier reports, Tailscale instructions, and evidence remain as historical records in `docs/`.

Requires Node 22.18+ with built-in `node:sqlite`. The real bridge runs only on loopback; its relay connector makes outbound connections. The local dashboard is `http://127.0.0.1:47832/`. No Tailscale or persistent OS service is required or installed.

Session details include a dedicated **Codex replies** section (or Claude Code replies), with streamed messages assembled into Markdown, separate progress updates, and a Copy Markdown button. Headings, lists, code blocks, tables, quotes, and task lists render in replies and activity. The composer offers Markdown preview before sending. Only retained history is available; expired history and truncated text are labeled. Markdown is sanitized, remote images are omitted, and links open separately without a referrer.

Mobile sessions now provide Close, Clear chat, Delete, Clear draft, and New session. Drafting remains available during errors or closed sessions. Separate Git workspaces allow multiple sessions per project. [Remote Preview](docs/remote-preview.md) detects reported dev-server candidates and exposes approved loopback apps through owner-authorized Railway preview IDs. Maintainers must provision isolated wildcard preview hosting and rebuild/deploy the dashboard, relay, and Companion; no per-server tunnel or port setup is required from users. Full Vite/Next HMR and native Windows preview acceptance remain unverified.

```sh
npm ci
npm run build
npm test
npm run test:failure
npm start
```

For development, `npm start` still opens the local bridge dashboard. Production users use the signed Companion installer. The manual command `npm run pair -- create owner` is retained only as a developer fallback; normal users never need it. A phone never runs npm.

The bridge binds loopback and starts **no agent at startup**. Tests use synthetic events and harmless local subprocesses; process/HTTP tests require permission to inspect processes and bind loopback. Operational state is `.bridge/bridge.sqlite`. Legacy JSON/evidence stays untouched. Startup may report held old leases; it never assumes their processes stopped.

```sh
npm run client -- agents
npm run client -- status
npm run client -- start fixture codex --operation-id start-fixture-0001
npm run client -- prompt SESSION_ID --operation-id prompt-fixture-0001 "Your task"
npm run client -- operation prompt-fixture-0001
npm run client -- status SESSION_ID
```

Keep the operation ID. If a response is lost, look it up or retry the **same ID and exact payload**. A new ID must not be used to blindly resend uncertain work. HTTP mutations require `Idempotency-Key` and return an operation envelope; `completed` means request handling finished, not native task completion. The CLI prints the ID before dispatch and unwraps successful results for compatibility. Inspect `operation` for pending or uncertain outcomes.

Controls have separate meanings:

```sh
npm run client -- interrupt SESSION_ID # request native turn interruption
npm run client -- stop SESSION_ID      # stop the currently owned agent parent
npm run client -- close SESSION_ID     # disable control; does not stop parent or release lease
```

Turn interruption and parent exit do **not** prove shell descendants stopped. Leases persist. After stopping the bridge and inspecting parent/descendant writers, an explicit offline reconciliation is available:

```sh
npm run release-lease -- SESSION_ID --confirm-no-writers "Describe the checks performed"
```

This records an operator attestation and audit, not fabricated native proof. Multiple legacy holders must each be reconciled. No HTTP release route exists. Claude explicit history resume requires stopped/reconciled state; arbitrary process reconnect and Codex history resume are not implemented.

Approve only an offered decision bound to the current session/turn/generation:

```sh
npm run client -- approve SESSION_ID APPROVAL_ID GENERATION accept
npm run client -- steer SESSION_ID "Codex steering input"
npm run client -- queue SESSION_ID "Claude queued input"
```

Claude questions use `answer` with a JSON map of native question text to answer. Claude controls remain unverified and unavailable without suitable subscription authentication. Nothing silently falls back to API billing.

The authoritative snapshot is `GET /sessions/:id`; health and diagnostics are read-only authenticated routes. SSE accepts `Last-Event-ID` or `?after=N`. If history expired, it returns `resync_required` and a current snapshot (or a snapshot URL on an existing stream). Replace local state and reconnect after the snapshot's sequence. The small `events` CLI prints raw frames; it does not automatically reconstruct a UI or hide gaps.

Configuration is local-only: copy `config.example.json` to `config.local.json` to adjust project IDs, optional absolute Claude executable, port, and bounds. Remote paths, executable flags, environment changes, provider credentials and arbitrary RPC/terminal endpoints are rejected. Protect `.bridge/`; bounded native events can still contain project text.

```sh
BRIDGE_EVIDENCE_DIR=docs/evidence/phase567 npm run test:security # requires running bridge, no inference
npm run test:claude-preflight  # version/auth only, no inference
npm run service:prepare       # renders launchd plist; installs nothing
```

Future installation commands and exact effects are documented in the Phase 4 report. Do not install before reviewing them. No Mac power settings were changed; sleep availability is not promised.

After future Claude subscription and official login, `npm run test:claude-live` is the explicit **real inference** acceptance command. `npm run integration` remains the real Codex acceptance runner. Neither was run in Phase 4. The future Claude harness exports its own evidence; these files are separate from bounded operational retention.

Tests: **49 unit/gateway regression + 6 browser-client + 12 local failure-injection + 22 original HTTP security checks passed**, plus interactive desktop/mobile testing using a disposable fake-agent harness. `npm run test:client` runs browser-client recovery tests; `npm run test:dashboard` starts the clearly isolated UI test server on port 47833 (no inference). Never expose that test server remotely.

The current fixture has historical unreconciled leases; they remain protected. Configure your intended repository locally and pair only the projects you mean to control. Read the setup guide's security implications before enabling remote access.
