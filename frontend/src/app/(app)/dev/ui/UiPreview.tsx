"use client";

import { COLORS, type ColorName } from "@mew/shared";

import { Button, type ButtonVariant } from "@/components/ui/Button";
import { Keycap, Keys } from "@/components/ui/Keycap";
import { NebDot, type NebDotState } from "@/components/ui/NebDot";

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
    </main>
  );
}
