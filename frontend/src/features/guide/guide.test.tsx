import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Guide } from "./Guide";

describe("How to use neb (decision U30)", () => {
  const html = renderToStaticMarkup(<Guide />);

  it("names the buttons a student presses to get from a PDF to a quiz, in order", () => {
    const at = (text: string) => html.indexOf(text);
    const path = ["Add course material", "Use as course material", "Start studying", "Quiz me"];
    for (const label of path) expect(at(label), label).toBeGreaterThan(-1);
    expect(path.map(at)).toEqual([...path.map(at)].sort((a, b) => a - b));
  });

  it("says coach mode isn't the PDF quiz, and where handwriting is redone", () => {
    expect(html).toContain("Coach mode");
    expect(html).toContain("won&#x27;t quiz you on a PDF");
    expect(html).toContain("Calibrate again");
  });

  it("links every chip at the top to a section on the page", () => {
    const targets = [...html.matchAll(/href="#([a-z-]+)"/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(5);
    for (const id of targets) expect(html).toContain(`id="${id}"`);
  });
});
