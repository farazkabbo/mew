/**
 * What the Circle & Ask card shows (S3.2 §2.3–2.5), as Rust sends it, checked by hand (the page
 * stays small) and turned into what to render: a top line, the main text, question chips, the
 * text box, and the buttons. Pure: the page (circle-card.ts) only draws it.
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
  | "close";

export type CardButton = { action: CardAction; label: string; primary?: boolean };

export type CardLayout = {
  mode: string;
  top: string;
  text: string;
  chips: string[];
  /** The text box: its placeholder, and what it starts with (null: no box). */
  input: { placeholder: string; value: string; action: CardAction } | null;
  buttons: CardButton[];
  /** Seconds left on the save toast, if it counts down. */
  countdown: number | null;
};

const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.length <= max ? value : null;

/** The layout for a view from Rust, or null for anything malformed. */
export function cardLayout(detail: unknown): CardLayout | null {
  if (typeof detail !== "object" || detail === null) return null;
  const view = detail as Record<string, unknown>;
  const followUp = text(view.followUp, 220);
  const note = text(view.note, 200);
  const askBox = (placeholder: string) => ({ placeholder, value: "", action: "ask" as const });
  switch (view.mode) {
    case "ask": {
      const silent = view.silent === true;
      return {
        mode: "ask",
        top:
          note ??
          (silent ? "Type a question, or just press Enter" : "Hold Ctrl+Alt+Space to ask out loud"),
        text: followUp ? `To check: ${followUp}` : "",
        chips: [],
        input: askBox("Ask about this…"),
        buttons: [
          { action: "select_question", label: "Select question on screen" },
          { action: "ask", label: "Explain ↵", primary: true },
        ],
        countdown: null,
      };
    }
    case "thinking":
      return {
        mode: "thinking",
        top: "",
        text: "Looking at what you marked…",
        chips: [],
        input: null,
        buttons: [{ action: "close", label: "Cancel" }],
        countdown: null,
      };
    case "explain": {
      const step = Number(view.step);
      const total = Number(view.total);
      const say = text(view.say, 220);
      if (!Number.isInteger(step) || !Number.isInteger(total) || step < 1 || !say) return null;
      const paused = view.paused === true;
      return {
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
      };
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
              { action: "edit_crop", label: "Edit crop" },
              { action: "open", label: "Open", primary: true },
            ]
          : [
              { action: "save", label: "Save to notebook", primary: true },
              { action: "edit_crop", label: "Edit crop" },
              { action: "undo", label: "Not now" },
            ];
      return {
        mode: "toast",
        top: canSave
          ? counting
            ? "✓ Saving to your notebook · From screen"
            : "Save this to your notebook?"
          : "",
        text: note ?? (followUp ? `To check: ${followUp}` : ""),
        chips: [],
        input: askBox("Ask a follow-up…"),
        buttons,
        countdown: counting ? seconds : null,
      };
    }
    case "saved":
      return {
        mode: "saved",
        top:
          view.open === true
            ? "✓ Opened in your notebook"
            : "✓ Saved to your notebook · From screen",
        text: "",
        chips: [],
        input: askBox("Ask a follow-up…"),
        buttons: [{ action: "close", label: "Done", primary: true }],
        countdown: null,
      };
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
      return {
        mode: "message",
        top: "",
        text: message,
        chips: [],
        input: null,
        buttons: [{ action: "close", label: "Close", primary: true }],
        countdown: null,
      };
    }
    default:
      return null;
  }
}
