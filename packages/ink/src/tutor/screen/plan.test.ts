import type { BBox, ScreenAction, ScreenBox } from "@mew/shared";
import { describe, expect, it } from "vitest";

import { overlapsAny } from "../placement";
import {
  besideCandidates,
  boxToPixels,
  planScreenInk,
  pointToPixels,
  type ScreenInkInput,
  screenXHeight,
} from "./plan";

/** A 1920×1080 monitor at 150 % scaling: 2880×1620 physical pixels. */
const MONITOR: BBox = [0, 0, 2880, 1620];
const COLORS = { ink: "#8a7bf0", highlight: "#8a7bf055" };

/** Lines of text 24 px high every 40 px, between `left` and `right`, over the whole height. */
function textLines(left: number, right: number, top = 40, bottom = 1580): BBox[] {
  const lines: BBox[] = [];
  for (let y = top; y + 24 <= bottom; y += 40) lines.push([left, y, right - left, 24]);
  return lines;
}

/** A pixel rectangle on the monitor → normalised 0–1000 (frame = the monitor). */
function norm([x, y, w, h]: BBox, frame: BBox = MONITOR): ScreenBox {
  const nx = (v: number) => Math.round(((v - frame[0]) / frame[2]) * 1000);
  const ny = (v: number) => Math.round(((v - frame[1]) / frame[3]) * 1000);
  return { left: nx(x), top: ny(y), right: nx(x + w), bottom: ny(y + h) };
}

/** The question: three lines in the middle column of a PDF page (x 720–2160). */
const QUESTION: BBox = [760, 440, 1340, 104];

function input(obstacles: BBox[], overrides: Partial<ScreenInkInput> = {}): ScreenInkInput {
  return {
    frame: MONITOR,
    bounds: MONITOR,
    obstacles,
    textHeight: 24,
    scale: 1.5,
    seed: "turn-1",
    colors: COLORS,
    ...overrides,
  };
}

const focus = (box: BBox, kind: "question" | "video_frame" = "question"): ScreenAction => ({
  type: "focus_region",
  box: norm(box),
  kind,
});

const note = (text = "Draw the forces first"): ScreenAction => ({
  type: "margin_note",
  text,
  besideBox: norm(QUESTION),
  side: "auto",
});

function inkOf(plan: ReturnType<typeof planScreenInk>, type: ScreenAction["type"]): BBox {
  const action = plan.actions.find((a) => a.type === type);
  if (!action) throw new Error(`no ${type} in ${JSON.stringify(plan.skipped)}`);
  return action.bbox;
}

describe("coordinate mapping", () => {
  it("maps normalised boxes and points into the frame, including negative monitors", () => {
    const frame: BBox = [-2560, -200, 2560, 1440];
    expect(boxToPixels({ left: 0, top: 0, right: 1000, bottom: 1000 }, frame)).toEqual(frame);
    expect(boxToPixels({ left: 500, top: 250, right: 750, bottom: 500 }, frame)).toEqual([
      -1280, 160, 640, 360,
    ]);
    expect(pointToPixels({ x: 1000, y: 0 }, frame)).toEqual([0, -200]);
  });

  it("sizes handwriting from the text around it, scaled for the monitor", () => {
    expect(screenXHeight(undefined, 1)).toBe(10);
    expect(screenXHeight(undefined, 2)).toBe(20);
    expect(screenXHeight(24, 1.5)).toBeCloseTo(14.4);
    expect(screenXHeight(4, 1.5)).toBe(10.5); // never tiny
    expect(screenXHeight(200, 1)).toBe(16); // never shouting
  });
});

