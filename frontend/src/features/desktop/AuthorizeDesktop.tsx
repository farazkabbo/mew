"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import { DeviceLinkCode } from "@mew/shared";
import { useState } from "react";

import { authPrimaryButton, authQuietButton, AuthScreen } from "./AuthScreen";

type Step = "confirm" | "sending" | "sent" | "failed";

/** The way back to the desktop app; it checks the code against the sign-in it started. */
const signInLink = (code: string) => `neb://auth/callback?code=${encodeURIComponent(code)}`;

/**
 * In the browser, signed in: confirms which account the desktop app should use, then sends it a
 * one-time code. Always a click: a page mustn't be able to sign anyone's app in just by opening
 * this address.
 */
export function AuthorizeDesktop({ challenge }: { challenge: string | null }) {
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
      const next = signInLink(code);
      setLink(next);
      setStep("sent");
      window.location.assign(next);
    } catch {
      setStep("failed");
    }
  };

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
  return (
    <AuthScreen title="Sign in to Neb Desktop">
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
