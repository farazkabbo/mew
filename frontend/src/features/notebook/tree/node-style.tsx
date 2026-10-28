import type { Notebook, NotebookColor, NotebookIcon } from "@mew/shared";
import {
  Atom,
  BookOpen,
  Brain,
  Calculator,
  Code,
  Dna,
  FlaskConical,
  Globe,
  Landmark,
  Languages,
  Leaf,
  type LucideIcon,
  Music,
  Palette,
  Sigma,
} from "lucide-react";

/** The icon set a notebook can wear, in the order the creation popover offers them. */
export const ICONS: Record<NotebookIcon, { icon: LucideIcon; label: string }> = {
  book: { icon: BookOpen, label: "Book" },
  atom: { icon: Atom, label: "Atom" },
  flask: { icon: FlaskConical, label: "Flask" },
  sigma: { icon: Sigma, label: "Sigma" },
  dna: { icon: Dna, label: "DNA" },
  leaf: { icon: Leaf, label: "Leaf" },
  globe: { icon: Globe, label: "Globe" },
  code: { icon: Code, label: "Code" },
  landmark: { icon: Landmark, label: "Landmark" },
  languages: { icon: Languages, label: "Languages" },
  music: { icon: Music, label: "Music" },
  palette: { icon: Palette, label: "Palette" },
  brain: { icon: Brain, label: "Brain" },
  calculator: { icon: Calculator, label: "Calculator" },
};

/**
 * Notebook colours, shown as the cover palette (NEB_APP_UI §3.1): never violet, which is neb's.
 * The stored names stay as they are until U4's covers add the rest of the palette; "violet"
 * (from before) shows as sky and isn't offered any more.
 */
export const COLORS: Record<NotebookColor, { hex: string; label: string }> = {
  slate: { hex: "#6F7C86", label: "Slate" },
  teal: { hex: "#7DA4AF", label: "Teal" },
  blue: { hex: "#9DB8D9", label: "Sky" },
  violet: { hex: "#9DB8D9", label: "Sky" },
  rose: { hex: "#C99AA4", label: "Rose" },
  amber: { hex: "#D4B45A", label: "Mustard" },
  green: { hex: "#8FA98B", label: "Sage" },
};

/** The colours a student can pick (violet only stays readable on notebooks that had it). */
export const PICKABLE_COLORS = (Object.keys(COLORS) as NotebookColor[]).filter(
  (c) => c !== "violet",
);

/** A notebook's icon in its colour (a chapter or section shows its root's). */
export function NodeIcon({
  node,
  className = "size-4",
}: {
  node: Pick<Notebook, "icon" | "color">;
  className?: string;
}) {
  const Icon = ICONS[node.icon ?? "book"].icon;
  return (
    <Icon
      className={`shrink-0 ${className}`}
      style={{ color: COLORS[node.color ?? "slate"].hex }}
      aria-hidden
    />
  );
}