describe("notes beside content", () => {
  it("writes in the right margin of a PDF page, clear of every line of text", () => {
    const text = textLines(760, 2100);
    const plan = planScreenInk([focus(QUESTION), note()], input(text));
    const bbox = inkOf(plan, "margin_note");
    expect(bbox[0]).toBeGreaterThan(QUESTION[0] + QUESTION[2]);
    expect(overlapsAny(bbox, text)).toBe(false);
    expect(plan.actions[0]?.card).toBeUndefined();
    // Level with the question it's about.
    expect(bbox[1]).toBeLessThan(QUESTION[1] + QUESTION[3]);
  });

  it("uses the left margin when the right is full, then below, then a sticky note", () => {
    const rightFull = [...textLines(760, 2100), ...textLines(2150, 2880)];
    const left = inkOf(planScreenInk([focus(QUESTION), note()], input(rightFull)), "margin_note");
    expect(left[0] + left[2]).toBeLessThan(QUESTION[0]);
    expect(overlapsAny(left, rightFull)).toBe(false);

    // Text across the whole width, except a gap under the question.
    const sidesFull = [
      ...textLines(0, 2880, 40, QUESTION[1] + QUESTION[3]),
      ...textLines(0, 2880, QUESTION[1] + QUESTION[3] + 200),
    ];
    const below = inkOf(planScreenInk([focus(QUESTION), note()], input(sidesFull)), "margin_note");
    expect(below[1]).toBeGreaterThan(QUESTION[1] + QUESTION[3]);
    expect(overlapsAny(below, sidesFull)).toBe(false);

    const full = textLines(0, 2880);
    const plan = planScreenInk([focus(QUESTION), note()], input(full));
    const card = plan.actions[0]?.card;
    expect(card).toBeDefined();
    if (!card) return;
    // On the edge of the screen, off the question, with an arrow (3 strokes) pointing at it.
    expect(card[0] + card[2] > 2700 || card[0] < 180 || card[1] < 180 || card[1] > 1300).toBe(true);
    expect(overlapsAny(card, [QUESTION])).toBe(false);
    expect(plan.actions[0]?.strokes.length).toBeGreaterThan(3);
  });

  it("honours a requested side when it's free", () => {
    const plan = planScreenInk(
      [focus(QUESTION), { ...note(), side: "below" } as ScreenAction],
      input(textLines(760, 2100, 40, 400)),
    );
    expect(inkOf(plan, "margin_note")[1]).toBeGreaterThan(QUESTION[1] + QUESTION[3]);
  });

  it("never draws outside the monitor or the captured window", () => {
    const window: BBox = [400, 200, 1600, 1000];
    const besideBox = norm([1500, 400, 480, 100], window); // near the window's right edge
    const plan = planScreenInk(
      [{ type: "margin_note", text: "Units: newtons", besideBox, side: "right" }],
      input([], { frame: window }),
    );
    const bbox = inkOf(plan, "margin_note");
    expect(bbox[0]).toBeGreaterThanOrEqual(window[0]);
    expect(bbox[0] + bbox[2]).toBeLessThanOrEqual(window[0] + window[2]);
  });

  it("writes steps as maths when they look like LaTeX", () => {
    const plan = planScreenInk(
      [
        focus(QUESTION),
        {
          type: "write_step",
          latexOrText: "F = ma \\Rightarrow a = \\frac{F}{m}",
          besideBox: norm(QUESTION),
        },
      ],
      input(textLines(760, 2100)),
    );
    expect(plan.skipped).toEqual([]);
    expect(plan.actions[0]?.strokes.length).toBeGreaterThan(5);
  });
});

describe("videos", () => {
  /** A player filling the middle of the monitor; its controls and title are text. */
  const PLAYER: BBox = [480, 180, 1920, 1080];

  it("keeps notes outside the picture and points into it", () => {
    const plan = planScreenInk(
      [
        focus(PLAYER, "video_frame"),
        { type: "point_at", point: { x: 500, y: 400 }, label: "Electron shell" },
        {
          type: "margin_note",
          text: "Energy levels",
          besideBox: norm(PLAYER),
          side: "auto",
        },
      ],
      input([[480, 1300, 1920, 40]]),
    );
    const noteBox = inkOf(plan, "margin_note");
    expect(overlapsAny(noteBox, [PLAYER])).toBe(false);
    const arrow = plan.actions.find((a) => a.type === "point_at");
    expect(arrow).toBeDefined();
    // The label sits outside the player; the arrow's tip is inside it.
    const tip = arrow?.strokes.at(-1)?.points.at(-1);
    expect(tip && tip[0] > PLAYER[0] && tip[1] > PLAYER[1]).toBe(true);
    expect(plan.focus?.kind).toBe("video_frame");
  });
});

