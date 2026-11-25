// Screen Coach settings (a bundled page; only this window may call these commands).
"use strict";

const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
const $ = (id) => document.getElementById(id);

let current = null;

function showNotice(text) {
  const notice = $("notice");
  notice.textContent = text ?? "";
  notice.hidden = !text;
}

function render(view) {
  current = view;
  const usable = view.supported;
  $("state-word").textContent = !view.on ? "off" : view.paused ? "paused" : "on";
  $("consent-row").hidden = view.on;
  $("turn-on").hidden = view.on;
  $("turn-on").disabled = !usable || !$("consent").checked;
  $("turn-off").hidden = !view.on;
  $("pause").hidden = !view.on;
  $("pause").textContent = view.paused ? "Resume" : "Pause";
  $("pause").setAttribute("aria-pressed", String(view.paused));
  $("consent").disabled = !usable;

  $("shortcuts-notice").hidden = !view.shortcutsNotice;

  renderPrivacy(view);
  renderCircle(view);
  renderCursor(view);
  renderAccount(view);

  if (!usable) showNotice(view.unsupportedReason);
  else if (view.settingsReset)
    showNotice(
      "Your Screen Coach settings couldn't be read, so they were reset. Screen Coach is off.",
    );
}

async function run(action) {
  try {
    render(await action());
    return true;
  } catch (error) {
    showNotice(typeof error === "string" ? error : "Something went wrong. Please try again.");
    return false;
  }
}

const refresh = () => run(() => invoke("screen_coach_status"));

$("consent").addEventListener("change", () => current && render(current));

$("turn-on").addEventListener("click", async () => {
  showNotice("");
  const ok = await run(() =>
    invoke("screen_coach_set_enabled", { enabled: true, consentVersion: current.consentVersion }),
  );
  if (ok) showNotice("Screen Coach is on. Double-tap Ctrl+Alt for its tools.");
});

$("turn-off").addEventListener("click", async () => {
  $("consent").checked = false;
  const ok = await run(() =>
    invoke("screen_coach_set_enabled", { enabled: false, consentVersion: 0 }),
  );
  if (ok) showNotice("Screen Coach is off. Neb won't look at your screen.");
});

$("pause").addEventListener("click", () =>
  run(() => invoke("screen_coach_set_paused", { paused: !current.paused })),
);

$("shortcuts-seen").addEventListener("click", () =>
  run(() => invoke("screen_coach_shortcuts_seen")),
);

// ─── Account ─────────────────────────────────────────────────────────────────────────────────

function renderAccount(view) {
  $("account-state").textContent = view.connected
    ? "Connected to your Neb account."
    : "Connect Screen Coach to your Neb account so it can answer your questions.";
  $("connect").hidden = view.connected;
  $("disconnect").hidden = !view.connected;
}

$("connect").addEventListener("click", async () => {
  const ok = await run(() => invoke("screen_coach_link_start"));
  if (ok) showNotice("Finish connecting in the Neb window that just opened.");
});

$("disconnect").addEventListener("click", async () => {
  const ok = await run(() => invoke("screen_coach_disconnect"));
  if (ok) showNotice("Disconnected. This computer's sign-in was removed.");
});

// ─── Circle & Ask ────────────────────────────────────────────────────────────────────────────

function renderCircle(view) {
  const { circle } = view;
  for (const radio of document.querySelectorAll('input[name="pointer"]')) {
    radio.checked = radio.value === circle.pointer;
  }
  for (const radio of document.querySelectorAll('input[name="save"]')) {
    radio.checked = radio.value === circle.save;
  }
  $("pointer-size").value = circle.pointerSize;
  $("pointer-corner").value = circle.pointerCorner;
  $("include-link").checked = circle.includeSourceLink;
  $("silent").checked = circle.silent;
}

/** Sends Circle & Ask's settings with `changes` applied; Rust checks and saves them. */
function saveCircle(changes) {
  return run(() =>
    invoke("screen_coach_set_circle", { circle: { ...current.circle, ...changes } }),
  );
}

for (const radio of document.querySelectorAll('input[name="pointer"]')) {
  radio.addEventListener("change", () => saveCircle({ pointer: radio.value }));
}
for (const radio of document.querySelectorAll('input[name="save"]')) {
  radio.addEventListener("change", () => saveCircle({ save: radio.value }));
}
$("pointer-size").addEventListener("change", (event) =>
  saveCircle({ pointerSize: event.target.value }),
);
$("pointer-corner").addEventListener("change", (event) =>
  saveCircle({ pointerCorner: event.target.value }),
);
$("include-link").addEventListener("change", (event) =>
  saveCircle({ includeSourceLink: event.target.checked }),
);
$("silent").addEventListener("change", (event) => saveCircle({ silent: event.target.checked }));

