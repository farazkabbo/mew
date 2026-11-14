"use client";

import type { SkillEvidence, SkillView } from "@mew/shared";
import { Monitor, X } from "lucide-react";
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

  if (!skills) return null;

  const forget = async (id: string) => {
    setError(null);
    try {
      await coursesApi.forgetSkill(id);
      setSkills((list) => list?.filter((s) => s.id !== id) ?? null);
    } catch {
      setError("Couldn't forget that skill. Try again.");
    }
  };

  return <SkillsCard skills={skills} now={now} error={error} onForget={forget} />;
}

/** The card itself (board 8), for the page and /dev/ui. */
export function SkillsCard({
  skills,
  now,
  error = null,
  onForget,
}: {
  skills: readonly SkillView[];
  now: Date;
  error?: string | null;
  onForget(id: string): void;
}) {
  const sorted = [...skills].sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  const due = sorted.filter((s) => Date.parse(s.dueAt) <= now.getTime()).length;
  return (
    <section
      aria-labelledby="review-skills-title"
      data-testid="review-skills"
      className="rounded-xl border border-line bg-paper px-[22px] py-5"
    >
      <h2 id="review-skills-title" className="flex items-center gap-2.5 font-semibold">
        <Monitor className="size-5" strokeWidth={1.8} aria-hidden />
        Skills to re-check
      </h2>
      <p className="mt-2 text-sm text-muted">
        {sorted.length === 0
          ? "None due. Finish a walkthrough in the desktop app and its re-check shows up here."
          : due === 0
            ? "Nothing to re-check today."
            : `${due === 1 ? "1 skill is" : `${due} skills are`} due. On your computer, say “let me try ${sorted[0]?.title.toLowerCase()} on my own”.`}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-muted">
          {error}
        </p>
      )}
      {sorted.length > 0 && (
        <ul className="mt-3 divide-y divide-line border-t border-line">
          {sorted.map((skill) => (
            <li key={skill.id} data-testid="review-skill" className="flex items-center gap-3 py-3">
              <span className="min-w-0 flex-1">
                <span className="text-[15px] font-medium">{skill.title}</span>
                <span className="block text-[13px] text-muted">
                  {[
                    skill.conceptTitle && `Part of ${skill.conceptTitle}`,
                    skill.lastEvidence && `Last time: ${LAST[skill.lastEvidence]}`,
                    skill.solo > 0 && `${skill.solo === 1 ? "once" : `${skill.solo} times`} alone`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <span className="text-[13px] whitespace-nowrap text-muted">
                {formatDue(skill.dueAt, now)}
              </span>
              <button
                type="button"
                onClick={() => onForget(skill.id)}
                aria-label={`Forget ${skill.title}`}
                className="rounded-full p-1 text-muted hover:text-ink"
              >
                <X className="size-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
