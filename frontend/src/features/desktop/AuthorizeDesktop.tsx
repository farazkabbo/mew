"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import { DeviceLinkCode } from "@mew/shared";
import { useState } from "react";

import { authPrimaryButton, authQuietButton, AuthScreen } from "./AuthScreen";

type Step = "confirm" | "sending" | "sent" | "failed" | "cancelled";

/**
 * The way back to the desktop app; it checks the state is its own and the code against the
 * sign-in it started. (When the link is blocked, the app's polling picks the sign-in up.)
 */
const signInLink = (code: string, state: string | null) =>
  `neb://auth/callback?code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ""}`;

const DEVICES = { windows: "a Windows PC", mac: "a Mac" } as const;

/** "just now", "3 minutes ago"… from the app's start time (seconds), as the page sees it. */
function startedWhen(startedAt: number | null): string | null {
  if (startedAt === null) return null;
  const minutes = Math.floor((Date.now() / 1000 - startedAt) / 60);
  if (minutes < 1) return "just now";
  if (minutes < 15) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  return null;
}

/**
 * In the browser, signed in: confirms which account and which computer, then sends the app a
 * one-time code. Always a click: a page mustn't be able to sign anyone's app in just by opening
 * this address (with polling, an attacker could otherwise start a sign-in and have a victim's
 * open tab finish it). "This wasn't me" cancels the sign-in for good.
 */
export function AuthorizeDesktop({
  challenge,
  state,
  device,
  startedAt,
}: {
  challenge: string | null;
  state: string | null;
  device: keyof typeof DEVICES | null;
  startedAt: number | null;
}) {
  const { signOut } = useClerk();
  const { user } = useUser();
  const [step, setStep] = useState<Step>("confirm");
  const [link, setLink] = useState<string | null>(null);

  if (!challenge) {
    return (
      <AuthScreen title="Nothing to do here">
        <p className="text-muted">Open Neb Desktop and choose Continue with browser.</p>
      </AuthScreen>
    );
  }

  const send = async () => {
    setStep("sending");
    try {
      const response = await fetch("/api/devices/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge }),
        cache: "no-store",
      });
      if (!response.ok) throw new Error("link code refused");
      const { code } = DeviceLinkCode.parse(await response.json());
      const next = signInLink(code, state);
      setLink(next);
      setStep("sent");
      window.location.assign(next);
    } catch {
      setStep("failed");
    }
  };

  const notMe = async () => {
    // Nothing is connected: no code was made, and this sign-in can't be finished from now on.
    await fetch("/api/devices/link/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge }),
      cache: "no-store",
    }).catch(() => undefined);
    setStep("cancelled");
  };

  if (step === "cancelled") {
    return (
      <AuthScreen title="Cancelled">
        <p className="text-muted">Nothing was connected to your account. You can close this tab.</p>
      </AuthScreen>
    );
  }

  if (step === "sent") {
    return (
      <AuthScreen title="You're signed in">
        <p className="text-muted">Head back to Neb Desktop. You can close this tab.</p>
        {link && (
          <a href={link} className={authQuietButton}>
            Didn&apos;t switch? Open Neb Desktop
          </a>
        )}
      </AuthScreen>
    );
  }
  const email = user?.primaryEmailAddress?.emailAddress;
  const when = startedWhen(startedAt);
  return (
    <AuthScreen
      title={`Connect neb on ${device ? DEVICES[device] : "this computer"}${when ? `, started ${when}` : ""}?`}
    >
      <p className="text-muted">
        {email ? (
          <>
            Continue as <span className="text-ink">{email}</span>?
          </>
        ) : (
          "Continue with this account?"
        )}
      </p>
      <button
        type="button"
        disabled={step === "sending"}
        onClick={() => void send()}
        className={authPrimaryButton}
      >
        {step === "sending" ? "Opening Neb Desktop…" : "Continue"}
      </button>
      <button type="button" onClick={() => void notMe()} className={authQuietButton}>
        This wasn&apos;t me
      </button>
      {step === "failed" && (
        <p role="alert" className="text-sm text-muted">
          That didn&apos;t work. Start again from Neb Desktop.
        </p>
      )}
      <button
        type="button"
        onClick={() => void signOut({ redirectUrl: window.location.href })}
        className={authQuietButton}
      >
        Use a different account
      </button>
    </AuthScreen>
  );
}
