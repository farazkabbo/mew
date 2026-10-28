import { describe, expect, it } from "vitest";

import { spacing, timelineDots } from "./SpacingTimeline";

const DAY = 86_400_000;

describe("When it comes back (NEB_APP_UI §5.5)", () => {
  it("says gaps the way people do", () => {
    expect(spacing(DAY)).toBe("1 day");
    expect(spacing(3 * DAY)).toBe("3 days");
    expect(spacing(7 * DAY)).toBe("1 week");
    expect(spacing(21 * DAY)).toBe("3 weeks");
    expect(spacing(60 * DAY)).toBe("2 months");
  });

  it("is saved, now, then the next date FSRS gave once answered", () => {
    const now = 10 * DAY;
    const before = timelineDots({ savedAt: now - 3 * DAY, now, nextDue: null });
    expect(before.map((d) => d.label)).toEqual([
      "saved",
      "3 days · now",
      "next",
      "1 week",
      "4 weeks",
    ]);
    const after = timelineDots({ savedAt: now - 3 * DAY, now, nextDue: now + 7 * DAY });
    expect(after.map((d) => [d.label, d.state])).toEqual([
      ["saved", "past"],
      ["3 days · now", "now"],
      ["1 week", "future"],
      ["3 weeks", "future"],
      ["2 months", "future"],
    ]);
  });
});
