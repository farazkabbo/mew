import { NotesCheckResult, type PanelGroup, panelGroups } from "@mew/shared";

import { invoke, on } from "./tauri";

/**
 * The Notes Check panel (N4, brief §2.3): a check's findings beside the screen, grouped as in
 * the notebook (`panelGroups`). Rust sends the checked reply; this page validates it again and
 * renders it with text nodes only (the quotes come from the screen and the notes: data, never
 * markup). Each item can open its line in the notebook; the footer hides the marks on screen.
 *
 * The window doesn't take focus when it appears (the student's app stays active); a click
 * gives it the keyboard, and everything is reachable with Tab, Enter and Esc.
 */

const groupsBox = document.getElementById("notes-groups");
const speech = document.getElementById("notes-speech");
const scope = document.getElementById("notes-scope");

function act(action: "close" | "hide_marks" | "open_line", findingId?: string): void {
  void invoke("screen_notes_panel", { action, findingId }).catch(() => undefined);
}

function render(detail: unknown): void {
  const parsed = NotesCheckResult.safeParse(detail);
  if (!parsed.success || !groupsBox || !speech || !scope) return;
  const result = parsed.data;
  speech.textContent = result.speech;
  scope.textContent = result.scopeLabel;
  groupsBox.replaceChildren(...panelGroups(result.findings).map(section));
}

function section(group: PanelGroup): HTMLElement {
  const wrapper = document.createElement(group.collapsed ? "details" : "section");
  wrapper.className = `group ${group.type}`;
  const heading = document.createElement(group.collapsed ? "summary" : "h2");
  heading.textContent = group.heading;
  wrapper.append(heading);
  const list = document.createElement("ul");
  for (const item of group.items) {
    const row = document.createElement("li");
    const icon = document.createElement("span");
    icon.className = "icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = item.icon;
    const body = document.createElement("div");
    const title = document.createElement("p");
    title.className = "title";
    title.textContent = item.title;
    body.append(title);
    if (item.detail) {
      const detail = document.createElement("p");
      detail.className = "detail";
      detail.textContent = item.detail;
      body.append(detail);
    }
    if (item.inNotebook) {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "link";
      open.textContent = "Show in notebook";
      open.addEventListener("click", () => {
        act("open_line", item.findingId);
      });
      body.append(open);
    }
    row.append(icon, body);
    list.append(row);
  }
  wrapper.append(list);
  return wrapper;
}

for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-action]")) {
  button.addEventListener("click", () => {
    const action = button.dataset.action;
    if (action === "close" || action === "hide_marks") act(action);
  });
}
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") act("close");
});

on("mew:notes-panel-show", render);
