import { Client, ApiError, readEvents } from "./client.mjs";
import { browserTransport } from "./relay-client.mjs";
import { renderMarkdown } from "./markdown.mjs";
import { Replies, isTruncated } from "./replies.mjs";
const replies = new Replies();
const replyCards = new Map();
let replyRenderPending = false;
window.addEventListener("hashchange", () => {
  if (location.hash.startsWith("#pair=") || location.hash.startsWith("#local="))
    location.reload();
});
window.addEventListener('storage', event => { if(event.key === 'pm.signedOut') location.replace('/'); });
const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
let connection;
try {
  connection = await browserTransport();
} catch (e) {
  document.querySelector("#pair-error").textContent = e.message;
  throw e;
}
const client = new Client({ fetcher: connection.transport.fetch });
if (connection.remote) {
  $("#local-launch").hidden = true;
  $("#manual-pair-toggle").hidden = true;
  $("#welcome-chip").textContent = connection.invitation
    ? "QR PAIRING"
    : "YOUR PHONE WORKSPACE";
  $("#welcome-title").textContent = connection.invitation
    ? "You’re one step away."
    : connection.name
      ? "Welcome back."
      : "Scan. Connect. Continue.";
  $("#welcome-description").textContent = connection.invitation
    ? `Connect this browser to ${connection.name}. Just give it a name—you don’t need to enter a code.`
    : connection.name
      ? `Reconnecting to ${connection.name}…`
      : "On your computer, open Relay and choose Connect phone. Scan its QR code with your phone camera to open your workspace here.";
  $("#pair-form").hidden = !connection.invitation;
  $("#pair-code").required = false;
  $("#pair-code").hidden = true;
  $('label[for="pair-code"]').hidden = true;
  $(".local-help").hidden = true;
  $("#pair-error").textContent = connection.invitation
    ? `Connect to ${connection.name}. Give this browser a name below.`
    : connection.name
      ? `Connecting to ${connection.name}…`
      : "Scan a QR code from Connect phone on your computer.";
  $('#pair-form button[type="submit"]').disabled = !connection.invitation;
}
$("#manual-pair-toggle").addEventListener("click", () => {
  const open = $("#pair-form").hidden;
  $("#pair-form").hidden = !open;
  $(".local-help").hidden = !open;
  $("#manual-pair-toggle").setAttribute("aria-expanded", String(open));
});
$("#copy-launch").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText("npm start");
    $("#launch-feedback").textContent =
      "Copied. Paste into a terminal opened in the Relay folder.";
  } catch {
    $("#launch-feedback").textContent =
      "Run npm start in a terminal opened in the Relay folder.";
  }
});
if (connection.computers?.length > 1) {
  const picker = document.createElement("select");
  picker.setAttribute("aria-label", "Computer");
  for (const computer of connection.computers) {
    const option = document.createElement("option");
    option.value = computer.hostId;
    option.textContent = computer.hostName;
    option.selected = computer.hostId === connection.transport.profile.hostId;
    picker.append(option);
  }
  picker.onchange = () => {
    localStorage.setItem("relay.activeComputer", picker.value);
    location.reload();
  };
  $("#logout").before(picker);
}
let projects = [],
  agents = [],
  sessions = [],
  selected = null,
  snapshot = null,
  controller = null,
  cursor = 0,
  page = "sessions",
  busy = false,
  polling = false,
  refreshTimer = null,
  eventsTimer = null,
  epoch = 0,
  allApprovals = [];
const drafts = new Map();
let previewRows = [];
const el = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
const pretty = (x) => JSON.stringify(x, null, 2),
  name = (a) => (a === "claude" ? "Claude Code" : "Codex"),
  human = (x) => String(x ?? "unknown").replaceAll("_", " "),
  canWrite = () => client.device?.role !== "viewer";
