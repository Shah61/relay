# Current remote-access path

New installations use [our hosted relay with QR pairing](hosted-relay-setup.md), with Railway and Vercel. This document describes the earlier optional Tailscale path.

# Legacy private phone → Mac setup

**Prepared, not activated.** On October 2, 2026, you chose to leave remote setup for later. Tailscale was not installed, no tunnel was enabled, no persistent daemon was installed, and no phone-to-Mac test was claimed.

## When ready

1. Install the official [Tailscale Mac application](https://tailscale.com/download/mac) and its iOS/Android application. Sign both devices into the same tailnet. Complete the macOS network/system-extension approval yourself. The official [macOS variants guide](https://tailscale.com/docs/concepts/macos-variants) explains the standalone app.
2. In this repository, run `npm run remote:status`. It must report `connected`. This reads status without exposing Tailscale credentials.
3. Run `npm run remote:configure`. This preserves your existing local config and adds the exact Mac HTTPS origin and gateway port. It does not enable sharing.
4. Stop your foreground bridge with Ctrl-C, then run `npm run bridge` again. For a deliberately installed launchd service, restart that service instead; do not run a second bridge owner.
5. In another terminal, run `npm run remote:enable`. It verifies the local Relay gateway, refuses unrelated Serve configuration or existing Funnel exposure, and runs the equivalent of `tailscale serve --bg --https=443 http://127.0.0.1:47832`. Tailscale may require enabling HTTPS certificates in your tailnet. Complete its account/admin prompt and rerun the command; never bypass TLS warnings. This background Serve setting persists until disabled.
6. The command checks the HTTPS address from the Mac. Open that exact address on your phone with Tailscale connected. Generate a phone code locally: `npm run pair -- create operator fixture`. Enter it on the phone with a descriptive device name. For read-only access, use `viewer` instead.
7. Switch the phone to cellular, leave Tailscale connected, and confirm the project/session list loads. Refresh a selected session and observe its event stream. For a future real agent acceptance run, send one deliberate task with a unique operation ID and verify its result on the Mac. No such inference is needed merely to establish private connectivity. Test revocation using `npm run pair -- list` and `npm run pair -- revoke DEVICE_ID`.
8. Optionally add the website to your phone's home screen. The manifest provides standalone presentation. There is no offline command execution or service-worker credential cache.

Official command reference: [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve). The scripts support the official macOS app binary and common Homebrew CLI paths. They do not invoke Funnel or expose the root control API. Unknown/pre-existing Serve configurations fail closed instead of being overwritten.

## Disable or revoke

- `npm run remote:disable` disables HTTPS Serve only when the current mapping exactly matches Relay's configured target; unrelated mappings are refused. This affects private HTTPS access, not agent processes.
- `npm run pair -- revoke DEVICE_ID` revokes that browser immediately, including active streams. It does not disable other devices or stop agents.
- Stop the bridge to stop accepting requests. Graceful bridge shutdown uses the existing supervisor semantics and retains uncertain worktree leases.

## Staying available

The Mac must remain awake, online and signed into Tailscale. No power settings were changed. The Phase 4 launchd template and `npm run service:prepare` remain available; [the Phase 4 service section](phase-4-results.md) documents installation and its exact effects. Nothing was silently installed. Bridge process restarts do not reconnect arbitrary native processes or automatically resend tasks.

Completion requires a real phone test. Prepared commands, a local viewport preview, and a Mac-side HTTPS check are not proof of a working cellular phone route.
