import { CONCEPT_STATUS_LABELS, type ConceptStatus } from "@mew/shared";

const TONE: Record<ConceptStatus, string> = {
  not_started: "border-rule text-ink-muted",
  explored: "border-accent/30 text-accent",
  practised_with_hint: "border-tutor/40 text-tutor",
  checked: "border-check/40 bg-check/10 text-check",
  revisit: "border-error/40 text-error",
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
