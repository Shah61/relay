# Phase 3: common local bridge and unverified Claude integration

Date: 2026-10-01. Phase 3 only. No Claude inference, login, API credential, separate API billing, or new Codex inference was attempted. Phase 1 and Phase 2 remain the historical source of truth. This report distinguishes implementation tests from agent runtime proof.

## Common layer

`src/agents/types.ts` defines an adapter contract and capability records containing supported, implemented, verification, available, native mechanism, source, and evidence. `src/sessions/manager.ts` owns common session identity, project allowlisting, canonical worktree leases, pending decisions, persisted state, and event journaling. Codex's existing protocol/session engine is retained behind `src/codex/adapter.ts`.

An agent session's lifecycle, current turn, and local parent process have independent states. Parent exit does not imply shell descendant termination. Interrupt receipts set `interruptRequested`; only a native terminal event marks the turn interrupted. No blind prompt retry or process reconnect is offered. Claude turns use explicit bridge input UUIDs because no equivalent stable native turn ID is assumed; native message, tool, and session IDs remain in events.

Events have schema version 2, monotonic sequence, timestamp, bridge session, agent, native session, process generation, bridge/native turn, item/message IDs, source, normalized type, and untouched native payload. Codex events also retain `legacyType`; historical Phase 2 event records remain intact. Claude SDK callbacks are labeled `sdk_callback`, distinct from native messages and bridge actions. Tool-specific file events are not a complete filesystem audit.

`GET /agents` reports installation/auth availability independently of sessions. Starting the bridge creates no agent process. Clients select configured project IDs and agent names; they cannot submit paths, executables, environment variables, flags, or arbitrary RPC.

## Codex

The Phase 2 proofs remain valid historical evidence for app-server, native thread/turn IDs, follow-up/context, active steering, interrupt, permission allow/cancel, streamed events, and fixture edits/tests. They are not presented as a new post-refactor live integration run. Refactor validation used the original 10 unit regressions plus a fake-transport replay of actual Phase 2 native evidence. No additional model quota was consumed.

The adapter retains app-server stdio, manual approvals, raw evidence, stale generation/turn checks, and SSE. A transport failure alone now records unknown process state; native child exit separately records exited. Shutdown is bounded. Codex history resume is documented but not implemented, as in Phase 2. Its current version/auth entitlement is not inferred from historical success.

## Claude implementation

Pinned official dependency: `@anthropic-ai/claude-agent-sdk` 0.3.286. Implemented against its installed TypeScript declarations and current official documentation:

- `query()` with an async input iterable, configured cwd/executable, persistent session, explicit `resume`, streamed `SDKMessage` events and partial text.
- Native init establishes the session ID; constructing query is not proof of an alive session.
- Normal follow-ups use the same long-lived query. Queued input is a bounded, **bridge-serialized FIFO**: a new prompt is delivered only after the previous native result. It does not claim native active steering or input coalescing. Interrupt retains queued inputs; close discards them.
- `canUseTool` allow/deny, cancellation via `interrupt: true`, abort handling, stale/duplicate protection, and `AskUserQuestion` answers mapped to `updatedInput.answers`.
- `Query.interrupt()` receipts remain separate from native result terminal reasons. Native failures, SDK iterator failures, local spawn errors, and uncertain shutdown remain visible.
- `Query.close()` and the SDK's official child-spawn hook track parent process lifetime; no whole-process-tree termination claim.
- Explicit saved native session resume starts a new process generation. It requires observed parent exit or offline operator reconciliation; arbitrary process reattachment is unsupported.

No terminal scraping, Messages API replacement, copied Desktop credentials, or authentication reverse engineering is used. Discovery uses only executable checks, `--version`, and official `auth status`. Standard installed CLI locations take precedence over Desktop-managed versions, unless a local absolute executable override is configured. Remote overrides are rejected.

Subscription-only execution rejects alternative credential/provider environment settings, disables project/user settings sources and external MCP configuration, and requires official CLI status to identify authenticated `claude.ai`, first-party, Pro/Max/Team/Enterprise subscription access. Unknown status fails closed. These checks do not measure account quota or guarantee future SDK/CLI interoperability.

### What is not verified

Every implemented Claude runtime capability remains **unverified**: session initialization, edit/test execution, streaming, follow-ups/context, FIFO behavior against a live query, permission allow/deny/cancel, questions, interruption, process shutdown, persisted history and resume. Synthetic unit fixtures prove only our bookkeeping. SDK 0.3.286 and local CLI 2.1.284 are different release streams; compatibility requires the future live test.

## Actual Mac availability

Recorded through the authenticated bridge on 2026-10-01 in `docs/evidence/phase3/availability.json`:

| Field | Observed result |
| --- | --- |
| Adapter installed | yes |
| SDK available | yes, 0.3.286 |
| Executable available | yes, Desktop-managed fallback |
| CLI version | 2.1.284 (Claude Code) |
| Authentication | unauthenticated |
| State | authentication_required |
| Ready | false |
| Inference attempted | false |

Executable: `/Users/mukhtarshah/Library/Application Support/Claude/claude-code/2.1.284/claude.app/Contents/MacOS/claude`. This is discovered each time, not hardcoded. Future UI can render “Claude Code — Not connected. Authentication required.”

## Capability matrix

“Verified” below means **Phase 2 local Codex evidence**, not a fresh inference run. “Unsupported” is scoped to this adapter, not a universal claim about the underlying product.

