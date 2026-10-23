"use client";

import { TTS_SAMPLE_RATE } from "@mew/shared";
import { Loader2, Volume2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { CourseShell } from "../courses/CourseShell";
import { PcmStreamPlayer } from "../tutor/pcm-player";
import { Section, Toggle } from "./controls";
import { DevicesSection } from "./DevicesSection";
import { LatencyTable } from "./LatencyTable";
import { PrivacySection } from "./PrivacySection";
import { useSettings } from "./store";

/** The settings screen (brief §12): listening, Mew, the tutor, voice, privacy, performance. */
export function SettingsApp() {
  const { settings, loaded, localOnly, error, voices, update } = useSettings();

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
        <Section title="Listening">
          <Toggle
            label="Start listening when a notebook opens"
            hint="Otherwise, tap the microphone. Your browser asks for permission the first time."
            checked={settings.listen_on_open}
            onChange={(listen_on_open) => void update({ listen_on_open })}
          />
        </Section>

        <Section title="Mew">
          <label className="block">
            <span className="font-medium">How readily Mew speaks up</span>
            <span className="mt-1 block text-sm text-ink-muted">
              Mew only answers when it&apos;s this sure you want help. Tapping Mew always works.
            </span>
            <span className="mt-3 flex items-center gap-3 text-sm text-ink-muted">
              <span>More often</span>
              <input
                type="range"
                min={0.3}
                max={0.95}
                step={0.05}
                value={settings.mew_threshold}
                aria-label="Mew sensitivity threshold"
                aria-valuetext={`${Math.round(settings.mew_threshold * 100)}% sure`}
                onChange={(e) => void update({ mew_threshold: Number(e.target.value) })}
                className="flex-1 accent-(--accent)"
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
                    className="mt-1 accent-(--accent)"
                  />
                  <span>
                    {label}
                    <span className="block text-sm text-ink-muted">{hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <Toggle
            label="Captions"
            hint="Show what the tutor says next to Mew."
            checked={settings.captions}
            onChange={(captions) => void update({ captions })}
          />
          <Toggle
            label="Check my steps as I write"
            hint="After a pause, a correct step gets a quiet tick; a wrong one gets a hint."
            checked={settings.auto_check}
            onChange={(auto_check) => void update({ auto_check })}
          />
          <Toggle
            label="Let the tutor check my notes"
            hint="Keeps the text of your notes (never your handwriting itself) with your account, so the tutor can compare what's on your screen with what you wrote. Turning this off deletes that copy."
            checked={settings.notes_index}
            onChange={(notes_index) => void update({ notes_index })}
          />
        </Section>

        <Section title="Voice">
          {voices.length === 0 ? (
            <p className="text-sm text-ink-muted">
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

        <PrivacySection />

        <DevicesSection />

        <Section title="Performance">
          <p className="text-sm text-ink-muted">
            How quickly the tutor has responded to you recently (on this server, since it started).
          </p>
          <LatencyTable />
        </Section>

        <Section title="Introduction">
          <button
            type="button"
            onClick={() => void update({ onboarded: false })}
            className="rounded-full border border-rule px-4 py-1.5 text-sm hover:border-accent"
          >
            Show the introduction again
          </button>
          <p className="text-sm text-ink-muted">
            It appears next time you open the{" "}
            <Link href="/notebook" className="underline hover:text-accent">
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
          text: "Hi, I'm Mew. I'll stay quiet until you need me.",
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
            className="rounded-lg border border-rule bg-paper px-3 py-1.5 outline-none focus:border-accent"
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
          className="inline-flex items-center gap-1.5 rounded-full border border-rule px-3 py-1.5 text-sm hover:border-accent disabled:opacity-50"
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
        <p role="alert" className="text-sm text-error">
          {state}
        </p>
      )}
    </div>
  );
}
