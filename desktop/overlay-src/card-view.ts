/**
 * What the Circle & Ask card shows (S3.2 §2.3–2.5), as Rust sends it, checked by hand (the page
 * stays small) and turned into what to render: a top line, the main text, question chips, where
 * it's saved (K3), the text box, and the buttons. Pure: the page (circle-card.ts) only draws it.
 */

export type CardAction =
  | "ask"
  | "select_question"
  | "confirm"
  | "pause"
  | "resume"
  | "repeat"
  | "next"
  | "stop"
  | "undo"
  | "edit_crop"
  | "open"
  | "save"
  | "save_only"
  | "close"
  /** K3: open the destination picker (the chip's ▾, "Change", Ctrl+D). */
  | "change_place"
  /** K3: one of the offered places (its index goes as the text). */
  | "pick_place"
  /** K3: "Create it and save". */
  | "create_place"
  | "place_cancel"
  /** The ask box's mic: on to say the question (or follow-up), off to ask it. */
  | "mic"
  /** The page needs this much height (its CSS pixels go as the text): the window follows. */
  | "fit";

export type CardButton = { action: CardAction; label: string; primary?: boolean };

/** A place to choose (K3): an offered one (by index), the chapter to create, or "Change ▾". */
export type PlaceChip = {
  label: string;
  action: "pick_place" | "create_place" | "change_place";
  index?: number;
};

export type CardLayout = {
  mode: string;
  top: string;
  text: string;
  chips: string[];
  /** Where it's saved (K3): "Saving to: Physics › Chapter 5" and what can be chosen. */
  place: { line: string; chips: PlaceChip[] } | null;
  /** The text box: its placeholder, and what it starts with (null: no box). */
  input: { placeholder: string; value: string; action: CardAction } | null;
  buttons: CardButton[];
  /** Seconds left on the save toast, if it counts down. */
  countdown: number | null;
};

const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.length <= max ? value : null;

const PLACE_CHARS = 640;

/** The place part of a view (K3): its label, the offered choices, a chapter to create; and
 * (K8) why it was filed there and a notebook to start. */
function placeOf(value: unknown): {
  label: string | null;
  choices: string[];
  create: string | null;
  note: string | null;
  newNotebook: string | null;
} {
  const place = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const choices = Array.isArray(place.choices)
    ? place.choices
        .map((c) => text(c, PLACE_CHARS))
        .filter((c): c is string => !!c)
        .slice(0, 3)
    : [];
  return {
    label: text(place.label, PLACE_CHARS),
    choices,
    create: text(place.create, PLACE_CHARS),
    note: text(place.note, NOTE_CHARS),
    newNotebook: text(place.newNotebook, NOTE_CHARS),
  };
}

const NOTE_CHARS = 80;

/** "Physics › Chapter 3 · matched “projectile motion”": the place, and why it went there (K8). */
function placed(label: string, note: string | null): string {
  return note ? `${label} · ${note}` : label;
}

/** The "Saving to: …" row under the main text. */
function placeRow(value: unknown): CardLayout["place"] {
  const { label, choices, create, note, newNotebook } = placeOf(value);
  const chips: PlaceChip[] = choices.map((choice, index) => ({
    label: choice,
    action: "pick_place",
    index,
  }));
  if (create) chips.push({ label: `Create ${create} and save`, action: "create_place" });
  // K8: Unsorted's "+ New notebook: Biology" (made only on this tap).
  if (newNotebook) chips.push({ label: `+ New notebook: ${newNotebook}`, action: "create_place" });
  chips.push({
    label: choices.length || create ? "Pick another…" : "Change ▾",
    action: "change_place",
  });
  const line = label
    ? `Saving to: ${placed(label, note)}`
    : choices.length > 0
      ? "Save it to which one?"
      : create
        ? `There's no ${create} yet.`
        : "Saving to: where it fits (you can change it)";
  return { line, chips };
}

