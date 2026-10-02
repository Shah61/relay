# Phase 4 — local bridge reliability

Completed 2026-10-01. Local reliability only. No Claude inference, new Codex inference, login, provider credential, remote access, dashboard, notification, or persistent service installation was performed. Codex's Phase 2 runtime evidence remains historical proof; Claude remains implemented and runtime-unverified. The Phase 1–3 reports and historical evidence files were preserved.

## Storage

Operational state now lives in `.bridge/bridge.sqlite` using Node 22.18.0's built-in `node:sqlite` (experimental in this Node release), SQLite 3.50.2. No database server or new dependency is required. WAL mode, `synchronous=FULL`, foreign keys, bounded busy waits, explicit `BEGIN IMMEDIATE` transactions, schema versions, and startup integrity/invariant checks are enabled. Durability still depends on macOS/filesystem/hardware honoring sync; this is not a power-failure hardware test.

| Table | Purpose |
| --- | --- |
| `meta` | Global event sequence, pruning cursor, import marker, exclusive bridge owner identity |
| `sessions` | Authoritative JSON snapshot with queryable ID/agent/worktree columns |
| `process_generations` | Parent identity, generation, start/exit observations and lifecycle history |
| `leases` | Unique canonical worktree reservation |
| `lease_members` | Explicit holders; preserves multiple unresolved legacy claimants |
| `operations` | Idempotency key, canonical payload hash, action, session, phase, result/error and native acknowledgement source |
| `operation_steps` | Ordered durable operation transitions |
| `approvals` | Session/native session/generation/turn/native request binding, state and bounded preview |
| `events` | Bounded durable event envelopes and monotonic global sequence |
| `audit` | Local reconciliation, approval decisions, import and observation-gap audit |
| `verification` | Capability metadata and existing evidence references; no Phase 4 promotion |

Migration 1 creates the common state/journals. Migration 2 adds explicit process-generation history and the operation-session index. `PRAGMA user_version=2` is the current DB version; event envelope schema is **3**, a separate version number. Each migration is transactional. Newer schemas, corrupt databases, invalid journal transitions, bad session snapshots, or invalid sequences fail startup with “state preserved, no reset.” No fallback empty database is created over an existing failed one.

Legacy JSON snapshots are imported once. Historical JSONL evidence is streamed only to carry forward the global sequence; it is not rewritten or represented as complete retained SQLite history. Old cursors therefore require resync. Codex's internal engine now runs without its POC disk writer in production; the common SQLite store owns persistence. The token file and small connection/PID discovery files remain outside the DB; they are not the operational source of truth. Model-provider credentials are never loaded into the store. Known secret fields/token patterns are redacted from bounded event copies, but arbitrary agent-generated text cannot be guaranteed secret-free.

The actual local migration found **two legacy sessions claiming the same fixture**. Both remain blockers under one canonical worktree reservation. Neither was silently selected as the only writer, discarded, or force-released. An authenticated snapshot/diagnostics sample is saved in `docs/evidence/phase4/local-recovery.json`.

## Recovery

Startup performs the following before accepting requests:

1. Open/check/version the DB and validate operation transition histories and session invariants.
2. Acquire exclusive ownership transactionally using this bridge's PID and OS start fingerprint. A live or uncertain prior owner blocks startup. Recovery never signals a process based only on a persisted PID.
3. Import legacy metadata once, preserving existing files and unknown leases.
4. Finish undispatched `received`/`accepted` operations as failed, with a recovery reason. Convert `dispatched` or `native_acknowledged` operations lacking a durable final response to `delivery_uncertain`.
5. Invalidate pending approvals; decisions in `responding` become `delivery_uncertain`. No callback is reconstructed or resent.
6. Probe stored parent identities through supported OS process information. A missing/reused PID proves the recorded parent is no longer that process; it does not prove exit code, exact exit time, or descendant status. `exitObservedAt` distinguishes recovery observation time from an actual native exit timestamp.
7. Mark prior sessions disconnected/closed and active turns unknown. Even a matching live parent is not a reconnected agent. A spawn that was not observed before crash is unknown, not falsely “never started.” Retain worktree claims, mark lost queue state uncertain, and publish a recovery event/snapshot.

No prompts, queue entries, permissions, native turns, or sessions are automatically replayed. A late native event after an observation gap cannot clear the reconciliation flag. Only current owned adapters can be stopped by the API; persisted orphan identities require deliberate local handling. Claude history resume is separately implemented and unverified; Codex history resume remains unimplemented.

