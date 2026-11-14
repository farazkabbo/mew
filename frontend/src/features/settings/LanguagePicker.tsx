"use client";

import { NEB_LANGUAGES, NebLanguage } from "@mew/shared";

/** The language neb listens and speaks in, saved to the account so the desktop app follows it. */
export function LanguagePicker({
  value,
  onChange,
}: {
  value: NebLanguage;
  onChange: (language: NebLanguage) => void;
}) {
  return (
    <fieldset className="space-y-3" data-testid="language-picker">
      <legend className="font-medium">Neb&apos;s language</legend>
      <div className="flex flex-wrap gap-2">
        {NebLanguage.options.map((choice) => (
          <label
            key={choice}
            className="flex cursor-pointer items-center gap-2 rounded-full border border-line px-4 py-2 text-sm has-checked:border-ink has-checked:bg-paper-hi"
          >
            <input
              type="radio"
              name="language"
              value={choice}
              checked={value === choice}
              onChange={() => onChange(choice)}
              className="accent-(--ink)"
            />
            {NEB_LANGUAGES[choice].label}
          </label>
        ))}
      </div>
      {value !== "en" && (
        <p className="text-sm text-muted">
          Neb listens and speaks in {NEB_LANGUAGES[value].name}. What it draws on the page stays in
          English.
        </p>
      )}
    </fieldset>
  );
}
