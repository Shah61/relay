# Hosted relay implementation and acceptance

The current architecture is phone browser → own WebSocket relay on Railway → outbound connector on the local computer. Vercel serves only the static dashboard. Tailscale is no longer the primary setup path. Hosting has **not** been deployed in this session; no public route or real phone/cellular acceptance is claimed.

Implemented:

- Authenticated host enrollment, exact browser-origin allowlist, bounded sockets/frames/buffering, heartbeat and host reconnect, single-replica routing without an offline command queue.
- QR invitations created locally, single-use ten-minute pairing, cancellation, encrypted device credentials at rest, non-exportable browser keys in IndexedDB, and a computer picker for multiple paired hosts.
- AES-GCM payload encryption with fresh host connection challenges, counters and context binding. Existing local role/project authorization and operation journal remain authoritative. Local host setup and root administration cannot be routed from the phone.
- Live event streaming, prompt/control/approval requests, revocation, and recovery of uncertain acknowledgments without automatic mutation replay.
- Local owner auto-pairing through `npm start`, Mac/Windows convenience launchers, Windows native-executable discovery and process fingerprinting, Linux-compatible PATH discovery. No OS service or power-setting change was installed.
- Railway Docker/config files, Vercel static build with a single allowed relay origin, and a three-OS CI workflow. The cloud builds and Windows/Linux workflow have not been run on their target platforms.

Validation on this Mac:

| Check | Result |
|---|---|
| TypeScript build | Passed |
| Full unit/integration suite | 53 passed |
| Browser client recovery suite | 6 passed |
| Process/crash failure suite | 12 passed |
| Existing core HTTP security checks | 22 passed against the updated local bridge |
| Final relay-specific suite | 4 passed; includes real HTTP/WebSocket pairing, wrong host token/origin, canceled QR, setup protection, scope/role checks, events, encryption tamper/replay, durable reconnect/revocation, and lost-acknowledgment recovery |
| Static dashboard production build | Passed with a placeholder `wss://relay.example.com` origin; this is not a deployment |
| Real browser UI | Automatic local pairing, QR destination, fragment removal, encrypted pairing, reload persistence, start/prompt/live response, approval confirmation/completion verified with fake agents |
| Phone-size layout | 390 px viewport and 390 px document width; no overflow; no browser error/warning logs in inspected state |

The browser test's “Demo Windows PC” label is a **test fixture name**, not proof of execution on Windows. All fake-agent tests avoid provider inference. Codex retains its historical Phase 2 runtime evidence; Claude remains runtime-unverified. Existing unresolved local worktree leases were not force-released.

Evidence: [relay checks](evidence/hosted-relay/relay-tests.tap), [HTTP security checks](evidence/hosted-relay/security.json), [QR interface](evidence/hosted-relay/qr-pairing.png), [phone-width browser](evidence/hosted-relay/phone-browser.png). The QR in the screenshot was canceled; it is not a usable credential. Disposable UI servers and state were cleaned up. The real local bridge remains available at `http://127.0.0.1:47832/` as a foreground development process.

One initial security-check run failed because the old bridge port was no longer listening. After starting the updated local bridge, all 22 checks passed. One initial Windows path assertion assumed x64 on this arm64 Mac; it was corrected to explicitly exercise both Windows architectures, and the suite passed. Neither issue was hidden by claiming a successful first attempt.

Remaining acceptance: deploy the Railway/Vercel projects with the actual origins, configure a host, scan from a physical phone and test over cellular, and execute a harmless real agent task on each intended host OS. Independent security review is still advisable before broader use: the custom protocol has no forward secrecy and trusts the frontend deployment and both endpoints.

Follow [the numbered setup and security guide](hosted-relay-setup.md) and [the protocol notes](relay-protocol.md).
