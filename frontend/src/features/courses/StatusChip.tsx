import { CONCEPT_STATUS_LABELS, type ConceptStatus } from "@mew/shared";

/** The chips used on Review too (decision U28): checked is neb's, revisit a sticky note. */
const TONE: Record<ConceptStatus, string> = {
  not_started: "px-1 py-1 text-muted",
  explored: "border border-line px-2.5 py-[3px] text-ink",
  practised_with_hint: "border border-line px-2.5 py-[3px] text-muted",
  checked: "bg-neb-wash px-2.5 py-1 text-neb-ink",
  revisit: "bg-note px-2.5 py-1 text-ink",
};

/** A concept's learning status: Not started · Explored · Practised with hint · Checked · Revisit. */
export function StatusChip({ status }: { status: ConceptStatus }) {
  return (
    <span
      data-testid="concept-status"
      className={`inline-flex shrink-0 items-center rounded-full text-[13px] font-semibold whitespace-nowrap ${TONE[status]}`}
    >
      {CONCEPT_STATUS_LABELS[status]}
    </span>
  );
}
