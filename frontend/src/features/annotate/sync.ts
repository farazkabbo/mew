import { ANNOTATION_LIMITS, AnnotationSyncResult, toAnnotationUpsert } from "@mew/shared";

import type { AnnotationRecords } from "./records";

/** After a change, marks are sent this long later (several land together). */
const DEBOUNCE_MS = 3_000;
const RETRY_MS = 60_000;

/**
 * Sends the device's live annotations to the server (K9 §7.3): each mark once made, and again
 * when it resolves or is dismissed. Best effort and offline-safe: unsent marks stay marked as
 * unsynced and go at the next change or when the connection is back. The recognised text goes
 * only while the student lets neb keep their notes' text.
 */
export class AnnotationSync {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private readonly onOnline = () => this.soon(0);

  constructor(
    private readonly records: Pick<AnnotationRecords, "unsynced" | "markSynced">,
    private readonly keepText: () => boolean,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {
    globalThis.addEventListener?.("online", this.onOnline);
  }

  /** Something changed: send it shortly. */
  soon(ms = DEBOUNCE_MS): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), ms);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    globalThis.removeEventListener?.("online", this.onOnline);
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const batch = await this.records.unsynced(ANNOTATION_LIMITS.syncBatch);
        if (batch.length === 0) return;
        const keep = this.keepText();
        const response = await this.fetchImpl("/api/annotations", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ annotations: batch.map((a) => toAnnotationUpsert(a, keep)) }),
          cache: "no-store",
        }).catch(() => null);
        if (!response?.ok) {
          this.soon(RETRY_MS);
          return;
        }
        AnnotationSyncResult.parse(await response.json());
        await this.records.markSynced(batch);
        if (batch.length < ANNOTATION_LIMITS.syncBatch) return;
      }
    } finally {
      this.running = false;
    }
  }
}
