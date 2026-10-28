"use client";

import { TEXT_SCALE } from "@mew/shared";
import { useEffect, useState } from "react";

import {
  type Appearance,
  readAppearance,
  readTextScale,
  setAppearance,
  setTextScale,
} from "@/lib/display";

import { Section } from "./controls";

const CHOICES: { value: Appearance; label: string }[] = [
  { value: "system", label: "Same as this device" },
  { value: "light", label: "Light" },
  { value: "night", label: "Night desk" },
];

/**
 * Appearance and text size (docs/NEB_APP_UI.md §3.1, §3.10). Kept on this device; exported pages
 * are always light, and the text size never changes the ink.
 */
export function DisplaySection() {
  const [appearance, setChoice] = useState<Appearance>("system");
  const [scale, setScale] = useState<number>(TEXT_SCALE.default);
  useEffect(() => {
    // localStorage exists only in the browser: read it after the first render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setChoice(readAppearance());
    setScale(readTextScale());
  }, []);

  return (
    <Section title="Appearance">
      <fieldset className="flex flex-wrap gap-2" data-testid="appearance">
        <legend className="sr-only">Appearance</legend>
        {CHOICES.map((choice) => (
          <label
            key={choice.value}
            className="flex cursor-pointer items-center gap-2 rounded-full border border-line px-4 py-2 text-sm has-checked:border-ink has-checked:bg-paper-hi"
          >
            <input
              type="radio"
              name="appearance"
              value={choice.value}
              checked={appearance === choice.value}
              onChange={() => {
                setChoice(choice.value);
                setAppearance(choice.value);
              }}
              className="accent-(--ink)"
            />
            {choice.label}
          </label>
        ))}
      </fieldset>
      <label className="flex flex-col gap-2 text-sm">
        <span>
          <span className="font-medium">Text size</span>{" "}
          <span className="text-muted tabular-nums">{Math.round(scale * 100)} %</span>
        </span>
        <input
          type="range"
          min={TEXT_SCALE.min}
          max={TEXT_SCALE.max}
          step={TEXT_SCALE.step}
          value={scale}
          onChange={(event) => {
            const next = Number(event.target.value);
            setScale(next);
            setTextScale(next);
          }}
          className="w-64 accent-(--ink)"
          aria-describedby="text-size-hint"
        />
        <span id="text-size-hint" className="text-muted">
          Makes buttons and words bigger or smaller. Your writing stays the size you wrote it.
        </span>
      </label>
    </Section>
  );
}
