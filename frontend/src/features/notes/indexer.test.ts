import "fake-indexeddb/auto";

import { type Line, type PageDocument } from "@mew/ink";
import type { NotePageSync, Recognition, Stroke } from "@mew/shared";
import { beforeEach, describe, expect, it } from "vitest";

import { NotebookDb } from "../notebook/db";
import { strokesOf } from "../notebook/export-line";
import { NoteBackfill } from "./backfill";
import { type IndexedPage, NoteIndexer, type SyncOutcome } from "./indexer";
import { LocalNoteLines } from "./local-lines";
import { docOf, PAGE_ID, recognised, writtenLine } from "./test-helpers";

const REF = {
  notebook: { id: "11111111-1111-4111-8111-111111111111", title: "Biology", courseId: null },
  pageIndex: 0,
};

/** Recognition that reads each line's first stroke id from a script, and counts its calls. */
class FakeRecognition {
  readonly canBatch = true;
  readonly singles: number[] = [];
  readonly batches: number[] = [];
  readonly remembered: string[] = [];
  private readonly cache = new Map<string, Recognition>();
  /** What each line "says", by its first stroke; a line not listed is skipped by the model. */
  constructor(private readonly script: Map<string, string>) {}

  private read(doc: PageDocument, line: Line): Recognition | null {
    const text = this.script.get(strokesOf(doc, [line])[0]?.id ?? "");
    return text === undefined ? null : recognised(text);
  }
  async recognize(doc: PageDocument, line: Line) {
    this.singles.push(1);
    return this.read(doc, line);
  }
  async recognizeMany(doc: PageDocument, lines: readonly Line[]) {
    this.batches.push(lines.length);
    return lines.map((line) => this.read(doc, line));
  }
  cached(_doc: PageDocument, line: Line) {
    return this.cache.get(line.strokeIds.join());
  }
  remember(_doc: PageDocument, line: Line, recognition: Recognition) {
    this.remembered.push(recognition.text);
    this.cache.set(line.strokeIds.join(), recognition);
  }
}

class FakeServer {
  readonly bodies: NotePageSync[] = [];
  outcome: SyncOutcome = "ok";
  async sync(_pageId: string, body: NotePageSync): Promise<SyncOutcome> {
    this.bodies.push(body);
    return this.outcome;
  }
}

let counter = 0;
let lines: LocalNoteLines;
let server: FakeServer;
let enabled: boolean;

beforeEach(() => {
  lines = new LocalNoteLines(new NotebookDb(`notes_${++counter}`));
  server = new FakeServer();
  enabled = true;
});

function indexerWith(recognition: FakeRecognition): NoteIndexer {
  return new NoteIndexer({
    lines,
    recognition,
    pageRef: async () => REF,
    sync: (pageId, body) => server.sync(pageId, body),
    syncEnabled: () => enabled,
    newId: () => crypto.randomUUID(),
  });
}

function page(strokes: Stroke[]): IndexedPage {
  return { id: PAGE_ID, doc: docOf(strokes), images: [] };
}

function script(entries: [Stroke[], string][]): Map<string, string> {
  return new Map(entries.map(([strokes, text]) => [strokes[0]?.id ?? "", text]));
}

const AFTER_PAUSE = { recognize: 9, currentFirst: true } as const;

