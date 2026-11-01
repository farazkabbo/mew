"use client";

import { useEffect, useState } from "react";

const LANGUAGES = ["Bengali", "English", "French", "Mandarin"] as const;
type Language = (typeof LANGUAGES)[number];

const STORAGE_KEY = "neb.language";

function readLanguage(): Language {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return LANGUAGES.find((language) => language === stored) ?? "English";
  } catch {
    return "English";
  }
}

/**
 * Neb's language. Only the choice for now, kept on this device: nothing reads it yet, so Neb still
 * speaks and writes English.
 */
export function LanguagePicker() {
  const [language, setLanguage] = useState<Language>("English");
  useEffect(() => {
    // localStorage exists only in the browser: read it after the first render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLanguage(readLanguage());
  }, []);

  return (
    <fieldset className="space-y-3" data-testid="language-picker">
      <legend className="font-medium">Neb&apos;s language</legend>
      <div className="flex flex-wrap gap-2">
        {LANGUAGES.map((choice) => (
          <label
            key={choice}
            className="flex cursor-pointer items-center gap-2 rounded-full border border-line px-4 py-2 text-sm has-checked:border-ink has-checked:bg-paper-hi"
          >
            <input
              type="radio"
              name="language"
              value={choice}
              checked={language === choice}
              onChange={() => {
                setLanguage(choice);
                try {
                  window.localStorage.setItem(STORAGE_KEY, choice);
                } catch {
                  // Not kept this time; the choice still shows until the page closes.
                }
              }}
              className="accent-(--ink)"
            />
            {choice}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
