import { describe, expect, it } from "vitest";

import { circleImagePlan, needsScreen } from "./routing";

describe("how much of the screen a question needs", () => {
  it.each([
    "what does this button do?",
    "how do I make a pivot table",
    "explain step 2",
    "why is the answer 4 here",
    "",
  ])("looks at the screen for %j", (question) => {
    expect(needsScreen(question)).toBe(true);
  });

  it.each(["what's the difference between weather and climate?", "who wrote Hamlet", "hello"])(
    "answers %j without it",
    (question) => {
      expect(needsScreen(question)).toBe(false);
    },
  );

  it("always looks in other languages: the rules only know English", () => {
    expect(needsScreen("quelle est la différence entre météo et climat ?", "fr")).toBe(true);
  });

  it("sends a circled line's words without the window around it", () => {
    expect(circleImagePlan("explain", [{ text: "3x + 7 = 19" }], "browser")).toEqual({
      focus: "medium",
      context: null,
    });
  });

  it("keeps the window for figures, videos and where-questions", () => {
    expect(circleImagePlan("explain", [{ text: "" }], "browser").context).toBe("low");
    expect(circleImagePlan("explain", [{ text: "velocity" }], "video").context).toBe("low");
    expect(circleImagePlan("where is the save button", [{ text: "Save" }], "app").context).toBe(
      "medium",
    );
  });
});
