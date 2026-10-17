"use client";

import type { CSSProperties } from "react";

export type MascotState = "sleeping" | "listening" | "thinking" | "speaking" | "muted";

const LABEL: Record<MascotState, string> = {
  sleeping: "Mew is asleep",
  listening: "Mew is listening",
  thinking: "Mew is thinking",
  speaking: "Mew is speaking",
  muted: "Mew is muted",
};

export function mascotLabel(state: MascotState): string {
  return LABEL[state];
}

/**
 * Mew: a small, calm cat-like blob. State shows in the eyes (closed, open, glancing up), a soft
 * pulse that follows the voice level while listening, and a slash when muted. Motion is disabled
 * for people who prefer reduced motion.
 */
export function Mascot({ state, level = 0 }: { state: MascotState; level?: number }) {
  const pulse = state === "listening" ? 1 + Math.min(level * 6, 0.45) : 1;
  return (
    <span className="relative grid size-14 place-items-center">
      {state === "listening" && (
        <span
          aria-hidden
          className="absolute inset-0 rounded-full bg-accent/25 transition-transform duration-150 motion-safe:animate-[mew-breathe_2.6s_ease-in-out_infinite]"
          style={{ transform: `scale(${pulse})` } as CSSProperties}
        />
      )}
      <svg viewBox="0 0 48 48" aria-hidden className="relative size-12 text-ink">
        <path d="M11 20 L13 6 L22 14 Z M37 20 L35 6 L26 14 Z" fill="currentColor" />
        <circle cx="24" cy="27" r="16" fill="currentColor" />
        <Eyes state={state} />
        {state === "speaking" && (
          <ellipse
            cx="24"
            cy="33"
            rx="3"
            ry="2"
            className="fill-paper motion-safe:animate-[mew-talk_0.35s_ease-in-out_infinite_alternate]"
          />
        )}
        {state === "muted" && (
          <path d="M8 42 L40 10" stroke="var(--error)" strokeWidth="3" strokeLinecap="round" />
        )}
      </svg>
      {state === "thinking" && (
        <span aria-hidden className="absolute -top-1 right-0 flex gap-0.5">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="size-1.5 rounded-full bg-tutor motion-safe:animate-[mew-dot_1s_ease-in-out_infinite]"
              style={{ animationDelay: `${i * 0.15}s` }}
            />
          ))}
        </span>
      )}
    </span>
  );
}

function Eyes({ state }: { state: MascotState }) {
  if (state === "sleeping" || state === "muted") {
    return (
      <g stroke="var(--paper)" strokeWidth="2" strokeLinecap="round" fill="none">
        <path d="M15.5 26 q2.5 2.5 5 0" />
        <path d="M27.5 26 q2.5 2.5 5 0" />
      </g>
    );
  }
  const lookUp = state === "thinking" ? -2 : 0;
  return (
    <g className="fill-paper">
      <circle cx={18 + (lookUp ? 1 : 0)} cy={26 + lookUp} r="2.4" />
      <circle cx={30 + (lookUp ? 1 : 0)} cy={26 + lookUp} r="2.4" />
    </g>
  );
}
