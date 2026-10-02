# Current setup

The hosted relay with QR pairing supersedes this earlier Mac/Tailscale guide. Follow [the current numbered setup guide](hosted-relay-setup.md). The instructions below are retained for the legacy private-network option.

# Legacy: connect your MacBook to Relay

## Which computer runs the command?

`npm run pair -- create owner` runs **inside this repository on the machine hosting the bridge**. For you, that is your MacBook. Do not include a trailing backslash. A Windows/Linux laptop or a phone connecting as a client only needs Tailscale and a current browser. Generate its one-time code on the Mac and paste it into that device's Relay page.

| Device/use | What is supported here |
|---|---|
| MacBook hosting the bridge | Implemented and locally tested |
| Phone, Windows, Linux, another Mac as a browser client | Same HTTPS web dashboard and pairing flow; actual external-device connection still needs your acceptance test |
| Linux hosting the bridge | Node command syntax is similar, but this complete deployment has not been validated on Linux |
| Windows hosting the bridge | Not supported by this implementation yet: process identity assumes `/bin/ps`, service preparation uses launchd, and executable discovery is Mac-focused |

Relay is a responsive **web app**. It controls bridge-owned agent sessions; it is not remote desktop software and does not attach to arbitrary existing desktop-agent processes. No additional native Relay phone app is required.

## 1. Open the local dashboard

Open `http://127.0.0.1:47832/` on this Mac. The bridge has been left running for the current work session, but it is not installed as a persistent service.

For a later manual start, open Terminal:

```sh
cd "/Users/mukhtarshah/Desktop/Coding Personal/prompt-manager"
npm run bridge
```

Keep that terminal running. If a bridge is already running, use it; don't start a second instance. Node and this repository's dependencies are already installed on this Mac. On a clean deployment, use the supported Node runtime and `npm ci` from this trusted repository. The build was tested on Node 22.18.0; updating runtimes should include rerunning the regression tests.

## 2. Pair your Mac browser

In another Terminal tab, in the same folder:

```sh
npm run pair -- create owner
```

Copy the newly printed code into Relay, name the browser, and connect. The code is single-use and expires in 10 minutes. This owner browser can manage devices; do not share its code. You can generate an `operator` or `viewer` code instead if you want fewer permissions.

## 3. Choose the project you will actually control

The current default is the `fixture` test project. Its two historical session holders still require deliberate local reconciliation; they were not force-released. Connecting/pairing works, but starting another writer in that reserved worktree will be refused.

To use your own repository, create/edit `config.local.json` and map a short project ID to its absolute directory under `projects`. Preserve any other settings. Restart the bridge, then issue a new pairing scoped to the new project (existing device scopes do not automatically expand). For example:

```json
{
  "projects": {
    "my-project": "/absolute/path/to/your/repository"
  },
  "browser": { "port": 47832 }
}
```

Use a real path you intend to grant access to. You can inspect the current agent availability without inference using `npm run client -- agents`. Claude still needs a future official subscription/login and separate live verification; it is not ready merely because its adapter is present.

## 4. Install Tailscale when you are ready for remote access

