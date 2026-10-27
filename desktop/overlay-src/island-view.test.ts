import { describe, expect, it } from "vitest";

import { notchPath, parseIslandView } from "./island-view";

const VIEW = {
  tool: "select",
  shape: "ellipse",
  mic: true,
  silent: false,
  activity: "listening",
  clearable: true,
};

describe("parseIslandView", () => {
  it("takes the view Rust sends", () => {
    expect(parseIslandView(VIEW)).toEqual(VIEW);
  });

  it("refuses anything malformed", () => {
    expect(parseIslandView(null)).toBeNull();
    expect(parseIslandView({ ...VIEW, tool: "laser" })).toBeNull();
    expect(parseIslandView({ ...VIEW, shape: "star" })).toBeNull();
    expect(parseIslandView({ ...VIEW, mic: "yes" })).toBeNull();
    expect(parseIslandView({ ...VIEW, activity: "<b>hi</b>" })).toBeNull();
  });
});

describe("notchPath", () => {
  it("is flat along the top, with ears and round bottom corners", () => {
    expect(notchPath(476, 58, 12, 22)).toBe(
      "M0 0H476A12 12 0 0 0 464 12V36A22 22 0 0 1 442 58H34A22 22 0 0 1 12 36V12A12 12 0 0 0 0 0Z",
    );
  });

  it("keeps the curves inside a small window", () => {
    expect(notchPath(40, 20, 12, 22)).toBe(
      "M0 0H40A10 10 0 0 0 30 10V10A10 10 0 0 1 20 20H20A10 10 0 0 1 10 10V10A10 10 0 0 0 0 0Z",
    );
  });
});

describe("the island as drawn", () => {
  it("has a square top flush with the screen and round bottom corners", () => {
    expect(notchPath(476, 58, 0, 22)).toBe(
      "M0 0H476A0 0 0 0 0 476 0V36A22 22 0 0 1 454 58H22A22 22 0 0 1 0 36V0A0 0 0 0 0 0 0Z",
    );
  });
});
