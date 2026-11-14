import { beforeEach, describe, expect, it, vi } from "vitest";

import { hrefOf, placeOf, stepsFor, TOUR_STEPS } from "./steps";
import { useTour } from "./store";
import { arrowPath, cardBox, place } from "./TourGuide";

const VIEW = { width: 1280, height: 800 };

/** This device's storage, where the tour keeps its place. */
const kept = new Map<string, string>();
const localStorage = {
  getItem: (key: string) => kept.get(key) ?? null,
  setItem: (key: string, value: string) => void kept.set(key, value),
  removeItem: (key: string) => void kept.delete(key),
};
vi.stubGlobal("window", { localStorage });

describe("the guided tour's steps (decision U32)", () => {
  it("walks the real app in the order a new student meets it", () => {
    expect(stepsFor(false).map((s) => s.id)).toEqual([
      "welcome",
      "notebook",
      "page",
      "write",
      "marks",
      "ask",
      "to-home",
      "home",
      "pdf",
      "back-home",
      "study-tab",
      "reading",
      "topics",
      "quiz",
      "answer",
      "to-desk",
      "review-open",
      "review",
      "done",
    ]);
  });

  it("adds Screen Coach in the Windows app only, before the end", () => {
    const extra = stepsFor(true)
      .map((s) => s.id)
      .filter((id) => !stepsFor(false).some((s) => s.id === id));
    expect(extra).toEqual(["coach", "island", "circle", "moments"]);
    expect(stepsFor(true).at(-1)?.id).toBe("done");
  });

  it("warns before every step that spends a question, and lets a PDF be skipped", () => {
    const noted = TOUR_STEPS.filter((s) => s.note).map((s) => s.id);
    expect(noted).toEqual(["ask", "pdf", "reading", "island", "circle"]);
  });

  it("lets the student pace the steps where something has to be watched or heard", () => {
    const paced = TOUR_STEPS.filter((s) => s.done.by === "next" && s.done.after).map((s) => s.id);
    expect(paced).toEqual(["write", "ask", "answer", "coach", "circle"]);
    // Only a finished import moves on by itself.
    expect(TOUR_STEPS.filter((s) => s.done.by === "signal").map((s) => s.id)).toEqual(["pdf"]);
  });

  it("goes from the PDF to a quiz before Review, and past them all without a PDF", () => {
    const ids = stepsFor(false).map((s) => s.id);
    expect(ids.indexOf("pdf")).toBeLessThan(ids.indexOf("quiz"));
    expect(ids.indexOf("answer")).toBeLessThan(ids.indexOf("review-open"));
    const needPdf = ["pdf", "back-home", "study-tab", "reading", "topics", "quiz", "answer"];
    for (const id of needPdf) {
      expect(TOUR_STEPS.find((s) => s.id === id)?.skipTo, id).toBe("to-desk");
    }
    useTour.setState({ stepId: "pdf" });
    useTour.getState().skip("pdf", "to-desk");
    expect(useTour.getState().stepId).toBe("to-desk");
  });

  it("points at a real control wherever the student has to press one", () => {
    for (const step of TOUR_STEPS) {
      if (step.done.by === "place") expect(step.target, step.id).toBeTruthy();
    }
  });
});

describe("where the student is", () => {
  it("reads the place from the address", () => {
    expect(placeOf("/desk", "")).toBe("desk");
    expect(placeOf("/review", "")).toBe("review");
    expect(placeOf("/notebook", "?node=abc")).toBe("home");
    expect(placeOf("/notebook", "?page=xyz")).toBe("page");
    expect(placeOf("/notebook", "")).toBeNull();
    expect(placeOf("/settings", "")).toBeNull();
  });

  it("can go back to the tour's notebook and page once they exist", () => {
    const none = { nodeId: null, pageId: null };
    expect(hrefOf("desk", none)).toBe("/desk");
    expect(hrefOf("home", none)).toBeNull();
    expect(hrefOf("home", { nodeId: "n1", pageId: null })).toBe("/notebook?node=n1");
    expect(hrefOf("page", { nodeId: "n1", pageId: "p1" })).toBe("/notebook?page=p1");
  });
});

