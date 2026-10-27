import { z } from "zod";

import {
  COACH_LIMITS,
  type Walkthrough,
  type WalkthroughKind,
  type WalkthroughStep,
} from "./coach";
import { AppName, ScreenImage, SCREEN_LIMITS } from "./screen";

/**
 * Skills (Screen Coach S5, docs/SCREEN_COACH.md §2.6 and §6): a walkthrough of a task in an app
 * ("Pivot tables" in Excel) makes a skill in the learner model, re-checked later with spaced
 * repetition ("Three days ago you made a pivot table with one hint. Want to try it solo?").
 *
 * The evidence rules are the brief's: a guided walkthrough is `with_hint`, or `after_explanation`
 * once a step needed the explicit instruction, never `independent`; only a re-check done without
 * coaching is `independent`. The database enforces the same rule.
 */

export const SkillEvidence = z.enum(["independent", "with_hint", "after_explanation", "not_yet"]);
export type SkillEvidence = z.infer<typeof SkillEvidence>;

/** The same task in the same app is one skill. */
export function skillKey(title: string, app: string | null): string {
  return `${title.trim().replace(/\s+/g, " ").toLowerCase()}|${app ?? ""}`.slice(0, 130);
}

/** What a finished walkthrough counts as (§6). Null when it didn't finish: nothing is recorded. */
export function walkthroughEvidence(
  walkthrough: Pick<Walkthrough, "status" | "steps"> & { kind: WalkthroughKind },
): SkillEvidence | null {
  if (walkthrough.status !== "completed") return null;
  const most = Math.max(0, ...walkthrough.steps.map((s) => s.hints));
  if (most >= COACH_LIMITS.hintLevels) return "after_explanation";
  if (walkthrough.kind === "recheck" && most === 0) return "independent";
  return "with_hint";
}

/**
 * A re-check (§6: "do it without me, tell me when done", then verify): the whole task as one
 * step, checked against what the last step of the walkthrough that taught it looked like when
 * it was done. Asking for help still works: the hints are the first step's, so the student is
 * nudged into the task, and a re-check with hints isn't independent.
 */
export function recheckSteps(title: string, taught: readonly WalkthroughStep[]): WalkthroughStep[] {
  const first = taught[0];
  const last = taught.at(-1);
  if (!first || !last) return [];
  const instruction = `Do it on your own: ${title}. Say "done" when it's finished.`.slice(
    0,
    COACH_LIMITS.instructionChars,
  );
  return [
    {
      instruction,
      successCondition: last.successCondition,
      hint: first.hint,
      explicit: first.explicit,
      hints: 0,
      checks: 0,
      misses: 0,
      outcome: null,
    },
  ];
}

/** "Three days ago you made a pivot table with one hint. Want to try it solo?" */
export function recheckOffer(
  skill: { title: string; lastAt: string; lastHints: number },
  now: number,
): string {
  const days = Math.max(0, Math.round((now - Date.parse(skill.lastAt)) / 86_400_000));
  const when = days === 0 ? "Today" : days === 1 ? "Yesterday" : `${spelled(days)} days ago`;
  const how =
    skill.lastHints === 0
      ? "on your own"
      : `with ${skill.lastHints === 1 ? "one hint" : `${skill.lastHints} hints`}`;
  return `${when} you did “${skill.title}” ${how}. Want to try it solo?`;
}

const NUMBERS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
const spelled = (n: number) => NUMBERS[n] ?? String(n);

/**
 * Which of the student's skills a re-check is for: the one named in their words ("let me try
 * pivot tables on my own"), else the most overdue one in this app, else the most overdue one.
 */
export function pickSkill<T extends { title: string; app: string | null; dueAt: string }>(
  skills: readonly T[],
  words: string,
  app: string | null,
): T | null {
  const normal = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .map((w) => w.replace(/(ies|es|s)$/, ""));
  const said = new Set(normal(words));
  const named = skills
    .map((skill) => {
      const title = normal(skill.title);
      const hits = title.filter((w) => said.has(w)).length;
      return { skill, score: title.length > 0 ? hits / title.length : 0 };
    })
    .filter((s) => s.score >= 0.5)
    .sort((a, b) => b.score - a.score);
  if (named[0]) return named[0].skill;
  const byDue = [...skills].sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  return byDue.find((s) => app !== null && s.app === app) ?? byDue[0] ?? null;
}

// ─── Wire shapes ─────────────────────────────────────────────────────────────────────────────

/** A skill as the student's review shows it. */
export const SkillView = z.object({
  id: z.uuid(),
  title: z.string(),
  app: AppName.nullable(),
  /** The course concept that is this task, when there is one. */
  conceptTitle: z.string().nullable(),
  dueAt: z.iso.datetime({ offset: true }),
  /** How the last walkthrough of it went. */
  lastEvidence: SkillEvidence.nullable(),
  lastHints: z.number().int().min(0),
  lastAt: z.iso.datetime({ offset: true }).nullable(),
  /** Times it was done alone (re-checks without help). */
  solo: z.number().int().min(0),
});
export type SkillView = z.infer<typeof SkillView>;

export const SkillsView = z.object({ skills: z.array(SkillView).max(500) });
export type SkillsView = z.infer<typeof SkillsView>;

/**
 * `POST /api/screen/coach/recheck` (device token): "let me try pivot tables on my own", with the
 * screen. The words name the skill (or don't: the most overdue one).
 */
export const CoachRecheckRequest = z.object({
  words: z.string().trim().max(SCREEN_LIMITS.transcriptChars),
  app: AppName.nullable(),
  scope: z.enum(["window", "monitor"]),
  image: ScreenImage,
});
export type CoachRecheckRequest = z.infer<typeof CoachRecheckRequest>;
