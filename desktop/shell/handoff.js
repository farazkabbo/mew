// Hand off's preview (a bundled page; only this window may call these commands). Everything here
// was redacted on this computer; nothing is sent until Send.
"use strict";

const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
const $ = (id) => document.getElementById(id);

const STEPS = ["Reading your last 90 minutes…", "Writing the brief…", "Hiding private info…"];
const KIND_WORDS = {
  email: "email",
  phone: "phone number",
  secret: "secret",
  card: "card number",
  person_name: "name",
  address: "address",
  custom: "hidden by you",
};

let state = null;
let step = 0;

const lines = (id) =>
  $(id)
    .value.split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** The brief as the fields say, keeping a line's moment when its text is unchanged. */
function briefFromFields() {
  const cite = (items, texts) =>
    texts.map((text) => {
      const same = items.find((i) => i.text === text);
      return same && same.momentId ? { text, momentId: same.momentId } : { text };
    });
  const b = state.brief;
  return {
    title: $("title").value.trim() || "Handoff",
    where: $("where").value.trim(),
    goal: $("goal").value.trim(),
    tried: cite(b.tried, lines("tried")),
    blockers: cite(b.blockers, lines("blockers")),
    next: lines("next")
      .slice(0, 3)
      .map((line) => {
        if (line.startsWith("$ ")) {
          const command = line.slice(2).trim();
          return { text: `Run ${command}`, kind: "command", target: command };
        }
        const same = b.next.find((n) => n.text === line);
        return same ?? { text: line, kind: "decide" };
      }),
    openQuestions: lines("questions"),
  };
}

function fill() {
  const b = state.brief;
  $("title").value = b.title;
  $("where").value = b.where;
  $("goal").value = b.goal;
  $("tried").value = b.tried.map((t) => t.text).join("\n");
  $("blockers").value = b.blockers.map((t) => t.text).join("\n");
  $("next").value = b.next
    .map((n) => (n.kind === "command" && n.target ? `$ ${n.target}` : n.text))
    .join("\n");
  $("questions").value = b.openQuestions.join("\n");
  const total = state.hidden.reduce((n, h) => n + h.count, 0);
  $("hidden-badge").textContent =
    total === 0
      ? "Nothing private found"
      : `${total} thing${total === 1 ? "" : "s"} hidden: ${state.hidden
          .map((h) => `${h.count} ${KIND_WORDS[h.kind] ?? h.kind}`)
          .join(", ")}`;
  $("hide-names").hidden = state.names.length === 0;
  $("names-note").hidden = state.names.length === 0;
  $("names-note").textContent = state.names.length
    ? `Names spotted: ${state.names.join(", ")}. They're kept unless you hide them.`
    : "";
  $("recent").replaceChildren(
    ...state.recent.map((e) => Object.assign(document.createElement("option"), { value: e })),
  );
  $("name").value = state.senderName || "";
  $("expiry").value = String(state.expiryDays || 7);
  if (state.hint && !$("to").value) $("to").placeholder = `${state.hint}'s email`;
  renderMoments();
}

function renderMoments() {
  const list = $("moments");
  list.replaceChildren(
    ...state.moments.map((m) => {
      const card = document.createElement("div");
      card.className = `moment${m.include ? "" : " off"}`;
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = m.include;
      box.addEventListener("change", () => {
        m.include = box.checked;
        void save({ include: state.moments.filter((x) => x.include).map((x) => x.id) });
        card.className = `moment${m.include ? "" : " off"}`;
      });
      label.append(box, ` ${m.id} · ${m.app}${m.question ? ` · “${m.question}”` : ""}`);
      const frame = document.createElement("div");
      frame.className = "frame";
      const img = document.createElement("img");
      img.alt = `Moment ${m.id} from ${m.app}`;
      img.src = `${m.src}?v=${Date.now()}`;
      frame.append(img);
      blurOnDrag(frame, img, m);
      card.append(label, frame);
      return card;
    }),
  );
}

