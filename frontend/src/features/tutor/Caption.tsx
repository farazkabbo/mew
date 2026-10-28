"use client";

import { useEffect, useState } from "react";

import { useTutor } from "./store";

/** How long a caption stays after the tutor stops talking. */
const LINGER_MS = 6000;

/** Speech bubble with what the tutor is saying (togglable in settings). */
export function Caption() {
  const { caption, captions, phase } = useTutor();
  const turnId = useTutor((s) => s.turns[0]?.id ?? 0);
  // The turn whose caption has lingered long enough after it ended (hidden from then on).
  const [expiredTurn, setExpiredTurn] = useState<number | null>(null);

  useEffect(() => {
    if (!caption || phase !== "idle") return;
    const timer = setTimeout(() => setExpiredTurn(turnId), LINGER_MS);
    return () => clearTimeout(timer);
  }, [caption, phase, turnId]);

  if (!captions || !caption || expiredTurn === turnId) return null;
  return (
    <p
      aria-live="polite"
      data-testid="tutor-caption"
      className="max-w-80 rounded-2xl rounded-br-sm border border-line bg-paper-hi px-4 py-2.5 text-sm leading-relaxed text-ink shadow-lg"
    >
      {caption}
    </p>
  );
}
