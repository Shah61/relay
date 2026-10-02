const $ = (id) => document.getElementById(id);
let busy = false;
let qrTimer;
let qrExpiresAt = 0;
function clearQr() {
  clearTimeout(qrTimer);
  qrExpiresAt = 0;
  $("qr").hidden = true;
  $("qr").removeAttribute("src");
}
async function refresh() {
  try {
    const state = await window.companion.status();
    $("computer-name").textContent = state.name;
    $("status").textContent = !state.configured
      ? "Service not configured"
      : state.pending
        ? "Authorize in your browser"
        : state.connected
          ? "This computer is connected"
          : state.enrolled
            ? "Reconnecting to your workspace…"
            : "This computer is not connected";
    $("description").textContent = !state.configured
      ? "This development build is waiting for release configuration from the product team. No server settings are needed from you."
      : state.pending
        ? "Check the computer name, then choose Authorize in the dashboard."
        : "Connect once. Pick up your work from any device.";
    $("connect").hidden = state.enrolled;
    $("connect").disabled = !state.configured || state.pending || busy;
    $("dashboard").hidden = !state.enrolled;
    $("dashboard").disabled = !state.configured || busy;
    $("phone-section").hidden = false;
    $("pair").disabled = busy || !state.configured || !state.enrolled || !state.connected || !state.projects.length;
    $("pair-status").textContent = !state.configured
      ? "Phone pairing will be available when the service is configured."
      : !state.enrolled
        ? "Connect this computer first, then create a phone QR."
        : !state.connected
          ? "Waiting for this computer to reconnect. QR pairing requires an online connection."
          : !state.projects.length
            ? "Add a project folder first, then create a phone QR."
            : "Ready. Create a one-time QR and scan it with your phone camera.";
    if (!state.configured || !state.enrolled) clearQr();
    else if (qrExpiresAt > Date.now()) {
      $("qr").hidden = !state.connected;
      $("qr-note").textContent = state.connected
        ? "Private, single-use code. Expires at " + new Date(qrExpiresAt).toLocaleTimeString() + "."
        : "Your QR is temporarily unavailable while the computer reconnects.";
    }
    $("autostart").checked = state.autoStart;
    $("autostart").disabled = !state.packaged;
    $("projects").replaceChildren(
      ...state.projects.map((name) => {
        const li = document.createElement("li");
        li.textContent = name;
        return li;
      }),
    );
    if (state.error) $("feedback").textContent = state.error;
  } catch (error) {
    $("feedback").textContent = error.message;
  }
}
function action(id, fn) {
  $(id).onclick = async () => {
    busy = true;
    $(id).disabled = true;
    $("feedback").textContent = "";
    try {
      await fn();
    } catch (e) {
      $("feedback").textContent = e.message;
    } finally {
      busy = false;
      $(id).disabled = false;
      await refresh();
    }
  };
}
action("connect", () => window.companion.connect());
action("dashboard", () => window.companion.dashboard());
action("add-project", () => window.companion.addProject());
action("pair", async () => {
  const pair = await window.companion.pairPhone();
  clearQr();
  qrExpiresAt = pair.expiresAt;
  $("qr").src = pair.qr;
  $("qr").hidden = false;
  $("qr-note").textContent =
    "Scan with your phone camera. Private, single-use, valid for 10 minutes.";
  qrTimer = setTimeout(
    () => {
      clearQr();
      $("qr-note").textContent = "This QR has expired. Choose Create phone QR for a fresh code.";
    },
    Math.max(0, pair.expiresAt - Date.now()),
  );
});
$("autostart").onchange = async () => {
  try {
    await window.companion.setAutoStart($("autostart").checked);
  } catch (e) {
    $("feedback").textContent = e.message;
  }
  await refresh();
};
setInterval(refresh, 3000);
void refresh();