## Operation safety

Every accepted HTTP mutation envelope requires `Idempotency-Key` (8–128 letters, numbers, `_` or `-`). The key and SHA-256 of canonical `{action, session, payload}` are saved before any adapter dispatch. Prompt text is not duplicated into the operation journal; the hash binds the request. Native output may still contain prompt content.

- Same key + same payload returns the saved operation, or its current pending/uncertain state. It never dispatches again.
- Same key + different payload returns a conflict.
- A failed/uncertain key is never recycled or automatically retried.
- A new key cannot bypass an uncertain session or worktree lease.
- Per-session operation exclusion rejects conflicting requests while dispatch is in progress. Starts also reserve by canonical worktree, with SQLite uniqueness as the durable guard. Different worktrees can start separately.

Stages are `received → accepted → dispatched → [native_acknowledged] → completed`, with `failed` before dispatch or `delivery_uncertain` after an unproven dispatch. **Completed means the bridge finished handling that request, not that a native agent turn completed.** For example, completed interruption may only have an interrupt receipt. Native turn status remains separate in the session/events. Codex RPC responses are identified as native acknowledgements for applicable operations. A Claude input-queue return is not mislabeled as native acknowledgement. Claude queue entries are bridge FIFO; recovery reports their uncertain fate rather than reconstructing an in-flight input stream.

The supported client surface is the HTTP API; internal adapter/unit/live-harness calls are not remote client commands. Structurally malformed or unauthenticated requests are rejected before becoming accepted operations. Fetch `/operations/OPERATION_ID` after losing a response. Retry with the **same key and exact payload**, not a new random key. A 202 response means still in progress; 409 can contain a durable failed/uncertain operation, or a boundary conflict. A 200 replay can contain an old successful response alongside a now-disconnected session; fetch its snapshot for current state.

The CLI prints the operation ID before sending. Supply it explicitly for repeatable commands:

```sh
npm run client -- prompt SESSION_ID --operation-id my-prompt-0001 "Your task"
npm run client -- operation my-prompt-0001
```

A request lock covers dispatch/acknowledgement, not the entire agent turn. Follow-up, steering, queueing and interruption retain their different adapter semantics. A stalled dispatch can temporarily block other mutations for that session; read-only operation/snapshot routes remain usable. Codex native requests retain their bounded timeout. On clean bridge shutdown, owned parents are asked to stop; unfinished operations still recover conservatively.

## Event replay and snapshots

Events are persisted in the same transaction as their state/approval updates **before** they are emitted to SSE clients. Sequence allocation is transactional, global, monotonic, and never reset by pruning. Native IDs and bounded native payloads remain associated with bridge session, agent, generation, turn, tool/message, timestamp and source. Truncation is explicit and includes lengths/digests or structural-limit reasons where available; no truncated transport message is parsed as a valid native acknowledgement.

`GET /sessions/:id` is the authoritative current snapshot. It includes agent/project/IDs, capabilities, last-known availability, lifecycle, turn, pending decisions, queue count/uncertainty, parent metadata, lease, latest global sequence, reconciliation flags and distinct available actions. After restart, old availability is marked unknown until rediscovery. `/agents` safely refreshes installation/auth availability without inference. `/sessions` is paginated, with snapshot URLs for detail.

SSE accepts `?after=N` or `Last-Event-ID: N`. It reads bounded DB batches rather than copying the whole journal. Subscription/pumping covers the snapshot-to-stream gap. Cursor frames advance over global events for other sessions without inventing session events. Disconnecting an SSE client does not interrupt its agent or replay any commands.

If the cursor predates retained history, the endpoint returns **409 `resync_required` plus a current snapshot and its sequence**. The client replaces its local state and opens a new stream after that sequence. If retention overtakes an already connected stream, it receives an explicit `resync_required` event with the snapshot URL and current sequence, then the stream closes. The snapshot is fetched separately so the SSE payload stays bounded. Slow consumers are disconnected after a bounded drain wait; clients must replay/resync. At most 32 concurrent streams are accepted.

Retention removes a contiguous global prefix. A busy session can therefore cause older history from other sessions to expire as well; all such gaps are explicit. No promise of complete retained history is made after pruning.

## Process model and exact controls