describe("NoteIndexer", () => {
  const top = writtenLine(100, 1_000);
  const bottom = writtenLine(200, 5_000);
  const third = writtenLine(300, 9_000);

  it("reads the newest line alone, the rest in one batch, then syncs them once", async () => {
    const recognition = new FakeRecognition(
      script([
        [top, "enzymes lower activation energy"],
        [bottom, "they are used up"],
        [third, "optimum temperature"],
      ]),
    );
    const indexer = indexerWith(recognition);
    await indexer.index(page([...top, ...bottom, ...third]), AFTER_PAUSE);

    expect(recognition.singles).toEqual([1]);
    expect(recognition.batches).toEqual([2]);
    const stored = await lines.forPage(PAGE_ID);
    expect(stored.map((l) => l.recognition?.text).sort()).toEqual([
      "enzymes lower activation energy",
      "optimum temperature",
      "they are used up",
    ]);
    expect(server.bodies).toHaveLength(1);
    expect(server.bodies[0]?.upsert.map((u) => u.lineIndex).sort()).toEqual([0, 1, 2]);

    // Nothing changed: no recognition, no request.
    await indexer.index(page([...top, ...bottom, ...third]), AFTER_PAUSE);
    expect(recognition.singles).toEqual([1]);
    expect(server.bodies).toHaveLength(1);
  });

  it("keeps everything on the device when the student turned the copy off", async () => {
    enabled = false;
    const indexer = indexerWith(new FakeRecognition(script([[top, "a note"]])));
    await indexer.index(page(top), AFTER_PAUSE);
    expect(server.bodies).toEqual([]);
    expect((await lines.forPage(PAGE_ID))[0]?.recognition?.text).toBe("a note");
  });

  it("sends the same changes again after a failed sync", async () => {
    server.outcome = "failed";
    const indexer = indexerWith(new FakeRecognition(script([[top, "a note"]])));
    await indexer.index(page(top), AFTER_PAUSE);
    server.outcome = "ok";
    await indexer.index(page(top), { recognize: 0, currentFirst: false });
    expect(server.bodies.map((b) => b.upsert.length)).toEqual([1, 1]);
    await indexer.index(page(top), { recognize: 0, currentFirst: false });
    expect(server.bodies).toHaveLength(2);
  });

  it("withdraws an erased line from the server, then forgets it", async () => {
    const indexer = indexerWith(
      new FakeRecognition(
        script([
          [top, "a"],
          [bottom, "b"],
        ]),
      ),
    );
    await indexer.index(page([...top, ...bottom]), AFTER_PAUSE);
    const bottomId = server.bodies[0]?.upsert.find((u) => u.text === "b")?.id;

    await indexer.index(page(top), AFTER_PAUSE);
    // The top line is unchanged (still line 0), so only the removal is sent.
    expect(server.bodies[1]).toMatchObject({ upsert: [], remove: [bottomId] });
    expect((await lines.forPage(PAGE_ID)).map((l) => l.recognition?.text)).toEqual(["a"]);
  });

  it("withdraws a line while it's being rewritten, and sends it again once read", async () => {
    const changed = [
      ...top,
      ...writtenLine(100, 1_400, 1).map((s) => ({
        ...s,
        bbox: [170, 99, 30, 4] as Stroke["bbox"],
      })),
    ];
    const recognition = new FakeRecognition(script([[top, "used up"]]));
    const indexer = indexerWith(recognition);
    await indexer.index(page(top), AFTER_PAUSE);
    const id = server.bodies[0]?.upsert[0]?.id;

    // Edited, but the model is busy (no result): the old text must not stay on the server.
    const busy = new FakeRecognition(new Map());
    const busyIndexer = indexerWith(busy);
    await busyIndexer.index(page(changed), AFTER_PAUSE);
    expect(server.bodies[1]).toMatchObject({ upsert: [], remove: [id] });

    await indexerWith(new FakeRecognition(script([[top, "not used up"]]))).index(
      page(changed),
      AFTER_PAUSE,
    );
    expect(server.bodies[2]?.upsert).toMatchObject([{ id, text: "not used up" }]);
  });

  it("stops asking about a line it couldn't read twice while the model was reachable", async () => {
    const recognition = new FakeRecognition(
      script([
        [top, "a"],
        [third, "c"],
      ]),
    ); // bottom is unreadable
    const indexer = indexerWith(recognition);
    const strokes = [...top, ...bottom, ...third];
    await indexer.index(page(strokes), AFTER_PAUSE);
    expect(await indexer.hasWork(page(strokes))).toBe(true);
    await indexer.index(page(strokes), { recognize: 8, currentFirst: false });
    expect(await indexer.hasWork(page(strokes))).toBe(false);
  });

  it("gives the tutor the stored text of a reopened page without asking the model", async () => {
    await indexerWith(new FakeRecognition(script([[top, "stored text"]]))).index(
      page(top),
      AFTER_PAUSE,
    );
    const fresh = new FakeRecognition(new Map());
    await indexerWith(fresh).index(page(top), { recognize: 0, currentFirst: false });
    expect(fresh.remembered).toEqual(["stored text"]);
    expect(fresh.singles).toEqual([]);
  });
});

describe("NoteBackfill", () => {
  const top = writtenLine(100, 1_000);
  const bottom = writtenLine(200, 5_000);

  function backfillWith(recognition: FakeRecognition, ready = () => true) {
    const indexer = indexerWith(recognition);
    const pages = new Map([[PAGE_ID, page([...top, ...bottom])]]);
    let forgot = 0;
    const backfill = new NoteBackfill({
      indexer,
      candidatePages: async () => [...pages.keys()],
      pagesToSync: () => lines.pagesToSync(),
      loadPage: async (id) => pages.get(id) ?? null,
      ready,
      syncEnabled: () => enabled,
      forgetSynced: async () => {
        forgot++;
        await lines.forgetSynced();
      },
    });
    return { backfill, forgot: () => forgot };
  }

  it("catches up a page in one batch, then leaves it alone", async () => {
    const recognition = new FakeRecognition(
      script([
        [top, "a"],
        [bottom, "b"],
      ]),
    );
    const { backfill } = backfillWith(recognition);
    await backfill.tick();
    expect(recognition.singles).toEqual([]);
    expect(recognition.batches).toEqual([2]);
    expect(server.bodies).toHaveLength(1);
    await backfill.tick();
    await backfill.tick();
    expect(recognition.batches).toEqual([2]);
  });

  it("does nothing while the student or the model is busy", async () => {
    const recognition = new FakeRecognition(script([[top, "a"]]));
    const { backfill } = backfillWith(recognition, () => false);
    await backfill.tick();
    expect(recognition.batches).toEqual([]);
  });

  it("forgets what was synced when the copy is turned off, and sends it all again when it's back on", async () => {
    const recognition = new FakeRecognition(
      script([
        [top, "a"],
        [bottom, "b"],
      ]),
    );
    const { backfill, forgot } = backfillWith(recognition);
    await backfill.tick();
    enabled = false;
    await backfill.tick();
    expect(forgot()).toBe(1);
    expect((await lines.forPage(PAGE_ID)).map((l) => l.synced)).toEqual(["", ""]);
    enabled = true;
    await backfill.tick();
    expect(server.bodies.map((b) => b.upsert.length)).toEqual([2, 2]);
  });
});
