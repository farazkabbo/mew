import { ClipView, type EntryTurn, type ImageBlock } from "@mew/shared";
import { describe, expect, it, vi } from "vitest";

import {
  entryFollowUps,
  entryToPage,
  IMAGE_ORIGIN,
  nextEntryTop,
  noteHeight,
  SOLUTION_ROOM,
  solutionRegion,
  today,
} from "./clip-page";
import { replayEntry, replaySteps, stepMs } from "./entry-replay";

const PAGE = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";

const stroke = (x: number, color = "#8a7bf0") => ({
  tool: "pen" as const,
  color,
  width: 3,
  points: [
    [x, 10, 0.5, 0],
    [x + 10, 20, 0.5, 8],
  ] as [number, number, number, number][],
});

const TURN_1 = {
  question: "Explain this",
  steps: ["This axis is velocity.", "So a flat part means constant speed."],
  summary: "A flat line means constant speed.",
  followUpQuestion: "What's the acceleration there?",
};
const TURN_2 = { question: "And this?", steps: ["That's the steep part."], summary: "Steep." };

function clip(
  turns: EntryTurn[] = [TURN_1],
  strokeSteps: [number, number][] = [
    [0, 0],
    [0, 1],
  ],
) {
  return ClipView.parse({
    id: "33333333-3333-4333-8333-333333333333",
    width: 1440,
    height: 800,
    pixelRatio: 1.5,
    strokes: strokeSteps.map((_, i) => stroke(100 * i)),
    source: { app: "msedge.exe", capturedAt: "2026-10-24T10:00:00.000Z" },
    ocrText: "velocity (m/s)",
    notebookPageId: null,
    createdAt: "2026-10-24T10:00:01.000+00:00",
    entry: {
      sessionId: SESSION,
      studentStrokes: [stroke(500, "#3b5b8c")],
      turns,
      strokeSteps,
      conceptHints: [],
    },
  });
}

function ids() {
  let n = 0;
  return { now: 1000, newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` };
}

describe("an entry on the page", () => {
  it("places the picture, the student's marks and the tutor's ink a group per step", () => {
    const { image, strokes } = entryToPage(clip(), PAGE, 300, ids());
    // 1440 px at 150 % is 960 CSS px, capped to the column (720): 0.5 page units per pixel.
    expect([image.x, image.y, image.width, image.height]).toEqual([IMAGE_ORIGIN[0], 300, 720, 400]);
    const student = strokes.filter((s) => s.author === "student");
    const tutor = strokes.filter((s) => s.author === "tutor");
    expect(student).toHaveLength(1);
    expect(student[0]?.color).toBe("#3b5b8c");
    expect(student[0]?.points[0]).toEqual([IMAGE_ORIGIN[0] + 250, 305, 0.5, 0]);
    expect(tutor.map((s) => s.groupId)).toEqual(image.entry?.stepGroups[0]);
    expect(image.entry).toMatchObject({ sessionId: SESSION, turns: [TURN_1], strokeCount: 2 });
  });

  it("stacks entries with room to write under each", () => {
    const first = entryToPage(clip(), PAGE, IMAGE_ORIGIN[1], ids()).image;
    const below = nextEntryTop([first]);
    expect(below).toBeGreaterThan(
      first.y + first.height + (first.entry ? noteHeight(first.entry, first.width) : 0),
    );
    expect(nextEntryTop([])).toBe(IMAGE_ORIGIN[1]);
  });

  it("keeps a worked solution saved from the screen, with room under the note for it (K7)", () => {
    const solution = {
      problem: { text: "3x + 7 = 19", latex: "3x + 7 = 19" },
      steps: [{ work: "3x = 12", latex: "3x = 12", why: "Subtract 7." }],
      finalAnswer: { text: "x = 4", latex: "x = 4" },
      yourTurn: null,
    };
    const base = clip();
    const solved = ClipView.parse({ ...base, entry: { ...base.entry, solution } });
    const { image } = entryToPage(solved, PAGE, IMAGE_ORIGIN[1], ids());
    expect(image.entry?.solution).toEqual(solution);

    const plain = entryToPage(clip(), PAGE, IMAGE_ORIGIN[1], ids()).image;
    expect(nextEntryTop([image]) - nextEntryTop([plain])).toBe(SOLUTION_ROOM);
    // The solution goes under the note, inside that room.
    const [, top, , height] = solutionRegion(image);
    const note = image.entry ? noteHeight(image.entry, image.width) : 0;
    expect(top).toBeGreaterThan(image.y + image.height + note);
    expect(top + height).toBeLessThanOrEqual(image.y + image.height + note + SOLUTION_ROOM);
  });

  it("adds a follow-up's turn and strokes to the same entry", () => {
    const { image } = entryToPage(clip(), PAGE, 300, ids());
    const later = clip(
      [TURN_1, TURN_2],
      [
        [0, 0],
        [0, 1],
        [1, 0],
      ],
    );
    const added = entryFollowUps(later, image, ids());
    expect(added?.strokes).toHaveLength(1);
    expect(added?.image.entry?.turns).toEqual([TURN_1, TURN_2]);
    expect(added?.image.entry?.strokeCount).toBe(3);
    expect(added?.strokes[0]?.groupId).toBe(added?.image.entry?.stepGroups[1]?.[0]);
    // Nothing new: nothing to add.
    expect(entryFollowUps(clip(), image, ids())).toBeNull();
  });

  it("names the day's page by the student's calendar", () => {
    expect(today(new Date(2026, 9, 4, 23, 30))).toBe("2026-10-04");
  });
});

describe("replaying an entry", () => {
  it("hides every step, then shows them one at a time, then all", () => {
    const { image } = entryToPage(
      clip(
        [TURN_1, TURN_2],
        [
          [0, 0],
          [0, 1],
          [1, 0],
        ],
      ),
      PAGE,
      300,
      ids(),
    );
    const entry = (image as ImageBlock & { entry: NonNullable<ImageBlock["entry"]> }).entry;
    const steps = replaySteps(entry);
    expect(steps.map(({ turn, step }) => [turn, step])).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
    ]);
    expect(stepMs(entry, steps[0]!)).toBe(1400);

    vi.useFakeTimers();
    const hidden: number[] = [];
    const shown: (string | null)[] = [];
    replayEntry(
      entry,
      (groups) => hidden.push(groups.size),
      (step) => shown.push(step ? `${step.turn}.${step.step}` : null),
    );
    vi.runAllTimers();
    vi.useRealTimers();
    expect(hidden).toEqual([3, 2, 1, 0, 0]);
    expect(shown).toEqual(["0.0", "0.1", "1.0", null]);
  });

  it("stops at once, showing everything", () => {
    const { image } = entryToPage(clip(), PAGE, 300, ids());
    vi.useFakeTimers();
    const hidden: number[] = [];
    const stop = replayEntry(
      image.entry!,
      (g) => hidden.push(g.size),
      () => undefined,
    );
    stop();
    vi.runAllTimers();
    vi.useRealTimers();
    expect(hidden).toEqual([2, 0]);
  });
});
