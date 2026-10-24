import type { FindingType, NotesFinding } from "./notes-check";

/**
 * How a check's findings are listed (Notes Check panel, brief §2.3): differences first, then
 * what couldn't be read, then gaps, then the matches in one collapsed row. Shared by the
 * desktop app's panel and the notebook, so both say the same thing the same way.
 *
 * Icons carry the meaning as well as colour does (brief §8): ? look again, + add, ✓ you have it.
 */
export type PanelItem = {
  findingId: string;
  type: FindingType;
  icon: "?" | "+" | "✓";
  /** What the tutor asks (or, for a match, the line of the notes it matched). */
  title: string;
  /** The words compared, for context. */
  detail?: string;
  /** "Show in notebook" can open it (a finding about lines, or a gap with a place to go). */
  inNotebook: boolean;
};

export type PanelGroup = {
  type: FindingType;
  heading: string;
  items: PanelItem[];
  /** Matches are listed quietly: collapsed under a count (brief §2.3). */
  collapsed: boolean;
};

const HEADINGS: Record<FindingType, (n: number) => string> = {
  difference: (n) => (n === 1 ? "One line to look at again" : `${n} lines to look at again`),
  unclear: (n) => (n === 1 ? "One line I couldn't read" : `${n} lines I couldn't read`),
  gap: (n) => (n === 1 ? "One idea not in your notes yet" : `${n} ideas not in your notes yet`),
  match: (n) => (n === 1 ? "1 match" : `${n} matches`),
};

const ORDER: readonly FindingType[] = ["difference", "unclear", "gap", "match"];

export function panelGroups(findings: readonly NotesFinding[]): PanelGroup[] {
  return ORDER.map((type) => {
    const items = findings
      .filter((f) => f.type === type)
      .sort((a, b) => b.confidence - a.confidence)
      .map(panelItem);
    return { type, heading: HEADINGS[type](items.length), items, collapsed: type === "match" };
  }).filter((group) => group.items.length > 0);
}

function panelItem(finding: NotesFinding): PanelItem {
  const quote = (text: string) => `“${text}”`;
  const inNotebook = finding.lineIds.length > 0 || finding.insertAfterLineId !== undefined;
  switch (finding.type) {
    case "difference":
      return {
        findingId: finding.id,
        type: finding.type,
        icon: "?",
        title: finding.question ?? `Look again at ${quote(finding.noteQuote ?? "")}`,
        detail: [
          finding.noteQuote && `Your notes: ${quote(finding.noteQuote)}`,
          `On screen: ${quote(finding.screenQuote)}`,
          finding.sourceConflict &&
            "Your course material agrees with your notes: the slide may differ.",
        ]
          .filter(Boolean)
          .join(" · "),
        inNotebook,
      };
    case "unclear":
      return {
        findingId: finding.id,
        type: finding.type,
        icon: "?",
        title: finding.question ?? "I couldn't quite read this line.",
        ...(finding.noteQuote && { detail: `I read: ${quote(finding.noteQuote)}` }),
        inNotebook,
      };
    case "gap":
      return {
        findingId: finding.id,
        type: finding.type,
        icon: "+",
        title: finding.question ?? "This isn't in your notes yet. Want to add it?",
        detail: `On screen: ${quote(finding.screenQuote)}`,
        inNotebook,
      };
    case "match":
      return {
        findingId: finding.id,
        type: finding.type,
        icon: "✓",
        title: finding.noteQuote ?? finding.screenQuote,
        inNotebook,
      };
  }
}