// ─── Cursor modes ────────────────────────────────────────────────────────────────────────────

const COUNT_WORDS = {
  show_me_started: "SHOW ME lessons started",
  show_me_completed: "SHOW ME lessons finished",
  show_me_correction: "Corrections before a wrong click",
  do_it_done: "DO IT chores done",
  do_it_undone: "Renames undone",
  catch_shown: "CATCH ME catches",
  catch_continued: "Carried on after a catch",
  catch_not_a_mistake: 'Marked "not a mistake"',
  catch_snoozed: "Rules snoozed",
};

function renderCursor(view) {
  const { cursor } = view;
  const decided = cursor.catchMeConsent >= view.catchMeConsentVersion;
  const on = cursor.catchMe && decided;
  $("catch-new").hidden = decided;
  $("catch-consent-row").hidden = on;
  $("catch-on").hidden = on;
  $("catch-on").disabled = !$("catch-consent").checked;
  $("catch-not-now").hidden = on || decided;
  $("catch-off").hidden = !on;
  $("catch-paused").hidden = !(on && view.catchMePaused);
  $("catch-rules").disabled = !on;
  const now = Date.now() / 1000;
  const snoozed = [];
  for (const box of document.querySelectorAll("input[data-catch]")) {
    const rule = box.dataset.catch;
    box.checked = !cursor.rulesOff.includes(rule);
    if ((cursor.snoozed[rule] ?? 0) > now) snoozed.push(box.parentElement.textContent.trim());
  }
  $("catch-snoozed").hidden = snoozed.length === 0;
  $("catch-snoozed").textContent = snoozed.length ? `Snoozed for now: ${snoozed.join(", ")}.` : "";
  for (const radio of document.querySelectorAll('input[name="guidance"]')) {
    radio.checked = radio.value === cursor.guidance;
  }
  $("cursor-voice").checked = cursor.voice;
  $("cursor-debug").checked = cursor.debug;
  $("cursor-record").checked = cursor.recordTraces;
  $("cursor-counts").replaceChildren(
    ...Object.entries(COUNT_WORDS).map(([key, words]) => {
      const item = document.createElement("li");
      item.textContent = `${words}: ${view.cursorCounts[key] ?? 0}`;
      return item;
    }),
  );
}

/** Sends the cursor modes' settings with `changes` applied; Rust checks and saves them. */
function saveCursor(changes) {
  return run(() =>
    invoke("screen_coach_set_cursor", { cursor: { ...current.cursor, ...changes } }),
  );
}

$("catch-consent").addEventListener("change", () => current && render(current));
$("catch-on").addEventListener("click", async () => {
  const ok = await saveCursor({ catchMe: true, catchMeConsent: current.catchMeConsentVersion });
  if (ok) showNotice("CATCH ME is on. It speaks up only before a costly slip.");
});
$("catch-not-now").addEventListener("click", () =>
  saveCursor({ catchMe: false, catchMeConsent: current.catchMeConsentVersion }),
);
$("catch-off").addEventListener("click", () => {
  $("catch-consent").checked = false;
  return saveCursor({ catchMe: false });
});
for (const box of document.querySelectorAll("input[data-catch]")) {
  box.addEventListener("change", () => {
    const rule = box.dataset.catch;
    const others = current.cursor.rulesOff.filter((other) => other !== rule);
    const snoozed = { ...current.cursor.snoozed };
    delete snoozed[rule];
    return saveCursor({ rulesOff: box.checked ? others : [...others, rule], snoozed });
  });
}
$("catch-reset").addEventListener("click", () => saveCursor({ notMistakes: {}, snoozed: {} }));
for (const radio of document.querySelectorAll('input[name="guidance"]')) {
  radio.addEventListener("change", () => saveCursor({ guidance: radio.value }));
}
$("cursor-voice").addEventListener("change", (event) =>
  saveCursor({ voice: event.target.checked }),
);
$("cursor-debug").addEventListener("change", (event) =>
  saveCursor({ debug: event.target.checked }),
);
$("cursor-record").addEventListener("change", (event) =>
  saveCursor({ recordTraces: event.target.checked }),
);
$("forget-paths").addEventListener("click", async () => {
  const ok = await run(() => invoke("screen_coach_forget_paths"));
  if (ok) showNotice("Forgotten. SHOW ME will plan each lesson again.");
});

// ─── Privacy ─────────────────────────────────────────────────────────────────────────────────