/** The layout for a view from Rust, or null for anything malformed. */
export function cardLayout(detail: unknown): CardLayout | null {
  if (typeof detail !== "object" || detail === null) return null;
  const view = detail as Record<string, unknown>;
  const followUp = text(view.followUp, 220);
  const note = text(view.note, 200);
  const askBox = (placeholder: string) => ({ placeholder, value: "", action: "ask" as const });
  const { label, note: why } = placeOf(view.place);
  const where = label ? placed(label, why) : "your notebook · From screen";
  const withPlace = (layout: Omit<CardLayout, "place">): CardLayout => ({
    ...layout,
    place: view.place === undefined ? null : placeRow(view.place),
  });
  switch (view.mode) {
    case "ask": {
      const silent = view.silent === true;
      return withPlace({
        mode: "ask",
        top:
          note ??
          (silent ? "Type a question, or just press Enter" : "Or click the mic to ask out loud"),
        text: followUp ? `To check: ${followUp}` : "",
        chips: [],
        input: askBox("Ask about this…"),
        buttons: [
          { action: "select_question", label: "Select question on screen" },
          { action: "ask", label: "Explain ↵", primary: true },
        ],
        countdown: null,
      });
    }
    case "thinking":
      return withPlace({
        mode: "thinking",
        top: "",
        text: "Looking at what you marked…",
        chips: [],
        input: null,
        buttons: [{ action: "close", label: "Cancel" }],
        countdown: null,
      });
    case "explain": {
      const step = Number(view.step);
      const total = Number(view.total);
      const say = text(view.say, 220);
      if (!Number.isInteger(step) || !Number.isInteger(total) || step < 1 || !say) return null;
      const paused = view.paused === true;
      return withPlace({
        mode: "explain",
        top: `Step ${step} of ${Math.max(step, total)}${paused ? " · paused" : ""}`,
        text: say,
        chips: [],
        input: askBox("Ask a follow-up…"),
        buttons: [
          paused
            ? { action: "resume", label: "Resume", primary: true }
            : { action: "pause", label: "Pause" },
          { action: "repeat", label: "Repeat" },
          { action: "next", label: "Next" },
          { action: "stop", label: "Stop" },
        ],
        countdown: null,
      });
    }
    case "toast": {
      const seconds =
        view.seconds === null || view.seconds === undefined ? null : Number(view.seconds);
      const canSave = view.canSave !== false;
      const counting = seconds !== null && Number.isFinite(seconds);
      const buttons: CardButton[] = !canSave
        ? [{ action: "close", label: "Close" }]
        : counting
          ? [
              { action: "undo", label: "Undo" },
              { action: "change_place", label: "Change" },
              { action: "edit_crop", label: "Edit crop" },
              { action: "open", label: "Open", primary: true },
            ]
          : [
              { action: "save", label: "Save", primary: true },
              { action: "change_place", label: "Change" },
              { action: "edit_crop", label: "Edit crop" },
              { action: "undo", label: "Not now" },
            ];
      return withPlace({
        mode: "toast",
        top: canSave ? (counting ? `✓ Saving to ${where}` : `Save this to ${where}?`) : "",
        text: note ?? (followUp ? `To check: ${followUp}` : ""),
        chips: [],
        input: askBox("Ask a follow-up…"),
        buttons,
        countdown: counting ? seconds : null,
      });
    }
    case "saved":
      return withPlace({
        mode: "saved",
        top: view.open === true ? "✓ Opened in your notebook" : `✓ Saved to ${where}`,
        text: "",
        chips: [],
        input: askBox("Ask a follow-up…"),
        buttons: [
          { action: "change_place", label: "Change" },
          { action: "close", label: "Done", primary: true },
        ],
        countdown: null,
      });
    case "place": {
      // The picker (K3 §4.4): every notebook, chapter and section, filtered as you type.
      const places = Array.isArray(view.places)
        ? view.places
            .map((p) => text(p, PLACE_CHARS))
            .filter((p): p is string => !!p)
            .slice(0, 200)
        : [];
      return {
        mode: "place",
        top: places.length > 0 ? "Save it to…" : "You have no notebooks yet.",
        text: "",
        chips: places,
        place: null,
        input: { placeholder: "Find a notebook or chapter…", value: "", action: "pick_place" },
        buttons: [{ action: "place_cancel", label: "Cancel" }],
        countdown: null,
      };
    }
    case "confirm": {
      const questions = Array.isArray(view.questions)
        ? view.questions
            .map((q) => text(q, 500))
            .filter((q): q is string => !!q)
            .slice(0, 5)
        : [];
      if (questions.length === 0) return null;
      const one = questions.length === 1;
      return {
        mode: "confirm",
        top: one ? "I read this. Is it right?" : "Which question?",
        text: "",
        chips: one ? [] : questions,
        place: null,
        input: { placeholder: "Your question", value: questions[0] ?? "", action: "confirm" },
        buttons: [
          { action: "confirm", label: "Ask", primary: true },
          { action: "close", label: "Cancel" },
        ],
        countdown: null,
      };
    }
    case "message": {
      const message = text(view.text, 300);
      if (!message) return null;
      return withPlace({
        mode: "message",
        top: "",
        text: message,
        chips: [],
        input: null,
        buttons: [{ action: "close", label: "Close", primary: true }],
        countdown: null,
      });
    }
    default:
      return null;
  }
}

/** The picker's places that match what's typed (every word, anywhere, ignoring case), by index. */
export function filterPlaces(places: readonly string[], query: string): number[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return places
    .map((place, index) => ({ place: place.toLowerCase(), index }))
    .filter(({ place }) => words.every((w) => place.includes(w)))
    .map(({ index }) => index)
    .slice(0, 30);
}

/**
 * The card's keys (S3.2 §4, K2 §11.2: two keys at most), or null. `typing`: the text box has the
 * keyboard and something in it (the arrows and Space are the box's then).
 */
export function cardKey(
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
  layout: CardLayout | null,
  typing: boolean,
): CardAction | null {
  if (!layout) return null;
  const mode = layout.mode;
  if (event.key === "Escape") {
    return mode === "explain" ? "stop" : mode === "place" ? "place_cancel" : "close";
  }
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
    if (event.code === "KeyD") return layout.place ? "change_place" : null;
    if (event.code !== "KeyS") return null;
    if (mode === "toast") return layout.buttons.some((b) => b.action === "save") ? "save" : null;
    return mode === "ask" ? "save_only" : null;
  }
  if (typing || mode !== "explain" || event.altKey || event.ctrlKey || event.metaKey) return null;
  if (event.key === " ") {
    return layout.buttons.some((b) => b.action === "resume") ? "resume" : "pause";
  }
  if (event.key === "ArrowRight") return "next";
  if (event.key === "ArrowLeft") return "repeat";
  return null;
}
