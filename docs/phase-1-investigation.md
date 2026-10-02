# Local agent bridge: phase 1 investigation

Investigated 1 October 2026 (Asia/Kuala_Lumpur). This is a feasibility and architecture record, not a claim that the application has been built. Official documentation is rolling documentation; installed binaries and their generated schemas determine implementation compatibility.

## Conclusion

Build a local TypeScript bridge that owns genuine agent subprocesses. Start with Codex app-server over stdio. Add Claude through the Claude Agent SDK after a separate authentication and adapter proof. Keep execution, credentials, project mapping, and persistence on the Mac. Use a narrow authenticated HTTP command API and SSE event feed, privately reachable through Tailscale Serve. No PTY is needed for the managed-session design.

Arbitrary process attachment is not a universal supported feature. Distinguish resuming saved conversation history from connecting to the process currently executing it. V1 should promise control only for bridge-owned sessions; supported native attachment modes can be investigated as a separate capability.

## Local evidence

| Check | Observed result |
|---|---|
| Workspace | Empty directory; no source, package manifest, Git repository, tests, or project instructions present. Checked immediate ancestor instruction paths too. |
| Node / Python | Node 22.18.0; Python 3.9.6. |
| Codex CLI | `codex-cli 0.153.4`, installed through the user's Node installation. |
| Codex authentication | `codex login status` reports ChatGPT login. No credential contents were read or copied. This does not prove model entitlement or a successful inference request. |
| Codex protocol | Generated JSON schemas from the installed binary; confirmed thread start/resume/read, turn start/steer/interrupt, approval requests, and streamed notifications. |
| Live Codex probe | Spawned `codex app-server --listen stdio://`; sent `initialize`, `initialized`, then `thread/loaded/list`. Initialization succeeded; result was an empty list for this new process; closed stdin and child exited 0. No model turn or project modification requested. |
| Sandbox limitation | First probe failed because this chat's filesystem sandbox could not initialize Codex's SQLite state under the user's Codex directory. The same bounded probe succeeded with reviewed elevated execution. This is an execution-environment limitation, not evidence that the protocol is broken. |
| Existing Codex daemon | `codex app-server daemon version` could not connect: default control socket did not exist. This does not establish that no other app-owned server exists. |
| Claude CLI | Not on PATH or standard checked executable locations. Found Desktop-managed Claude Code 2.1.284 at `~/Library/Application Support/Claude/claude-code/2.1.284/claude.app/Contents/MacOS/claude`. `--version` and `--help` work. |
| Claude authentication | Bundled binary's `auth status` reports `loggedIn: false`, `authMethod: none` in this execution environment. Desktop sign-in is not proof of reusable CLI authentication; check again in the intended daemon/login context. |
| Remote access utilities | Neither `tailscale` nor `cloudflared` resolved on PATH. No tunnel or public listener was created. |

The Desktop-managed Claude path is versioned and update-sensitive. Use a configurable validated executable path and preferably an officially installed CLI for the eventual service. Do not copy or reverse-engineer Desktop credentials. The Codex desktop host's exact build was not established; CLI findings should not be described as an audit of this app's internal server.

## Codex integration

