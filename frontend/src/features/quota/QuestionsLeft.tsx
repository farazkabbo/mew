"use client";

import { useEffect, useState } from "react";
import { z } from "zod";

/** Said once when this many are left (docs/LAUNCH_LIMITS.md). */
const NEARLY_OUT = 2;
/** Fired after an answer so the count follows without waiting for a refocus. */
export const QUESTIONS_CHANGED_EVENT = "neb:questions-changed";
const SEEN_KEY = "neb.questionsNotice";

const Quota = z.union([
  z.object({ enforced: z.literal(false) }),
  z.object({
    enforced: z.literal(true),
    used: z.number().int(),
    limit: z.number().int(),
    remaining: z.number().int(),
    unlimited: z.boolean(),
    maskedEmail: z.string().max(260).nullable().optional(),
  }),
]);
type Quota = z.infer<typeof Quota>;

/**
 * "5 of 8 questions left", quietly (docs/LAUNCH_LIMITS.md): refreshed when the window comes back
 * and after each answer. At 2 left, one gentle notice; at 0, what happens next. Nothing while
 * questions aren't counted (development) or for the unlimited.
 */
export function QuestionsLeft() {
  const [quota, setQuota] = useState<Quota | null>(null);
  const [noticeSeen, setNoticeSeen] = useState(() => {
    try {
      return typeof window !== "undefined" && window.localStorage.getItem(SEEN_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    let alive = true;
    const load = () =>
      void fetch("/api/quota", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((body: unknown) => {
          const parsed = Quota.safeParse(body);
          if (alive && parsed.success) setQuota(parsed.data);
        })
        .catch(() => undefined);
    load();
    window.addEventListener("focus", load);
    window.addEventListener(QUESTIONS_CHANGED_EVENT, load);
    return () => {
      alive = false;
      window.removeEventListener("focus", load);
      window.removeEventListener(QUESTIONS_CHANGED_EVENT, load);
    };
  }, []);

  if (!quota?.enforced || quota.unlimited) return null;
  const left = quota.remaining;
  const nearlyOut = left > 0 && left <= NEARLY_OUT && !noticeSeen;

  return (
    <div className="flex items-center gap-3 text-sm text-muted" data-testid="questions-left">
      <span aria-live="polite">
        {left > 0
          ? `${left} of ${quota.limit} questions left`
          : `You've used your ${quota.limit} free questions. We'll email you${
              quota.maskedEmail ? ` at ${quota.maskedEmail}` : ""
            } when more open up.`}
      </span>
      {nearlyOut && (
        <span role="status" className="rounded-full bg-neb-wash px-3 py-1 text-neb-ink">
          Only {left} left. Your notebook, Replay and PDFs stay free.
          <button
            type="button"
            className="ml-2 underline underline-offset-2"
            onClick={() => {
              setNoticeSeen(true);
              try {
                window.localStorage.setItem(SEEN_KEY, "1");
              } catch {
                // Shown again next time; that's fine.
              }
            }}
          >
            OK
          </button>
        </span>
      )}
    </div>
  );
}
