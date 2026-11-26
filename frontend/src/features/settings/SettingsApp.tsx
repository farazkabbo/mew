"use client";

import { NEB_LANGUAGES, type NebLanguage, TTS_SAMPLE_RATE } from "@mew/shared";
import { Loader2, Volume2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";

import { CourseShell } from "../courses/CourseShell";
import {
  hasCombinedSettings,
  isDesktop,
  openSettingsOnThisPc,
  screenCoachForOnboarding,
} from "../desktop/bridge";
import { momentsApi } from "../moments/api";
import { useMomentChecks } from "../moments/store";
import { ShortcutsSection } from "../shortcuts/ShortcutsSection";
import { PcmStreamPlayer } from "../tutor/pcm-player";
import { Section, Toggle } from "./controls";
import { DevicesSection } from "./DevicesSection";
import { DisplaySection } from "./DisplaySection";
import { LatencyTable } from "./LatencyTable";
import { HandwritingSection } from "../handwriting/HandwritingSection";
import { LanguagePicker } from "./LanguagePicker";
import { PrivacySection } from "./PrivacySection";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "./sections";
import { useSettings } from "./store";

/**
 * Settings (brief §12), one page at a time beside a sidebar: the tutor, voice and language,
 * appearance, handwriting, shortcuts (K2), helping improve Neb, signed-in devices, and about.
 *
 * In the desktop app, Settings is one window on the computer (`desktop/shell/screen-coach.html`)
 * holding this PC's pages and these, each of these shown on its own (`embed`) in a part of that
 * window that can't reach the computer's settings. So there, this page only opens that window.
 */
export function SettingsApp({
  section = "tutor",
  embed = false,
}: {
  section?: SettingsSectionId;
  /** Shown inside the desktop app's settings window: only the page, nothing around it. */
  embed?: boolean;
}) {
  const { loaded, localOnly, error } = useSettings();
  // Known only in the browser (the server renders the web app's settings page).
  const combined = useSyncExternalStore(noChange, hasCombinedSettings, () => false);
  // An older desktop app (its settings window has only this PC's pages): a way there.
  const desktop = useSyncExternalStore(noChange, isDesktop, () => false);

  useEffect(() => {
    void useSettings.getState().load();
    void useSettings.getState().loadVoices();
  }, []);

  const saved = !loaded
    ? "Loading…"
    : localOnly
      ? (error ?? "Saved on this device (your account isn't reachable).")
      : "Saved to your account.";

  if (embed) {
    return (
      <div className="min-h-dvh bg-paper px-8 py-7 text-ink">
        <p className="mb-6 text-sm text-muted">{saved}</p>
        <SectionBody id={section} />
      </div>
    );
  }

  if (combined) return <OpenOnThisPc section={section} />;

  return (
    <CourseShell
      back={{ href: "/notebook", label: "Notebook" }}
      title="Settings"
      subtitle={saved}
      wide
    >
      <div className="grid gap-8 md:grid-cols-[12rem_minmax(0,1fr)]">
        <nav aria-label="Settings pages" className="md:sticky md:top-8 md:self-start">
          <ul className="flex flex-wrap gap-1 md:flex-col">
            {SETTINGS_SECTIONS.map(({ id, label }) => (
              <li key={id}>
                <Link
                  href={`/settings?section=${id}`}
                  replace
                  scroll={false}
                  aria-current={id === section ? "page" : undefined}
                  className="block rounded-lg px-3 py-2 text-sm text-muted hover:bg-paper-hi hover:text-ink aria-[current=page]:bg-paper-hi aria-[current=page]:font-medium aria-[current=page]:text-ink"
                >
                  {label}
                </Link>
              </li>
            ))}
          </ul>
          {desktop && (
            <button
              type="button"
              onClick={() => void screenCoachForOnboarding(true)}
              className="mt-3 block rounded-lg px-3 py-2 text-left text-sm text-muted hover:bg-paper-hi hover:text-ink"
            >
              This PC&apos;s settings →
            </button>
          )}
        </nav>
        <div className="min-w-0 rounded-2xl border border-line bg-paper-hi/40 p-6 sm:p-8">
          <SectionBody id={section} />
        </div>
      </div>
    </CourseShell>
  );
}

/** One settings page. */
function SectionBody({ id }: { id: SettingsSectionId }) {
  switch (id) {
    case "tutor":
      return <TutorSection />;
    case "voice":
      return <VoiceSection />;
    case "appearance":
      return <DisplaySection />;
    case "handwriting":
      return <HandwritingSection />;
    case "shortcuts":
      return <ShortcutsSection />;
    case "improve":
      return <PrivacySection />;
    case "devices":
      return <DevicesSection />;
    case "about":
      return <AboutSection />;
  }
}

/**
 * The desktop app, on a version whose settings window holds these pages too (most links there
 * open it without coming here: `SettingsLink`). It opens at the page, and Neb's window goes back
 * to the notebook; if it couldn't be opened, a button to try again.
 */
function OpenOnThisPc({ section }: { section: SettingsSectionId }) {
  const router = useRouter();
  useEffect(() => {
    void openSettingsOnThisPc(section).then((opened) => {
      if (opened) router.replace("/notebook");
    });
  }, [router, section]);
  return (
    <CourseShell back={{ href: "/notebook", label: "Notebook" }} title="Settings">
      <div className="max-w-xl space-y-4 rounded-2xl border border-line bg-paper-hi/40 p-6">
        <p>
          Your settings are in their own window: this PC&apos;s settings and your account&apos;s,
          side by side.
        </p>
        <button
          type="button"
          onClick={() => void openSettingsOnThisPc(section)}
          className="rounded-full bg-ink px-4 py-1.5 text-sm font-medium text-paper"
        >
          Open settings
        </button>
      </div>
    </CourseShell>
  );
}

function TutorSection() {
  const { settings, update } = useSettings();
  const desktop = useSyncExternalStore(noChange, isDesktop, () => false);
  /** "Quiz me on things I save" was just turned off: keep the checks, or clear them (K8). */
  const [askClear, setAskClear] = useState(false);
  return (
    <div className="space-y-10">
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

      <Section title="Neb in your notebook">
        <Toggle
          label="Start listening when a notebook opens"
          hint="Otherwise, tap the microphone. Your browser asks for permission the first time."
          checked={settings.listen_on_open}
          onChange={(listen_on_open) => void update({ listen_on_open })}
        />
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
    </div>
  );
}

function VoiceSection() {
  const { settings, voices, update } = useSettings();
  return (
    <Section title="Voice & language">
      <LanguagePicker
        value={settings.language}
        onChange={(language) => void update({ language })}
      />
      {voices.length === 0 ? (
        <p className="text-sm text-muted">
          The tutor&apos;s voice isn&apos;t set up on this server.
        </p>
      ) : (
        <VoicePicker
          voices={voices}
          value={voices.find((voice) => voice.id === settings.voice_id)?.id ?? voices[0]?.id ?? ""}
          onChange={(voice_id) => void update({ voice_id })}
          language={settings.language}
        />
      )}
    </Section>
  );
}

function AboutSection() {
  const { update } = useSettings();
  return (
    <div className="space-y-10">
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
      <Section title="Performance">
        <p className="text-sm text-muted">
          How quickly the tutor has responded to you recently (on this server, since it started).
        </p>
        <LatencyTable />
      </Section>
    </div>
  );
}

function VoicePicker({
  voices,
  value,
  onChange,
  language,
}: {
  voices: { id: string; name: string }[];
  value: string;
  language: NebLanguage;
  onChange(id: string): void;
}) {
  const [player] = useState(() => new PcmStreamPlayer());
  /** The voice whose sample is playing, if any. */
  const [playing, setPlaying] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const sample = async (voiceId: string) => {
    player.unlock(); // inside the click
    setPlaying(voiceId);
    setProblem(null);
    try {
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: NEB_LANGUAGES[language].sample,
          voiceId,
          language,
        }),
        cache: "no-store",
      });
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
        setProblem(typeof body?.error === "string" ? body.error : "That voice couldn't be played.");
        return;
      }
      await player.play(response.body, { sampleRate: TTS_SAMPLE_RATE });
    } catch {
      setProblem("That voice couldn't be played.");
    } finally {
      setPlaying(null);
    }
  };

  return (
    <fieldset className="space-y-3" data-testid="voice-picker">
      <legend className="font-medium">Neb&apos;s voice</legend>
      <p className="text-sm text-muted">Neb uses it in your notebook and on your screen.</p>
      <div className="flex flex-wrap gap-2">
        {voices.map((voice) => (
          <div
            key={voice.id}
            className="flex items-center gap-1 rounded-full border border-line py-1 pr-1 pl-4 text-sm has-checked:border-ink has-checked:bg-paper-hi"
          >
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="radio"
                name="voice"
                value={voice.id}
                checked={value === voice.id}
                onChange={() => {
                  setProblem(null);
                  onChange(voice.id);
                }}
                className="accent-(--ink)"
              />
              {voice.name}
            </label>
            <button
              type="button"
              onClick={() => void sample(voice.id)}
              disabled={playing !== null}
              aria-label={`Hear ${voice.name}`}
              title={`Hear ${voice.name}`}
              className="ml-1 inline-flex size-8 items-center justify-center rounded-full hover:bg-paper-hi disabled:opacity-50"
            >
              {playing === voice.id ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Volume2 className="size-4" aria-hidden />
              )}
            </button>
          </div>
        ))}
      </div>
      {problem !== null && (
        <p role="alert" className="text-sm text-muted">
          {problem}
        </p>
      )}
    </fieldset>
  );
}

/** Whether this is the desktop app never changes while the page is open. */
function noChange(): () => void {
  return () => undefined;
}
