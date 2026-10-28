"use client";

import { TTS_SAMPLE_RATE } from "@mew/shared";
import { Loader2, Volume2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";

import { CourseShell } from "../courses/CourseShell";
import { isDesktop } from "../desktop/bridge";
import { momentsApi } from "../moments/api";
import { useMomentChecks } from "../moments/store";
import { ShortcutsSection } from "../shortcuts/ShortcutsSection";
import { PcmStreamPlayer } from "../tutor/pcm-player";
import { Section, Toggle } from "./controls";
import { DevicesSection } from "./DevicesSection";
import { DisplaySection } from "./DisplaySection";
import { LatencyTable } from "./LatencyTable";
import { HandwritingSection } from "../handwriting/HandwritingSection";
import { PrivacySection } from "./PrivacySection";
import { useSettings } from "./store";

/**
 * The settings screen (brief §12): listening, Mew, the tutor, voice, shortcuts (K2), privacy,
 * performance.
 */
export function SettingsApp() {
  const { settings, loaded, localOnly, error, voices, update } = useSettings();
  // Known only in the browser (the server renders the web app's settings page).
  const desktop = useSyncExternalStore(noChange, isDesktop, () => false);
  /** "Quiz me on things I save" was just turned off: keep the checks, or clear them (K8). */
  const [askClear, setAskClear] = useState(false);

  useEffect(() => {
    void useSettings.getState().load();
    void useSettings.getState().loadVoices();
  }, []);

  return (
    <CourseShell
      back={{ href: "/notebook", label: "Notebook" }}
      title="Settings"
      subtitle={
        !loaded
          ? "Loading…"
          : localOnly
            ? (error ?? "Saved on this device (your account isn't reachable).")
            : "Saved to your account."
      }
    >
      <div className="space-y-10">
        <DisplaySection />

        <Section title="Listening">
          <Toggle
            label="Start listening when a notebook opens"
            hint="Otherwise, tap the microphone. Your browser asks for permission the first time."
            checked={settings.listen_on_open}
            onChange={(listen_on_open) => void update({ listen_on_open })}
          />
        </Section>

        <Section title="Neb">
          <label className="block">
            <span className="font-medium">How readily Neb speaks up</span>
            <span className="mt-1 block text-sm text-muted">
              Neb only answers when it&apos;s this sure you want help. Tapping Neb always works.
            </span>
            <span className="mt-3 flex items-center gap-3 text-sm text-muted">
              <span>More often</span>
              <input
                type="range"
                min={0.3}
                max={0.95}
                step={0.05}
                value={settings.mew_threshold}
                aria-label="Neb sensitivity threshold"
                aria-valuetext={`${Math.round(settings.mew_threshold * 100)}% sure`}
                onChange={(e) => void update({ mew_threshold: Number(e.target.value) })}
                className="flex-1 accent-(--ink)"
              />
              <span>Quieter</span>
              <span className="w-10 text-right text-ink tabular-nums">
                {settings.mew_threshold.toFixed(2)}
              </span>
            </span>
          </label>
        </Section>

        <Section title="The tutor">
          <fieldset>
            <legend className="font-medium">Answer style</legend>
            <div className="mt-2 flex flex-wrap gap-4">
              {(
                [
                  ["hints_first", "Hints first", "Questions and hints before answers."],
                  ["direct", "Direct answers", "Straight to the answer when you ask."],
                ] as const
              ).map(([value, label, hint]) => (
                <label key={value} className="flex max-w-60 gap-2">
                  <input
                    type="radio"
                    name="answer-style"
                    checked={settings.answer_style === value}
                    onChange={() => void update({ answer_style: value })}
                    className="mt-1 accent-(--ink)"
                  />
                  <span>
                    {label}
                    <span className="block text-sm text-muted">{hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <Toggle
            label="Captions"
            hint="Show what the tutor says next to Neb."
            checked={settings.captions}
            onChange={(captions) => void update({ captions })}
          />
          <Toggle
            label="Mark my work as I write"
            hint="Each line you finish is checked: a right step gets a small tick, one that isn't right yet a circle and a short hint, silently. Choose how much in each notebook: Quiet, Hint or Coach."
            checked={settings.auto_check}
            onChange={(auto_check) => void update({ auto_check })}
          />
          <Toggle
            label="After a full solution: give me a Your Turn"
            hint="When you ask for the answer, Neb shows every step, then folds it away and gives you a similar problem to do on your own."
            checked={settings.your_turn_after_solution}
            onChange={(your_turn_after_solution) => void update({ your_turn_after_solution })}
          />
          <Toggle
            label="Quiz me on things I save"
            hint="Every moment you save from your screen comes back as a check question, about a day later and then spaced out. Answering it on your own counts toward what you know."
            checked={settings.quiz_saved_moments}
            onChange={(quiz_saved_moments) => {
              void update({ quiz_saved_moments });
              setAskClear(!quiz_saved_moments);
            }}
          />
          {desktop && (
            <Toggle
              label="Tell me when checks are due"
              hint="A Windows notification, at most twice a day, when questions about things you saved are waiting. Off: they wait in Review and the Quick check."
              checked={settings.notify_moment_checks}
              onChange={(notify_moment_checks) => void update({ notify_moment_checks })}
            />
          )}
          {askClear && (
            <div
              role="group"
              aria-label="Checks you already have"
              data-testid="moment-checks-keep-or-clear"
              className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-paper p-3 text-sm"
            >
              <span className="flex-1">
                No new checks from now on. Keep the ones you already have?
              </span>
              <button
                type="button"
                onClick={() => setAskClear(false)}
                className="rounded-full border border-line px-3 py-1 hover:border-ink"
              >
                Keep them
              </button>
              <button
                type="button"
                onClick={() =>
                  void momentsApi.clearChecks().then(
                    () => {
                      useMomentChecks.getState().clear();
                      setAskClear(false);
                    },
                    () => undefined,
                  )
                }
                className="rounded-full bg-ink px-3 py-1 font-medium text-paper"
              >
                Clear them
              </button>
            </div>
          )}
          <Toggle
            label="Let the tutor check my notes"
            hint="Keeps the text of your notes (never your handwriting itself) with your account, so the tutor can compare what's on your screen with what you wrote. Turning this off deletes that copy."
            checked={settings.notes_index}
            onChange={(notes_index) => void update({ notes_index })}
          />
        </Section>

        <HandwritingSection />

        <Section title="Voice">
          {voices.length === 0 ? (
            <p className="text-sm text-muted">
              The tutor&apos;s voice isn&apos;t set up on this server.
            </p>
          ) : (
            <VoicePicker
              voices={voices}
              value={settings.voice_id ?? voices[0]?.id ?? ""}
              onChange={(voice_id) => void update({ voice_id })}
            />
          )}
        </Section>

        <ShortcutsSection />

        <PrivacySection />

        <DevicesSection />

        <Section title="Performance">
          <p className="text-sm text-muted">
            How quickly the tutor has responded to you recently (on this server, since it started).
          </p>
          <LatencyTable />
        </Section>

        <Section title="Introduction">
          <button
            type="button"
            onClick={() => void update({ onboarded: false })}
            className="rounded-full border border-line px-4 py-1.5 text-sm hover:border-ink"
          >
            Show the introduction again
          </button>
          <p className="text-sm text-muted">
            It appears next time you open the{" "}
            <Link href="/notebook" className="underline hover:text-ink">
              notebook
            </Link>
            .
          </p>
        </Section>
      </div>
    </CourseShell>
  );
}

function VoicePicker({
  voices,
  value,
  onChange,
}: {
  voices: { id: string; name: string }[];
  value: string;
  onChange(id: string): void;
}) {
  const [player] = useState(() => new PcmStreamPlayer());
  const [state, setState] = useState<"idle" | "playing" | string>("idle");

  const sample = async () => {
    player.unlock(); // inside the click
    setState("playing");
    try {
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Hi, I'm Neb. I'll stay quiet until you need me.",
          voiceId: value,
        }),
        cache: "no-store",
      });
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
        setState(typeof body?.error === "string" ? body.error : "That voice couldn't be played.");
        return;
      }
      await player.play(response.body, { sampleRate: TTS_SAMPLE_RATE });
      setState("idle");
    } catch {
      setState("That voice couldn't be played.");
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          <span className="font-medium">Tutor&apos;s voice</span>
          <select
            value={value}
            onChange={(e) => {
              setState("idle");
              onChange(e.target.value);
            }}
            className="rounded-lg border border-line bg-paper px-3 py-1.5 outline-none focus:border-ink"
          >
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void sample()}
          disabled={state === "playing"}
          className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-sm hover:border-ink disabled:opacity-50"
        >
          {state === "playing" ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Volume2 className="size-4" aria-hidden />
          )}
          Play a sample
        </button>
      </div>
      {state !== "idle" && state !== "playing" && (
        <p role="alert" className="text-sm text-muted">
          {state}
        </p>
      )}
    </div>
  );
}

/** Whether this is the desktop app never changes while the page is open. */
function noChange(): () => void {
  return () => undefined;
}
