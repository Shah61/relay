# Phases 5–7 results — October 2, 2026

## Outcome

| Phase | Result |
|---|---|
| 5 — Client contract and authorization/security | Implemented and locally tested |
| 6 — Phone → Mac remote access | Private Tailscale workflow implemented; installation, activation and real phone acceptance deliberately deferred at your request |
| 7 — Web/mobile dashboard | Implemented, connected to real APIs, and tested at desktop and phone widths |

The real local dashboard is `http://127.0.0.1:47832/`, running against the existing SQLite state. It was left running as a foreground development process, not installed as a daemon. You must generate a local one-use pairing code to enter it. The temporary UI test server was stopped and its disposable database removed. No real agent was started and no model inference was performed in these phases.

## Security and contract

The core bearer API remains on a separate random loopback port. The browser gateway accepts device cookies, exact Host/Origin, CSRF tokens, assigned project scope, and owner/operator/viewer roles. Root bearer authentication is explicitly refused there. Local-only administrative routes issue pairing codes and revoke devices. Pairing codes are single-use and expire in 10 minutes; sessions expire after 30 days or 7 idle days. Only hashes are stored. Revocation disconnects live streams immediately.

Schema 3 adds `device_pairings`, `browser_devices`, and `security_audit` in a transactional migration. Previous operational tables and recovery semantics remain intact. Security writes use the same SQLite failure/WAL guard; audit retention and pending/device limits are bounded. Existing operation IDs are preserved. Browser IDs are namespaced by device, retaining payload-hash duplicate protection and cross-client supervisor locks.

The client persists operation metadata before sending, retains unknown/uncertain delivery, looks up original IDs after reload and never automatically resends prompts or approval decisions. Version negotiation refuses unknown browser contracts. Read and mutation timeouts are bounded. SSE reconnects from its cursor, explicitly displays retention gaps and reloads the authoritative snapshot. It renders a bounded latest-200-event view.

The gateway enforces positive-approval refusal when the browser-visible evidence is truncated. Raw text, tool output and diff data are shown as text rather than interpreted HTML. CSP, HttpOnly cookies, strict same-site policy, exact origins, request bounds, rate limits and stream caps are enabled. No arbitrary shell, project-path configuration, executable override, local admin, or lease-release route is exposed remotely.

See [client-contract.md](client-contract.md) and [browser-openapi.json](browser-openapi.json) for roles, routes, schemas, status codes, trust assumptions and limits. The OpenAPI JSON and internal references were checked; it was not independently certified by an external API validator.

## Remote preparation

The Mac-focused helper discovers the official Tailscale application/CLI. It can inspect connection status, preserve local config while adding the exact private HTTPS origin, enable only the browser gateway and probe HTTPS from the Mac. It refuses unrelated/unknown Serve configuration or Funnel exposure. Disable also verifies the target before removing a mapping.

Tailscale was absent. You answered **“Leave remote setup ready for later.”** No Tailscale installation/login, HTTPS certificate issuance, Serve activation, public tunnel, router port or phone test took place. No power settings or persistent service were changed. These commands remain unverified against a live Tailscale account; policy and refusal paths have automated coverage. A real external-device test is still required.

The [numbered setup guide](setup-guide.md) covers local pairing, project configuration, Tailscale installation, expected permissions, HTTPS hostname privacy, phone pairing, cellular acceptance, and revocation. [Remote-access instructions](remote-access.md) provide operational detail.

## Dashboard

The responsive interface uses pale lavender backgrounds, white surfaces, deep plum text and violet controls, including its icon and home-screen manifest. It provides session selection/creation, capability-gated follow-up/queue/steer, distinct interrupt/stop/close/resume controls, approval/question forms, native evidence, explicit uncertainty, pending-operation recovery, device revocation, diagnostics and remote-setup guidance.

Input mode is never silently converted into a different operation. Hidden mobile navigation is inert until opened. Claude is marked runtime-unverified. Reconciliation warnings and parent/descendant uncertainty are preserved rather than hidden by the design.

Actual browser acceptance used a disposable fake-agent server through the same gateway and frontend. It verified pairing, start, prompt, SSE, approval confirmation/resolution, reload, device page, stop-parent, close-control, retained worktree reservation and mobile navigation. An `<img ... onerror=...>` test string rendered literally with zero image elements in the activity DOM. At 390 px, document width was exactly 390 px. Browser developer logs showed no errors/warnings at the inspected point. Physical iOS/Android devices have not been tested.

Screenshots contain **test-only data**, not evidence of new native-agent inference:

- [Purple desktop dashboard](evidence/phase567/dashboard-desktop.jpg)
- [Purple phone-width dashboard](evidence/phase567/dashboard-mobile.jpg)
- [Purple pairing screen](evidence/phase567/pairing-purple.jpg)

## Validation

| Check | Result | Evidence |
|---|---|---|
| TypeScript build | Pass | [build.txt](evidence/phase567/build.txt) |
| Existing regression + new gateway/security tests | 49/49 pass (38 existing + 11 new) | [unit-tests.txt](evidence/phase567/unit-tests.txt) |
| Browser-client recovery/contract/storage tests | 6/6 pass | [client-tests.txt](evidence/phase567/client-tests.txt) |
| Existing real local failure injection | 12/12 pass | [failure-tests.txt](evidence/phase567/failure-tests.txt) |
| Existing core HTTP security suite | 22 checks pass | [security.json](evidence/phase567/security.json) |
| Historical integrity manifest | 20 files unchanged | [historical-integrity.json](evidence/phase567/historical-integrity.json) |
| Real final bridge | Healthy, version 0.7.0, schema 3 | [final-state.json](evidence/phase567/final-state.json) |

The first sandboxed test attempt could not inspect processes; the authorized local run passed. Initial new gateway tests exposed a test-client Host-header issue and a fake-agent turn-completion issue; these were corrected, not removed. Final tests use real HTTP Host overrides and actual local sockets. No previous test suite was replaced.

The earlier standalone `gateway-tests.txt` is a 10-test checkpoint; the final 49-test combined run additionally includes truncated-approval enforcement. Historical Phase 1–4 reports/evidence were not edited. The core security script now defaults to the new evidence directory to avoid overwriting Phase 4 results.

## Remaining limits

- Real remote installation and phone acceptance remain deferred, not completed.
- Host support is Mac-focused. Windows/Linux can act as browser clients, but full bridge hosting was not verified on Linux and Windows requires portability work (`/bin/ps`, launchd, executable discovery).
- Production state still has **two historical lease members on one worktree**. They were not force-released. Use a deliberately configured project or perform proper offline reconciliation before another writer starts in that fixture.
- Codex retains historical Phase 2 proof. Claude remains unauthenticated and runtime-unverified; no billing fallback was introduced. Agent integrations were not redesigned.
- Tailscale is a network trust dependency. Pairing adds application authorization but does not replace careful tailnet membership/ACLs. The Mac account and local processes are trusted. This system has not received an independent security audit.
- No complete descendant termination guarantee, arbitrary process reattachment, Codex history resume, push notifications, offline execution, or native phone application is claimed.
- Current foreground availability is not persistent login/startup availability; review the existing launchd procedure before deliberately installing it.