You chose to defer this installation. Later, install the official [Mac application](https://tailscale.com/download/mac) and the official Tailscale app on the connecting phone/Windows/Linux computer. Sign into the same tailnet/account and connect both devices. Use the provider's official installers or app-store listings.

On macOS, the standalone app needs its system/network extension authorized. On a phone, approve the expected VPN configuration from the genuine Tailscale app. Do not disable OS security or bypass certificate warnings. See [the official Mac extension instructions](https://tailscale.com/docs/concepts/macos-sysext).

## 5. Configure Relay's exact private address

On the Mac, in this repository:

```sh
npm run remote:status
npm run remote:configure
```

Status must say `connected`. Configure writes the exact HTTPS `.ts.net` origin into your local config; it preserves existing projects and does not publish anything. Restart the bridge after configuration: Ctrl-C in the terminal running it, then `npm run bridge` again. If you later deliberately install the service, restart that service instead.

## 6. Enable private HTTPS

In a second Mac Terminal tab:

```sh
npm run remote:enable
```

Tailscale may ask you to enable HTTPS certificates for your tailnet. Complete that official account step yourself if prompted, then rerun the command. The script exposes only the browser gateway through private Tailscale Serve, refuses conflicting Serve configurations/Funnel, and tests the HTTPS address from the Mac. It prints your exact URL.

This setting persists in Tailscale until disabled. It does not make the bridge run continuously. [Serve is tailnet-only](https://tailscale.com/docs/reference/tailscale-cli/serve); do not substitute Funnel, router port-forwarding, or public hosting.

## 7. Pair the remote browser

Generate a separate code on the Mac. Replace `my-project` with your configured project ID:

```sh
npm run pair -- create operator my-project
```

On the phone or other computer, keep Tailscale connected and open the printed **HTTPS URL** in its browser. Enter the code and a device name. Do not use `127.0.0.1` on the phone—that means the phone itself, not your Mac.

Use `viewer` for read-only access. Reserve `owner` for browsers that should manage other devices. You can optionally add the Relay website to your phone's home screen.

## 8. Confirm the connection actually works

Switch your phone to cellular with Tailscale still connected. Open Relay, check its assigned project/session list, select a session and refresh its state. Confirm that signing out or revoking that browser removes access. Only after this test should you consider the phone route verified.

No command is automatically resent when the network drops. If an operation says delivery is unknown/uncertain, check the operation recovery panel and session snapshot before sending more work. Mac sleep can make the service unavailable; keep the Mac awake when you expect access. No sleep settings were changed.

## 9. Know how to revoke or stop access

```sh
npm run pair -- list
npm run pair -- revoke DEVICE_ID
npm run remote:disable
```

Revoke disconnects one browser. Disable turns off Relay's matching private HTTPS Serve mapping; it refuses to overwrite unrelated mappings. These commands do not mean that agent descendants stopped. Interrupt, stop-parent, close-control and release-worktree remain separate actions. Worktree release is local/offline only.

If you want automatic startup later, review the launchd installation section in [Phase 4 results](phase-4-results.md) first. `npm run service:prepare` only prepares the configuration. No daemon has been installed.

## Security implications

- **Tailscale is trusted networking software.** It installs a network/VPN component and adds your devices to a private network. Secure its login with MFA, keep its software updated, remove lost devices, and restrict tailnet access rules to intended devices/users. Do not invite untrusted users into a broadly permissive tailnet. Relay additionally requires its own device pairing.
- **HTTPS certificate names are public metadata.** Tailscale documents that issued certificate hostnames appear in public Certificate Transparency logs. Use a non-sensitive machine name before requesting HTTPS. Your Relay content does not become public merely because its certificate name is logged. [Official HTTPS guidance](https://tailscale.com/docs/how-to/set-up-https-certificates).
- **A paired browser has real authority.** Operators can send agent tasks and approval decisions in their assigned projects. Owners can also revoke other devices. Treat pairing codes as temporary passwords; don't put them in screenshots, chats or shared notes. Use viewer access where control isn't needed, and revoke stolen or unused devices.
- **This Node bridge runs as your Mac user.** Only run trusted repository code and dependencies. Do not use `sudo` for the bridge or pairing command. Existing agent permissions and approval behavior still matter; project scoping is not a replacement for an OS sandbox. Native output can contain source code or sensitive text even with best-effort redaction.
- **The root API remains local.** Its bearer token stays in the protected `.bridge` directory. Remote browsers receive an expiring HttpOnly cookie, not that token. No public tunnel, inbound router port, remote shell endpoint, Tailscale SSH, exit node, or subnet router was enabled by this work.
- **Limits remain explicit.** This is a tested personal system, not an independently audited security product. There is no promise of availability while asleep, complete descendant termination, or new native-agent verification. Operational data resides locally in SQLite; back up/protect the Mac accordingly.
