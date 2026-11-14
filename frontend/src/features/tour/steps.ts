import type { TourSignal } from "./signals";

/** Where in the app a step happens. */
export type TourPlace = "desk" | "home" | "page" | "review";

/** Something on screen (a CSS selector): the Study tab's plan, a quiz's feedback. */
export type TourSight = { present: string };

/** What finishes a step. */
export type TourDone =
  /**
   * The student presses the step's button, at their own pace. With `after`, the button waits
   * until they've done the thing (written, asked, turned Screen Coach on, had an answer marked).
   */
  | { by: "next"; label?: string; after?: TourSignal | "coach-on" | TourSight }
  /** Getting somewhere, by doing the real thing (creating a notebook opens it). */
  | { by: "place"; places: readonly TourPlace[] }
  /** Something that's plainly finished when the app reports it (a PDF imported). */
  | { by: "signal"; signal: TourSignal }
  /** Something appearing on screen because of what the student did, or what neb finished. */
  | { by: "present"; selector: string };

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
  /** Where "Skip this step" goes when the steps after it can't be done without this one. */
  skipTo?: string;
};

const STUDY = '[data-testid="course-study"]';
const TOPICS = '[data-testid="review-concept"]';
const PLAN = '[data-testid="plan-summary"]';
const QUIZ = '[data-testid="quiz-card"]';
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
    body: "Write some working with the mouse, a pen or your finger: 3x + 7 = 19, then 3x = 26 below it. Each time you pause, I read the line: a tick if it's right, a circle where something slipped. Take your time, and carry on when you've seen a mark.",
    place: "page",
    target: '[data-testid="sheet"]',
    done: { by: "next", after: "wrote" },
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
    body: "Hold both keys. While they're down, circle the line you mean and ask your question out loud. Then let go, and I answer: out loud, and in writing beside your work. Carry on when I've finished.",
    place: "page",
    done: { by: "next", after: "asked" },
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
    body: "Add your slides, a syllabus or a chapter as a PDF, and leave \"Use as course material\" ticked. I read it and build lessons and quizzes from the subject. I'll carry on as soon as it's in.",
    place: "home",
    target: '[data-testid="add-material"], [data-tour="import-pdf"]',
    done: { by: "signal", signal: "pdf" },
    note: "No PDF to hand? Skip this step and add one later.",
    skipTo: "to-desk",
  },
  {
    id: "back-home",
    title: "Your PDF is in",
    body: "Its pages are in the notebook now, for you to write on. Press the notebook's name up here to go back to its home.",
    place: "page",
    target: '[data-testid="breadcrumb"] button',
    done: { by: "place", places: ["home"] },
    skipTo: "to-desk",
  },
  {
    id: "study-tab",
    title: "Open Study",
    body: "The notebook has a Study tab now. Press it.",
    place: "home",
    target: "#home-tab-study",
    done: { by: "present", selector: STUDY },
    skipTo: "to-desk",
  },
  {
    id: "reading",
    title: "I'm reading your PDF",
    body: "This takes a minute or two. I'll carry on by myself when the topics are ready.",
    place: "home",
    done: { by: "present", selector: `${TOPICS}, ${PLAN}` },
    note: "If it says the course couldn't be built, skip this step and try another PDF later.",
    skipTo: "to-desk",
  },
  {
    id: "topics",
    title: "Check the topics",
    body: "These are the topics I found. Untick any you don't need, then press Start studying.",
    place: "home",
    target: '[data-tour="start-studying"]',
    done: { by: "present", selector: PLAN },
    skipTo: "to-desk",
  },
  {
    id: "quiz",
    title: "Take a quiz",
    body: "This is your study plan: each topic, with a lesson. Press Quiz me to try a question now.",
    place: "home",
    target: '[data-tour="quiz-me"]',
    done: { by: "present", selector: QUIZ },
    skipTo: "to-desk",
  },
  {
    id: "answer",
    title: "Answer on the page",
    body: "Write your answer on the page, or say it, then press Check my answer. I mark it and tell you why. Try another if you like, then press End quiz and carry on.",
    place: "page",
    // Nothing ringed: the card stays in the corner, clear of where the answer is written.
    done: { by: "next", after: { present: '[data-testid="quiz-feedback"]' } },
    skipTo: "to-desk",
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
    body: "Each notebook gets a folder here, with the topics you've started and the things you saved. What you just practised is in it, and comes back for another look just before you'd forget it. A notebook you haven't studied from has no folder yet.",
    place: "review",
    target: '[data-testid="review-folders"]',
    done: { by: "next" },
  },
  {
    id: "coach",
    title: "Turn on Screen Coach",
    body: "Screen Coach lets me help over any app on your PC: a slide, a PDF, a video. Its settings say exactly what I can see. Turn it on there, then come back here.",
    done: { by: "next", after: "coach-on" },
    desktopOnly: true,
  },
  {
    id: "island",
    title: "Find the island",
    body: "Tap Ctrl + Alt twice, quickly. A black bar appears at the top of your screen: that's the island, with a pen, a selection tool, a microphone and your music. Tap twice again to hide it.",
    done: { by: "next", label: "I see it" },
    note: "Nothing there? Click on another window first, then tap twice again.",
    desktopOnly: true,
  },
  {
    id: "circle",
    title: "Circle anything and ask",
    body: "Open something to study in another window: slides, a PDF, a video. On the island, pick the selection tool and draw round the part you mean. Press the island's microphone, ask out loud, and press it again. I explain it step by step, right beside it. Come back here afterwards.",
    done: { by: "next", after: "screen-asked" },
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
