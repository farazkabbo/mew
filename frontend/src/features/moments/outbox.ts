import { z } from "zod";

import { momentsApi } from "./api";

const KEY = "mew:moment-moves";
const Moves = z.array(z.object({ clipId: z.uuid(), nodeId: z.uuid() })).max(200);
type Moves = z.infer<typeof Moves>;

/**
 * Moments filed from the notebook while the server couldn't be reached (K8, decision 95): the
 * entry has moved on this device already; the server hears of it (its destination, filing's
 * memory, the check's place) when the connection is back. The latest move of a moment wins.
 */
export class MomentMoves {
  constructor(
    private readonly send: (clipId: string, nodeId: string) => Promise<unknown> = momentsApi.moved,
    private readonly storage: Pick<Storage, "getItem" | "setItem"> | null = safeStorage(),
  ) {}

  /** Tells the server now, or keeps it for later. */
  async moved(clipId: string, nodeId: string): Promise<boolean> {
    try {
      await this.send(clipId, nodeId);
      this.write(this.read().filter((m) => m.clipId !== clipId));
      return true;
    } catch {
      this.write([...this.read().filter((m) => m.clipId !== clipId), { clipId, nodeId }]);
      return false;
    }
  }

  /** Sends what's waiting (on load and when the connection comes back). */
  async flush(): Promise<void> {
    for (const move of this.read()) {
      if (!(await this.moved(move.clipId, move.nodeId))) return;
    }
  }

  pending(): Moves {
    return this.read();
  }

  private read(): Moves {
    try {
      const parsed = Moves.safeParse(JSON.parse(this.storage?.getItem(KEY) ?? "[]"));
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  }

  private write(moves: Moves): void {
    try {
      this.storage?.setItem(KEY, JSON.stringify(moves.slice(-200)));
    } catch {
      // Storage unavailable: the move reaches the server the next time it's tried, or not.
    }
  }
}

function safeStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
