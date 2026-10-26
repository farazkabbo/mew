import type { CircleAskRequest, DestinationNode } from "@mew/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./env", () => ({ geminiEnv: () => ({ GEMINI_GATE_MODEL: "gate-model" }) }));

const {
  circleDestination,
  forgetDestinations,
  placesOf,
  rememberDestination,
  resolveForUser,
  stickyDestination,
} = await import("./destinations");

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const nodes: DestinationNode[] = [
  { id: id(1), parentId: null, title: "Physics", position: "a0" },
  { id: id(2), parentId: id(1), title: "Chapter 1 · Kinematics", position: "a0" },
  { id: id(3), parentId: id(1), title: "Chapter 2 · Forces", position: "a1" },
  { id: id(4), parentId: null, title: "Chemistry", position: "a1" },
  { id: id(5), parentId: null, title: "Old", position: "a2", deletedAt: 5 },
];
const quiet = { log: () => undefined };

function ask(text: string, source?: CircleAskRequest["source"]): CircleAskRequest {
  return {
    sessionId: id(99),
    question: { source: "voice", text },
    marks: [],
    focus: { image: { jpeg: "x", width: 1, height: 1 }, widthPx: 1, heightPx: 1 },
    context: { jpeg: "x", width: 1, height: 1 },
    blocks: [],
    app: "msedge.exe",
    kind: "video",
    ...(source && { source }),
    history: [],
  } as unknown as CircleAskRequest;
}

afterEach(() => forgetDestinations());

describe("destinations for the desktop app (K3)", () => {
  it("takes the place out of the question before the model sees it", async () => {
    const tree = vi.fn(() => Promise.resolve(nodes));
    const generate = vi.fn();
    const placed = await circleDestination(
      ask("why is this the hypotenuse? save it to my physics notebook chapter 2"),
      "user_a",
      "token",
      { ...quiet, generate, tree },
    );
    expect(placed.request.question).toEqual({
      source: "voice",
      text: "why is this the hypotenuse?",
    });
    expect(placed.event).toMatchObject({
      type: "destination",
      phrase: "my physics notebook chapter 2",
      resolution: { kind: "resolved", destination: { nodeId: id(3) } },
    });
    expect(generate).not.toHaveBeenCalled();

    // Only a save: "explain this".
    const only = await circleDestination(ask("save it to physics chapter 1"), "user_a", "token", {
      ...quiet,
      generate,
      tree,
    });
    expect(only.request.question).toEqual({ source: "none" });

    // A question about saving keeps its words (nothing of theirs is called "pdf").
    const about = await circleDestination(ask("why can't I save this to pdf"), "user_a", "token", {
      ...quiet,
      generate,
      tree,
    });
    expect(about.request.question).toEqual({
      source: "voice",
      text: "why can't I save this to pdf",
    });
    expect(about.event).toBeNull();
  });

  it("offers the source's sticky place for 2 hours", async () => {
    const source = { title: "Lecture 5", url: "https://www.youtube.com/watch?v=abcdefghijk&t=10" };
    const destination = {
      nodeId: id(2),
      page: { kind: "from_screen" as const },
      path: ["Physics", "Chapter 1 · Kinematics"],
    };
    rememberDestination("user_a", destination, { app: "msedge.exe", ...source }, 1_000);
    expect(stickyDestination("user_a", { app: "msedge.exe", ...source }, 2_000)).toMatchObject({
      nodeId: id(2),
      method: "sticky",
    });
    // The same video at another second is the same source; another student never sees it.
    const later = { ...source, url: "https://www.youtube.com/watch?v=abcdefghijk&t=99" };
    expect(stickyDestination("user_a", { app: "msedge.exe", ...later }, 3_000)).not.toBeNull();
    expect(stickyDestination("user_b", { app: "msedge.exe", ...source }, 3_000)).toBeNull();
    expect(
      stickyDestination("user_a", { app: "msedge.exe", ...source }, 1_000 + 2 * 3600_000 + 1),
    ).toBeNull();

    // Asked about the same video again now: "Saving to: Physics › Chapter 1" without a word.
    rememberDestination("user_a", destination, { app: "msedge.exe", ...source });
    const tree = vi.fn(() => Promise.resolve(nodes));
    const placed = await circleDestination(ask("why is this curved?", source), "user_a", "t", {
      ...quiet,
      generate: vi.fn(),
      tree,
    });
    expect(placed.event).toMatchObject({
      phrase: null,
      resolution: { kind: "resolved", destination: { nodeId: id(2), method: "sticky" } },
    });
    expect(tree).not.toHaveBeenCalled();
  });

  it("asks the model only for descriptions, and only takes the student's own ids", async () => {
    const generate = vi.fn<(request: { input: string }) => Promise<unknown>>(() =>
      Promise.resolve({ nodeId: id(3) }),
    );
    const described = await resolveForUser("user_a", "the one about forces and pushing", nodes, {
      ...quiet,
      generate: generate as never,
    });
    expect(described).toMatchObject({
      kind: "resolved",
      destination: { nodeId: id(3), method: "model", path: ["Physics", "Chapter 2 · Forces"] },
    });
    // Only live places, by id: never a trashed one.
    const request = generate.mock.calls[0]?.[0];
    expect(request?.input).not.toContain(id(5));

    // An id that isn't one of theirs (a schema slip, or worse) is never used.
    const stranger = vi.fn(() =>
      Promise.resolve({ nodeId: "11111111-1111-4111-8111-111111111111" }),
    );
    expect(
      await resolveForUser("user_a", "the one about forces and pushing", nodes, {
        ...quiet,
        generate: stranger as never,
      }),
    ).toEqual({ kind: "none" });

    // A name that isn't there: no model call.
    const unused = vi.fn();
    expect(
      await resolveForUser("user_a", "geography", nodes, { ...quiet, generate: unused }),
    ).toEqual({
      kind: "none",
    });
    expect(unused).not.toHaveBeenCalled();
  });

  it("lists the picker's places in tree order, without the trash", () => {
    expect(placesOf(nodes)).toEqual([
      { nodeId: id(1), path: ["Physics"] },
      { nodeId: id(2), path: ["Physics", "Chapter 1 · Kinematics"] },
      { nodeId: id(3), path: ["Physics", "Chapter 2 · Forces"] },
      { nodeId: id(4), path: ["Chemistry"] },
    ]);
  });
});
