import type { ClipView } from "@mew/shared";

/**
 * A moment's own voice (K8 §4.7: "Replay … with the original voice"). The page says Circle &
 * Ask's steps out loud (the desktop app hands it each line); it keeps what each line sounded like
 * for a while, and when the explanation is saved as an entry, the steps whose words it said are
 * uploaded with it. A replay then costs nothing and sounds the same; a step it didn't keep
 * (said before a reload, or too long) is replayed with its caption instead.
 */

/** About a minute of 24 kHz 16-bit speech, kept at most (the newest lines). */
const MAX_BYTES = 3_000_000;
const MAX_LINES = 40;
/** One step's voice, as the audio route takes it (about 20 s). */
export const MAX_STEP_BYTES = 1_000_000;
/** The turns and steps a moment keeps a voice for (the route's own bounds). */
const VOICED = { turns: 3, steps: 5 } as const;

const normalise = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

export class SpokenLines {
  private lines: { text: string; pcm: Uint8Array }[] = [];
  private bytes = 0;

  remember(text: string, sound: Uint8Array): void {
    // Whole 16-bit samples only (a stream cut short may end mid-sample).
    const pcm = sound.byteLength % 2 ? sound.subarray(0, sound.byteLength - 1) : sound;
    if (pcm.byteLength === 0 || pcm.byteLength > MAX_STEP_BYTES) return;
    this.lines.push({ text: normalise(text), pcm });
    this.bytes += pcm.byteLength;
    while (this.lines.length > MAX_LINES || this.bytes > MAX_BYTES) {
      const dropped = this.lines.shift();
      this.bytes -= dropped?.pcm.byteLength ?? 0;
    }
  }

  /** The newest voice for these words. */
  find(text: string): Uint8Array | null {
    const wanted = normalise(text);
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const line = this.lines[i];
      if (line?.text === wanted) return line.pcm;
    }
    return null;
  }
}

export type EntryVoiceDeps = {
  clip: (clipId: string) => Promise<ClipView>;
  upload: (clipId: string, turn: number, step: number, pcm: Uint8Array) => Promise<boolean>;
};

/**
 * Uploads the voice of every step of a saved entry that this page said and hasn't uploaded yet
 * (a follow-up saves the same entry again, with a turn more). `uploaded` remembers what went.
 */
export async function keepEntryVoice(
  clipId: string,
  lines: SpokenLines,
  uploaded: Set<string>,
  deps: EntryVoiceDeps,
): Promise<number> {
  const clip = await deps.clip(clipId);
  const turns = clip.entry?.turns ?? [];
  let sent = 0;
  for (const [t, turn] of turns.slice(0, VOICED.turns).entries()) {
    for (const [s, words] of turn.steps.slice(0, VOICED.steps).entries()) {
      const key = `${clipId}:${t}:${s}`;
      if (uploaded.has(key)) continue;
      const pcm = lines.find(words);
      if (!pcm) continue;
      uploaded.add(key);
      if (await deps.upload(clipId, t, s, pcm)) sent++;
      else uploaded.delete(key);
    }
  }
  return sent;
}

/** Reads a stream to the end, keeping its bytes (as many as `limit`; null past it). */
export async function collect(
  stream: ReadableStream<Uint8Array>,
  limit = MAX_STEP_BYTES,
): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
