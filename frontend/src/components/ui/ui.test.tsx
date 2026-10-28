import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Button, buttonClass } from "./Button";
import { Keycap, Keys } from "./Keycap";
import { NebDot, nebDotLabel, type NebDotState } from "./NebDot";

describe("Button (§3.5)", () => {
  it("is a real button, 44 px tall, ink by default", () => {
    const html = renderToStaticMarkup(<Button>Resume</Button>);
    expect(html).toContain('type="button"');
    expect(html).toContain("h-11");
    expect(html).toContain("bg-ink text-paper");
  });

  it("keeps a 44 px hit area when dense", () => {
    const dense = buttonClass("quiet", { dense: true });
    expect(dense).toContain("h-9");
    expect(dense).toContain("after:-inset-y-1");
  });

  it("is violet only for what neb offers", () => {
    const classes = (["ink", "ghost", "quiet", "danger"] as const).map((v) => buttonClass(v));
    expect(classes.some((c) => /\bneb\b|bg-neb/.test(c))).toBe(false);
    expect(buttonClass("neb")).toContain("bg-neb");
  });
});

describe("Keycap (§3.6)", () => {
  it("is a <kbd>, and shows a held key in neb's wash", () => {
    expect(renderToStaticMarkup(<Keycap>Alt</Keycap>)).toMatch(/^<kbd[^>]*>Alt<\/kbd>$/);
    const held = renderToStaticMarkup(<Keycap pressed>Ctrl</Keycap>);
    expect(held).toContain('data-pressed="true"');
    expect(held).toContain("bg-neb-wash");
  });

  it("writes Ctrl + K as two caps", () => {
    const html = renderToStaticMarkup(<Keys keys={["Ctrl", "K"]} />);
    expect(html.match(/<kbd/g)).toHaveLength(2);
  });
});

describe("NebDot (§3.8)", () => {
  const states: NebDotState[] = [
    "off",
    "watching",
    "thinking",
    "has-note",
    "speaking",
    "listening",
  ];

  it.each(states)("says what neb is doing to a screen reader (%s)", (state) => {
    const html = renderToStaticMarkup(<NebDot state={state} notes={2} />);
    expect(html).toContain(`data-neb-dot="${state}"`);
    expect(html).toContain(`<span class="sr-only">${nebDotLabel(state, 2)}</span>`);
  });

  it("is a hollow grey ring when off, and violet otherwise", () => {
    expect(renderToStaticMarkup(<NebDot state="off" />)).toContain("border-muted");
    expect(renderToStaticMarkup(<NebDot state="watching" />)).toContain("bg-neb");
  });

  it("counts unresolved notes on its badge and label", () => {
    const html = renderToStaticMarkup(<NebDot state="has-note" notes={3} label />);
    expect(html).toContain(">3</span>");
    expect(html).toContain("3 notes");
    expect(nebDotLabel("has-note", 1)).toBe("neb has 1 note");
  });

  it("moves only under motion-safe (reduced motion: still)", () => {
    const html = renderToStaticMarkup(
      <>
        <NebDot state="watching" />
        <NebDot state="thinking" />
        <NebDot state="listening" />
      </>,
    );
    const animations = html.match(/[\w:-]*animate-\[[^\]]+\]/g) ?? [];
    expect(animations.length).toBeGreaterThan(0);
    expect(animations.every((a) => a.startsWith("motion-safe:"))).toBe(true);
  });
});
