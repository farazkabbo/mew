import { describe, expect, it } from "vitest";

import { glyph, withGlyphOverrides } from "../tutor/glyphs/font";
import {
  bytesToBase64,
  encodePng,
  type InkLike,
  prepareLine,
  prepareLineAsDrawn,
  rasterize,
  RECOGNITION_RENDER,
  storedDeflate,
} from ".";

const stroke = (...pts: [number, number][]) => ({ points: pts.map(([x, y]) => [x, y, 0.5, 0]) });

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected a value");
  return value;
}

/** Four "letters" 10 tall, each 5 wide, along a baseline that rises `rise` per unit across. */
function slantedLine(rise: number) {
  return [0, 20, 40, 60].map((x) =>
    stroke([x, 100 - rise * x - 10], [x + 5, 100 - rise * (x + 5)], [x, 100 - rise * x]),
  );
}

const scaled = (strokes: InkLike[], k: number): InkLike[] =>
  strokes.map((s) => ({ points: s.points.map((p) => p.map((v) => v * k)) }));

describe("prepareLine", () => {
  it("returns null without ink", () => {
    expect(prepareLine([])).toBeNull();
    expect(prepareLine([{ points: [] }])).toBeNull();
  });

  it("scales letters to the same size whatever the page zoom", () => {
    const small = must(prepareLine(slantedLine(0)));
    const big = must(prepareLine(scaled(slantedLine(0), 4)));
    expect(small.height).toBe(big.height);
    expect(small.width).toBe(big.width);
    // A letter is about letterPx tall, plus the margins.
    expect(small.height).toBeCloseTo(
      RECOGNITION_RENDER.letterPx + 2 * RECOGNITION_RENDER.padPx,
      -1,
    );
  });

  it("removes a rising baseline", () => {
    const flat = must(prepareLine(slantedLine(0)));
    const rising = must(prepareLine(slantedLine(0.15)));
    expect(rising.skewDegrees).toBeCloseTo((Math.atan(0.15) * 180) / Math.PI, 0);
    // Deskewed, the line is about as tall as the flat one.
    expect(rising.height).toBeLessThan(flat.height * 1.3);
  });

  it("leaves a steep 'line' alone", () => {
    expect(must(prepareLine(slantedLine(1))).skewDegrees).toBe(0);
  });

  it("gives every stroke the same pen width", () => {
    expect(must(prepareLine(slantedLine(0))).penWidth).toBe(RECOGNITION_RENDER.penPx);
  });

  it("keeps a very long line within the image limits", () => {
    const long = Array.from({ length: 400 }, (_, i) => stroke([i * 20, 0], [i * 20 + 5, 10]));
    expect(must(prepareLine(long)).width).toBeLessThanOrEqual(RECOGNITION_RENDER.maxWidthPx + 1);
  });
});

describe("prepareLineAsDrawn (the old pipeline, for the eval's baseline)", () => {
  it("keeps the strokes' own width, unrotated", () => {
    const line = must(prepareLineAsDrawn([{ ...stroke([0, 0], [100, 50]), width: 3 }]));
    expect(line.skewDegrees).toBe(0);
    expect(line.penWidth).toBeGreaterThan(3);
  });
});

describe("rasterize + encodePng", () => {
  it("draws ink on white", () => {
    const line = must(prepareLine([stroke([0, 0], [0, 10])]));
    const image = rasterize(line);
    expect(image.pixels.length).toBe(line.width * line.height);
    expect(Math.min(...image.pixels)).toBe(0);
    expect(image.pixels[0]).toBe(255);
  });

  it("writes a valid greyscale PNG", async () => {
    const image = { width: 3, height: 2, pixels: Uint8Array.from([0, 128, 255, 255, 128, 0]) };
    const png = await encodePng(image, storedDeflate);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(png.buffer);
    expect(view.getUint32(16)).toBe(3);
    expect(view.getUint32(20)).toBe(2);
    const idatLength = view.getUint32(33);
    // One stored block: a 2-byte zlib header and a 5-byte block header before the rows.
    expect(idatLength).toBe(2 + 5 + 8 + 4);
    expect([...png.subarray(41 + 7, 41 + idatLength - 4)]).toEqual([
      0, 0, 128, 255, 0, 255, 128, 0,
    ]);
  });
});

describe("withGlyphOverrides", () => {
  it("replaces a glyph only inside the call", () => {
    const one = must(glyph("1"));
    expect(withGlyphOverrides(new Map([["7", one]]), () => glyph("7"))).toBe(one);
    expect(glyph("7")).not.toBe(one);
  });
});

describe("bytesToBase64", () => {
  it("matches the standard alphabet and padding", () => {
    const enc = (s: string) => bytesToBase64(Uint8Array.from(s, (c) => c.charCodeAt(0)));
    expect(enc("")).toBe("");
    expect(enc("f")).toBe("Zg==");
    expect(enc("fo")).toBe("Zm8=");
    expect(enc("foo")).toBe("Zm9v");
    expect(enc("ÿþý")).toBe("//79");
  });
});
