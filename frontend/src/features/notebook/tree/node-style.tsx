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

/** Mid tones that read on the dark sidebar and on paper alike. */
export const COLORS: Record<NotebookColor, { hex: string; label: string }> = {
  slate: { hex: "#8b909a", label: "Slate" },
  teal: { hex: "#2a9d8f", label: "Teal" },
  blue: { hex: "#5b8def", label: "Blue" },
  violet: { hex: "#8a7bf0", label: "Violet" },
  rose: { hex: "#e0607e", label: "Rose" },
  amber: { hex: "#d9962b", label: "Amber" },
  green: { hex: "#3e9a69", label: "Green" },
};

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
