"use client";

import { useEffect, useRef } from "react";

import { NebDot } from "@/components/ui/NebDot";

import { Calibration } from "../handwriting/Calibration";

/**
 * First run (NEB_APP_UI §5.10, decision U34): only K10's 60-second handwriting calibration,
 * skippable. Everything else a new student needs is shown in the app itself by the tour that
 * follows (the writing hand, how much neb marks and Screen Coach all have their own controls).
 * Finishing or skipping it starts listening: it's a click, so the browser allows audio and the
 * microphone prompt, and the dialog says so first. The first notebook is named on the desk's
 * first-run cover.
 */
export function Onboarding({
  onDone,
  onStartListening,
}: {
  onDone(): void;
  onStartListening(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => element?.close();
  }, []);

  const finish = (listen: boolean) => {
    dialog.current?.close();
    if (listen) onStartListening();
    onDone();
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby="onboarding-title"
      data-testid="onboarding"
      onCancel={(e) => {
        e.preventDefault(); // Escape: skipped, and nothing starts
        finish(false);
      }}
      className="m-auto w-[min(40rem,calc(100vw-2rem))] rounded-[14px] border-0 bg-desk p-0 text-ink shadow-sh-3 backdrop:bg-ink/30"
    >
      <div className="flex flex-col gap-6 p-8">
        <header className="flex items-center gap-3">
          <NebDot state="watching" size={26} />
        </header>
        <h2 id="onboarding-title" className="font-serif text-[40px] leading-tight">
          Teach neb your handwriting
        </h2>
        <div>
          <p className="mb-4 text-muted">
            60 seconds, so neb reads your 7s and your xs right. Then neb starts listening: it stays
            quiet until you ask.
          </p>
          <Calibration skipLabel="Skip, neb will learn as you go" onDone={() => finish(true)} />
        </div>
      </div>
    </dialog>
  );
}
