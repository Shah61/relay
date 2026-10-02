import {
  startRegistration,
  startAuthentication,
} from "./vendor/webauthn/index.js";
import { browserAccessKey, unwrapAccess } from "./access-crypto.mjs";
import {
  authorizedComputer,
  storedComputers,
  forgetComputers,
} from "./relay-client.mjs";
const $ = (id) => document.getElementById(id);
let me,
  enrollment = location.hash.startsWith("#authorize=")
    ? location.hash.slice(11)
    : null,
  busy = false;
if (location.hash.startsWith("#pair="))
  location.replace("/workspace.html" + location.hash);
else history.replaceState(null, "", "/");
async function api(path, body) {
  const response = await fetch("/account-api/" + path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(me?.csrf ? { "X-CSRF-Token": me.csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw Error(
      `Account service returned an unexpected response (HTTP ${response.status}). Please retry after the deployment finishes.`,
    );
  }
  if (!response.ok)
    throw Error((data.error ?? "Connection unavailable").replaceAll("_", " "));
  return data;
}
function message(text) {
  $("message").textContent = text;
}
async function authentication(mode) {
  if (busy) return;
  busy = true;
  try {
    message("Follow your device’s passkey prompt…");
    const options = await api("auth/options", {
      mode,
      name: $("account-name").value.trim(),
    });
    const response = await (mode === "register"
      ? startRegistration({ optionsJSON: options.options })
      : startAuthentication({ optionsJSON: options.options }));
    await api("auth/verify", { id: options.id, response });
    message("");
    await boot();
  } catch (e) {
    message(e.message);
  } finally {
    busy = false;
  }
}
$("auth-form").onsubmit = (event) => {
  event.preventDefault();
  void authentication("login");
};
$("register").onclick = () => {
  if ($("auth-form").reportValidity()) void authentication("register");
};
async function boot() {
  try {
    me = await api("me");
    $("signin").hidden = true;
    $("signout").hidden = false;
    if (enrollment) {
      const details = await api("enrollment/details", { id: enrollment });
      $("authorize").hidden = false;
      $("dashboard").hidden = true;
      $("computer-details").textContent =
        `${details.name} · ${details.platform === "darwin" ? "macOS" : "Windows"}`;
    } else {
      $("authorize").hidden = true;
      $("dashboard").hidden = false;
      $("greeting").textContent =
        `Welcome, ${me.name}. Choose a computer to continue.`;
      await computers();
    }
  } catch (e) {
    if (me) message(e.message);
    else {
      $("signin").hidden = false;
      $("dashboard").hidden = true;
    }
  }
}
$("approve").onclick = async () => {
  if (busy) return;
  busy = true;
  $("approve").disabled = true;
  try {
    await api("enrollment/approve", { id: enrollment });
    enrollment = null;
    message("Authorized. Your companion will connect automatically.");
    await boot();
  } catch (e) {
    message(e.message);
  } finally {
    busy = false;
    $("approve").disabled = false;
  }
};
$("decline").onclick = () => {
  enrollment = null;
  message("Request was not authorized.");
  void boot();
};
$("signout").onclick = async () => {
  try {
    await api("logout", {});
    await forgetComputers();
    localStorage.setItem("pm.signedOut", String(Date.now()));
    location.reload();
  } catch (e) {
    message(e.message);
  }
};
async function computers() {
  const data = await api("computers");
  const nodes = [];
  for (const computer of data.computers) {
    const card = document.createElement("article");
    card.className = "computer-card";
    const info = document.createElement("div"),
      title = document.createElement("h2"),
      status = document.createElement("p");
    title.textContent = computer.name;
    status.textContent = `${computer.online ? "● Online" : "○ Offline"} · ${computer.platform === "darwin" ? "macOS" : "Windows"}`;
    info.append(title, status);
    const actions = document.createElement("div");
    actions.className = "actions";
    const open = document.createElement("button");
    open.className = "primary";
    open.textContent = "Open workspace ↗";
    open.disabled = !computer.online;
    open.onclick = () => void control(computer);
    const revoke = document.createElement("button");
    revoke.textContent = "Disconnect";
    revoke.onclick = async () => {
      if (
        !confirm(
          `Disconnect ${computer.name}? It must be authorized again before reconnecting.`,
        )
      )
        return;
      try {
        await api("computers/revoke", { id: computer.id });
        await computers();
      } catch (e) {
        message(e.message);
      }
    };
    actions.append(open, revoke);
    card.append(info, actions);
    nodes.push(card);
  }
  if (!nodes.length) {
    const empty = document.createElement("p");
    empty.textContent =
      "No computers connected yet. Start with the companion on your Mac or PC.";
    nodes.push(empty);
  }
  $("computers").replaceChildren(...nodes);
}
async function waitForAccess(id, state) {
  for (let i = 0; i < 50; i++) {
    const result = await api("access/status", { id });
    if (result.state === state) return result;
    if (result.state === "failed")
      throw Error(
        "Computer could not authorize this browser. Check that a project is selected in the companion.",
      );
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw Error(
    "Computer did not respond. Check that it is awake and connected.",
  );
}
async function control(computer) {
  if (busy) return;
  busy = true;
  try {
    const existing = (await storedComputers()).find(
      (p) => p.hostId === computer.id,
    );
    if (!existing) {
      message("Authorizing an encrypted connection to this computer…");
      const key = await browserAccessKey();
      const request = await api("access/start", {
        hostId: computer.id,
        publicKey: key.publicKey,
      });
      const challenge = await waitForAccess(request.id, "challenge");
      const response = await startAuthentication({
        optionsJSON: challenge.options,
      });
      await api("access/finish", { id: request.id, response });
      const result = await waitForAccess(request.id, "ready");
      const payload = await unwrapAccess(
        key.privateKey,
        `${computer.id}:${request.id}`,
        result.encrypted,
      );
      if (payload.hostId !== computer.id)
        throw Error("Computer identity mismatch");
      await authorizedComputer(payload);
    }
    localStorage.setItem("relay.activeComputer", computer.id);
    location.assign("/workspace.html");
  } catch (e) {
    message(e.message);
  } finally {
    busy = false;
  }
}
setInterval(() => {
  if (me && !enrollment && !busy)
    void computers().catch(() => message("Reconnecting to your account…"));
}, 5000);
void boot();
