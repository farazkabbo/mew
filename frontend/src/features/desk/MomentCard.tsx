"use client";

import type { Moment } from "../moments/moments";

const SOURCE: Record<Moment["kind"], string> = {
  video: "video",
  web: "web page",
  pdf: "PDF",
  app: "app",
};

/**
 * A saved moment on the desk (docs/NEB_APP_UI.md §5.1): the clip with neb's circle on it, where it
 * came from, the question asked, where it's filed, and Replay.
 */
export function MomentCard({
  moment,
  where,
  image,
  onOpen,
}: {
  moment: Moment;
  where: string;
  image: string;
  onOpen(): void;
}) {
  const source = moment.sourceName
    ? `${SOURCE[moment.kind]} · ${moment.sourceName}`
    : SOURCE[moment.kind];
  return (
    <article
      className="overflow-hidden rounded-[10px] bg-paper-hi shadow-[0_1px_0_var(--line)]"
      data-testid="moment-card"
    >
      <button type="button" onClick={onOpen} className="block w-full text-left">
        <span className="relative block h-[92px] overflow-hidden bg-[#2C4B57]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image} alt="" loading="lazy" className="h-full w-full object-cover" />
          <span className="absolute right-2.5 bottom-2 max-w-[70%] truncate rounded-[9px] bg-[#1E1D1Acc] px-2 py-0.5 text-[11px] text-white">
            {source}
          </span>
        </span>
        <span className="flex flex-col gap-1.5 px-3.5 pt-3 pb-3.5">
          <span className="line-clamp-2 text-sm font-semibold">
            {moment.question || "A saved moment"}
          </span>
          <span className="flex items-center justify-between gap-2 text-xs text-muted">
            <span className="truncate">{where}</span>
            <span className="shrink-0 font-semibold text-neb-ink">▶ Replay</span>
          </span>
        </span>
      </button>
    </article>
  );
}