function renderPrivacy(view) {
  const { privacy, microphone } = view;
  $("mic-off").hidden = microphone !== "denied";
  for (const radio of document.querySelectorAll('input[name="scope"]')) {
    radio.checked = radio.value === privacy.askScope;
  }
  $("pause-during-calls").checked = privacy.pauseDuringCalls;
  $("show-in-captures").checked = privacy.showInCaptures;
  $("let-neb-click").checked = privacy.letNebClick;
  $("show-in-captures-paused").hidden = !(privacy.showInCaptures && privacy.pauseDuringCalls);
  for (const box of document.querySelectorAll("input[data-rule]")) {
    box.checked = privacy.redaction[box.dataset.rule];
  }

  const list = $("blocked-list");
  list.replaceChildren(
    ...privacy.blockedApps.map((app) => {
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = app;
      const unblock = document.createElement("button");
      unblock.type = "button";
      unblock.textContent = "Unblock";
      unblock.setAttribute("aria-label", `Unblock ${app}`);
      unblock.addEventListener("click", () =>
        savePrivacy({ blockedApps: privacy.blockedApps.filter((other) => other !== app) }),
      );
      item.append(name, unblock);
      return item;
    }),
  );
}

/** Sends the whole privacy settings with `changes` applied; Rust checks and saves them. */
async function savePrivacy(changes) {
  const privacy = { ...current.privacy, ...changes };
  try {
    render(await invoke("screen_coach_set_privacy", { privacy }));
    $("problem-blocked").hidden = true;
    return true;
  } catch (error) {
    const problem = $("problem-blocked");
    problem.textContent = typeof error === "string" ? error : "Couldn't save that setting.";
    problem.hidden = false;
    render(current);
    return false;
  }
}

for (const radio of document.querySelectorAll('input[name="scope"]')) {
  radio.addEventListener("change", () => savePrivacy({ askScope: radio.value }));
}

$("pause-during-calls").addEventListener("change", (event) =>
  savePrivacy({ pauseDuringCalls: event.target.checked }),
);

$("show-in-captures").addEventListener("change", (event) =>
  savePrivacy({ showInCaptures: event.target.checked }),
);

$("let-neb-click").addEventListener("change", (event) =>
  savePrivacy({ letNebClick: event.target.checked }),
);

for (const box of document.querySelectorAll("input[data-rule]")) {
  box.addEventListener("change", () =>
    savePrivacy({ redaction: { ...current.privacy.redaction, [box.dataset.rule]: box.checked } }),
  );
}

$("block-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("block-input");
  const name = input.value.trim();
  if (!name) return;
  if (await savePrivacy({ blockedApps: [...current.privacy.blockedApps, name] })) input.value = "";
});

$("restore-defaults").addEventListener("click", () =>
  savePrivacy({ blockedApps: [...current.defaultBlockedApps] }),
);

$("open-mic").addEventListener("click", () => invoke("screen_coach_open_mic_settings"));

// ─── Updates ─────────────────────────────────────────────────────────────────────────────────

/** What to say about the app's updates; Rust decides the state. */
function updateWords({ current, phase }) {
  switch (phase.state) {
    case "off":
      return `Version ${current}. This build doesn't update itself.`;
    case "checking":
      return `Version ${current}. Checking for updates…`;
    case "upToDate":
      return `Version ${current}. You're up to date.`;
    case "downloading":
      return `Getting version ${phase.version}… ${phase.percent === null ? "" : `${phase.percent}%`}`;
    case "ready":
      return `Version ${phase.version} is ready. You have ${current}.`;
    case "failed":
      return `Version ${current}. Couldn't update just now; Neb will try again later.`;
    default:
      return `Version ${current}.`;
  }
}

function renderUpdates(view) {
  const { state } = view.phase;
  $("update-state").textContent = updateWords(view);
  $("update-check").hidden = state === "off" || state === "ready";
  $("update-check").disabled = state === "checking" || state === "downloading";
  $("update-install").hidden = state !== "ready";
}

async function runUpdates(command) {
  try {
    renderUpdates(await invoke(command));
  } catch {
    $("update-state").textContent = "Couldn't update just now. Please try again later.";
  }
}

$("update-check").addEventListener("click", () => runUpdates("desktop_update_check"));
$("update-install").addEventListener("click", () => runUpdates("desktop_update_install"));

// Rust tells the page when anything changes elsewhere (tray, voice, the hold gesture).
window.addEventListener("screen-coach:changed", refresh);
window.addEventListener("neb:update-changed", () => runUpdates("desktop_update_status"));
refresh();
runUpdates("desktop_update_status");