| Action | Meaning |
| --- | --- |
| Interrupt Turn | Request a native turn interruption; wait for native terminal evidence. Does not stop the parent or prove shell-child termination. |
| Stop Agent (`POST .../stop`) | Gracefully close the current owned adapter/parent, with bounded shutdown waiting and scoped native/parent termination behavior. Keep the lease. No PID-only recovery kill or process-name kill. |
| Close Session (`POST .../close`) | Disable active control and invalidate approvals. Does **not** imply parent exit, cancel already accepted work, or release the worktree. Stop separately when intended. |
| Release Worktree | Offline local reconciliation with an explicit human attestation/reason and durable audit. Never a remote endpoint. |

Parent metadata includes PID, OS start fingerprint, process generation, observed start time, native exit time/code/signal when observed, expected/unexpected exit, and recovery observations. `ps` start time + UID + PID gives useful correlation, not a cryptographic process identity or race-free reattachment guarantee. We never use a recovered match as permission to signal an arbitrary PID.

Descendant state remains **unknown** unless a local operator explicitly attests quiescence. The bridge does not enumerate all grandchildren, reparented children, detached shell jobs or agents launched outside its ownership. The Phase 2 finding remains permanent: **turn interrupted ≠ all shell processes stopped**. Full descendant termination capability is still unknown. Native agents may have their own internal shutdown policy; this bridge adds no blanket `kill -9`, process-name killing, or broad process-group termination.

A real harmless-parent regression exposed that Codex's old close path returned early on transport disconnect even when its parent remained alive. Fixed: stopping now uses the current owned child handle and waits for actual parent exit, independently of RPC connectivity. This was a bridge reliability test, not new Codex runtime/inference proof.

Protocol lines are bounded before parsing. Codex rejects an oversized/malformed frame and enters uncertainty; Claude's official SDK spawn-hook stream is bounded before SDK JSON decoding. Oversized Claude transport output stops only that owned parent via SIGTERM and marks reconciliation required. The SDK adapter remains runtime-unverified. SDK/agent internal resource use beyond the bridge-facing stream is not fully controlled.

## Worktree and approval safety

Canonical real paths plus Git `--show-toplevel` unify same paths, symlink aliases, nested directories and alternate representations. Separate Git worktrees remain independent. SQLite's unique lease row survives crashes. Legacy multi-claim worktrees retain every holder in `lease_members`; releasing one does not erase others. Parent exit or turn completion never automatically releases a worktree.

To reconcile, **stop the bridge and inspect the session's parent and possible descendant writers first**, then run locally:

```sh
npm run release-lease -- SESSION_ID --confirm-no-writers "Describe how you checked parent and descendants"
```

The command claims exclusive DB ownership, refuses a matching still-live recorded parent, writes the reason/observation/attestation into the audit and event journals, and releases only that session's claim. Unknown identity can be reconciled only through this explicit operator attestation; it is never converted into native exit proof. No force-release route exists. For the two imported fixture holders, each must be reconciled before a new writer can start. This phase did not perform those attestations on the user's behalf.

Pending approvals bind bridge session, native session, process generation, current turn, native request ID and bridge approval ID. A decision is reserved durably as `responding` before sending. A crash in that window yields uncertainty, not automatic resend. Native completion, process loss, close and startup invalidate pending callbacks. Same-operation replay is idempotent; a duplicate decision with a new key remains rejected. Question answers are validated before consuming the callback. A resumed process always has a new generation and cannot inherit actionable old callbacks.

## Bounds and capacity

Local overrides live under `limits` in `config.local.json`; `config.example.json` shows the main settings. Defaults:

| Bound | Default |
| --- | --- |
| HTTP mutation body | 32 KiB |
| Native protocol frame before parsing | 2 MiB |
| Stored event / raw payload | 64 KiB / 32 KiB |
| Output / diff / error preview | 8 KiB / 16 KiB / 4 KiB |
| SSE frame budget | 65 KiB (66,560 bytes) |
| Pending common approvals / unresolved adapter tool bookkeeping | 32 / 128 |
| Event journal | 16 MiB, 10,000 global events, 2,000 per-session events, 7 days |
| DB pages | 256 MiB |
| WAL write-stop budget | 8 MiB, checked before transactions; possible one-transaction overshoot |
| Operations / sessions / approval records | 100,000 / 10,000 / 100,000 |
| Service bridge logs | 1 MiB active + three rotated files, bounded chunks |

