import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { tokensCss } from "@mew/shared";
import { describe, expect, it } from "vitest";

import { displayColor, INK_COLORS, TUTOR_INK } from "../features/notebook/palette";

const ROOT = path.resolve(import.meta.dirname, "../../..");

describe("design assets (NEB_APP_UI §3)", () => {
  it.each(["frontend/src/app/tokens.css", "desktop/shell/tokens.css"])(
    "%s is up to date with tokens.ts (run pnpm build:tokens)",
    (file) => {
      expect(readFileSync(path.join(ROOT, file), "utf8")).toBe(tokensCss());
    },
  );

  it("bundles the fonts under 180 KB, each with its licence", () => {
    const dir = path.join(ROOT, "packages/shared/fonts");
    const fonts = readdirSync(dir).filter((f) => f.endsWith(".woff2"));
    const total = fonts.reduce((sum, f) => sum + statSync(path.join(dir, f)).size, 0);
    expect(total).toBeLessThan(180 * 1024);
    for (const family of ["inter", "instrument-serif", "pixelify-sans", "caveat"]) {
      expect(fonts.some((f) => f.startsWith(family))).toBe(true);
      expect(readFileSync(path.join(dir, `OFL-${family}.txt`), "utf8")).toContain(
        "SIL Open Font License",
      );
    }
  });
});

describe("ink colours (decision U2)", () => {
  it("draws strokes saved in the old colours in today's", () => {
    expect(displayColor("#8a7bf0", false)).toBe(TUTOR_INK.light);
    expect(displayColor("#8A7BF0", true)).toBe(TUTOR_INK.dark);
    expect(displayColor("#1d1c1a", false)).toBe(INK_COLORS[0].light);
    expect(displayColor("#2f5fd0", true)).toBe(INK_COLORS[1].dark);
  });

  it("keeps today's colours, and any other colour, as they are", () => {
    expect(displayColor(TUTOR_INK.light, false)).toBe(TUTOR_INK.light);
    expect(displayColor(TUTOR_INK.light, true)).toBe(TUTOR_INK.dark);
    expect(displayColor("#123456", true)).toBe("#123456");
  });
});
