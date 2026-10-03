# Remote Preview and mobile session management

## User flow

Sessions now offer **Close session**, **Clear chat**, **Delete session**, **Clear draft**, and **New session** in a mobile grid. The composer stays editable while a session is busy, closed, or uncertain; sending still follows the native agent's capabilities. Drafts are kept separately in memory when switching sessions, and discarded after a successful send. Clearing chat hides earlier replies/activity without resetting the agent's conversation. Deleting a session closes it, attempts to stop the owned agent, and durably archives the dashboard entry. Project files, native history, the operation journal, and uncertain workspace reservations remain available. Failed agent shutdown is recorded and does not prevent archiving.

New sessions default to **Use a separate workspace**. For a Git project this creates a detached worktree from committed `HEAD` under the Companion's private state directory. Each session has its own writer reservation; multiple sessions can use the same project safely. Uncommitted changes are not copied, and existing worktrees are never deleted automatically. Unchecking the option uses the original folder. Non-Git folders retain one reserved writer; a second session needs another project folder or local reconciliation. The original CLI `close` still means control-only closure; the dashboard uses the new `end` operation to also attempt owned-parent shutdown.

When Codex command output or a Claude Bash result reports an HTTP loopback URL, **Preview** shows a candidate with **Enable Preview**. Assistant prose is not a detection source. All output-based candidates require explicit confirmation because output cannot establish the identity or purpose of a listener. There is no port scan, remote target registration, or browser-supplied port field. A known local integration can call `PreviewTargets.candidate(sessionId, url)` with an allowlisted session; it follows the same approval path.

After approval and a bounded HTTP reachability check, the companion registers that exact target. Railway generates an opaque preview UUID. **Open Preview** opens `/p/<uuid>` on Vercel; **Refresh** reloads preview status, and **Disable Preview** immediately revokes the target without killing unrelated processes. Multiple detected servers are listed by port within their session. The local server can stay bound to `127.0.0.1`.

## Routing and production release configuration

### A dev server fails with `listen EPERM`

This means the local process could not open a listening socket; no running server exists for the relay to expose. It is independent of the phone's IP address. Codex sessions now use `on-request` with user-reviewed native command approvals and keep the workspace-write sandbox. Production instructions tell the agent to request permission for the exact dev-server command when sandbox binding is denied. They no longer identify real projects as disposable fixtures or prohibit the approval recovery flow. The change does not automatically grant network access or approve commands.

Rebuild/reinstall Companion and start a new Codex session to receive the corrected thread instructions. Ask it to start the project's dev server on `127.0.0.1`; if a command approval appears, review it on the phone. Once actual command output reports the running server, enable its preview and open it. A declined command or an enforced machine policy remains a denial. Existing native threads keep their original instructions.

Remote Preview works through public HTTPS and an outbound Companion connection, without LAN access, router port forwarding, or a shared Wi-Fi network. The laptop must remain awake and online with Companion and the server running. Closing the laptop may put it to sleep and disconnect the preview.

The dashboard now distinguishes a disconnected preview connection, failed relay connection, and a computer that is not account-enrolled. It also uses the configured dashboard origin for launch links when opened from the local gateway. Relay `/health` reports `previewHosting: true` only when isolated preview hosting is configured; a missing field means the deployment predates this diagnostic. This flag alone does not verify public DNS/TLS routing.

Recheck on 2026-10-03: 66 unit/integration tests and 14 browser-client/Markdown tests passed; type checking, dashboard build, and Companion compilation passed. Tests cover native approval forwarding (simulated agent transport), preview-host connection failure, and the existing disposable-server HTTP/WebSocket/security checks. Public Railway health responded and the Vercel preview launch rejected an unauthenticated request with 401. No production preview domain, real model-driven server launch, or physical cellular-device session was verified in this recheck. These changes require deployment and a Companion update before they affect the installed product.

```text
Phone → Vercel /p/<preview-id> → Railway account authorization / one-use launch ticket
Phone → <preview-id>.preview.example.com → Railway → outbound Companion preview socket → 127.0.0.1:<approved-port>
```

App traffic uses Railway directly after the dashboard authorizes the launch. It does not pass through a Vercel function for every asset or WebSocket. Each preview has its own origin, so root-relative assets, cookies, routing, and WebSocket URLs work without fragile HTML/JavaScript rewriting. Untrusted development HTML never runs on the dashboard or account API origin.

The release maintainer must provision wildcard DNS and TLS for a dedicated preview domain routed to the same Railway service, then set:

```sh
PREVIEW_ORIGIN_TEMPLATE=https://{id}.preview.example.com
```

The template must place `{id}` in a hostname label. Do not serve the dashboard within the preview suffix. A custom wildcard domain/TLS edge is necessary; Railway's generated service domain alone does not supply arbitrary preview subdomains. The edge must preserve the original Host, forward WebSocket upgrades, stream responses, and route all these hosts to the one relay replica. Check the provider's supported wildcard routing and certificates when provisioning the deployment. This is a once-per-product release setting, never a field or port/tunnel step for users.

Deploy the updated Railway image and Vercel dashboard/functions, and ship the rebuilt Mac/Windows Companion. The Vercel `RELAY_PUBLIC_URL` remains the existing exact WSS relay origin. Without `PREVIEW_ORIGIN_TEMPLATE`, session transport remains available but preview hosting is disabled. Legacy QR-only browsers need to sign into the account dashboard before they can launch previews. A computer must have been enrolled to an account; the legacy shared-token relay cannot expose previews.

## Security and lifecycle

