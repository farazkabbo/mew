import { type Line, type PageDocument } from "@mew/ink";
import {
  HANDWRITING_LIMITS,
  type HandwritingSampleInput,
  type HandwritingSampleSource,
} from "@mew/shared";

import { lineImage } from "../tutor/recognition";
import { handwritingApi } from "./api";

export type Correction = {
  /** What the line really says. */
  text: string;
  latex: string | null;
  /** What neb had read (null when it was read right). */
  readAs: string | null;
  source: Exclude<HandwritingSampleSource, "calibration">;
};

/**
 * Every correction teaches (K10 §8.3): fixing what neb read, confirming a "?" and "not wrong"
 * each save the line's picture and its real text to the student's handwriting profile. Nothing
 * is sent when "Learn my handwriting" is off, and a failure is dropped (it's a nicety).
 */
export class HandwritingTeacher {
  constructor(
    private readonly enabled: () => boolean,
    private readonly send: (samples: HandwritingSampleInput[]) => Promise<unknown> = (s) =>
      handwritingApi.add(s),
  ) {}

  async teach(doc: PageDocument, line: Line, correction: Correction): Promise<boolean> {
    if (!this.enabled()) return false;
    const text = correction.text.trim().slice(0, HANDWRITING_LIMITS.lineChars);
    if (!text) return false;
    const image = await lineImage(doc, line);
    if (!image || image.length > HANDWRITING_LIMITS.sampleImageChars) return false;
    const readAs = correction.readAs?.trim().slice(0, HANDWRITING_LIMITS.lineChars) || null;
    try {
      await this.send([
        {
          id: crypto.randomUUID(),
          text,
          latex: correction.latex?.trim().slice(0, HANDWRITING_LIMITS.lineChars) || null,
          readAs: readAs === text ? null : readAs,
          source: correction.source,
          image,
        },
      ]);
      return true;
    } catch {
      return false;
    }
  }
}
