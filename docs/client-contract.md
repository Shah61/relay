# Relay browser contract v1

Relay 0.7 exposes a browser gateway on `127.0.0.1:47832` and retains a separate, randomly assigned loopback control API. Only the browser gateway is eligible for private Tailscale Serve. The root bearer token never reaches the browser. Machine-readable routes and payloads are in [browser-openapi.json](browser-openapi.json); live metadata is `GET /api/contract`.

## Authentication and authorization

Create a one-use code on the Mac with `npm run pair -- create operator PROJECT_ID`. Omit project IDs to assign all locally configured projects. Roles:

| Role | Assigned project reads | Session controls and approvals | List/revoke other devices | Diagnostics |
|---|---|---|---|---|
| viewer | Yes | No | No | No |
| operator | Yes | Yes | No | No |
| owner | Yes | Yes | Yes, globally | Yes |

Every role can inspect/revoke its own device and sign out. Owner is global device administration but is still project-scoped for session control. Project configuration, executable selection, pairing issuance, and worktree force-release remain local-only. There is no shell/RPC passthrough route. Device roles/scopes are fixed at pairing; revoke and pair again to change them.

Codes contain 192 random bits, expire after 10 minutes, and are consumed in one SQLite transaction. Device secrets contain 256 random bits. SQLite stores only SHA-256 hashes of these high-entropy credentials. Codes and secrets are not included in audit records. There are at most 20 pending codes, 1,000 device records, and 5,000 retained security audit records. Expired/revoked device rows count toward capacity; maintenance is an explicit offline task.

`POST /auth/pair` takes `{code,name}`. HTTPS sets `__Host-relay` with Secure, HttpOnly, SameSite=Strict, Path=/ and no Domain. Local HTTP uses a separate `relay_local` cookie. Both expire at 30 days, with a server-side 7-day idle timeout. `GET /auth/me` returns the public device, CSRF token, `contractVersion:1`, and transport. The dashboard refuses unknown contract versions. Revocation is durable and immediately disconnects that device's active event streams; expiry is rechecked at least every 10 seconds on a stream.

All mutations require an exact same-origin `Origin`; authenticated mutations also require `X-CSRF-Token` derived from the device secret. Browser JavaScript supplies Origin automatically. Host must exactly equal the loopback gateway or the single locally configured HTTPS `.ts.net` origin. No wildcard CORS, forwarded-header identity, or Tailscale identity-header authentication is accepted. Root bearer credentials are explicitly refused at this gateway.

## Request and operation semantics

Session mutations require `Idempotency-Key` (8–80 characters, letters/digits/underscore/hyphen). The backend namespaces IDs by device before using the durable Phase 4 operation journal. Identical IDs and payloads return the existing operation; changed payloads fail. An operation lookup from another device returns 404 even if it knows the client ID. Two different devices still share the same authoritative session/worktree locks.

Responses are `{operation,replayed?}`; states are `received`, `accepted`, `dispatched`, `native_acknowledged`, `completed`, `failed`, or `delivery_uncertain`. HTTP 200 means completed bridge request handling; 202 means recorded/pending; 409 may contain a failed/uncertain operation or a pre-dispatch rejection. **Completed does not mean the native task finished.** Inspect the session's current turn separately. Early authentication, permission, malformed-input, rate-limit and size failures may have no operation record.

Before transmission, the browser stores only the ID, route, time and state in a device-specific local outbox. It does not persist prompt bodies, pairing codes, cookies or CSRF tokens there. A 30-second response timeout or connection failure leaves `delivery_unknown`. Reload reconnects and looks up the original IDs. It never automatically resends a command, including when lookup is 404. Inspect the authoritative snapshot and local journal before explicitly deciding on further work. Clearing browser storage loses this convenience index, not the backend journal.

Request bodies are capped at 32 KiB (pairing 4 KiB). Unknown fields are rejected. Prompts are capped at 16,000 characters. Rate limits: 20 pairing attempts/minute globally, 240 authenticated requests/minute/device, 60 mutations/minute/device, 30 discovery calls/minute globally, 4 SSE streams/device and 32 core streams overall. Limits return 429. A shared gateway is intended for a small trusted personal tailnet, not public multi-tenant hosting.

## Snapshots, events and approvals

`GET /api/sessions` is paginated (`nextOffset`); every list, snapshot, approval and event route enforces project scope. A snapshot includes session/native IDs, capabilities with verification metadata, lifecycle, process, current turn, queue, approvals, lease, current event sequence and uncertainty. Capabilities govern offered controls; the server remains authoritative.

`GET /api/sessions/{id}/events?after=N` streams SSE. `Last-Event-ID` is also accepted. Normal event data includes durable `sequence`, `type`, source, native references and bounded raw evidence. `event: cursor` advances the global cursor without fabricating activity. Retention loss returns HTTP 409 `{error:"resync_required",...snapshot}`, or an established stream emits `event: resync_required` and ends. Reload the snapshot and reconnect after its `latestEventSequence`, clearly showing the gap. The dashboard retains at most 200 visible events and bounds individual SSE frames. Disconnect does not stop an agent.

Approvals bind `approvalId`, generation, session and native turn. Only offered decisions are accepted; terminal/stale/duplicate requests fail in the existing supervisor. Positive decisions on truncated browser approval evidence are rejected server-side; decline/cancel remain available. Claude questions use `answers` mapping each native question string to its answer. Raw content is rendered with text nodes, never injected HTML; CSP permits only local assets. Agent text can still contain sensitive project content—redaction is best effort, not a universal secret detector.

## Distinct controls

| Action | Meaning |
|---|---|
| prompt | Follow-up on the current native session when idle |
| queue | Claude adapter FIFO; not steering |
| steer | Codex active-turn steering; not a follow-up |
| interrupt | Request turn interruption; descendants may survive |
| stop | Stop the owned parent; reservation remains |
| close | Disable session control; does not stop parent or release reservation |
| end | Dashboard Close: disable control and attempt owned-parent shutdown |
| clear | Hide earlier chat/activity using a retained-event cursor; keep native context |
| delete | End and archive the dashboard session; keep files, native history, audit, and reservations |
| resume | Start a new process from supported native history; not process reattachment |
| release worktree | Audited offline Mac action only; never exposed here |

The UI never silently changes input modes. Claude runtime remains unverified; Codex retains historical Phase 2 runtime evidence. This contract does not claim new native-agent verification.

`POST /api/sessions` also accepts `isolated: true`. Git projects receive a separate detached worktree from committed HEAD, allowing multiple sessions for one project while preserving one writer per worktree. Existing dirty changes stay in the original folder. Archived sessions are omitted from the dashboard list. Snapshots expose `historyStartCursor` after clearing chat. The composer remains editable while sending is unavailable. See [Remote Preview](remote-preview.md) for candidate approval and the separate owner-authorized preview transport.

## Trust boundary and limitations

The Mac account, local filesystem, installed bridge code and local processes are trusted. Loopback cookies are not port-isolated by browsers; local mode is for the trusted Mac only. HTTPS terminates at Tailscale Serve and forwards to loopback; never port-forward or bind either bridge listener to a public/LAN interface. Tailnet access alone does not authorize Relay; pairing is still required. Tailnet ACLs should restrict the Mac's HTTPS service to intended devices/users. Pairing codes are access credentials until consumed or expired.

There is no independent security audit, hardware-bound credential, push notification, offline command queue, native mobile app, automatic descendant cleanup, or guarantee of availability while the Mac sleeps. A compromised owner browser has its granted powers. A stolen cookie must be revoked. Multi-tab UI prevention is convenience; durable locks and IDs enforce safety on the server.
