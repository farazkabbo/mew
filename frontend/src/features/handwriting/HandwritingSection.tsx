"use client";

import type { HandwritingProfileSummary } from "@mew/shared";
import { useCallback, useEffect, useState } from "react";

import { Section, Toggle } from "../settings/controls";
import { useSettings } from "../settings/store";
import { handwritingApi } from "./api";
import { Calibration } from "./Calibration";

/**
 * Settings → Handwriting (K10 §8.3): what neb has learned about the student's handwriting (a
 * count and the look-alikes it found), the 60-second calibration, Reset, and the switch that
 * stops learning (turning it off deletes what was learned).
 */
export function HandwritingSection() {
  const learn = useSettings((s) => s.settings.learn_handwriting);
  const update = useSettings((s) => s.update);
  const [summary, setSummary] = useState<HandwritingProfileSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const load = useCallback(() => {
    handwritingApi.summary().then(
      (next) => {
        setSummary(next);
        setFailed(false);
      },
      () => setFailed(true),
    );
  }, []);
  useEffect(load, [load]);

  const reset = async () => {
    setConfirmReset(false);
    try {
      await handwritingApi.reset();
    } catch {
      setFailed(true);
    }
    load();
  };

  return (
    <Section title="Handwriting">
      <Toggle
        label="Learn my handwriting"
        hint="neb remembers the lines you correct, and your calibration, to read your writing better. Turning this off deletes what it learned."
        checked={learn}
        onChange={(on) => {
          void update({ learn_handwriting: on });
          if (!on) void reset();
        }}
      />
      {learn && (
        <div className="space-y-3 text-sm" data-testid="handwriting-summary">
          {summary && (
            <p>
              {summary.learned === 0
                ? "neb hasn't learned anything about your handwriting yet."
                : `neb has learned ${summary.learned} ${summary.learned === 1 ? "thing" : "things"} about your handwriting.`}
            </p>
          )}
          {summary && summary.confusions.length > 0 && (
            <ul className="list-inside list-disc text-muted">
              {summary.confusions.slice(0, 5).map((c) => (
                <li key={`${c.read}-${c.meant}`}>
                  your <span className="font-mono text-ink">{c.meant}</span> was read as{" "}
                  <span className="font-mono text-ink">{c.read}</span>
                  {c.count > 1 ? ` (${c.count} times)` : ""}
                </li>
              ))}
            </ul>
          )}
          {failed && <p className="text-muted">Couldn&apos;t reach neb. Try again later.</p>}
          {calibrating ? (
            <Calibration
              skipLabel="Cancel"
              onDone={(learned) => {
                setCalibrating(false);
                if (learned !== null) load();
              }}
            />
          ) : (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setCalibrating(true)}
                className="rounded-full border border-ink px-4 py-1.5"
              >
                {summary?.calibrated
                  ? "Calibrate again (60 s)"
                  : "Teach neb your handwriting (60 s)"}
              </button>
              {summary && summary.learned > 0 && !confirmReset && (
                <button
                  type="button"
                  onClick={() => setConfirmReset(true)}
                  className="rounded-full border border-line px-4 py-1.5 text-muted"
                >
                  Reset
                </button>
              )}
              {confirmReset && (
                <span className="flex items-center gap-2">
                  Forget everything neb learned?
                  <button
                    type="button"
                    onClick={() => void reset()}
                    className="rounded-full border border-line px-3 py-1"
                  >
                    Forget it
                  </button>
                  <button type="button" onClick={() => setConfirmReset(false)}>
                    Keep it
                  </button>
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
