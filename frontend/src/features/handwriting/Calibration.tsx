"use client";

import { CALIBRATION_PROMPTS, type Point } from "@mew/shared";
import { Loader2 } from "lucide-react";
import { useRef, useState } from "react";

import { handwritingApi } from "./api";
import { calibrationSamples } from "./calibrate";
import { InkBox } from "./InkBox";

const GROUPS: { title: string; prompts: typeof CALIBRATION_PROMPTS }[] = [
  { title: "Digits", prompts: CALIBRATION_PROMPTS.slice(0, 10) },
  { title: "Letters", prompts: CALIBRATION_PROMPTS.slice(10, 15) },
  { title: "Symbols", prompts: CALIBRATION_PROMPTS.slice(15, 27) },
  { title: "A sentence", prompts: CALIBRATION_PROMPTS.slice(27) },
];

/**
 * Teach neb your handwriting (K10 §8.3): about 60 seconds of writing each digit, a few letters,
 * the maths symbols and one sentence, once, in its own box. Optional; neb also learns from every
 * correction.
 */
export function Calibration({
  onDone,
  skipLabel = "Skip",
}: {
  onDone(learned: number | null): void;
  skipLabel?: string;
}) {
  const written = useRef(new Map<string, Point[][]>());
  const [filled, setFilled] = useState(0);
  const [state, setState] = useState<"writing" | "saving" | "failed">("writing");

  const save = async () => {
    setState("saving");
    try {
      const entries = CALIBRATION_PROMPTS.map((prompt) => ({
        prompt,
        strokes: written.current.get(prompt.text) ?? [],
      }));
      const samples = await calibrationSamples(entries);
      const saved = samples.length > 0 ? await handwritingApi.add(samples) : 0;
      onDone(saved);
    } catch {
      setState("failed");
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="calibration">
      <p className="text-sm text-ink-muted">
        Write each one in its box, the way you normally write. It takes about a minute, and you can
        skip any box.
      </p>
      {GROUPS.map((group) => (
        <fieldset key={group.title} className="flex flex-col gap-2">
          <legend className="mb-1 text-xs font-semibold tracking-wide text-ink-muted uppercase">
            {group.title}
          </legend>
          <div className="flex flex-wrap gap-2">
            {group.prompts.map((prompt) => {
              const wide = prompt.text.length > 3;
              return (
                <label key={prompt.text} className="flex flex-col items-center gap-1 text-xs">
                  <span aria-hidden className="font-medium">
                    {prompt.text}
                  </span>
                  <InkBox
                    label={`Write ${prompt.text}`}
                    width={wide ? 420 : 44}
                    height={wide ? 64 : 52}
                    onChange={(strokes) => {
                      written.current.set(prompt.text, strokes);
                      setFilled(written.current.size);
                    }}
                  />
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={filled === 0 || state === "saving"}
          onClick={() => void save()}
          className="rounded-full bg-ink px-4 py-1.5 text-sm font-medium text-paper disabled:opacity-50"
        >
          {state === "saving" ? (
            <Loader2 className="inline size-4 animate-spin" aria-label="Saving" />
          ) : (
            "Teach neb"
          )}
        </button>
        <button
          type="button"
          onClick={() => onDone(null)}
          className="text-sm text-ink-muted hover:text-ink"
        >
          {skipLabel}
        </button>
        <span className="text-xs text-ink-muted" aria-live="polite">
          {filled} of {CALIBRATION_PROMPTS.length} written
        </span>
        {state === "failed" && (
          <span role="alert" className="text-sm text-ink-muted">
            Couldn&apos;t save that. Your writing is still here; try again.
          </span>
        )}
      </div>
    </div>
  );
}
