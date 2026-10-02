# Connect your computer to your phone

This is the current setup path. It replaces the earlier Tailscale plan. The phone needs only a modern browser. Railway runs our account/encrypted routing server, Vercel serves our dashboard, and the Prompt Manager Companion runs local agents on macOS or Windows. Hosting providers and normal open-source packages are still dependencies; no VPN or managed tunneling service is required.

## 1. Deploy the relay on Railway (once)

1. Put this project in a **private repository containing only this project**. Do not upload your home directory, `.bridge`, `config.local.json`, `.env`, agent credentials, or project workspaces. This checkout currently inherits a parent Git repository; create/select a dedicated project repository before connecting Git deployment.
2. Create a Railway service from that repository. The included `railway.json` selects `Dockerfile.relay`. It runs only the routing server, never Codex or Claude.
3. Add a persistent Railway volume attached to the relay service and mounted at `/data`. Set `RELAY_DATA_DIR=/data` and `DASHBOARD_ORIGIN` to the exact Vercel production origin, for example `https://my-relay.vercel.app` (no trailing slash). Updated server builds also detect Railway's automatically supplied `RAILWAY_VOLUME_MOUNT_PATH` when `RELAY_DATA_DIR` is unset. Setting a directory variable does not create a persistent volume. The service stores its account database there; no host token is shipped to users.
   Set `RAILWAY_RUN_UID=0` for this deployment: Railway mounts volumes as root, while the Dockerfile defaults to the non-root `node` user. This is Railway's documented volume-permissions workaround and runs the relay as root inside its container, not on users' computers. See [Railway volume permissions](https://docs.railway.com/volumes#permissions).
4. Deploy with **one replica**, a single region, and an always-running service. The relay keeps live routing in memory and account state on the volume; multiple replicas need a separate coordinated routing implementation. Do not enable service sleeping. Generate a public HTTPS domain and verify `/health` reports `status: ok`.
5. Keep the relay address as `wss://YOUR-RAILWAY-DOMAIN` (same domain, WebSocket scheme). Railway handles the public TLS certificate. No Mac/PC port forwarding is needed.

## 2. Deploy the dashboard on Vercel (once)

1. Import the same dedicated repository. Use the repository root and framework **Other**. The included `vercel.json` builds with `node scripts/build-dashboard.mjs` and publishes only `dist-web`.
2. Set `RELAY_PUBLIC_URL` to `wss://YOUR-RAILWAY-DOMAIN` and `DASHBOARD_ORIGIN` to the exact Vercel production origin, then deploy. These are product release settings, not user settings. **Never add a host credential or agent token to Vercel.**
3. Confirm the final production origin matches Railway's `DASHBOARD_ORIGIN`. If either address changes, update the deployment settings and rebuild the companion release. The dashboard's security policy allows WebSocket traffic only to the configured relay origin.
4. Make the production dashboard reachable on the phone without a Vercel team sign-in. It intentionally serves a public, unauthenticated shell; access to a computer still requires QR pairing. Preview deployments are not authorized unless their exact origins are explicitly configured.

Official references: [Railway WebSocket networking](https://docs.railway.com/networking/public-networking/specs-and-limits), [Vercel project configuration](https://vercel.com/docs/project-configuration).

## 3. Prepare each computer (once per Mac or PC)

1. Install the signed **Prompt Manager Companion** for macOS or Windows. The release contains the dashboard/relay addresses; users do not enter them. Its credential is protected by macOS Keychain-backed Electron secure storage or Windows DPAPI-backed secure storage.
2. Open the companion and choose **Connect this computer**. It opens the Vercel dashboard. Sign in with your account passkey and authorize the computer. The companion polls a short-lived enrollment request and receives a unique computer credential; no shared host token is distributed.
3. Add only the project folders you want to control using **Add project folder**. The local bridge exposes those folders to Codex/Claude and nothing else.
4. Choose **Start automatically when I sign in**. The companion starts the local bridge and reconnects to the relay when the computer is online. Keep the computer awake for remote work.
5. Open the same Vercel dashboard on your phone. Your authorized computers appear as separate online/offline cards. Select one to authorize an encrypted browser channel and control sessions on that computer.

For development builds, run `npm run companion:build` and use `npm run companion:dev`; it intentionally displays “Service not configured” until a release is built with `PM_DASHBOARD_ORIGIN` and `PM_RELAY_ORIGIN`. Create installers only after deployment with `PM_DASHBOARD_ORIGIN=https://... PM_RELAY_ORIGIN=https://... npm run companion:package`.

Legacy manual bridge setup remains useful for development only. A production user should not run `npm run pair -- create owner`, enter URLs, or copy a host token.

The old direct Node setup below is retained for local bridge development:

1. Install Node.js **22.18 or newer in the Node 22 line**, Git, and the agent you want to use from their official sources. Sign in to Codex/Claude **on that computer** with your account. Claude on Windows may also require Git Bash; follow its current official installation instructions. Do not paste provider credentials into Relay.
2. In this project's folder, run `npm ci` and `npm run build`. This installs code dependencies locally, not on your phone.
3. Create `config.local.json` listing only the repositories you want to control:

   ```json
   {
     "projects": { "my-app": "/Users/your-name/Projects/my-app" },
     "browser": { "port": 47832 }
   }
   ```

   On Windows the path can be `C:/Users/your-name/Projects/my-app`. Use an existing local Git repository. The included default `fixture` project is only for testing. Optional `codex.executable` or `claude.executable` specifies an absolute native executable when automatic discovery cannot find it. Windows launches native `.exe` files directly; it does not run prompts through `.cmd` wrappers.
4. Run **`npm start`**. It opens and pairs the local owner dashboard automatically. Keep the terminal open. `Start Relay.command` (Mac) and `Start Relay.cmd` (Windows) are convenience launchers once Node and dependencies are installed. Linux uses the same `npm start` command.
5. (Legacy development path.) Open **Connect phone → One-time relay settings** only when exercising the old direct Node bridge. The signed Companion path above owns these addresses and credentials for the user.
6. Select phone access: **Send prompts & approve actions** or **View only**. Click **Create phone QR code**. The QR grants access to all projects visible to this local owner. It expires after ten minutes and works once. Cancel it if you created it by mistake.

`npm run pair -- create owner` still works on Mac, Windows, and Linux when the bridge is running on that same computer. It is the manual local pairing alternative; `npm start` removes that typing step. Native Windows/Linux agent execution still requires platform acceptance testing—portable launch code and a three-OS CI workflow are included, but a Mac test does not prove a real Windows agent run.

## 4. Connect the phone

1. Scan the QR with the phone's ordinary camera and open the link in Safari/Chrome.
2. Give the browser a name and tap **Connect this device**. No enrollment token, command, VPN, or phone package installation is needed.
3. Bookmark the Vercel address after pairing. Pairing material is removed from the address bar immediately. Browser access survives refreshes through a non-exportable Web Crypto key stored in IndexedDB; clearing site data or using a different browser requires pairing again.
4. For a second computer, repeat step 3 there and scan its QR in the same phone browser. A computer selector appears after reloading when multiple computers are paired.
5. Test over **cellular data with phone Wi-Fi off**. Start one harmless task in an approved project, watch output, and verify an approval if offered. This real phone/network check is required before relying on it away from home.

## Everyday use

Keep the computer powered, online, awake, and Relay running. Closing a laptop lid usually puts it to sleep; this system does not provide wake-on-LAN. Agent execution stays on the computer. Agent approvals and existing worktree locks still apply. Relay does not attach to arbitrary pre-existing desktop chats; manage sessions created through this bridge.

Open your bookmark, choose the computer/session, and send the task. You can optionally add the site to the home screen, but installation is not required. If the network drops after sending, inspect **Pending operations**; do not send a new copy until you know the first request's outcome. The transport never automatically replays a mutation.

Stop remote access by stopping Relay or revoking the phone under **Devices** from the local owner dashboard. Device access expires after 30 days or seven idle days. A lost phone should be revoked immediately. Canceling an invitation does not revoke an already paired browser; use Devices for that.

## Security and limitations

- QR codes are temporary credentials. Someone who scans an unused operator QR can prompt agents and approve actions within its project scope. Never publish screenshots of a live code. Companion computer credentials remain private and are revocable from the dashboard.
- Prompts, responses, pairing exchanges, and browser commands are encrypted with AES-256-GCM using Web Crypto. Fresh per-connection challenges, direction binding, and counters reject tampering/replay. Railway sees addresses, routing identifiers, timing, and message sizes; it can interrupt service. It does not receive the paired-device encryption key or readable prompt payloads through this protocol.
- Vercel serves the browser JavaScript and is therefore trusted, as are your repository/deployment accounts, browser, and computer. Malicious frontend code could use a stored browser key. Non-exportable does not protect against malicious code executing in the same origin. Protect hosting accounts with MFA and restrict deployment access.
- This is a custom protocol using standard cryptographic primitives, **not an independently audited security product**. It has no forward secrecy: theft of a device secret can expose captured traffic for that device. Use it for your own trusted computers; this is a single-owner deployment, not a public multi-tenant service.
- The local bridge stays on loopback; only the outbound connector reaches Railway. Host-only setup/admin endpoints are explicitly excluded from remote routing. Viewer/project permissions are checked on the computer before agent dispatch. Relay cannot make agent actions harmless; granting an operator agent access can modify files or run agent-approved commands.
- In the legacy direct bridge, `.bridge/relay.json` stores the host enrollment token and `.bridge/relay-devices.json` stores device secrets encrypted using a key derived from the local root token. The signed Companion path stores its per-computer credential through OS secure storage (macOS Keychain-backed and Windows DPAPI-backed). Protect the computer account, backups, OS login, and full-disk encryption; never sync either credential store publicly.
- No provider API keys are added to the hosting providers or phone. Existing local agent account/billing behavior remains in effect. Claude's subscription-only restrictions remain enforced.
- Dependency installation executes trusted package-manager software on your computer. Use the lockfile and official Node/Git/agent sources. No Tailscale, Cloudflare tunnel, router port forwarding, certificate bypass, or administrator-level remote-control service is required.
- Hosting incurs Railway/Vercel usage costs under your accounts. The relay is bounded to 16 hosts and 128 sockets total, with 32 clients per host. It is designed for personal use. There is no offline command queue on the server.

Current verification: real local HTTP/WebSocket transport with fake agents; encryption failure/replay checks, role/project isolation, event streaming, lost-acknowledgment recovery, reconnect and revocation. Public hosting, a physical phone over cellular, and native Windows/Linux agent runs are separate acceptance steps. No provider inference was used to test this relay.