function notice(message, error = false) {
  const n = $("#global-message");
  n.textContent = message;
  n.hidden = !message;
  n.classList.toggle("amber", error);
}
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  setTimeout(() => ($("#toast").hidden = true), 5000);
}
function failure(e) {
  if (e.status === 401) {
    signedOut();
    $("#pair-error").textContent =
      "This device session expired or was revoked. Pair again on the computer.";
  } else notice(e.message ?? String(e), true);
}
function confirmAction(title, text) {
  const d = $("#confirm-dialog");
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  d.returnValue = "cancel";
  d.showModal();
  return new Promise((resolve) =>
    d.addEventListener("close", () => resolve(d.returnValue === "confirm"), {
      once: true,
    }),
  );
}
function signedOut() {
  epoch++;
  controller?.abort();
  clearInterval(refreshTimer);
  clearTimeout(eventsTimer);
  client.device = null;
  client.csrf = "";
  $("#workspace").hidden = true;
  $("#login").hidden = false;
  selected = null;
  snapshot = null;
  resetReplies("Loading retained replies…");
}
async function boot() {
  try {
    const me = await client.connect();
    $("#login").hidden = true;
    $("#workspace").hidden = false;
    $("#device-label").textContent = `${me.device.name} · ${me.device.role}`;
    $("#transport-label").textContent =
      me.transport === "encrypted_relay"
        ? `Encrypted · ${connection.name}`
        : me.transport === "private_https"
          ? "Private HTTPS"
          : "Local connection";
    $("#host-setup").hidden = connection.remote || me.device.role !== "owner";
    $('[data-page="diagnostics"]').hidden = me.device.role !== "owner";
    $("#new-session").disabled = !canWrite();
    await refresh(true);
    await pending();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => refresh(false).catch(failure), 15000);
  } catch (e) {
    if (e.status !== 401) failure(e);
  }
}
$("#pair-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const b = e.submitter;
  b.disabled = true;
  $("#pair-error").textContent = "";
  try {
    await client.get("/auth/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: $("#pair-code").value.trim(),
        name: $("#device-name").value.trim(),
      }),
    });
    $("#pair-code").value = "";
    await boot();
  } catch (err) {
    $("#pair-error").textContent = err.message;
  } finally {
    b.disabled = false;
  }
});
async function loadSessions() {
  let offset = 0,
    result = [];
  do {
    const data = await client.get(`/api/sessions?offset=${offset}`);
    result.push(...data.sessions);
    offset = data.nextOffset;
  } while (offset !== null && result.length < 10000);
  sessions = result.reverse();
}
async function refresh(discovery = false) {
  if (polling || !client.device) return;
  polling = true;
  try {
    if (discovery || !projects.length) {
      const [p, a] = await Promise.all([
        client.get("/api/projects"),
        client.get("/api/agents"),
      ]);
      projects = p.projects;
      agents = a;
      renderAgents();
      $("#remote-status").replaceChildren(
        el(
          "p",
          connection.remote
            ? `Connected to ${connection.name} through your encrypted relay.`
            : "Connect this computer in Prompt Manager Companion. Then sign in on your phone or scan a QR code.",
          "notice",
        ),
      );
    }
    await loadSessions();
    if (selected && !sessions.some(s => s.id === selected)) {
      epoch++; controller?.abort(); clearTimeout(eventsTimer);
      selected = null; snapshot = null;
      $("#session-detail").hidden = true; $("#empty-session").hidden = false;
    }
    renderSessions();
    allApprovals = (await client.get("/api/approvals")).approvals;
    renderAllApprovals();
    $("#host-status").textContent = "Bridge connected";
    $("#connection-state").textContent = "● Connected";
    if (selected) await updateSnapshot(selected);
    await loadPreviews();
    if (page === "devices") await renderDevices();
    if (page === "diagnostics") await renderDiagnostics();
  } catch (e) {
    $("#host-status").textContent = "Connection unavailable";
    $("#connection-state").textContent = "○ Reconnecting";
    throw e;
  } finally {
    polling = false;
  }
}
function renderAgents() {
  const root = $("#agent-strip");
  root.replaceChildren();
  for (const a of agents) {
    const card = el("div", undefined, "agent-card"),
      info = el("div");
    info.append(
      el("strong", name(a.agent)),
      el(
        "p",
        a.availability.ready
          ? "Available on your computer"
          : human(a.availability.state),
      ),
    );
    card.append(
      el("span", a.agent === "claude" ? "✳" : "⌘", "agent-icon"),
      info,
      el(
        "span",
        a.agent === "claude" ? "Runtime unverified" : "Prior runtime evidence",
        `badge ${a.agent === "claude" ? "warn" : ""}`,
      ),
    );
    card.title =
      a.availability.reason ??
      "Capability evidence is available in session details.";
    root.append(card);
  }
}
function renderSessions() {
  const root = $("#session-list");
  root.replaceChildren();
  $("#session-count").textContent = sessions.length;
  $("#session-total").textContent = `${sessions.length} total`;
  if (!sessions.length)
    root.append(
      el("p", "No sessions yet. Start one in an approved project.", "notice"),
    );
  for (const s of sessions) {
    const b = el(
      "button",
      undefined,
      `session-row ${s.id === selected ? "active" : ""}`,
    );
    b.append(
      el("strong", s.project),
      el("small", `${name(s.agent)} · ${s.id.slice(0, 8)}`),
      el("small", `Process: ${human(s.process.state)}`),
      el(
        "span",
        s.controlClosed ? "Closed" : s.reconciliationRequired
          ? "Needs reconciliation"
          : human(s.currentTurn.state),
        `badge ${s.reconciliationRequired ? "warn" : ""}`,
      ),
    );
    b.addEventListener("click", () => selectSession(s.id).catch(failure));
    root.append(b);
  }
}
async function updateSnapshot(id) {
  const data = await client.get(`/api/sessions/${id}`);
  if (id !== selected) return;
  snapshot = data;
  if ((data.historyStartCursor ?? 0) > cursor) {
    cursor = data.historyStartCursor;
    resetReplies("Chat cleared. New replies will appear here.");
    $("#activity").replaceChildren();
  }
  renderDetail();
  return data;
}
async function selectSession(id) {
  if (selected) drafts.set(selected, $("#prompt").value);
  epoch++;
  controller?.abort();
  clearTimeout(eventsTimer);
  selected = id;
  $("#prompt").value = drafts.get(id) ?? "";
  updatePreview();
  cursor = 0;
  snapshot = null;
  resetReplies("No replies yet. Codex’s messages will appear here as it works.");
  $("#activity").replaceChildren(
    el("p", "Loading retained activity…", "muted"),
  );
  $("#empty-session").hidden = true;
  $("#session-detail").hidden = false;
  renderSessions();
  await updateSnapshot(id);
  cursor = snapshot?.historyStartCursor ?? 0;
  $("#activity").replaceChildren();
  stream(id, epoch).catch(failure);
  renderPreviews();
}
function renderDetail() {
  if (!snapshot) return;
  const s = snapshot.session;
  $("#replies-title").textContent = `${name(s.agent)} replies`;
  $("#detail-agent").textContent = `${name(s.agent)} / ${s.id.slice(0, 8)}`;
  $("#detail-project").textContent = s.project;
  $("#turn-badge").textContent = s.controlClosed ? "Closed" : human(s.currentTurn.state);
  $("#state-facts").replaceChildren(
    ...[
      `Session: ${s.lifecycle}`,
      `Parent: ${s.process.state}`,
      `Queue: ${snapshot.queue.state === "unknown" ? "unknown" : snapshot.queue.count}`,
      `Workspace: ${s.isolatedWorkspace ? "separate worktree" : s.leaseHeld ? "reserved" : "not reserved"}`,
    ].map((t) => el("span", t)),
  );
  const notes = [
    ...(snapshot.reconciliationRequired && !s.controlClosed
      ? [
          "Local reconciliation required. The bridge cannot prove this session is safe to control.",
        ]
      : []),
    ...(!s.controlClosed ? (snapshot.uncertainty ?? []) : []),
    ...(s.agent === "claude"
      ? ["Claude is implemented but runtime unverified."]
      : []),
    ...(s.controlClosed
      ? [
          `Session closed. Start a new session to continue working.${s.process.state !== "exited" ? " The agent could not be confirmed stopped; inspect it on your computer." : ""}`,
        ]
      : []),
  ];
  $("#session-notice").hidden = !notes.length;
  $("#session-notice").textContent = notes.join(" ");
  $("#inspector").replaceChildren(el("pre", pretty(snapshot)));
  const availability = {
    interrupt: s.capabilities.turnInterrupt.available,
    stop: snapshot.actions.stopAgent,
    close: snapshot.actions.closeSession,
    end: snapshot.actions.endSession,
    delete: snapshot.actions.deleteSession,
    clear: snapshot.actions.clearHistory,
    resume: s.capabilities.historyResume.available,
  };
  for (const b of $$("[data-control]"))
    b.disabled = busy || !canWrite() || !availability[b.dataset.control];
  const features = {
    prompt: "followup",
    queue: "queuedInput",
    steer: "activeSteering",
  };
  for (const o of $("#input-mode").options)
    o.disabled = !s.capabilities[features[o.value]].available || !canWrite();
  const allowed =
    s.capabilities[features[$("#input-mode").value]].available &&
    canWrite() &&
    !busy;
  $("#send-prompt").disabled = !allowed;
  $("#prompt").disabled = !canWrite();
  $("#composer-hint").textContent = !canWrite()
    ? "Read-only device"
    : allowed
      ? "Runs on your computer"
      : s.controlClosed ? "Session closed. Your draft is kept; start a new session."
        : s.reconciliationRequired ? "Session needs recovery. Keep drafting or start a separate session."
        : "Keep drafting. Send becomes available when the agent is ready.";
  renderApprovals($("#approval-inline"), snapshot.approvals);
}
function resetReplies(message, gap = false) {
  replies.clear();
  replyCards.clear();
  $("#replies").replaceChildren(el("p", message, gap ? "notice amber" : "muted"));
  $("#replies-gap").hidden = !gap;
}
function scheduleReplies() {
  if (replyRenderPending) return;
  replyRenderPending = true;
  requestAnimationFrame(() => {
    replyRenderPending = false;
    const root = $("#replies");
    const nearBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 70;
    for (const [key, card] of replyCards) {
      if (!replies.rows.has(key)) { card.entry.remove(); replyCards.delete(key); }
    }
    for (const row of replies.rows.values()) {
      if (!row.text) continue;
      let card = replyCards.get(row.key);
      if (!card) {
        if (!replyCards.size) root.replaceChildren();
        const entry = el("article", undefined, "reply-card"), header = el("header"),
          label = el("strong"), status = el("span", undefined, "muted"),
          copy = el("button", "Copy Markdown"), body = el("div"),
          warning = el("p", "This reply is truncated; additional content existed.", "error");
        copy.type = "button";
        copy.onclick = async () => {
          try { await navigator.clipboard.writeText(row.text); toast("Reply copied"); }
          catch { toast("Could not copy. Select the reply text to copy it."); }
        };
        header.append(label, status, copy);
        entry.append(header, body, warning);
        root.append(entry);
        card = { entry, label, status, body, warning };
        replyCards.set(row.key, card);
      }
      card.label.textContent = row.phase === "commentary" ? "Progress update" : "Reply";
      card.status.textContent = row.status;
      card.warning.hidden = !row.truncated;
      if (card.text !== row.text) { renderMarkdown(card.body, row.text); card.text = row.text; }
    }
    if (nearBottom) root.scrollTop = root.scrollHeight;
  });
}
function renderApprovals(root, rows) {
  const signature = pretty([rows, busy, client.device?.role]);
  if (root.dataset.signature === signature) return;
  root.dataset.signature = signature;
  root.replaceChildren();
  for (const a of rows) {
    const card = el("article", undefined, "approval-card");
    card.append(
      el(
        "h3",
        a.kind === "question"
          ? "Your agent has a question"
          : "Your approval is needed",
      ),
      el(
        "p",
        `Session ${a.sessionId.slice(0, 8)} · generation ${a.generation.slice(0, 8)}`,
      ),
      el("pre", pretty(a.raw)),
    );
    const truncated = isTruncated(a.raw);
    if (truncated)
      card.append(
        el(
          "p",
          "Request details are truncated. Accept/answer is disabled; inspect the request locally or decline it.",
          "error",
        ),
      );
    const questions = a.raw?.input?.questions;
    const inputs = [];
    if (a.kind === "question" && !truncated && Array.isArray(questions)) {
      for (const q of questions) {
        if (typeof q.question !== "string") continue;
        const label = el("label", q.question),
          input = el("textarea");
        input.rows = 2;
        input.maxLength = 8000;
        input.setAttribute("aria-label", q.question);
        if (Array.isArray(q.options))
          label.append(
            el(
              "p",
              q.options
                .map((x) => `${x.label}: ${x.description ?? ""}`)
                .join(" / "),
            ),
          );
        card.append(label, input);
        inputs.push([q.question, input]);
      }
    }
    for (const decision of a.decisions) {
      const b = el("button", human(decision));
      const positive = !["decline", "cancel", "deny"].includes(decision);
      b.disabled =
        busy ||
        !canWrite() ||
        a.status === "delivery_uncertain" ||
        a.status === "responding" ||
        (positive && truncated) ||
        (decision === "answer" && !inputs.length);
      b.onclick = async () => {
        try {
          if (
            positive &&
            !(await confirmAction(
              "Send this decision?",
              `Send “${decision}” to this exact request and process generation?`,
            ))
          )
            return;
          const answers =
            decision === "answer"
              ? Object.fromEntries(inputs.map(([q, n]) => [q, n.value]))
              : undefined;
          if (answers && Object.values(answers).some((v) => !v.trim()))
            throw Error("Answer every question before submitting.");
          await mutate(`/api/sessions/${a.sessionId}/approvals`, {
            approvalId: a.id,
            generation: a.generation,
            decision,
            ...(answers ? { answers } : {}),
          });
        } catch (e) {
          failure(e);
        }
      };
      card.append(b);
    }
    root.append(card);
  }
}
function renderAllApprovals() {
  $("#approval-count").textContent = allApprovals.length;
  renderApprovals($("#all-approvals"), allApprovals);
  if (!allApprovals.length && !$("#all-approvals").children.length)
    $("#all-approvals").append(
      el(
        "div",
        "All clear. No pending approvals in your assigned projects.",
        "notice",
      ),
    );
}
function eventText(e) {
  const r = e.raw,
    p = r?.params ?? r;
  const values = [
    p?.item?.text,
    p?.delta,
    r?.event?.delta?.text,
    p?.output,
    p?.text,
    p?.message,
    p?.diff,
  ];
  const v = values.find((x) => typeof x === "string");
  if (v) return v;
  const content = r?.message?.content;
  if (Array.isArray(content))
    return content
      .filter((x) => x.type === "text")
      .map((x) => x.text)
      .join("\n");
  return "";
}
function renderEvent(e) {
  if (replies.ingest(e)) scheduleReplies();
  const root = $("#activity"),
    entry = el("article", undefined, "event"),
    head = el("header");
  head.append(
    el("strong", human(e.type).replaceAll(".", " / ")),
    el("span", `#${e.sequence} · ${e.source}`),
  );
  entry.append(head);
  const text = eventText(e);
  if (text) {
    const body = el("div");
    renderMarkdown(body, text);
    entry.append(body);
  }
  if (isTruncated(e))
    entry.append(
      el("p", "Truncated evidence — additional content existed.", "error"),
    );
  const details = el("details");
  details.append(el("summary", "Native evidence"), el("pre", pretty(e.raw)));
  entry.append(details);
  const nearBottom =
    root.scrollHeight - root.scrollTop - root.clientHeight < 70;
  root.append(entry);
  while (root.children.length > 200) root.firstElementChild.remove();
  if (nearBottom) root.scrollTop = root.scrollHeight;
}
async function stream(id, generation) {
  let delay = 1000;
  while (selected === id && epoch === generation && client.device) {
    controller = new AbortController();
    const signal = controller.signal;
    let needsResync = false;
    try {
      $("#stream-label").textContent = cursor
        ? "Reconnecting from saved cursor…"
        : "Reading retained activity…";
      const response = await client.fetcher(
        `/api/sessions/${id}/events?after=${cursor}`,
        { credentials: "same-origin", signal },
      );
      if (response.status === 409) {
        const data = await response.json();
        if (data.error !== "resync_required")
          throw new ApiError(response.status, data);
        await resync(id);
        continue;
      }
      if (!response.ok)
        throw new ApiError(response.status, await response.json());
      $("#stream-label").textContent = "Live · latest 200 events";
      delay = 1000;
      await readEvents(
        response,
        async (frame) => {
          if (frame.type === "resync_required") {
            needsResync = true;
            controller.abort();
            return;
          }
          if (frame.id !== null && frame.id <= cursor) return;
          if (frame.id !== null) cursor = Math.max(cursor, frame.id);
          if (frame.type === "cursor") return;
          renderEvent(frame.data);
          clearTimeout(eventsTimer);
          eventsTimer = setTimeout(
            () => updateSnapshot(id).catch(failure),
            700,
          );
        },
        signal,
      );
      if (needsResync) {
        await resync(id);
        continue;
      }
    } catch (e) {
      if (epoch !== generation || selected !== id || !client.device) return;
      if (e.status === 401) {
        failure(e);
        return;
      }
      if (needsResync) {
        await resync(id);
        continue;
      }
      if (e.name === "AbortError") return;
      $("#stream-label").textContent =
        "Disconnected · reconnecting; no commands resent";
    }
    if (epoch !== generation) return;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 15000);
  }
}
async function resync(id) {
  const data = await updateSnapshot(id);
  if (!data) return;
  cursor = data.retainedEventCursor ?? data.latestEventSequence;
  resetReplies("Reading the replies still retained for this session…", true);
  $("#activity").replaceChildren(
    el(
      "p",
      "Retained history has a gap. Loaded a current snapshot; earlier activity is not shown.",
      "notice amber",
    ),
  );
}
async function pending() {
  if (!client.device) return;
  const rows = await client.reconcile();
  const root = $("#pending-operations");
  root.replaceChildren();
  root.hidden = !rows.length;
  if (rows.length) {
    root.append(el("strong", "Operation recovery"));
    for (const r of rows) {
      const state = r.operation?.state ?? r.state;
      root.append(el("p", `${r.id} · ${state}`));
    }
    root.append(
      el(
        "p",
        "No command has been resent. A missing or uncertain operation needs inspection before you send the same work again.",
      ),
    );
    const b = el("button", "Check operation status");
    b.onclick = () => pending().catch(failure);
    root.append(b);
  }
}
async function mutate(path, payload = {}) {
  if (busy) throw Error("Wait for the current request to return.");
  busy = true;
  renderDetail();
  $("#start-submit").disabled = true;
  try {
    const result = await client.mutate(path, payload);
    if (result.operation?.state === "failed")
      throw Error(
        result.operation.error ?? "Operation failed; inspect the session.",
      );
    if (result.operation?.state === "delivery_uncertain")
      notice(
        "Delivery is uncertain. Do not resend this action. Check its operation status.",
        true,
      );
    else
      toast(
        result.operation
          ? "Request recorded. Native turn state is shown separately."
          : "Saved",
      );
    return result;
  } finally {
    busy = false;
    await refresh(false).catch(failure);
    await pending().catch(failure);
    renderDetail();
    startHint();
  }
}
$("#prompt-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const text = $("#prompt").value;
    const id = selected;
    if (!text.trim()) return;
    const result = await mutate(
      `/api/sessions/${id}/${$("#input-mode").value}`,
      { text },
    );
    if (result.operation?.state === "completed") { drafts.delete(id); if (selected === id) { $("#prompt").value = ""; updatePreview(); } }
  } catch (err) {
    failure(err);
  }
};
$("#clear-draft").onclick = () => { $("#prompt").value = ""; drafts.delete(selected); updatePreview(); };
function updatePreview() {
  if (!$("#prompt-preview").hidden)
    renderMarkdown($("#prompt-preview"), $("#prompt").value || "Nothing to preview yet.");
}
$("#preview-prompt").onclick = () => {
  const preview = $("#prompt-preview").hidden;
  $("#prompt-preview").hidden = !preview;
  $("#prompt").hidden = preview;
  $("#preview-prompt").textContent = preview ? "Edit Markdown" : "Preview Markdown";
  $("#preview-prompt").setAttribute("aria-pressed", String(preview));
  updatePreview();
  if (!preview) $("#prompt").focus();
};
$("#prompt").addEventListener("input", () => { if (selected) drafts.set(selected, $("#prompt").value); updatePreview(); });
const controlText = {
  interrupt: [
    "Interrupt this turn?",
    "Requests a native turn interrupt. It does not prove that shell children have stopped.",
  ],
  stop: [
    "Stop this agent?",
    "Stops the bridge-owned parent. The worktree remains reserved; descendant state may remain unknown.",
  ],
  close: [
    "Close session control?",
    "Closes active control of this session. This does not stop the agent parent or release its worktree.",
  ],
  end: ["Close this session?", "Stops the owned agent and closes this session. Its history stays available. Any uncertain processes keep their workspace reservation."],
  clear: ["Clear this chat?", "Hides earlier messages and activity in this session. Your agent keeps its conversation context."],
  delete: ["Delete this session?", "Closes the session, stops the owned agent, and removes it from your session list. Project files and native history are kept."],
  resume: [
    "Resume native history?",
    "Starts a new process from native history. This does not reconnect to an existing process. Claude runtime remains unverified.",
  ],
};
for (const b of $$("[data-control]"))
  b.onclick = async () => {
    try {
      if (await confirmAction(...controlText[b.dataset.control])) {
        const id = selected;
        await mutate(`/api/sessions/${id}/${b.dataset.control}`);
        if (b.dataset.control === "clear" && selected === id) await selectSession(id);
      }
    } catch (e) {
      failure(e);
    }
  };