Pruning runs on writes and maintenance; idle age expiry is checked periodically. Free database pages are reused, not compacted on every event. SQLite's WAL size-limit pragma alone is not a hard cap, so the bridge also checks WAL growth, tries a truncate checkpoint, and stops writes if a pinned external reader prevents returning below budget. The pinned-reader failure test proves this behavior. Database-full writes roll back; the bridge stops accepting writes instead of sending work without durable state.

Operation IDs/tombstones and audit are not silently deleted to make room. Reaching their capacity or the physical DB budget requires deliberate offline maintenance/archive planning. There is no transparent indefinite-history or tombstone-compaction implementation yet. Historical evidence outside the operational DB is intentionally not pruned.

## Mac sleep/wake and network behavior

Apple documents native sleep/wake notifications through Cocoa/IOKit. This Node bridge does not claim to receive those notifications. Instead, a wall-clock observation-gap monitor detects a long interval (default 45 seconds) or backward clock change between ticks. It records the gap, probes owned-parent identities, marks affected session/turn state uncertain and requires reconciliation. It never replays prompts. A long event-loop stall can trigger the same conservative behavior; a short sleep can escape this heuristic. Actual system sleep was not forced and no Mac power settings were changed.

The failure suite uses **SIGSTOP/SIGCONT on an isolated test bridge** to prove gap behavior. That is process suspension evidence, not a claim of testing the Mac lid, power events or every sleep duration. A sleeping Mac is unavailable. Client/network reconnection uses snapshot/SSE replay and does not restore a native process. Provider-network problems are surfaced through native errors/timeouts; provider outage inference tests were not run.

## Mac service preparation

Prepared and syntax-validated:

- `service/bridge.plist.template`
- `service/local.agent-bridge.plist`, rendered for this Mac
- `service/run.ts`, foreground wrapper with bounded rotating bridge logs
- `npm run service:prepare`, regeneration using the current Node executable and absolute workspace paths

Nothing was copied to LaunchAgents, bootstrapped, enabled or installed. The template is a **per-user login LaunchAgent**, not a root/boot daemon. It runs from this fixed project directory/state directory, loads no embedded credentials, starts on login, and asks launchd to restart unsuccessful exits with a 30-second throttle. Clean exits do not immediately restart. The wrapper forwards SIGTERM and the bridge performs bounded shutdown. Native child exit/lease uncertainty remains visible after a service crash. launchd's external enforcement is not presented as complete descendant control.

Future deliberate installation, after reviewing the generated file:

```sh
npm run service:prepare
plutil -lint service/local.agent-bridge.plist
mkdir -p "$HOME/Library/LaunchAgents"
cp service/local.agent-bridge.plist "$HOME/Library/LaunchAgents/local.agent-bridge.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.agent-bridge.plist"
```

