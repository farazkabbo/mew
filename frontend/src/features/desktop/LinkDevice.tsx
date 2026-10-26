"use client";

import { DeviceChallenge, DeviceLinkCode } from "@mew/shared";
import Link from "next/link";
import { useEffect, useState } from "react";

import { CourseShell } from "../courses/CourseShell";
import { finishDeviceLink, isDesktop } from "./bridge";

type Step =
  | { kind: "checking" }
  | { kind: "not-desktop" }
  | { kind: "no-request" }
  | { kind: "confirm"; challenge: string }
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "failed"; message: string };

/**
 * Connects this computer's Mew desktop app to the signed-in account for Screen Coach
 * (decision 8). The desktop app opened this page with its challenge in the URL fragment (never
 * sent to the server); the student confirms, the page gets a one-time code for the challenge, and
 * hands it to the desktop app, which redeems it with the verifier only it knows.
 */
export function LinkDevice() {
  const [step, setStep] = useState<Step>({ kind: "checking" });

  useEffect(() => {
    // Only read here (React may run this twice in development): the URL is cleared once
    // connecting has finished, in `connect`.
    const challenge = DeviceChallenge.safeParse(
      new URLSearchParams(window.location.hash.slice(1)).get("challenge"),
    );
    const next: Step = !isDesktop()
      ? { kind: "not-desktop" }
      : challenge.success
        ? { kind: "confirm", challenge: challenge.data }
        : { kind: "no-request" };
    // Read from the URL after mounting (not during render): the server has no fragment.
    queueMicrotask(() => setStep(next));
  }, []);

  const connect = async (challenge: string) => {
    setStep({ kind: "connecting" });
    try {
      const response = await fetch("/api/devices/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge }),
        cache: "no-store",
      });
      if (!response.ok) throw new Error("link code refused");
      const { code } = DeviceLinkCode.parse(await response.json());
      await finishDeviceLink(code);
      setStep({ kind: "connected" });
    } catch {
      setStep({
        kind: "failed",
        message: "Connecting didn't work. Start again from Screen Coach settings in the tray.",
      });
    } finally {
      // The challenge has done its job (it works once): keep it out of the address and history.
      window.history.replaceState(null, "", window.location.pathname);
    }
  };

  return (
    <CourseShell back={{ href: "/notebook", label: "Notebook" }} title="Connect Screen Coach">
      <div className="max-w-prose space-y-4">
        {step.kind === "checking" && <p className="text-ink-muted">One moment…</p>}
        {step.kind === "not-desktop" && (
          <p>Open this page from the Neb desktop app: tray → Screen Coach settings → Connect.</p>
        )}
        {step.kind === "no-request" && (
          <p>
            There&apos;s nothing to connect right now. Start from the tray: Screen Coach settings →
            Connect.
          </p>
        )}
        {step.kind === "confirm" && (
          <>
            <p>
              Connect the Neb desktop app on this computer to your account? Screen Coach will then
              be able to answer your questions about your screen.
            </p>
            <p className="text-sm text-ink-muted">
              The app gets its own sign-in, which only works for Screen Coach. You can sign it out
              any time in{" "}
              <Link href="/settings" className="text-accent underline-offset-2 hover:underline">
                Settings → Signed-in devices
              </Link>
              .
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => void connect(step.challenge)}
                className="rounded-md bg-tutor px-4 py-2 font-medium text-white"
              >
                Connect
              </button>
              <Link href="/notebook" className="rounded-md border border-rule px-4 py-2">
                Not now
              </Link>
            </div>
          </>
        )}
        {step.kind === "connecting" && <p className="text-ink-muted">Connecting…</p>}
        {step.kind === "connected" && (
          <p>Connected. Hold Ctrl+Alt in any app and ask about your screen.</p>
        )}
        {step.kind === "failed" && (
          <p role="alert" className="text-error">
            {step.message}
          </p>
        )}
      </div>
    </CourseShell>
  );
}
