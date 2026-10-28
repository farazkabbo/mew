import type { CSSProperties } from "react";

/** docs/NEB_APP_UI.md §3.8: one component wherever neb is present. */
export type NebDotState = "off" | "watching" | "thinking" | "has-note" | "speaking" | "listening";

const LABEL: Record<NebDotState, string> = {
  off: "off",
  watching: "watching",
  thinking: "looking…",
  "has-note": "notes",
  speaking: "",
  listening: "listening",
};

/** What a screen reader hears for each state. */
export function nebDotLabel(state: NebDotState, notes = 0): string {
  switch (state) {
    case "off":
      return "neb is off";
    case "watching":
      return "neb is watching";
    case "thinking":
      return "neb is looking";
    case "has-note":
      return `neb has ${notes} ${notes === 1 ? "note" : "notes"}`;
    case "speaking":
      return "neb is speaking";
    case "listening":
      return "neb is listening";
  }
}

/** The n✓ mark: an "n" whose right leg turns into a tick. */
export function NebMark({
  className,
  stroke = "currentColor",
}: {
  className?: string;
  stroke?: string;
}) {
  return (
    <svg viewBox="12 34 190 146" aria-hidden className={className}>
      <path
        d="M36 150 V104 C36 74 56 58 80 58 C104 58 122 74 122 104 V136 L142 156 L178 106"
        fill="none"
        stroke={stroke}
        strokeWidth="30"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The neb dot: a 30 px violet circle with the white n✓, and an optional pixel label.
 * - off: a hollow grey ring;
 * - watching: a slow breathe with a violet-wash halo;
 * - thinking: three pixel dots cycling;
 * - has-note: an ink badge with the count of unresolved notes;
 * - speaking: the halo follows the voice level (0–1);
 * - listening: a ring of six short bars.
 * Motion only under motion-safe (reduced motion: still).
 */
export function NebDot({
  state,
  notes = 0,
  level = 0,
  label = false,
  size = 30,
}: {
  state: NebDotState;
  notes?: number;
  level?: number;
  label?: boolean;
  size?: number;
}) {
  const off = state === "off";
  const halo =
    state === "speaking" ? 1 + Math.min(level * 4, 0.5) : state === "watching" ? 1.17 : 0;
  const text = state === "has-note" ? `${notes} ${notes === 1 ? "note" : "notes"}` : LABEL[state];
  return (
    <span className="inline-flex items-center gap-2" data-neb-dot={state}>
      <span
        className="relative inline-grid place-items-center"
        style={{ width: size, height: size }}
      >
        {halo > 0 && (
          <span
            aria-hidden
            className="absolute inset-0 rounded-full bg-neb-wash transition-transform duration-150"
            style={{ transform: `scale(${halo})` } as CSSProperties}
          />
        )}
        {state === "listening" && <ListeningRing size={size} />}
        <span
          aria-hidden
          className={`relative grid size-full place-items-center rounded-full ${
            off ? "border-2 border-muted bg-transparent" : "bg-neb"
          } ${state === "watching" ? "motion-safe:animate-[neb-breathe_3.2s_ease-in-out_infinite]" : ""}`}
        >
          {state === "thinking" ? (
            <span className="flex gap-0.75">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="size-1 bg-white motion-safe:animate-[neb-dots_0.9s_steps(2)_infinite]"
                  style={{ animationDelay: `${i * 0.3}s` }}
                />
              ))}
            </span>
          ) : (
            <NebMark className="w-[56%]" stroke={off ? "var(--muted)" : "#ffffff"} />
          )}
        </span>
        {state === "has-note" && notes > 0 && (
          <span
            aria-hidden
            className="absolute -top-1 -right-1 grid min-w-4 place-items-center rounded-full bg-ink px-1 text-[10px] leading-4 font-semibold text-paper"
          >
            {notes}
          </span>
        )}
      </span>
      {label && text && <span className="neb-voice text-[13px]">{text}</span>}
      <span className="sr-only">{nebDotLabel(state, notes)}</span>
    </span>
  );
}

function ListeningRing({ size }: { size: number }) {
  // Ticks sit outside the dot, with a small gap.
  const r = size / 2 + 9;
  return (
    <span
      aria-hidden
      className="absolute"
      style={{ width: r * 2, height: r * 2, left: size / 2 - r, top: size / 2 - r }}
    >
      {Array.from({ length: 6 }, (_, i) => (
        <span
          key={i}
          className="absolute top-0 left-1/2 h-1.25 w-0.5 rounded-full bg-neb motion-safe:animate-[neb-bars_0.5s_ease-in-out_infinite_alternate]"
          style={
            {
              // Each tick turns about the ring's centre, r below its top.
              transformOrigin: `50% ${r}px`,
              transform: `translateX(-50%) rotate(${i * 60}deg)`,
              animationDelay: `${i * 0.08}s`,
            } as CSSProperties
          }
        />
      ))}
    </span>
  );
}
