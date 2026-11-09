import type { CircleMark } from "./circle";
import type { NebLanguage } from "./language";

/**
 * Cheap rules that decide, before the model runs, how much of the screen a question needs
 * (docs/PLAN.md, Part 4; the idea is Plip's `router.py`, MIT). Gemini 3 bills an image by its
 * resolution, not its size, so these decide most of a turn's cost. Any doubt keeps the screen:
 * a wasted image costs a little, a missing one makes neb blind.
 */

/** Words that tie an English question to what's on screen. */
const SCREEN_WORDS =
  /\b(this|that|these|those|here|there|it|its|my|screen|window|page|tab|app|button|menu|icon|field|click|press|tap|open|close|select|find|where|see|look|show|point|highlight|which|error|message|popup|dialog|settings?|option|toolbar|sidebar|file|folder|document|code|line|cell|row|column|chart|graph|image|picture|photo|video|email|question|answer|problem|exercise|equation|step|above|below|left|right|top|bottom)\b|how do i|how can i|how to|walk me|help me|what am i|what's on|what is on/i;

/** Questions about where something is, or what a control does: they need the surroundings. */
const WHERE_WORDS =
  /\b(where|which (button|menu|icon|tab|one)|find|locate|button|menu|icon|toolbar|click|what does (this|that) (button|do)|what's this for|what is this for)\b/i;

/**
 * Whether a spoken question needs the screenshot at all. Only English is judged: in other
 * languages the screen always goes (the rules would miss their words).
 */
export function needsScreen(question: string, language: NebLanguage = "en"): boolean {
  const words = question.trim();
  if (language !== "en" || words.length === 0) return true;
  return SCREEN_WORDS.test(words);
}

/** How a circle-and-ask turn shows the screen: the marked area always, the surroundings maybe. */
export type CircleImagePlan = {
  focus: "medium" | "high";
  context: "low" | "medium" | null;
};

/**
 * The marked area goes at medium resolution (it's small, and its words come as text too); the
 * window around it at low, at medium for "where is…" questions, and not at all when the marks'
 * own words carry the question (text-first): every mark has words, the question isn't about
 * where things are, and it isn't a video or a figure.
 */
export function circleImagePlan(
  question: string,
  marks: readonly Pick<CircleMark, "text">[],
  kind: "browser" | "pdf" | "video" | "app",
): CircleImagePlan {
  const where = WHERE_WORDS.test(question);
  const textFirst =
    !where &&
    kind !== "video" &&
    marks.length > 0 &&
    marks.every((mark) => mark.text.trim().split(/\s+/).join("").length >= 3);
  return { focus: "medium", context: textFirst ? null : where ? "medium" : "low" };
}

/** At most this many nearby text blocks go with a circle question (nearest to the marks first). */
export const NEARBY_BLOCKS = 20;