Companion and relay both validate the target as HTTP on `localhost` or `127.0.0.1`, normalize the connection to numeric `127.0.0.1`, require an explicit port between 1024 and 65535, and reject common database/cache/debug infrastructure ports. The companion additionally excludes its bridge/gateway ports. Only approved candidate IDs can be enabled remotely; target fields in approval requests are rejected. Only an authenticated computer can register a preview, and owner identity comes from its enrolled credential, never a supplied user ID.

Each preview record contains owner ID, computer ID, local candidate ID, session ID, project, exact target, preview UUID, creation/last activity/expiration timestamps, and revocation state. Records are memory-only and cannot survive a relay/companion restart as an active grant. Approval lasts at most one hour. A changed port is a new candidate requiring new approval. Session closure or agent exit revokes previews; a ten-second bounded check of approved servers detects stopped listeners. It probes only approved targets, never additional ports.

The dashboard launch verifies its HttpOnly account session and computer ownership. Railway issues a hashed, one-use, 60-second ticket bound to that preview and login. On the isolated preview origin the ticket sets a Secure, HttpOnly, host-only `__Host-pm-preview` cookie (SameSite=Lax) and redirects to a clean `/`. The grant expires after 30 minutes or the preview's expiration, whichever comes first. Every HTTP request and streamed/WS message checks the original login remains valid, the exact computer is still owned and online, the preview is active, and the target is approved. Idle streams/sockets recheck authorization within five seconds. Account logout, computer revocation, preview disable, expiry, or either companion connection dropping cancels active traffic. Reconnect creates fresh preview IDs; old IDs and grants stay invalid.

Preview credentials and dashboard cookies never reach the development server. App cookies remain per-preview and cannot set reserved authentication cookies or a parent Domain. Cross-origin requests and WebSocket origins are rejected; mutating app requests require the exact preview Origin. The companion ignores supplied destinations, connects only to its approved record, and never follows an upstream redirect. Same-target loopback redirects are rewritten to the preview origin; a loopback redirect to another port is rejected.

Preview traffic is TLS-protected in production and visible to the relay, unlike the existing end-to-end encrypted prompt/session transport. A separate authenticated `/preview-host` connection carries preview data, with independent capacity/backpressure. Prompt frame formats are unchanged. Codex thread initialization uses the native permission approval flow described above.

## Supported transport and limits

HTTP methods GET, HEAD, POST, PUT, PATCH, DELETE, and OPTIONS; query strings; binary assets; response status/headers; multiple cookies; gzip bytes; uploads; redirects; and incremental streaming are proxied. Host, Origin, and Referer are rewritten to the exact loopback target. WebSocket handshakes carry path/query, selected subprotocol, and text/binary messages. Compression is disabled on the tunnel. Chunk acknowledgements apply backpressure in both directions.

Limits: 32 concurrent preview requests/sockets per computer, 128 globally, 32 approved/candidate targets per computer, 8 MiB HTTP upload, 64 MiB ordinary response, 32 KiB chunks/WebSocket messages, bounded 1 MiB outgoing buffering, 32 KiB forwarded headers and cookies, 15-second chunk acknowledgement deadline, five-minute HTTP/stream lifetime, and 30-minute maximum WebSocket/grant lifetime. Event streams are exempt from the total 64 MiB cap but still have the time and backpressure bounds. Browsers must reopen an expired preview from the dashboard.

HTTP-only local targets and `127.0.0.1` listeners are implemented. HTTPS/self-signed local targets and IPv6-only listeners are not supported. Apps that hard-code localhost URLs, configure a separate HMR port, require special public-host settings, or use WebSocket messages larger than 32 KiB may need app configuration. This proxy does not rewrite arbitrary HTML or JavaScript source. Standard same-origin Vite/Next HMR paths are transported, but full framework HMR support is **not claimed** until tested with actual framework servers.

## Verification

`tests/preview.test.ts` uses a disposable loopback HTTP/WebSocket server and real Railway-style relay, enrolled companion, encrypted dashboard transport, and account grants. It verifies HTML, JS/CSS/image assets, encoded queries, loopback redirects, cookies/credential filtering, streaming chunks, 2 MiB responses, streamed uploads, WS subprotocol/text/binary traffic, and existing session prompt handling. It rejects missing/foreign accounts, wrong IDs, cross-origin access, arbitrary port routes/fields, privileged/infrastructure/LAN targets, revoked/expired previews, expired logins, stopped sessions, and stale IDs after disconnect/reconnect. Both `darwin` and `win32` enrolled-computer metadata paths are exercised on the development Mac; this is not a native Windows run.

`tests/session-management.test.ts` verifies concurrent isolated sessions in one Git project, preservation of uncommitted work, close/clear/delete semantics, viewer rejection, idempotent deletion, retained audit/reservations, and failed-shutdown recovery. The portable CI matrix now includes these tests on Windows, macOS, and Linux, but those remote CI jobs have not been run from this checkout.

Local results: 64 unit/gateway/relay tests, 14 browser-client/Markdown tests, and 12 failure-injection tests pass. Type checking, static dashboard build, and Companion compilation pass. A 390×844 browser smoke test verified mobile controls, editable drafts after closure, starting a second session, preview candidates, and chat clearing. The Vercel launch handler is tested for forwarding authentication to the fixed relay, rewrite routes, invalid links, and unauthenticated/cross-site rejection. Production wildcard/TLS routing, a physical phone over mobile data, actual Vite/Next HMR, and native Windows Companion execution remain release acceptance checks.

Framework references: [Vite server/HMR options](https://vite.dev/config/server-options), [Next.js development origin checks](https://nextjs.org/docs/pages/api-reference/config/next-config-js/allowedDevOrigins).
