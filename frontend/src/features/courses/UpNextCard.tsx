"use client";

/**
 * "Up next" on the Review page (docs/NEB_APP_UI.md decision U25, board 8): an index card for the
 * checks due from saved moments and screen quizzes, started with the neb button. With an exam
 * close, it says so: that course's reviews come first.
 */
export function UpNextCard({
  due,
  exam,
  onStart,
}: {
  due: number;
  exam: { title: string; daysLeft: number } | null;
  onStart(): void;
}) {
  const when = (days: number) =>
    days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
  return (
    <div
      data-testid="review-moments"
      className="relative rounded-[4px] bg-paper-hi pb-7 shadow-sh-3"
      style={{
        backgroundImage:
          "repeating-linear-gradient(to bottom, transparent 0, transparent 31px, var(--rule) 31px, var(--rule) 32px)",
        backgroundPosition: "0 66px",
      }}
    >
      <div className="box-border h-[66px] border-b-2 border-margin-red bg-paper-hi px-7 pt-[22px]">
        <span className="neb-voice text-sm font-medium text-neb-ink">from what you saved</span>
      </div>
      <div className="flex flex-col gap-[18px] px-7 pt-5">
        <div>
          <div className="font-serif text-[40px] leading-[1.05]">
            {due === 0 ? "Nothing to check" : due === 1 ? "1 quick check" : `${due} quick checks`}
          </div>
          <div className="mt-1.5 text-sm text-muted">
            {due === 0
              ? "Save something from your screen and its check comes back here."
              : `about ${Math.max(1, due * 2)} min · from moments you saved and quizzes on your screen`}
          </div>
          {exam && due > 0 && (
            <div className="mt-1.5 text-sm text-muted">
              Your {exam.title} exam is {when(exam.daysLeft)}, so its reviews come first.
            </div>
          )}
        </div>
        {due > 0 && (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onStart}
              className="h-12 rounded-full bg-neb px-7 text-base font-semibold text-white transition-opacity duration-[120ms] hover:opacity-90"
            >
              Start
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
