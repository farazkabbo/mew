import { describe, expect, it } from "vitest";

import { notchPath, parseIslandView, parseMusicView, pressedByPen } from "./island-view";

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

const ID = "37i9dQZF1DXcBWIGoYBM5M";
const MUSIC = {
  now: {
    title: "Song",
    artist: "Artist",
    player: "Spotify",
    playing: true,
    can_previous: false,
    can_next: true,
    art: "data:image/png;base64,iVBORw0KGgo=",
  },
  pins: [{ kind: "playlist", id: ID, name: "Deep Focus" }],
  notice: null,
  pinning: false,
};

describe("parseMusicView", () => {
  it("takes the panel Rust sends", () => {
    expect(parseMusicView(MUSIC)).toEqual({
      now: {
        title: "Song",
        artist: "Artist",
        player: "Spotify",
        playing: true,
        canPrevious: false,
        canNext: true,
        art: "data:image/png;base64,iVBORw0KGgo=",
      },
      pins: [{ kind: "playlist", id: ID, name: "Deep Focus" }],
      notice: null,
      pinning: false,
    });
    expect(parseMusicView({ ...MUSIC, now: null, pins: [] })?.now).toBeNull();
  });

  it("refuses anything malformed", () => {
    const now = MUSIC.now;
    expect(parseMusicView(null)).toBeNull();
    expect(parseMusicView({ ...MUSIC, now: { ...now, playing: "yes" } })).toBeNull();
    expect(parseMusicView({ ...MUSIC, now: { ...now, title: "x".repeat(400) } })).toBeNull();
    expect(parseMusicView({ ...MUSIC, pins: "none" })).toBeNull();
    expect(parseMusicView({ ...MUSIC, pins: [{ kind: "track", id: ID, name: "x" }] })).toBeNull();
    expect(
      parseMusicView({ ...MUSIC, pins: [{ kind: "playlist", id: "../x", name: "x" }] }),
    ).toBeNull();
    expect(parseMusicView({ ...MUSIC, pins: Array(7).fill(MUSIC.pins[0]) })).toBeNull();
  });

  it("shows only album art Rust checked", () => {
    for (const art of [
      "https://i.scdn.co/image/abc",
      "data:image/svg+xml;base64,PHN2Zz4=",
      'data:image/png;base64,abc" onerror="x',
      "javascript:alert(1)",
    ]) {
      expect(parseMusicView({ ...MUSIC, now: { ...MUSIC.now, art } })).toBeNull();
    }
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

describe("pressedByPen", () => {
  it("is true only for a pen", () => {
    const event = (pointerType?: string) =>
      Object.assign(new Event("x"), pointerType === undefined ? {} : { pointerType });
    expect(pressedByPen(event("pen"))).toBe(true);
    expect(pressedByPen(event("mouse"))).toBe(false);
    expect(pressedByPen(event("touch"))).toBe(false);
    expect(pressedByPen(event())).toBe(false);
  });
});
