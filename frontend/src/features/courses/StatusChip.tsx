import { CONCEPT_STATUS_LABELS, type ConceptStatus } from "@mew/shared";

const TONE: Record<ConceptStatus, string> = {
  not_started: "border-line text-muted",
  explored: "border-ink/30 text-ink",
  practised_with_hint: "border-line text-ink",
  checked: "border-ink/40 bg-ink/5 text-ink",
  revisit: "border-line text-muted",
};

/** A concept's learning status: Not started · Explored · Practised with hint · Checked · Revisit. */
export function StatusChip({ status }: { status: ConceptStatus }) {
  return (
    <span
      data-testid="concept-status"
      className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${TONE[status]}`}
    >
      {CONCEPT_STATUS_LABELS[status]}
    </span>
  );
}
