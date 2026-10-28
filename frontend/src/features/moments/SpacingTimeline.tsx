/**
 * "When it comes back" (docs/NEB_APP_UI.md §5.5, board 5): when a check was saved, today, and
 * when it comes back next (once answered: FSRS's own date), then the usual steps after that.
 * Past dots are filled violet, today's is bold, the future's are hollow.
 */
export type TimelineDot = { label: string; state: "past" | "now" | "future" };

const DAY = 86_400_000;

/** "1 day", "3 days", "1 week", "3 weeks", "2 months". */
export function spacing(ms: number): string {
  const days = Math.max(1, Math.round(ms / DAY));
  if (days < 7) return `${days} ${days === 1 ? "day" : "days"}`;
  if (days < 30) {
    const weeks = Math.round(days / 7);
    return `${weeks} ${weeks === 1 ? "week" : "weeks"}`;
  }
  const months = Math.round(days / 30);
  return `${months} ${months === 1 ? "month" : "months"}`;
}

export function timelineDots({
  savedAt,
  now,
  nextDue,
}: {
  savedAt: number;
  now: number;
  /** After answering: when it comes back (null before). */
  nextDue: number | null;
}): TimelineDot[] {
  const dots: TimelineDot[] = [
    { label: "saved", state: "past" },
    { label: now - savedAt >= DAY ? `${spacing(now - savedAt)} · now` : "now", state: "now" },
  ];
  // The next one: FSRS's date once answered; until then, a few days (it depends on the answer).
  const gap = nextDue !== null ? Math.max(DAY, nextDue - now) : null;
  dots.push({ label: gap !== null ? spacing(gap) : "next", state: "future" });
  // And the likely ones after, each about three times longer.
  const after = gap ?? 3 * DAY;
  dots.push({ label: spacing(after * 3), state: "future" });
  dots.push({ label: spacing(after * 9), state: "future" });
  return dots;
}

export function SpacingTimeline({ dots }: { dots: readonly TimelineDot[] }) {
  return (
    <div data-testid="spacing-timeline">
      <div className="mb-2 text-xs font-semibold tracking-[0.08em] text-muted uppercase">
        When it comes back
      </div>
      <ol className="relative flex items-start justify-between">
        <span aria-hidden className="absolute top-[7px] right-2 left-2 h-px bg-line" />
        {dots.map((dot, i) => (
          <li key={i} className="relative flex flex-col items-center gap-1.5 text-xs">
            <span
              aria-hidden
              className={`size-4 rounded-full border-2 ${
                dot.state === "future" ? "border-line bg-paper-hi" : "border-neb bg-neb"
              }`}
            />
            <span className={dot.state === "now" ? "font-semibold" : "text-muted"}>
              {dot.label}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
