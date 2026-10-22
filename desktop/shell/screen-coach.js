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

  for (const which of ["talk", "pause"]) {
    const report = view[which];
    const input = $(`hotkey-${which}`);
    if (document.activeElement !== input) input.value = report.accelerator;
    const problem = $(`problem-${which}`);
    problem.textContent = report.problem ?? "";
    problem.hidden = !report.problem;
    for (const kbd of document.querySelectorAll(`kbd[data-hotkey="${which}"]`)) {
      kbd.textContent = report.accelerator;
    }
  }

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
  if (ok)
    showNotice(`Screen Coach is on. Hold ${current.talk.accelerator} and ask about your screen.`);
});

$("turn-off").addEventListener("click", async () => {
  $("consent").checked = false;
  const ok = await run(() =>
    invoke("screen_coach_set_enabled", { enabled: false, consentVersion: 0 }),
  );
  if (ok) showNotice("Screen Coach is off. Mew won't look at your screen.");
});

$("pause").addEventListener("click", () =>
  run(() => invoke("screen_coach_set_paused", { paused: !current.paused })),
);

for (const form of document.querySelectorAll("form.hotkey")) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const which = form.dataset.which;
    const accelerator = form.elements.accelerator.value;
    const problem = $(`problem-${which}`);
    try {
      form.elements.accelerator.blur();
      render(await invoke("screen_coach_set_hotkey", { which, accelerator }));
    } catch (error) {
      problem.textContent = typeof error === "string" ? error : "Couldn't change the shortcut.";
      problem.hidden = false;
    }
  });
}

// Rust tells the page when anything changes elsewhere (tray, hotkeys).
window.addEventListener("screen-coach:changed", refresh);
refresh();
