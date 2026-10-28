"use client";

import Link from "next/link";

import { Section, Toggle } from "./controls";
import { useSettings } from "./store";

/** Opting in to keep Mew's decisions, so they can be labelled to train a better Mew (M10). */
export function PrivacySection() {
  const { settings, update } = useSettings();
  return (
    <Section title="Help improve Neb">
      <Toggle
        label="Keep Neb's decisions"
        hint="Saves what Neb heard (your words, not audio), what you were doing on the page, and what it decided, so you can correct it and help train a faster Neb. Off by default."
        checked={settings.mew_logging_opt_in}
        onChange={(mew_logging_opt_in) => void update({ mew_logging_opt_in })}
      />
      <p className="text-sm text-muted">
        <Link href="/teach" className="text-ink underline-offset-2 hover:underline">
          Teach Neb
        </Link>
        : review what Neb kept, mark what it should have done, download your labels, or delete
        everything.
      </p>
    </Section>
  );
}
