# Prompt Manager Companion

The production product flow is:

`Companion → Vercel account dashboard → passkey authorization → per-computer credential → Railway relay → local Codex/Claude bridge`

The Vercel and Railway origins are release configuration baked into the signed companion and Vercel build. They are never form fields. A development build deliberately reports **Service not configured** until a release build is made with `PM_DASHBOARD_ORIGIN` and `PM_RELAY_ORIGIN`.

## Computer enrollment

The installed companion creates a short-lived enrollment request over HTTPS. It opens the configured dashboard at `#authorize=<request-id>`. The user signs in or registers with a WebAuthn passkey and chooses **Authorize this computer**. Railway stores the request and the account's computer record. The companion polls with a random 256-bit poll secret, receives a unique 256-bit computer credential, encrypts it with Electron `safeStorage`, and starts its local bridge. The polling secret is never put in the URL. It expires in five minutes and is consumed after acknowledgement.

The account has no shared enrollment token. A computer credential is unique to one computer, hashed on Railway, revocable from the dashboard, and only accepted for that computer ID. The host WebSocket checks that credential before accepting its UUID hello. A duplicate active host connection is rejected. The local process stores the credential through `safeStorage`: macOS uses Keychain-backed app encryption and Windows uses DPAPI-backed app encryption. The companion also stores local projects under its user-data directory with owner-only permissions.

## Browser authorization

The account dashboard lists online computers. Selecting one generates an ephemeral browser P-256 ECDH key and asks the computer to verify the account's passkey. The computer verifies the signed challenge, creates a normal scoped browser device through the existing `DeviceAuth`, and encrypts that device secret to the browser's ephemeral public key. The browser stores only its non-exportable AES key and host metadata in IndexedDB, then uses the existing encrypted relay transport. Railway sees routing metadata and ciphertext, not prompts or browser secrets.

QR pairing remains available from a connected companion for a quick operator/viewer browser invitation. It is an optional shortcut; normal computer setup does not use QR or manual pairing codes.

## Product release configuration

After the domains exist, build the static dashboard and companion with:

```sh
DASHBOARD_ORIGIN=https://app.example.com \
RELAY_PUBLIC_URL=wss://relay.example.com \
npm run build:dashboard

PM_DASHBOARD_ORIGIN=https://app.example.com \
PM_RELAY_ORIGIN=https://relay.example.com \
npm run companion:package
```

Railway uses `DASHBOARD_ORIGIN` and a persistent volume mounted at `/data`; the service stores its account database there. It does not receive a host enrollment token. Vercel uses the same `DASHBOARD_ORIGIN` build value and `RELAY_PUBLIC_URL`. Production deployments must be HTTPS/WSS, one Railway replica, and a signed/notarized companion release. Local packaging disables notarization until release signing credentials are supplied.

## Security boundaries

Passkey verification authorizes the computer and the browser independently. A Vercel compromise could control a user's browser session, but it cannot read a computer credential from Railway. A compromised companion process runs with the user's local OS permissions and can access the selected projects; the companion does not sandbox Codex/Claude. A lost computer must be revoked in the dashboard and its local credential deleted. A lost phone/browser must be revoked under Devices. The existing command scopes, CSRF checks, idempotency journal, approval flow, and no-automatic-replay behavior remain in force.