describe("arrows", () => {
  it("never drops an arrow's label: on a full page it goes on a sticky note", () => {
    // Text over the whole monitor, its gaps too small for a label.
    const full = textLines(0, 2880);
    const plan = planScreenInk(
      [{ type: "point_at", point: { x: 500, y: 600 }, label: "units" }],
      input(full),
    );
    const arrow = plan.actions[0];
    expect(arrow?.card).toBeDefined();
    // The label's letters plus a three-stroke arrow.
    expect(arrow?.strokes.length).toBeGreaterThan(5);
  });

  it("puts the label in free space when there is some nearby", () => {
    // A word near the right edge of the text column (it ends at 2100): the margin is in reach.
    const plan = planScreenInk(
      [{ type: "point_at", point: { x: 694, y: 500 }, label: "units" }],
      input(textLines(760, 2100)),
    );
    const arrow = plan.actions[0];
    expect(arrow?.card).toBeUndefined();
    expect(arrow?.strokes.length).toBeGreaterThan(5);
    const [x, , w] = arrow?.bbox ?? [0, 0, 0, 0];
    expect(x + w).toBeGreaterThan(2100);
  });
});

describe("shapes", () => {
  it("circles, underlines and highlights the boxes it's given", () => {
    const words: BBox = [900, 450, 300, 28];
    const plan = planScreenInk(
      [
        focus(QUESTION),
        { type: "circle_region", box: norm(words) },
        { type: "underline", box: norm(words) },
        { type: "highlight", box: norm(words) },
      ],
      input(textLines(760, 2100)),
    );
    expect(plan.skipped).toEqual([]);
    const [circle, underline, highlight] = plan.actions;
    expect(circle?.bbox[0]).toBeLessThan(words[0]);
    expect(circle?.bbox[2]).toBeGreaterThan(words[2]);
    expect(underline?.bbox[1]).toBeGreaterThan(words[1] + words[3] - 4);
    expect(highlight?.strokes[0]?.tool).toBe("highlighter");
    // Every point is a full [x, y, pressure, t]: saved clips are validated against that.
    for (const action of plan.actions) {
      for (const stroke of action.strokes) {
        for (const point of stroke.points) expect(point).toHaveLength(4);
      }
    }
    expect(highlight?.strokes[0]?.color).toBe(COLORS.highlight);
  });

  it("is reproducible for a turn and reports the crop around everything", () => {
    const actions = [
      focus(QUESTION),
      note(),
      { type: "circle_region", box: norm(QUESTION) },
    ] as const;
    const a = planScreenInk(actions, input(textLines(760, 2100)));
    const b = planScreenInk(actions, input(textLines(760, 2100)));
    expect(a).toEqual(b);
    const bbox = a.bbox;
    expect(bbox).not.toBeNull();
    if (!bbox) return;
    for (const action of a.actions) expect(overlapsAny(action.bbox, [bbox])).toBe(true);
    expect(bbox[0]).toBeLessThanOrEqual(QUESTION[0]);
  });

  it("skips what it can't draw and ignores clear and an empty reply", () => {
    expect(planScreenInk([], input([])).bbox).toBeNull();
    const plan = planScreenInk([{ type: "clear" }, note("\u{1F600}")], input([]));
    expect(plan.actions).toEqual([]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(["nothing drawable"]);
  });
});

describe("candidates beside a box", () => {
  it("steps outward on the requested side, nearest first", () => {
    const target: BBox = [100, 100, 200, 50];
    const [first] = besideCandidates([40, 20], target, "right", 10);
    expect(first).toEqual([310, 95]);
    const [left] = besideCandidates([40, 20], target, "left", 10);
    expect(left).toEqual([50, 95]);
    const [below] = besideCandidates([40, 20], target, "below", 10);
    expect(below).toEqual([100, 160]);
  });
});
