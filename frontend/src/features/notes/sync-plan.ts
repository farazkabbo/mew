import { NOTES_LIMITS, type NotePageSync } from "@mew/shared";

import { type LocalNoteLine, syncKey, toUpsert } from "./local-lines";

export type PageRef = Pick<NotePageSync, "notebook" | "pageIndex">;

export type SyncBatch = {
  body: NotePageSync;
  /** For each line in the batch, the `syncKey` sent: it becomes the line's `synced` on success. */
  sent: Map<string, string>;
};

/** Whether the server's copy of these lines is out of date. */
export function needsSync(lines: readonly LocalNoteLine[]): boolean {
  return lines.some((line) => syncKey(line) !== line.synced);
}

/**
 * The requests that bring the server's copy of a page in line with these records (pure). Only
 * lines whose `syncKey` changed are sent: lines with text are added or changed, and lines the
 * server has but shouldn't (gone, blank, or changed and not recognised again yet) are removed.
 */
export function planSync(lines: readonly LocalNoteLine[], page: PageRef): SyncBatch[] {
  const upsert: { line: LocalNoteLine; key: string }[] = [];
  const remove: string[] = [];
  for (const line of lines) {
    const key = syncKey(line);
    if (key === line.synced) continue;
    if (key === "") remove.push(line.id);
    else upsert.push({ line, key });
  }

  const batches: SyncBatch[] = [];
  const count = Math.max(
    Math.ceil(upsert.length / NOTES_LIMITS.linesPerSync),
    Math.ceil(remove.length / NOTES_LIMITS.removedPerSync),
  );
  for (let i = 0; i < count; i++) {
    const ups = upsert.slice(i * NOTES_LIMITS.linesPerSync, (i + 1) * NOTES_LIMITS.linesPerSync);
    const rems = remove.slice(
      i * NOTES_LIMITS.removedPerSync,
      (i + 1) * NOTES_LIMITS.removedPerSync,
    );
    const sent = new Map<string, string>([
      ...ups.map(({ line, key }) => [line.id, key] as const),
      ...rems.map((id) => [id, ""] as const),
    ]);
    batches.push({
      body: {
        ...page,
        upsert: ups.map(({ line }) => toUpsert(line)).filter((u) => u !== null),
        remove: rems,
      },
      sent,
    });
  }
  return batches;
}

/**
 * Records after the server accepted a batch: each line sent is now synced, unless it changed
 * again meanwhile (then it's sent next time). Returns the records to save and the ids to delete
 * (lines that are gone and now gone from the server too).
 */
export function afterSync(
  lines: readonly LocalNoteLine[],
  sent: ReadonlyMap<string, string>,
): { save: LocalNoteLine[]; drop: string[] } {
  const save: LocalNoteLine[] = [];
  const drop: string[] = [];
  for (const line of lines) {
    const key = sent.get(line.id);
    if (key === undefined || syncKey(line) !== key) continue;
    if (line.removed && key === "") drop.push(line.id);
    else save.push({ ...line, synced: key });
  }
  return { save, drop };
}
