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

/** A way to a step's place: the control that leads there, and a sentence about it. */
export type Way = { target: string; hint: string };

const TO_HOME: Way = {
  target: '[data-testid="breadcrumb"] button',
  hint: "Press the notebook's name up here to open its home.",
};
const TO_DESK: Way = {
  target: '[aria-label="Back to the desk"]',
  hint: "This arrow takes you back to your desk.",
};

export type TourStep = {
  id: string;
  title: string;
  /** What this is, and what to do now. */
  body: string;
  /** Where it happens. Elsewhere, the guide offers to take the student there. */
  place?: TourPlace;
  /** The real control to ring (a CSS selector); the first one on screen is used. */
  target?: string;
  /**
   * How to get to `place` from somewhere else with the app's own controls: the control to ring
   * there, and what to say about it (the notebook's name on a page, the back arrow to the desk).
   */
  ways?: Partial<Record<TourPlace, Way>>;
  done: TourDone;
  /** Small print: what the step costs, or what to do without a microphone or a PDF. */
  note?: string;
  /** Only in the Windows app (the browser has no Screen Coach). */
  desktopOnly?: boolean;
  /** Only in the browser (the Windows app shows the island instead). */
  browserOnly?: boolean;
  /** Where "Skip this step" goes when the steps after it can't be done without this one. */
  skipTo?: string;
};

const USES_A_QUESTION = "A real question uses one of your free ones. To keep it, skip this step.";

/**
 * Five steps (the meeting of 2026-11-14): a notebook, then the three things that matter most:
 * asking (on the island in the Windows app, by holding Ctrl + Alt in the browser), quizzes from
 * your course, and Review.
 */
export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: "notebook",
    title: "Make your first notebook",
    body: "One notebook per class. Press New notebook, give it your class's name and create it (or open one you already have). Then I'll show you the three things that matter most.",
    place: "desk",
    target: '[data-tour="new-notebook"]',
    // A notebook with chapters opens on its home, one without on its first page.
    done: { by: "place", places: ["home", "page"] },
  },
  {
    id: "island",
    title: "Meet the island",
    body: "Tap Ctrl + Alt twice, quickly: the black bar at the top of your screen is the island, over any app. Draw round something with Select and press the mic to ask. Pick how much I give away: Quiet, Hint, Coach, or Answer for the full working with why. Press the eye and I watch while you work, and speak up when something slips.",
    done: { by: "next", after: "coach-on" },
    note: "The island needs Screen Coach on. Nothing there? Click another window, then tap twice again.",
    desktopOnly: true,
  },
  {
    id: "ask",
    title: "Write, then hold Ctrl + Alt to ask",
    body: "Open a page and write a line of working. I tick what's right and circle a slip. Hold Ctrl + Alt, ask your question out loud, and let go: I answer out loud and in writing beside your work.",
    target: '[data-testid="sheet"], [data-tour="new-page"]',
    done: { by: "next" },
    note: USES_A_QUESTION,
    browserOnly: true,
  },
  {
    id: "quiz",
    title: "Quizzes from your course",
    body: "Add your slides or a chapter as a PDF here. I read it and give the notebook a Study tab: its topics, short lessons, and Quiz me, where you answer on the page and I mark it and tell you why.",
    place: "home",
    target: '[data-testid="add-material"], [data-tour="import-pdf"], #home-tab-study',
    ways: { page: TO_HOME },
    done: { by: "next" },
  },
  {
    id: "review",
    title: "Review what's due",
    body: "Review brings back what you've studied and saved, from every notebook, just before you'd forget it. A few minutes a day keeps it. Press Review to see it.",
    place: "desk",
    target: '[data-testid="desk-review"]',
    ways: { page: TO_DESK, home: TO_DESK },
    done: { by: "place", places: ["review"] },
  },
  {
    id: "done",
    title: "You're ready",
    body: "You have 8 free questions. A follow-up on the same thing doesn't use one, and your notebooks keep working at zero. You can take this tour again from your initial, at the top right of your desk.",
    done: { by: "next", label: "Finish" },
  },
];

/** The steps for this app: the island in the Windows app, Ctrl + Alt on a page in the browser. */
export function stepsFor(desktop: boolean): readonly TourStep[] {
  return TOUR_STEPS.filter((step) => (desktop ? !step.browserOnly : !step.desktopOnly));
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
