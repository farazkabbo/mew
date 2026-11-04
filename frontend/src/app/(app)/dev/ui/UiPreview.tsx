"use client";

import { COLORS, type ColorName, type SkillView } from "@mew/shared";

import { Button, type ButtonVariant } from "@/components/ui/Button";
import { Keycap, Keys } from "@/components/ui/Keycap";
import { NebDot, type NebDotState } from "@/components/ui/NebDot";
import { ReviewFolders } from "@/features/courses/ReviewFolders";
import type { FolderCourse, FolderRow } from "@/features/courses/review-folders";
import { SkillsCard } from "@/features/courses/SkillsToRecheck";
import { UpNextCard } from "@/features/courses/UpNextCard";

const VARIANTS: { variant: ButtonVariant; label: string }[] = [
  { variant: "ink", label: "Resume" },
  { variant: "neb", label: "Check my work" },
  { variant: "ghost", label: "Back to your work" },
  { variant: "quiet", label: "Peek at a step" },
  { variant: "danger", label: "Delete" },
];

const DOTS: { state: NebDotState; notes?: number }[] = [
  { state: "off" },
  { state: "watching" },
  { state: "thinking" },
  { state: "has-note", notes: 2 },
  { state: "speaking" },
  { state: "listening" },
];

/** Review (decision U25): fixed data, so the screenshots don't move with the date. */
const NOW = new Date("2026-11-04T12:00:00Z");
const row = (title: string, kind: FolderRow["kind"], detail: string, i: number): FolderRow => ({
  conceptId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  title,
  kind,
  detail,
});
const FOLDERS: FolderCourse[] = [
  {
    id: "00000000-0000-4000-8000-000000000101",
    title: "EECS 4101 · Advanced Data Structures",
    color: "#C98B6B",
    quiz: 3,
    rows: [
      row("Amortized analysis", "revisit", "Due since 2 days ago", 1),
      row("Red-black tree deletion", "revisit", "Due since yesterday", 2),
      row("Splay trees", "new", "Not practised yet", 3),
      row("Skip lists", "hint", "Right with a hint · comes back tomorrow", 4),
      row("Binomial heaps", "checked", "Comes back in 5 days", 5),
    ],
  },
  {
    id: "00000000-0000-4000-8000-000000000102",
    title: "Business Mathematics",
    color: "#9DB8D9",
    quiz: 2,
    rows: [
      row("Simple Discount", "revisit", "Due since yesterday", 6),
      row("Simple Interest", "new", "Not practised yet", 7),
    ],
  },
  {
    id: "00000000-0000-4000-8000-000000000103",
    title: "NATS 1610 · The Living Body",
    color: "#8FA98B",
    quiz: 1,
    rows: [
      row("Membrane transport", "revisit", "Due today", 8),
      row("Homeostasis", "checked", "Comes back in 3 days", 9),
    ],
  },
  {
    id: "00000000-0000-4000-8000-000000000104",
    title: "Modern History",
    color: "#C99AA4",
    quiz: 0,
    rows: [row("The Treaty of Versailles", "checked", "Comes back in 4 days", 10)],
  },
];
const MANY: FolderCourse[] = [
  ...FOLDERS,
  ...["Statistics", "Organic Chemistry", "Linear Algebra", "Microeconomics", "Philosophy"].map(
    (title, i) => ({
      id: `00000000-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`,
      title,
      color: ["#D4B45A", "#7DA4AF", "#6F7C86", "#C98B6B", "#8FA98B"][i] ?? "#7DA4AF",
      quiz: 1,
      rows: [row(`${title} basics`, "new", "Not practised yet", 20 + i)],
    }),
  ),
];
const SKILLS: SkillView[] = [
  {
    id: "00000000-0000-4000-8000-000000000301",
    title: "Pivot tables",
    app: "Excel",
    conceptTitle: "Summarising data",
    lastEvidence: "independent",
    lastHints: 0,
    lastAt: "2026-10-31T12:00:00Z",
    solo: 1,
    dueAt: "2026-11-03T12:00:00Z",
  },
];

function Block({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} data-testid={`ui-${id}`} className="flex flex-col gap-4">
      <h2 className="font-serif text-[28px] leading-none">{title}</h2>
      {children}
    </section>
  );
}

/** The U series' components, section by section (U1: tokens, type, buttons, keycaps, the dot). */
export function UiPreview() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-12 p-10" data-testid="ui-preview">
      <header>
        <h1 className="font-serif text-[56px] leading-none">neb · ui</h1>
        <p className="mt-2 text-muted">Pencil is you. Violet is neb, and only neb.</p>
      </header>

      <Block id="colors" title="Colours">
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
          {(Object.keys(COLORS.light) as ColorName[]).map((name) => (
            <div key={name} className="flex flex-col gap-1 text-xs">
              <span
                className="h-12 rounded-[10px] border border-line"
                style={{ background: `var(--${name})` }}
              />
              <span className="font-medium">{name}</span>
            </div>
          ))}
        </div>
      </Block>

      <Block id="type" title="Type">
        <p className="font-serif text-[72px] leading-none">Good evening.</p>
        <p className="font-serif text-[32px]">Why is range biggest at 45°?</p>
        <p className="text-base">Inter 16 · student-facing copy is sentence case and plain.</p>
        <p className="text-[13px] text-muted">Inter 13 · secondary text in muted.</p>
        <p className="neb-voice text-[15px]">only the way up? that one stayed.</p>
        <p className="font-hand text-[28px] text-pencil">3x + 7 = 19</p>
      </Block>

      <Block id="buttons" title="Buttons">
        <div className="flex flex-wrap items-center gap-3">
          {VARIANTS.map(({ variant, label }) => (
            <Button key={variant} variant={variant}>
              {label}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {VARIANTS.map(({ variant, label }) => (
            <Button key={variant} variant={variant} dense>
              {label}
            </Button>
          ))}
          <Button disabled>Resume</Button>
        </div>
      </Block>

      <Block id="keycaps" title="Keycaps">
        <div className="flex flex-wrap items-end gap-4">
          <Keycap size="sm">Alt</Keycap>
          <Keycap size="md">Alt</Keycap>
          <Keycap size="lg">Alt</Keycap>
          <Keycap size="xl">Alt</Keycap>
          <Keys keys={["Ctrl", "K"]} />
          <Keys keys={["Ctrl", "Alt"]} size="lg" pressed />
        </div>
      </Block>

      <Block id="dot" title="The neb dot">
        <div className="flex flex-wrap items-center gap-8">
          {DOTS.map(({ state, notes }) => (
            <NebDot key={state} state={state} label {...(notes ? { notes } : {})} />
          ))}
        </div>
      </Block>

      <Block id="review" title="Review">
        <div className="flex flex-wrap items-start gap-10">
          <div className="flex max-w-[420px] min-w-0 flex-[1_1_340px] flex-col gap-6">
            <UpNextCard due={4} exam={null} onStart={() => undefined} />
            <UpNextCard due={0} exam={null} onStart={() => undefined} />
            <SkillsCard skills={[]} now={NOW} onForget={() => undefined} />
          </div>
          <div className="min-w-0 flex-[999_1_480px]">
            <ReviewFolders courses={FOLDERS} />
          </div>
        </div>
      </Block>

      <Block id="review-more" title="Review · many courses">
        <ReviewFolders courses={MANY} />
        <SkillsCard skills={SKILLS} now={NOW} onForget={() => undefined} />
      </Block>
    </main>
  );
}
