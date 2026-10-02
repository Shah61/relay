# Phase 2 results — 1 October 2026

The local vertical slice works: CLI → authenticated loopback bridge → owned Codex app-server subprocess → real local Codex thread → disposable Git repository. The successful main acceptance run finished at 14:42:42 Asia/Kuala_Lumpur. Phase 3 has not started. The bridge was cleanly stopped after verification; restart it with `npm run bridge`.

## WORKING

- Real file edits: Codex changed `double(n)` from returning `n` to `n * 2`, added positive and negative tests, and ran `node --test`. Native command completion reported exit 0. Independent execution also passed all three fixture tests; the filesystem and Git diff were inspected.
- Real streaming: the successful runner received 310 session-associated events over HTTP SSE, including native thread/turn lifecycle, agent text deltas, command items, file-change items, approvals, diff updates and terminal statuses. Untouched native messages are included in each event. The initial run additionally captured `item/commandExecution/outputDelta`; the corrected run's short commands delivered output in completed command items instead. Output deltas are exposed when provided, not synthesized.
- Same-thread follow-up: the second prompt did not repeat the public test value. Codex replied `fixture-color-orange-42`, which was present in conversation but absent from fixture files.
- In-flight steering: `turn/steer` returned the same active turn ID; its final response included `STEER_OBSERVED`. A separate post-completion steer returned `raced` and did not start another turn. The unit suite also exercises completion between dispatch and an RPC error.
- Turn interruption: `turn/interrupt` was followed by a native `turn/completed` with `status: interrupted`. Request acknowledgement alone is never presented as cancellation.
- Real approvals: file patches and commands required approval under `untrusted` / user review. Reviewed patches and test commands were allowed. The real `touch denied.txt` request was denied using the offered `cancel` decision; native command status was `declined`, turn status was `interrupted`, and the file did not exist.
- Real stale/duplicate protection: both replay requests returned HTTP 409 with `Stale, duplicate, or mismatched approval`. Requests bind to bridge session, active turn, process generation and a single-use approval ID.
- Checks: TypeScript build passed; 10 bridge/protocol/session unit tests passed; 8 live HTTP security checks passed. Unit tests are supplemental, not integration evidence.

## PARTIAL

**Turn interruption does not guarantee immediate shell-child termination.** In the approval/start-race test, native turn interruption arrived at sequence 583, then a process-start item arrived at 584, and that harmless `sleep 30` completed about 30 seconds later at 624. Preserve these separate facts. Do not label an interrupted turn “all processes stopped.” A broader stop-all mechanism is not implemented.

The supplemental test attempted to wait for an actual process ID before interrupting, but this run exposed its process ID through `terminalInteraction`, not another `item/started`. The initial supplemental harness missed it; no interrupt was sent. The harness now recognizes both forms and records failures, but that correction was not rerun because the account reached its usage limit. The original, successfully tested turn-interruption result remains valid.

Approval denial was tested through native `cancel` (deny and interrupt), because that was the simple denial option offered by this installation. `decline` without cancelling is accepted by the bridge only when the native request offers it; it was not live-tested.

The small POC persists JSON metadata and JSONL events. Restart marks old sessions disconnected and rejects control; it does not auto-resume them. Log retention, robust child-tree termination, crash consistency, broader server requests and production remote authentication are not implemented. File edits/read commands outside the runner's exact tiny test-command allowlist require manual review. One runner timed out waiting for that review; it was then continued against the same active thread.

## NOT WORKING / EXTERNAL LIMIT

The supplementary sixth turn failed with native `usageLimitExceeded`. No API key, alternate billing route or model was substituted. Further live agent tests were stopped. This failure occurred after the five-turn main acceptance sequence had passed and also demonstrated real failure-state propagation.

The initial acceptance attempt exposed an adapter defect: `cancel` was not accepted by the bridge even though Codex offered it. Fixed, covered by a unit test, and successfully exercised in the corrected live run. No remaining failure blocks the demonstrated five-turn vertical slice; guaranteed shell-tree stop remains a limitation.

## EVIDENCE

- Bridge session: `b306a458-2d5a-4dd9-a252-5d9f9f23b7e2`
- Codex thread: `01a0f62f-6838-7503-bb9b-0aad73827a05`
- Process generation: `3b5d8916-61ba-493d-b9c9-9c598eda1c69`
- Installed Codex: `0.153.4`; existing local ChatGPT authentication.

| Test | Native turn ID | Observed outcome |
|---|---|---|
| Edit and test | `01a0f62f-68f2-7560-bdaf-61e383ee3bdf` | completed; real two-file patch and passing tests |
| Follow-up | `01a0f632-f268-7e03-b306-4ebbe947883b` | completed; recalled conversation-only value |
| Steering | `01a0f633-01ff-7ec3-8f1f-b33b1aa2de7d` | accepted; completed with requested marker |
| Interrupt | `01a0f633-5154-7922-b8d3-dc4608358c3e` | native interrupted; shell completed later |
| Deny approval | `01a0f633-6324-74e2-bab0-eb1cfbc19d52` | command declined; turn interrupted; no denied file |
| Supplemental | `01a0f634-c392-7df2-9166-554cbeee7581` | usage-limit failure; no interrupt sent |

Artifacts:

- [Main results](evidence/latest-run.json): assertions, IDs, response text, tests and diff. `session` is the initial snapshot captured when that runner attached, not the final current status.
- [Main native/SSE records](evidence/latest-events.jsonl): 310 received event envelopes, sequence 301 onward (global events account for sequence gaps).
- [Git diff](evidence/fixture.diff) and [independent fixture tests](evidence/fixture-tests.tap).
- [Approval HTTP replay evidence](evidence/approval-replay.json).
- [Native interrupt/start race including late child completion](evidence/interrupt-start-race.json).
- [Supplemental failure and native evidence](evidence/interrupt-supplemental.json).
- [Unit tests](evidence/unit-tests.tap) and [live API security checks](evidence/security.json).
- [Initial failed run](evidence/initial-run/results.json), [initial native events](evidence/initial-run/events.jsonl), and [manual-review timeout](evidence/review-timeout/results.json).

All main acceptance events came from the installed local agent. Tests with fakes live only under `tests/`. No real project was used. The fixture Git baseline is local to `test-fixture/.git`.

## ARCHITECTURE CHANGES

No integration or transport redesign. Implementation follows Phase 1: local managed app-server, stdio RPC, semantic authenticated HTTP operations, SSE and project allowlisting. For Phase 2 only, JSON/JSONL replace the future SQLite store to avoid introducing database complexity into this proof. This deliberately lacks production crash guarantees.

Two protocol details informed implementation: use installed schema spelling `workspace-write`; respect the actual approval decisions offered by each request, including `cancel`. Native thread-start can precede the RPC response, so the bridge correlates that event after obtaining the thread ID. Native late events retain their original turn ID and cannot clear a newer active turn.

The interruption observation requires future capabilities to distinguish turn interruption from shell-process termination. Unknown native events remain visible as raw evidence rather than being assigned invented semantics.

## NEXT STEP

Phase 3 should extract a capability-aware common adapter contract from the proven Codex implementation, then add Claude through its official local Agent SDK after validating local authentication. Keep queued input, active steering, turn interruption and process termination as distinct capabilities. Do not add the dashboard or remote tunnel yet. Phase 3 requires the user's next instruction.