describe("the tour's place in it", () => {
  beforeEach(() => useTour.getState().end());

  it("moves on only from the step that finished", () => {
    useTour.getState().start();
    expect(useTour.getState().stepId).toBe("welcome");
    useTour.getState().advance("welcome", false);
    expect(useTour.getState().stepId).toBe("notebook");
    // A late signal for an earlier step changes nothing.
    useTour.getState().advance("welcome", false);
    expect(useTour.getState().stepId).toBe("notebook");
    useTour.getState().back(false);
    expect(useTour.getState().stepId).toBe("welcome");
  });

  it("skips Screen Coach in the browser and ends after the last step", () => {
    useTour.setState({ stepId: "review" });
    useTour.getState().advance("review", false);
    expect(useTour.getState().stepId).toBe("done");
    useTour.getState().advance("done", false);
    expect(useTour.getState().stepId).toBeNull();

    useTour.setState({ stepId: "review" });
    useTour.getState().advance("review", true);
    expect(useTour.getState().stepId).toBe("coach");
  });

  it("remembers the notebook and page made on the way, and survives a reload", () => {
    useTour.getState().start();
    useTour.getState().visited({ nodeId: "n1" });
    useTour.getState().visited({ pageId: "p1" });
    expect(useTour.getState()).toMatchObject({ nodeId: "n1", pageId: "p1" });
    expect(JSON.parse(localStorage.getItem("neb.tour") ?? "{}")).toEqual({
      stepId: "welcome",
      nodeId: "n1",
      pageId: "p1",
    });
    useTour.getState().end();
    expect(localStorage.getItem("neb.tour")).toBeNull();
  });
});

describe("where the card and its arrow go", () => {
  const button = { top: 16, left: 1100, width: 150, height: 44 };

  it("sits under the control, kept on screen, with room for the arrow", () => {
    const spot = place(button, 200, VIEW);
    expect(spot).toEqual({ top: 16 + 44 + 46, left: 1280 - 340 - 16 });
  });

  it("goes above when there's no room below, and to the corner for a full page", () => {
    expect(place({ top: 700, left: 400, width: 120, height: 60 }, 200, VIEW)).toMatchObject({
      top: 700 - 46 - 200,
    });
    const corner = { right: 16, bottom: 16 };
    expect(place({ top: 80, left: 200, width: 800, height: 700 }, 200, VIEW)).toEqual(corner);
    expect(place(null, 200, VIEW)).toEqual(corner);
  });

  it("draws an arrow from the card to the control, pointing at it", () => {
    const spot = place(button, 200, VIEW);
    const arrow = arrowPath(cardBox(spot, 200, VIEW), button);
    expect(arrow?.d).toMatch(/^M[\d. ]+ Q[\d. ]+ M[\d. ]+ L[\d. ]+ L[\d. ]+$/);
    // The card is below the button, so the arrow points up.
    expect(arrow?.dy).toBeLessThan(0);
  });

  it("points into the page from the corner, and draws nothing when they touch", () => {
    const page = { top: 80, left: 200, width: 800, height: 700 };
    const card = cardBox(place(page, 200, VIEW), 200, VIEW);
    const arrow = arrowPath(card, page);
    expect(arrow).not.toBeNull();
    expect(arrow?.dx).toBeLessThan(0);
    expect(arrowPath({ top: 70, left: 100, width: 340, height: 200 }, button)).not.toBeNull();
    expect(
      arrowPath(
        { top: 60, left: 1000, width: 340, height: 200 },
        { top: 50, left: 1100, width: 150, height: 4 },
      ),
    ).toBeNull();
  });
});