/** Drag a box on a picture: that part is covered (in Rust) before anything is sent. */
function blurOnDrag(frame, img, moment) {
  let start = null;
  let drawn = null;
  frame.addEventListener("pointerdown", (e) => {
    const r = frame.getBoundingClientRect();
    start = { x: e.clientX - r.left, y: e.clientY - r.top };
    drawn = document.createElement("div");
    drawn.className = "box";
    frame.append(drawn);
    frame.setPointerCapture(e.pointerId);
  });
  frame.addEventListener("pointermove", (e) => {
    if (!start || !drawn) return;
    const r = frame.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    Object.assign(drawn.style, {
      left: `${Math.min(x, start.x)}px`,
      top: `${Math.min(y, start.y)}px`,
      width: `${Math.abs(x - start.x)}px`,
      height: `${Math.abs(y - start.y)}px`,
    });
  });
  frame.addEventListener("pointerup", async (e) => {
    if (!start) return;
    const r = frame.getBoundingClientRect();
    const sx = img.naturalWidth / r.width;
    const sy = img.naturalHeight / r.height;
    const end = { x: e.clientX - r.left, y: e.clientY - r.top };
    const rect = [start.x * sx, start.y * sy, end.x * sx, end.y * sy].map((v) =>
      Math.max(0, Math.round(v)),
    );
    start = null;
    if (Math.abs(rect[2] - rect[0]) < 4 || Math.abs(rect[3] - rect[1]) < 4) {
      drawn?.remove();
      return;
    }
    try {
      await invoke("handoff_preview_blur", { moment: moment.id, rect });
      await refresh();
    } catch (error) {
      $("notice").textContent = String(error);
    }
  });
}

async function save(edit) {
  try {
    await invoke("handoff_preview_update", { edit });
  } catch (error) {
    $("notice").textContent = String(error);
  }
}

async function refresh() {
  state = await invoke("handoff_preview_state");
  const phase = state.phase;
  $("progress").hidden = phase !== "building";
  $("preview").hidden = phase !== "ready";
  $("empty").hidden = phase !== "empty";
  if (phase === "building") {
    $("progress").textContent = STEPS[Math.min(step++ >> 3, STEPS.length - 1)];
    setTimeout(() => void refresh(), 250);
  } else if (phase === "ready") {
    fill();
  } else if (phase === "failed") {
    $("progress").hidden = false;
    $("progress").textContent = state.message ?? "Couldn't build the handoff.";
  }
}

async function send(copyLink) {
  const recipients = $("to")
    .value.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const newcomers = recipients.filter((r) => !state.recent.includes(r.toLowerCase()));
  if (
    newcomers.length &&
    !window.confirm(
      `${newcomers.join(", ")} isn't someone you've handed off to before. Send anyway?`,
    )
  ) {
    return;
  }
  $("send").disabled = $("copy").disabled = true;
  $("notice").textContent = "Encrypting and sending…";
  try {
    await invoke("handoff_preview_update", { edit: { brief: briefFromFields() } });
    const link = await invoke("handoff_preview_send", {
      send: { recipients, expiryDays: Number($("expiry").value), senderName: $("name").value },
    });
    if (copyLink && link) await invoke("handoff_preview_copy", { text: link });
    $("preview").hidden = true;
    $("progress").hidden = false;
    $("progress").textContent =
      `Sent to ${recipients.join(", ")} ✓${copyLink ? " · link copied" : ""}`;
  } catch (error) {
    $("notice").textContent = String(error);
    $("send").disabled = $("copy").disabled = false;
  }
}

for (const id of ["title", "where", "goal", "tried", "blockers", "next", "questions"]) {
  $(id).addEventListener("change", () => {
    state.brief = briefFromFields();
    void save({ brief: state.brief });
  });
}
$("hide-names").addEventListener("click", async () => {
  await save({ hideNames: true });
  await refresh();
});
$("send").addEventListener("click", () => void send(false));
$("copy").addEventListener("click", () => void send(true));
$("cancel").addEventListener("click", () => void invoke("handoff_preview_cancel"));
$("close-empty").addEventListener("click", () => void invoke("handoff_preview_cancel"));
window.addEventListener("handoff:changed", () => {
  step = 0;
  void refresh();
});
void refresh();