| Operation | Codex | Claude |
| --- | --- | --- |
| Follow-up/context | Verified | Documented, implemented, unverified |
| Queued input | Unsupported | Bridge FIFO implemented over documented streaming input; unverified |
| Active steering | Verified | Unsupported |
| Turn interruption | Verified; children can survive | Documented, implemented, unverified |
| Parent process shutdown | Implemented, unverified | Documented, implemented, unverified |
| All descendant termination | Unknown | Unknown |
| Permission allow/deny | Verified native offered decisions | Documented, implemented, unverified |
| Permission + cancellation | Verified | Documented, implemented, unverified |
| User questions | Unsupported | Documented, implemented, unverified |
| Explicit history resume | Documented, unverified, not implemented | Documented, implemented, unverified |
| Process reconnect | Unsupported | Unsupported |
| Streaming | Verified | Documented, implemented, unverified |
| File changes | Verified | Tool-scoped normalization implemented, unverified |

Availability is a separate current-session field. No Claude control is currently ready. Unit tests never set verification to verified.

## Validation

- TypeScript `npm run build`: passed.
- `npm test`: 23 tests passed, including the original 10 regressions plus clearly labeled common/Claude/replay unit tests; see `docs/evidence/phase3/unit-tests.tap` for the final count.
- `npm run test:security`: 12 real loopback HTTP boundary checks passed, including missing/bad token, Origin rejection, allowlist/prototype checks, executable/cwd override refusal, unknown agent, malformed body, and arbitrary RPC refusal.
- `npm run test:claude-preflight`: reported authentication_required and no inference attempted.
- No live Claude acceptance report or verification promotion was created. Temporary security-test bridge was stopped.

## Future Claude acceptance — after subscribing

1. Install/update the official standalone Claude Code CLI using the [official setup instructions](https://code.claude.com/docs/en/setup). It will be preferred over the update-sensitive Desktop binary. Do not configure an API key/provider for this bridge.
2. Subscribe and use the official local `claude auth login` flow. Verify with `claude auth status`. The bridge requires supported subscription authentication; uncertain/other auth fails closed.
3. From this project, run **`npm run test:claude-live`**. No bridge server needs to be running. To inspect availability without any possible inference, use `npm run test:claude-preflight`.

The live command checks auth first and skips cleanly if unavailable. If ready, it creates a fresh isolated Git fixture in the system temp directory, runs real SDK turns, checks file contents and actual test execution, partial streaming, a random context token, two ordered queued results, permission acceptance/denial, interruption, observed parent shutdown, and explicit same-ID resume with retained context. It allows only narrowly enumerated test commands and fixture edits; unexpected permission requests are denied. Assertions/timeouts fail instead of manufacturing success. A finite sleep child is allowed time to end before resume; this does not prove generic process-tree termination.

Results and untouched native events are retained in the printed run directory. Only a wholly passing run writes `.bridge/claude-verification.json`. Runtime capability promotion requires matching SDK/CLI versions and matching SHA-256 of the saved event artifact. Deleting the temp evidence or upgrading versions returns capabilities to unverified. Copy/archive a successful run if you want long-term proof and update the local report's evidence path accordingly. No HTTP route can promote verification. User-question and approval-cancel capabilities deliberately remain unverified because this first harness does not exercise them. Failed/incomplete runs do not promote any features. Future live failures may require adapter corrections; this harness itself has not been exercised against a live authenticated Claude session.

## Architecture and operational changes

- Optional `config.local.json` copies the shape of `config.example.json`; it contains a local project-ID map and optional `claude.executable`. Config is not remote writable.
- `.bridge/common-sessions.json` stores common state; Codex adapter internals get per-session subdirectories. Legacy Phase 2 sessions migrate conservatively as disconnected with unknown process state and held leases. Old evidence remains unchanged.
- Canonical Git worktree roots (including path/symlink aliases) enforce one writing agent session across both agents. A PID lock prevents concurrent bridge processes using the same state directory. This is local cooperative enforcement, not protection against unrelated programs or a second installation using a different state directory.
- Leases are intentionally retained after shutdown while descendants are unknown. Stop the bridge and inspect the session's agent/shell processes before using `npm run release-lease -- SESSION_ID --confirm-no-writers`. This local-only command records **operator attestation**, distinctly from native exit, and releases the lease. Never use it merely to bypass a conflict. After reconciliation Claude history may be resumed; another session's lease still blocks it. Codex history resume remains unavailable.
- Existing Codex CLI commands remain, with optional agent selection. New semantic commands are `agents`, `queue`, `close`, and `resume`; approvals accept structured answers. SSE payload schema is v2, and Codex `legacyType` preserves old event names.
- The server remains a local backend prototype. Existing limits around log growth, crash consistency, sandbox scope, and process-tree control remain. No dashboard, mobile UI, tunnel, notifications, deployment, or arbitrary terminal endpoint was built.

## Recommended Phase 4 (not started)

Harden the local backend lifecycle before remote access: bounded journals/replay, crash recovery, durable command/approval audit, process supervision and tested lease recovery. When Claude access becomes available, run the dedicated live harness and fix any compatibility gaps before presenting Claude as working. Remote authentication/transport and UI work should follow a separately approved scope.

## Official API references

- [Streaming versus single-message input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [Permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
- [User input](https://code.claude.com/docs/en/agent-sdk/user-input)
- [Sessions and resume](https://code.claude.com/docs/en/agent-sdk/sessions)
- [CLI reference](https://code.claude.com/docs/en/cli-reference)

The installed `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` supplied exact signatures for query/options, permission callbacks, interruption receipts, native result reasons, close, and the spawn hook. Documentation supports implementation choices; it does not constitute local runtime proof.
