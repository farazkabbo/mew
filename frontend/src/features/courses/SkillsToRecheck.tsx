"use client";

import type { SkillEvidence, SkillView } from "@mew/shared";
import { X } from "lucide-react";
import { useEffect, useState } from "react";

import { coursesApi, formatDue } from "./api";

const LAST: Record<SkillEvidence, string> = {
  independent: "done on your own",
  with_hint: "done with hints",
  after_explanation: "done after I showed you",
  not_yet: "not finished yet",
};

/**
 * Skills from coach mode (Screen Coach S5): tasks the student learned on their computer ("make a
 * pivot table"), each with its next re-check, which happens on the computer itself ("let me try
 * pivot tables on my own"). Due ones first; forgetting one deletes it and its evidence.
 */
export function SkillsToRecheck({ now }: { now: Date }) {
  const [skills, setSkills] = useState<SkillView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    coursesApi.skills().then(
      (view) => !cancelled && setSkills(view.skills),
      () => !cancelled && setSkills([]), // optional: the rest of the review still works
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (!skills || skills.length === 0) return null;
  const sorted = [...skills].sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  const due = sorted.filter((s) => Date.parse(s.dueAt) <= now.getTime()).length;

  const forget = async (id: string) => {
    setError(null);
    try {
      await coursesApi.forgetSkill(id);
      setSkills((list) => list?.filter((s) => s.id !== id) ?? null);
    } catch {
      setError("Couldn't forget that skill. Try again.");
    }
  };

  return (
    <section
      aria-label="Skills to re-check"
      data-testid="review-skills"
      className="mb-8 rounded-2xl border border-line bg-paper-hi p-4"
    >
      <h2 className="font-serif text-2xl">Skills to re-check</h2>
      <p className="text-sm text-muted">
        {due === 0
          ? "Nothing to re-check today."
          : `${due === 1 ? "1 skill is" : `${due} skills are`} due. On your computer, hold the key and say “let me try ${sorted[0]?.title.toLowerCase()} on my own”.`}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-muted">
          {error}
        </p>
      )}
      <ul className="mt-3 divide-y divide-line border-y border-line">
        {sorted.map((skill) => (
          <li key={skill.id} data-testid="review-skill" className="flex items-center gap-4 py-3">
            <span className="min-w-0 flex-1">
              <span className="font-medium">{skill.title}</span>
              <span className="block text-sm text-muted">
                {[
                  skill.conceptTitle && `Part of ${skill.conceptTitle}`,
                  skill.lastEvidence && `Last time: ${LAST[skill.lastEvidence]}`,
                  skill.solo > 0 && `${skill.solo === 1 ? "once" : `${skill.solo} times`} alone`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </span>
            <span className="text-sm text-muted">{formatDue(skill.dueAt, now)}</span>
            <button
              type="button"
              onClick={() => void forget(skill.id)}
              aria-label={`Forget ${skill.title}`}
              className="rounded-full p-1 text-muted hover:text-ink"
            >
              <X className="size-4" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