$("#toggle-inspector").onclick = () =>
  ($("#inspector").hidden = !$("#inspector").hidden);
$("#input-mode").onchange = renderDetail;
function startHint() {
  const isCodex = $("#start-agent").value === "codex";
  $("#codex-settings").hidden = !isCodex;
  const a = agents.find((a) => a.agent === $("#start-agent").value);
  $("#start-hint").textContent = a
    ? `${a.availability.ready ? "Available" : human(a.availability.state)}. ${a.agent === "claude" ? "Runtime unverified. " : ""}${a.availability.reason ?? "Use separate workspaces for multiple sessions in one project."}`
    : "Agent availability unknown";
  $("#start-submit").disabled =
    busy || !canWrite() || !a?.availability.ready || !projects.length || (isCodex && !$("#start-model").value);
  if (isCodex && a?.availability.modelError)
    $("#start-hint").textContent = `Could not load Codex models: ${a.availability.modelError}`;
}
function modelChoices() {
  const models = agents.find(a => a.agent === "codex")?.availability.models ?? [];
  $("#start-model").replaceChildren(...models.map(m => {
    const option = el("option", `${m.displayName}${m.isDefault ? " (default)" : ""}`);
    option.value = m.model;
    return option;
  }));
  const defaultModel = models.find(m => m.isDefault);
  if (defaultModel) $("#start-model").value = defaultModel.model;
  effortChoices();
}
function effortChoices() {
  const models = agents.find(a => a.agent === "codex")?.availability.models ?? [];
  const model = models.find(m => m.model === $("#start-model").value);
  $("#start-effort").replaceChildren(...(model?.supportedReasoningEfforts ?? []).map(e => {
    const option = el("option", `${human(e.reasoningEffort)}${e.description ? " — " + e.description : ""}`);
    option.value = e.reasoningEffort;
    return option;
  }));
  if (model) $("#start-effort").value = model.defaultReasoningEffort;
  startHint();
}
$("#start-model").onchange = effortChoices;
$("#new-session").onclick = () => {
  modelChoices();
  $("#start-project").replaceChildren(
    ...projects.map((p) => {
      const o = el("option", p.id);
      o.value = p.id;
      return o;
    }),
  );
  startHint();
  $("#new-dialog").showModal();
};
$("#start-agent").onchange = startHint;
$("#new-project-session").onclick = () => { $("#new-session").click(); if (snapshot) $("#start-project").value = snapshot.session.project; };
$("#start-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const result = await mutate("/api/sessions", {
      project: $("#start-project").value,
      agent: $("#start-agent").value,
      isolated: $("#start-isolated").checked,
      ...($("#start-agent").value === "codex" ? {
        model: $("#start-model").value,
        reasoningEffort: $("#start-effort").value,
      } : {}),
    });
    if (result.operation?.state === "completed") {
      $("#new-dialog").close();
      const op = result.operation;
      const id = op.session_id ?? op.result?.id;
      if (id) await selectSession(id);
    }
  } catch (err) {
    failure(err);
  }
};
async function loadPreviews() {
  try { const data = await client.get("/api/previews"); previewRows = data.previews; renderPreviews(); }
  catch (e) { if (e.status !== 404) throw e; }
}
function renderPreviews() {
  const root = $("#preview-list"); root.replaceChildren();
  const rows = previewRows.filter(r => r.sessionId === selected);
  if (!rows.length) root.append(el("p", "Development servers will appear here when your agent reports them.", "muted"));
  for (const r of rows) {
    const card = el("article", undefined, "preview-card"), info = el("div"), actions = el("div", undefined, "preview-actions");
    info.append(el("strong", r.state === "candidate" ? "Development server detected" : r.state === "running" ? "● Running" : "○ Connecting preview"), el("p", r.label));
    if (r.state === "candidate") {
      const approve = el("button", "Enable Preview"); approve.disabled = busy || !canWrite();
      approve.onclick = async () => {
        try {
          if (await confirmAction("Enable this preview?", `Allow your signed-in account to open ${r.label} from this session remotely?`)) {
            await client.get(`/api/previews/${r.id}/approve`, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": client.csrf }, body: "{}" });
            await loadPreviews();
          }
        } catch (e) { failure(e); }
      };
      actions.append(approve);
    } else {
      const open = el("a", "Open Preview", "preview-open");
      if (r.state === "running" && r.previewId) { open.href = `/p/${r.previewId}`; open.target = "_blank"; open.rel = "noopener noreferrer"; }
      else { open.setAttribute("aria-disabled", "true"); info.append(el("small", "Waiting for preview hosting. Refresh in a moment.")); }
      actions.append(open);
    }
    const disable = el("button", "Disable Preview"); disable.disabled = busy || !canWrite();
    disable.onclick = async () => {
      try { await client.get(`/api/previews/${r.id}/disable`, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": client.csrf }, body: "{}" }); await loadPreviews(); }
      catch (e) { failure(e); }
    };
    actions.append(disable); card.append(info, actions); root.append(card);
  }
}
$("#refresh-previews").onclick = () => loadPreviews().catch(failure);
for (const b of $$("[data-dismiss]"))
  b.onclick = () => b.closest("dialog").close();
async function renderDevices() {
  const { devices } = await client.get("/api/devices"),
    root = $("#devices-list");
  root.replaceChildren();
  for (const d of devices) {
    const card = el("article", undefined, "card");
    card.append(
      el("h2", d.name),
      el("p", `${d.role} · ${d.projects.join(", ")}`),
      el(
        "p",
        d.revokedAt
          ? "Revoked"
          : `Expires ${new Date(d.expiresAt).toLocaleDateString()}`,
      ),
    );
    const b = el(
      "button",
      d.id === client.device.id ? "Sign out this device" : "Revoke device",
    );
    b.disabled = !!d.revokedAt;
    b.onclick = async () => {
      try {
        if (
          !(await confirmAction(
            "Revoke device?",
            `${d.name} will lose access immediately and must pair again.`,
          ))
        )
          return;
        await client.mutate(`/api/devices/${d.id}/revoke`);
        if (d.id === client.device.id) signedOut();
        else await renderDevices();
      } catch (e) {
        failure(e);
      }
    };
    card.append(b);
    root.append(card);
  }
}
async function renderDiagnostics() {
  const d = await client.get("/api/diagnostics");
  $("#diagnostics-content").replaceChildren(
    el(
      "div",
      "Local reconciliation and worktree release must be performed on the computer. This dashboard does not expose force-release.",
      "notice",
    ),
    el("pre", pretty(d)),
  );
}
const pages = {
  sessions: [
    "Your workspace, in motion.",
    "A live view of your agents. You stay in control.",
  ],
  approvals: [
    "The next move is yours.",
    "Review the native request before making a decision.",
  ],
  devices: [
    "A small circle of trust.",
    "Manage browsers with access to this workspace.",
  ],
  remote: [
    "Your computer, within reach.",
    "A private connection for the work you already started.",
  ],
  diagnostics: [
    "What the bridge knows.",
    "Durable state, reservations, and explicit uncertainty.",
  ],
};
for (const b of $$("[data-page]"))
  b.onclick = async () => {
    page = b.dataset.page;
    for (const k of Object.keys(pages)) $(`#${k}-page`).hidden = k !== page;
    for (const n of $$("[data-page]")) n.classList.toggle("active", n === b);
    $("#page-name").textContent = b.textContent
      .replace(/[0-9▤◇▣↗≋]/g, "")
      .trim();
    $("#page-title").textContent = pages[page][0];
    $("#page-subtitle").textContent = pages[page][1];
    $("#new-session").hidden = page !== "sessions";
    $("#workspace").classList.remove("menu-open");
    menuState();
    try {
      if (page === "devices") await renderDevices();
      if (page === "diagnostics") await renderDiagnostics();
      if (page === "approvals") await refresh(false);
    } catch (e) {
      failure(e);
    }
  };
const mobile = matchMedia("(max-width:780px)");
function menuState() {
  const open = $("#workspace").classList.contains("menu-open");
  $(".sidebar").inert = mobile.matches && !open;
  $("#menu-toggle").setAttribute("aria-expanded", String(open));
}
$("#menu-toggle").onclick = () => {
  $("#workspace").classList.toggle("menu-open");
  menuState();
};
mobile.addEventListener("change", menuState);
menuState();
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    $("#workspace").classList.remove("menu-open");
    menuState();
  }
});
$("#refresh").onclick = () => refresh(true).then(pending).catch(failure);
$("#logout").onclick = async () => {
  try {
    await client.get("/auth/logout", {
      method: "POST",
      headers: { "X-CSRF-Token": client.csrf },
    });
    signedOut();
  } catch (e) {
    failure(e);
  }
};
window.addEventListener("online", () => {
  if (client.device) refresh(false).then(pending).catch(failure);
});
async function hostStatus() {
  if (connection.remote || client.device?.role !== "owner") return;
  try {
    const status = await client.get("/api/host/status");
    $("#host-state").textContent =
      `Relay: ${human(status.state)}${status.hostName ? " · " + status.hostName : ""}`;
    $("#create-qr").disabled = status.state !== "connected";
  } catch (e) {
    $("#host-state").textContent = e.message;
  }
}
let invitationId, invitationTimer;
$("#create-qr").addEventListener("click", async () => {
  $("#create-qr").disabled = true;
  try {
    if (invitationId) await cancelInvitation();
    const invitation = await client.get("/api/host/pairings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": client.csrf,
      },
      body: JSON.stringify({
        role: $("#phone-role").value,
        projects: projects.map((p) => p.id),
      }),
    });
    invitationId = invitation.id;
    $("#phone-qr").src = invitation.qr;
    $("#phone-qr-wrap").hidden = false;
    $("#phone-pair-link").href = invitation.url;
    $("#qr-expiry").textContent =
      "Scan with your phone camera. Single use; expires in 10 minutes. Keep this code private.";
    invitationTimer = setTimeout(
      () => {
        $("#phone-qr-wrap").hidden = true;
        invitationId = null;
      },
      Math.max(0, invitation.expiresAt - Date.now()),
    );
  } catch (e) {
    notice(e.message, true);
  } finally {
    await hostStatus();
  }
});
async function cancelInvitation() {
  const id = invitationId;
  invitationId = null;
  clearTimeout(invitationTimer);
  $("#phone-qr-wrap").hidden = true;
  $("#phone-qr").removeAttribute("src");
  $("#phone-pair-link").removeAttribute("href");
  if (id)
    await client.get("/api/host/cancel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": client.csrf,
      },
      body: JSON.stringify({ id }),
    });
}
$("#cancel-qr").addEventListener("click", () =>
  cancelInvitation().catch(failure),
);
setInterval(() => void hostStatus(), 5000);
if (location.hash.startsWith("#local=") && !connection.remote) {
  const code = location.hash.slice(7);
  history.replaceState(null, "", location.pathname);
  $("#pair-code").value = code;
  $("#device-name").value = "This computer";
  $("#welcome-title").textContent = "Opening your workspace…";
  $("#local-launch").hidden = true;
  $("#manual-pair-toggle").hidden = true;
  $("#pair-form").requestSubmit($('#pair-form button[type="submit"]'));
} else void boot();