The official [app-server documentation](https://developers.openai.com/codex/app-server/) explicitly targets rich custom clients. Use its bidirectional JSON-RPC-like protocol: newline-delimited messages over stdin/stdout, omitting the `jsonrpc` field. Keep stderr separate. Wait for the initialize response before sending initialized and application requests.

Use `thread/start` with an allowlisted project cwd and explicit sandbox/approval settings; persist the returned thread ID. Start later prompts with `turn/start` on that ID. For an in-progress turn use `turn/steer` with the expected turn ID, handling a completion race explicitly. Use `turn/interrupt` to request cancellation; wait for terminal evidence before presenting it as stopped. `thread/resume` restores saved conversation context after restart, not an OS process or its running shell children.

Server-initiated approval requests are bidirectional RPC, not stdout text to scrape. Retain the request ID and its process generation, thread, turn, and item identity. Respond with the installed schema's decision payload. Also handle user-input questions and permission requests or fail them closed. Existing policy can auto-approve tools, so not every operation produces an approval request.

The installed schemas confirm command output, item lifecycle, reasoning-summary, and turn completion notifications. Only display exposed summaries. Schema presence alone does not establish that a notification is emitted: current docs specifically deprecate `item/fileChange/outputDelta`, so do not depend on it. Preserve unknown events for diagnostic review without inventing UI semantics.

`codex exec --json` and `exec resume` are valid simpler batch interfaces; stdin supplies an initial prompt, not the rich interactive RPC control channel. The Codex SDK is appropriate for task automation, but app-server matches this approval-and-steering interface more directly. No generic chat API replacement is proposed.

Reuse Codex-managed local ChatGPT authentication. The official app-server surface still carries experimental qualifications, especially WebSockets. Pin the CLI version, generate matching types, and run compatibility tests before upgrades. Never forward arbitrary app-server methods to remote clients: filesystem/configuration and explicit process/shell APIs are much broader than this product needs.

## Claude integration and authentication

Use the official [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), which runs Claude Code's binary locally. Prefer TypeScript `query()` with an asynchronous input stream; do not build against the removed experimental V2 session API. Configure cwd, permission handling, settings sources, and executable deliberately. This remains a local Claude agent with its actual tools and session history.

[Streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) supports a long-lived process, queued prompts and interruption. Treat a follow-up as queued unless the selected version proves stronger steering semantics; do not label it identical to Codex's turn/steer. Use explicit saved session IDs for [resume](https://code.claude.com/docs/en/agent-sdk/sessions), never “most recent” when multiple sessions exist.

Handle [permission callbacks](https://code.claude.com/docs/en/agent-sdk/permissions) and [user questions](https://code.claude.com/docs/en/agent-sdk/user-input). A callback is not an all-tool firewall: earlier rules can allow tools without calling it. Explicitly configure the permission mode and account for hooks. SDK and installed CLI mode names differ in the material checked; use the matching SDK's contract rather than translating names by guesswork.

The CLI also documents `-p`, JSON/stream-json, partial messages, and resume. Installed help confirms streaming stdin and host permission prompts. Prefer the SDK to hand-maintaining its lower-level control envelopes. [Headless documentation](https://code.claude.com/docs/en/headless) warns that project hooks/configuration can load without an interactive trust dialog. Review trusted project configuration before enrollment. `--bare` skips OAuth/keychain authentication, so it is unsuitable for a subscription-reuse assumption.

Authentication needs a precise distinction. Anthropic's [current subscription support article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) says the announced SDK billing changes were paused and SDK/print/third-party usage still draws from subscription limits. The SDK overview separately restricts third-party developers offering claude.ai login or rate limits without approval. For this personal local controller, first test officially supported local login reuse. Do not conclude that an API key is necessarily required, promise a particular entitlement, offer a new third-party login service, or silently fall back to paid API credentials. Local Claude authentication and live SDK behavior remain unproven here.

## Existing sessions: what attachment means

| Session origin | Evidence and v1 treatment |
|---|---|
| Bridge-owned Codex | Full protocol control is the intended integration. Transport tested; task/approval behavior awaits phase 2. |
| Codex on an explicitly shared app-server | Official remote CLI and Unix/WebSocket transports offer a supported connection route. Installed CLI also has daemon/proxy commands. Validate subscription and approval ownership against that exact server before claiming multi-client control. |
| Arbitrary Codex terminal/native-app session | Do not assume its process is reachable. Saved-history read/resume is distinct from live attachment. No general native-app injection or takeover API was established in this investigation. |
| Bridge-owned Claude | SDK streaming, callbacks and resume are documented; no live agent test yet. |
| Existing Claude session with native Remote Control enabled | Official [Remote Control](https://code.claude.com/docs/en/remote-control) allows local execution to be driven from Claude's own web/mobile clients, including opt-in from an interactive session. That does not establish a public custom-dashboard API for its relay. |
| Claude background session | Installed help and [CLI reference](https://code.claude.com/docs/en/cli-reference) expose agents listing, attach, logs and stop. Terminal attach is real, but is not an SDK structured-event attachment contract. Current docs describe additional resume behavior from 2.1.285; installed 2.1.284 must not be credited with it. |
| Claude with channels configured | [Channels](https://code.claude.com/docs/en/channels) can deliver external events and optionally relay permissions. They require explicit setup/enablement and are not universal full-session observability or arbitrary attachment. |

Do not scrape terminal output, alter live session files, inject keystrokes, or concurrently resume the same saved session under two owners. Import only explicitly selected stopped histories for allowlisted projects, after validating ownership and compatibility. Existing history can contain sensitive material and does not establish current runtime status.

## Event model and honest observability

Every envelope should carry bridge session ID, agent session/thread ID, process generation, optional turn/item/tool IDs, monotonic local sequence, receive timestamp, source and schema version. Keep normalized and bounded raw evidence locally. Adapter capabilities determine which UI controls exist.

| UI fact | Evidence required |
|---|---|
| Session created | Native thread response / SDK init; separately record bridge process startup. |
| Agent message | Agent text deltas or completed messages. |
| Thinking summary | Exposed reasoning/summary events only; silence is not evidence of thinking. |
| Command running/output/finished | Codex command items/deltas or Claude tool use/result; do not promise every byte of live Claude shell output before testing. |
| File read | Explicit tool/path evidence; a shell command may be opaque. Do not claim complete filesystem auditing. |
| File changed | Tool evidence or Git/filesystem observation, labeled by source. Git changes alone cannot identify the responsible agent. |
| Test result | Initially command output and exit status. Test counts require a validated test-reporter format, not invented parsing. |
| Waiting for approval | Actual unresolved request associated with the current child process. |
| Turn completed/failed/cancelled | Native terminal event and status; process exit alone is not successful task completion. |
| Disconnected/unknown | Missing transport/liveness evidence. Preserve last-known status separately. |

Git monitoring uses fixed argument arrays and a configured cwd, never a submitted shell string. Disable external diff/textconv execution; handle staged, unstaged and untracked files separately. Bound output and show truncation. Repo-level changes are shared when multiple sessions use the same worktree; v1 should allow one writing session per worktree. Project switching selects a different session, not a new cwd inside an active one.

## Remote connection and security design

Recommended path: phone browser → private HTTPS Tailscale Serve endpoint → loopback bridge HTTP API → managed agent stdio. Serve the eventual UI from the same origin. POST carries typed commands; SSE carries replayable events. Approval decisions are ordinary authenticated POST requests, so browser WebSockets are unnecessary. The bridge keeps agent connections alive when the browser disconnects.

| Option | Tradeoff |
|---|---|
| Tailscale Serve — choose for personal v1 | Private tailnet access, HTTPS, access rules; requires Tailscale on Mac and phone. [Official Serve docs](https://tailscale.com/docs/features/tailscale-serve). Do not enable public Funnel. |
| Cloudflare Tunnel + Access | Convenient browser access without phone VPN; outbound tunnel, but requires Access configuration and correct origin authentication, and introduces an intermediary for app traffic. Tunnel alone is not user authorization. [Tunnel docs](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/). |
| Custom outbound relay | Flexible device pairing and mobile reachability, but adds relay operations, credential lifecycle, replay and potentially application-level encryption work. Unnecessary for v1. |

Proposed safeguards, not implemented yet:

- Bind only loopback; allowlist tailnet identity and retain application authentication. Do not treat client-supplied identity headers as trustworthy outside the controlled proxy path.
- Locally confirmed, expiring, one-use pairing for the phone; revocable device credential; short-lived HttpOnly/Secure/SameSite session cookie, CSRF checks, strict Origin/Host validation, rate limiting. Do not put credentials in URLs or browser localStorage.
- Authorize every session/project operation. Clients submit project IDs, never filesystem paths, executable paths, agent flags, environment variables or shell commands. Canonicalize configured roots locally and account for symlinks.
- Durable operation IDs bound to payload hashes for deduplication. Never replay a prompt blindly after a crash between delivery and acknowledgement; show delivery uncertainty and reconcile history.
- Bind approvals to native request, session, turn and process generation; reject stale/duplicate responses. Disconnect must not imply approval. After process loss, old approval requests are invalid.
- Persist session metadata, operation journal and bounded event history in local SQLite. SSE reconnects use event cursors; retention gaps trigger a snapshot/resync rather than pretending continuity.
- Render agent output as untrusted text; sanitize any Markdown, escape terminal controls, cap buffers/log retention, and redact known credentials. Redaction cannot guarantee arbitrary agent output contains no sensitive data.
- Preserve native sandbox/permissions; no automatic approval bypass. Project allowlisting restricts launch destinations but is not an OS sandbox for agent-generated shell commands. Permission escalation expands risk and must be visible.
- Credentials remain local. Local execution does not mean offline inference: the official agents still communicate with their model providers.

## Next: smallest real proof, before UI

Use Codex only and a disposable fixture repository inside this workspace. Implement a small bridge plus command-line client, initially loopback-only with authentication already required. The bridge owns app-server; do not point it at Herta or another real project yet.

Acceptance evidence must include: a prompt creates/edits a fixture file; a real test command executes; native events reach the client; an idle follow-up uses the same thread and previous context; an in-flight follow-up exercises steer and its completion race; terminal status is observed; resulting Git diff is verified. Include approval allow/deny and interrupt tests before enabling those controls. Never claim success from protocol handshake alone.

After that, add the common adapter and Claude test, then remote access and the responsive dashboard. Reliability checks must cover bridge restart, duplicate sends, lost acknowledgements, browser/network reconnect, agent crash, sleep/wake, simultaneous sessions in separate worktrees, cancellation, pending approvals, output limits, Git changes and project selection. A sleeping Mac is unavailable; network reconnection cannot revive a terminated subprocess. Resume restores conversation, not in-flight execution. Keep launchd installation and machine sleep policy as explicit later deployment choices.

No application, UI, tunnel, login flow, paid model request or live agent task was built or launched in phase 1. Only documentation, installation inspection, schema generation and a no-turn protocol probe were performed.
