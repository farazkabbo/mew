"use client";

import { Plus } from "lucide-react";
import { useState } from "react";

/** Tab tints peeking from a cover's edge: its 3 most recent chapters (board 1). */
const TAB_TINTS = ["var(--note)", "var(--paper-hi)", "color-mix(in srgb, var(--teal) 40%, white)"];

/**
 * A notebook on the desk (docs/NEB_APP_UI.md §5.1): its colour with a binding shadow, an ivory
 * label plate (name, chapters and pages), up to 3 chapter tabs peeking out, a sticky note when
 * checks are due, a ribbon with how many stayed (§6.4), and where it was last used under it. Tap opens where you left off; a PDF
 * dropped on it is imported into it (K4).
 */
export function DeskCover({
  name,
  color,
  meta,
  tabs,
  due,
  stayed = 0,
  last,
  onOpen,
  onDropPdf,
}: {
  name: string;
  color: string;
  meta: string;
  tabs: number;
  due: number;
  /** Checks that stayed in it (§6.4): the ribbon, hidden at 0. */
  stayed?: number;
  last: string;
  onOpen(): void;
  onDropPdf?(file: File): void;
}) {
  const [dropping, setDropping] = useState(false);
  return (
    <div className="flex w-[150px] flex-col gap-2.5" data-testid="desk-cover">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${name}, ${meta}${stayed > 0 ? `, ${stayed} stayed` : ""}${due > 0 ? `, ${due} ${due === 1 ? "check" : "checks"} due` : ""}`}
        onDragOver={(event) => {
          if (!onDropPdf || !event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          setDropping(false);
          const file = [...event.dataTransfer.files].find((f) => f.type === "application/pdf");
          if (!file || !onDropPdf) return;
          event.preventDefault();
          onDropPdf(file);
        }}
        className={`relative h-[200px] w-[150px] rounded-[4px_10px_10px_4px] text-left text-ink shadow-[inset_12px_0_0_#00000022,0_12px_22px_-12px_#1E1D1A88] transition-transform duration-[220ms] ease-[cubic-bezier(.2,.8,.2,1)] hover:-translate-y-1 ${dropping ? "outline-2 outline-offset-4 outline-ink outline-dashed" : ""}`}
        style={{ background: color }}
      >
        {Array.from({ length: Math.min(3, tabs) }, (_, i) => (
          <span
            key={i}
            aria-hidden
            className="absolute -right-[9px] h-[26px] w-[9px] rounded-[0_4px_4px_0]"
            style={{ top: 26 + i * 32, background: TAB_TINTS[i] }}
          />
        ))}
        <span className="absolute top-[30px] right-3.5 left-[26px] rounded-[2px] bg-[#FFFEFB] px-2.5 pt-2.5 pb-3 text-[#1E1D1A]">
          <span className="block font-serif text-2xl leading-none break-words">{name}</span>
          <span className="mt-1.5 block truncate text-[11px] whitespace-nowrap text-[#5F5A50]">
            {meta}
          </span>
        </span>
        {stayed > 0 && (
          <span
            aria-hidden
            data-testid="stayed-ribbon"
            className="absolute -top-1 right-[18px] flex h-[74px] w-[26px] justify-center bg-[#FFFEFB] pt-2.5 text-[13px] font-semibold text-[#1E1D1A]"
            style={{ clipPath: "polygon(0 0, 100% 0, 100% 100%, 50% 84%, 0 100%)" }}
          >
            {stayed}
          </span>
        )}
        {due > 0 && (
          <span
            aria-hidden
            className="absolute -bottom-3.5 left-[18px] h-16 w-[76px] -rotate-6 bg-[#F1E5AE] p-2 font-hand text-[17px] leading-none text-[#3B3524] shadow-[0_5px_10px_#0003]"
          >
            {due} {due === 1 ? "check" : "checks"}
          </span>
        )}
      </button>
      <span className="pt-1.5 text-xs text-muted">{last}</span>
    </div>
  );
}

/** The last tile (§5.1), or the only one on a first run: "name it first, always". */
export function NewNotebookCover({ onNew, first = false }: { onNew(): void; first?: boolean }) {
  return (
    <button
      type="button"
      onClick={onNew}
      data-testid="desk-new-notebook"
      className={`flex flex-col items-center justify-center gap-2.5 rounded-[4px_10px_10px_4px] border-2 border-dashed border-[color-mix(in_srgb,var(--muted)_55%,var(--desk))] text-sm text-muted transition-colors duration-[120ms] hover:border-ink/50 hover:text-ink ${first ? "h-[260px] w-[200px] px-5 text-center" : "h-[200px] w-[150px]"}`}
    >
      <Plus className="size-7" strokeWidth={1.8} aria-hidden />
      {first ? (
        <>
          <span className="font-serif text-2xl leading-tight text-ink">Your first notebook.</span>
          <span>What are you studying?</span>
        </>
      ) : (
        <>
          New notebook
          <span className="text-xs">name it first, always</span>
        </>
      )}
    </button>
  );
}
