import type { TourSignal } from "./signals";

/** Where in the app a step happens. */
export type TourPlace = "desk" | "home" | "page" | "review";

/** What finishes a step. */
export type TourDone =
  /** Reading it: the student presses the step's button. */
  | { by: "next"; label?: string }
  /** Getting somewhere, by doing the real thing (creating a notebook opens it). */
  | { by: "place"; places: readonly TourPlace[] }
  /** Doing something the app reports (`signals.ts`). */
  | { by: "signal"; signal: TourSignal }
  /** Screen Coach being on (asked of the Windows app). */
  | { by: "coach-on" };

export type TourStep = {
  id: string;
  title: string;
  /** What this is, and what to do now. */
  body: string;
  /** Where it happens. Elsewhere, the guide offers to take the student there. */
  place?: TourPlace;
  /** The real control to ring (a CSS selector); the first one on screen is used. */
  target?: string;
  done: TourDone;
  /** Small print: what the step costs, or what to do without a microphone or a PDF. */
  note?: string;
  /** Only in the Windows app (the browser has no Screen Coach). */
  desktopOnly?: boolean;
};

const TABS = '[role="tablist"][aria-label="Notebook"]';
const USES_A_QUESTION = "A real question uses one of your free ones. To keep it, skip this step.";

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: "welcome",
    title: "Let's set up your desk together",
    body: "I'll point at the real buttons and you press them. What you make along the way, a notebook and a page, is yours to keep. It takes about five minutes.",
    done: { by: "next", label: "Start" },
  },
  {
    id: "notebook",
    title: "Make a notebook",
    body: "One notebook per class. Press New notebook, give it your class's name and create it.",
    place: "desk",
    target: '[data-tour="new-notebook"]',
    // A notebook with chapters opens on its home, one without on its first page.
    done: { by: "place", places: ["home", "page"] },
  },
  {
    id: "page",
    title: "Open a page",
    body: "Press New page. It opens straight away, ready to write on.",
    place: "home",
    target: '[data-tour="new-page"]',
    done: { by: "place", places: ["page"] },
  },
  {
    id: "write",
    title: "Write a line",
    body: "Write some working with the mouse, a pen or your finger: 3x + 7 = 19, then 3x = 26 below it. When you pause, I read the line. A tick if it's right, a circle where something slipped.",
    place: "page",
    target: '[data-testid="sheet"]',
    done: { by: "signal", signal: "wrote" },
  },
  {
    id: "marks",
    title: "Choose how much I mark",
    body: "Quiet only ticks. Hint circles a slip and says where to look. Coach adds a nudge when you're stuck. You can change it here whenever you like.",
    place: "page",
    target: '[data-testid="level-switch"]',
    done: { by: "next" },
  },
  {
    id: "ask",
    title: "Hold Ctrl + Alt to ask",
    body: "Hold both keys, ask your question out loud, and let go. While you hold, you can also circle the line you mean. I answer once you let go.",
    place: "page",
    done: { by: "signal", signal: "asked" },
    note: USES_A_QUESTION,
  },
  {
    id: "to-home",
    title: "Go to the notebook's home",
    body: "Up here is where you are. Press the notebook's name to open its home.",
    place: "page",
    target: '[data-testid="breadcrumb"] button',
    done: { by: "place", places: ["home"] },
  },
  {
    id: "home",
    title: "This is the notebook's home",
    body: "Tabs appear here as the notebook fills. Pages holds what you write, Moments keeps what I explained to you, and Study arrives once you add course material.",
    place: "home",
    target: TABS,
    done: { by: "next" },
  },
  {
    id: "pdf",
    title: "Add your course material",
    body: "Add your slides, a syllabus or a chapter as a PDF. I read it and build lessons and quizzes from the subject.",
    place: "home",
    target: '[data-testid="add-material"], [data-tour="import-pdf"]',
    done: { by: "signal", signal: "pdf" },
    note: "No PDF to hand? Skip this step and add one later.",
  },
  {
    id: "study",
    title: "Study from it",
    body: "Once I've read a PDF, a Study tab appears here with a plan, lessons and quizzes. Reading takes a minute or two, and you can keep working meanwhile.",
    place: "home",
    target: TABS,
    done: { by: "next" },
  },
  {
    id: "to-desk",
    title: "Back to your desk",
    body: "This arrow always takes you back to your desk. Press it.",
    target: '[aria-label="Back to the desk"]',
    done: { by: "place", places: ["desk"] },
  },
  {
    id: "review-open",
    title: "Open Review",
    body: "Review collects everything that's due, from every notebook. Press it.",
    place: "desk",
    target: '[data-testid="desk-review"]',
    done: { by: "place", places: ["review"] },
  },
  {
    id: "review",
    title: "What's due today",
    body: "Each notebook gets a folder here. Inside are the topics I'll quiz you on and the things you saved, brought back just before you'd forget them. It stays empty until you've studied something.",
    place: "review",
    target: '[data-testid="review-folders"]',
    done: { by: "next" },
  },
  {
    id: "coach",
    title: "Turn on Screen Coach",
    body: "Screen Coach lets me help over any app on your PC: a slide, a PDF, a video. Its settings say exactly what I can see. Turn it on there, then come back here.",
    done: { by: "coach-on" },
    desktopOnly: true,
  },
  {
    id: "island",
    title: "Find the island",
    body: "Tap Ctrl + Alt twice, quickly. A black bar appears at the top of your screen, with a pen, a selection tool, a microphone and your music. Tap twice again to hide it.",
    done: { by: "next", label: "I see it" },
    desktopOnly: true,
  },
  {
    id: "circle",
    title: "Circle anything and ask",
    body: "Hold Ctrl + Alt and drag a circle round something on your screen, this box if you like. Ask out loud and let go. I explain it step by step, right beside it.",
    done: { by: "signal", signal: "screen-asked" },
    note: USES_A_QUESTION,
    desktopOnly: true,
  },
  {
    id: "moments",
    title: "It's saved for you",
    body: "What I explain on your screen goes into a notebook's Moments tab, with the picture. Replay draws the explanation again, as it happened.",
    place: "home",
    target: TABS,
    done: { by: "next" },
    desktopOnly: true,
  },
  {
    id: "done",
    title: "You're ready",
    body: "You have 8 free questions. A follow-up on the same thing doesn't use one, and your notebooks keep working at zero. You can take this tour again from your initial, at the top right of your desk.",
    done: { by: "next", label: "Finish" },
  },
];

/** The steps for this app: Screen Coach's are the Windows app's only. */
export function stepsFor(desktop: boolean): readonly TourStep[] {
  return TOUR_STEPS.filter((step) => desktop || !step.desktopOnly);
}

/** Where the student is, from the address the app keeps in step with the screen (U29). */
export function placeOf(pathname: string, search: string): TourPlace | null {
  if (pathname === "/desk") return "desk";
  if (pathname === "/review") return "review";
  if (pathname !== "/notebook") return null;
  const params = new URLSearchParams(search);
  if (params.has("page")) return "page";
  return params.has("node") ? "home" : null;
}

/** The address of a place: the tour's own notebook and page, once they exist. */
export function hrefOf(
  place: TourPlace,
  made: { nodeId: string | null; pageId: string | null },
): string | null {
  if (place === "desk") return "/desk";
  if (place === "review") return "/review";
  if (place === "home") return made.nodeId ? `/notebook?node=${made.nodeId}` : null;
  return made.pageId ? `/notebook?page=${made.pageId}` : null;
}