This copy/`bootstrap` step installs and starts persistence; **it was not run**. Stop the interactive bridge first. To unload later:

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.agent-bridge.plist"
```

Remove that copied plist if automatic login startup is no longer wanted. Regenerate after moving the workspace or replacing its pinned absolute Node path. The generated PATH must include the desired official CLI installation. Service logs are `.bridge/service-logs/bridge.log*`; the plist routes wrapper stdout/stderr to `/dev/null` because the wrapper owns rotation. Wrapper failures before its logger initializes may require `launchctl` diagnostics. Login-keychain/agent behavior under launchd is not live-tested. No availability while logged out/asleep is promised.

## Health/API

All routes retain bearer authentication, strict loopback Host checks, and rejection of browser Origins. Read-only routes include `/health`, `/agents`, `/sessions`, `/sessions/:id`, `/operations/:id`, and `/diagnostics`. Diagnostics report version, schema, uptime, journal/sequence/pruning status, operation-state counts, capped lease listing, active/reconciliation counts and limits. Database health is accurately labeled as checked at open; it is not a continuous full integrity scan. Diagnostics do not echo the bearer token or provider secrets.

The API deliberately changes from Phase 3: mutations require idempotency keys and return an operation envelope; session lists are paginated; explicit `stop` is separate from `close`; operational events come from SQLite. The CLI and future acceptance helpers were adjusted for these boundaries. No historical live evidence was regenerated.

## Test results

| Check | Final result |
| --- | --- |
| TypeScript | Passed |
| Unit/regression tests | **38 passed**; includes all original tests, with the common close/resume test updated for the explicitly changed Phase 4 semantics |
| Real local failure integration | **12 passed** |
| Real authenticated loopback HTTP security | **22 passed**, extending all 12 Phase 3 boundary checks |
| launchd plist syntax | `plutil -lint`: passed; not installed |
| Historical report/evidence integrity | SHA-256 manifest comparison passed |
| New Codex / Claude inference | **None** |

The real local failure tests used the same HTTP server, session manager, SQLite store and recovery code with an explicitly test-only adapter and harmless spawned Node parents. They tested bridge SIGKILL after prompt dispatch, completed/lost HTTP acknowledgement retry, owned-parent termination, conflicting POSTs/starts, approval races/restart/uncertain send, SSE disconnect/replay, old-cursor resync, live-stream retention overrun, close versus stop, audited local release, SIGSTOP/SIGCONT observation gap, absent parent recovery, and corrupt operation sequence refusing startup. Tests are clearly labeled and do not create agent-runtime verification.

Unit/regression coverage additionally includes migrations, SQLite corruption/future version rejection, all dispatch crash phases, payload hash conflict, byte/count/age pruning, ID capacity, canonical Git worktrees and symlinks, legacy duplicate holders, process fingerprint mismatch, native frame limits, pre-SDK output bounds, SQLite-full rollback, pinned-reader WAL bounds, common/Claude callback state, and historical Codex evidence replay. One initial Host test used `fetch`, which did not send the requested Host override; it was corrected to use raw Node HTTP so the final test genuinely exercised Host rejection. The disconnected-parent regression failed before its fix and passed afterward.

Evidence: `docs/evidence/phase4/typecheck.txt`, `unit-tests.tap`, `failure-tests.tap`, `security.json`, `security-tests.txt`, `availability.json`, `local-recovery.json`, `historical-integrity.json` and `historical-integrity-result.json`. Temporary validation bridge and test processes were stopped. The SQLite migration remains in place, with old leases held for reconciliation.

## Remaining limitations

- Claude has not been exercised with an authenticated runtime. Its first live harness remains for future subscription/login; Phase 4 does not promote any Claude capability.
- No full shell-descendant enumeration or guaranteed stop-all. No process reconnection. Recovered parents may require local supervision; Codex history resume is still unavailable.
- Local-only cooperative ownership assumes one state directory for this bridge installation. It cannot stop unrelated editors, terminals or another installation from writing the same repository.
- Stop/control requests can be rejected while another dispatch owns the session operation lock. This prevents ambiguous racing dispatches; it is not a universal emergency-stop channel.
- Operation/audit capacity deliberately fails closed rather than forgetting idempotency history. Automated archival/compaction preserving tombstones remains future work.
- Output truncation loses detail explicitly; bounded event history may require repeated resync under sustained overload. Agent/SDK internal memory and external agent transcript files are outside the bridge journal bounds.
- Sleep detection is a heuristic. launchd lifecycle is prepared and plist-validated, not installed or proven under a real login/reboot cycle. Provider outages, physical power loss and actual machine sleep were not induced.
- SQLite integrity checks are not a substitute for backups. External modifications/readers are outside the normal single-owner model; capacity guards stop writes when necessary. Recovery never silently repairs corrupt data.
- The HTTP API remains a local bearer-token CLI interface, not a browser-session/CSRF/pairing design suitable for remote use. No remote transport or public endpoint exists.

## Recommended Phase 5 — not started

Design and test the local client contract and authorization model: operation status UX, snapshot/resync handling, explicit uncertainty/reconciliation actions, device/session authorization, and threat-model review. Keep remote transport and deployment behind a separate explicit approval. When Claude access is available, run its dedicated live harness and resolve compatibility failures before calling it verified. No Phase 5 work was started.

## Primary references

- [Node SQLite API](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html)
- [SQLite pragmas](https://sqlite.org/pragma.html) and [WAL behavior](https://www.sqlite.org/wal.html)
- [Apple launchd jobs](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
- [Apple sleep/wake notification APIs](https://developer.apple.com/library/archive/qa/qa1340/_index.html)

Exact Claude spawn-hook stream types were checked in the installed official SDK declarations. The integrations otherwise retain the Phase 1–3 architecture. Documentation informs implementation; local failure tests support only the bridge reliability claims stated above.
