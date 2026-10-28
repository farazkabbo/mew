import { describe, expect, it } from "vitest";

import { COLORS, contrast, COVER_COLORS, TEXT_PAIRS, tokensCss } from "./tokens";

describe("design tokens (NEB_APP_UI §3)", () => {
  it.each(["light", "night"] as const)(
    "every text colour reaches 4.5:1 on its background (%s)",
    (theme) => {
      for (const [text, background] of TEXT_PAIRS) {
        const ratio = contrast(COLORS[theme][text], COLORS[theme][background]);
        expect(ratio, `${theme}: ${text} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it("knows the WCAG ratio", () => {
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21);
    expect(contrast("#777777", "#777777")).toBe(1);
  });

  it("keeps violet for neb only: no cover colour is violet", () => {
    const hue = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [
        number,
        number,
        number,
      ];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max === min) return null;
      const d = max - min;
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    for (const { name, hex } of COVER_COLORS) {
      const h = hue(hex);
      expect(h === null || h < 240 || h > 290, `${name} ${hex}`).toBe(true);
    }
  });

  it("writes light on :root, and night for the OS's dark mode or the student's choice", () => {
    const css = tokensCss();
    expect(css).toContain("--neb: #6B4EE6;");
    expect(css).toContain(
      '@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"])',
    );
    expect(css).toContain(':root[data-theme="night"]');
    expect(css.match(/--neb: #9C86FF;/g)).toHaveLength(2);
  });
});
