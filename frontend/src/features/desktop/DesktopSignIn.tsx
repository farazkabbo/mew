"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useState } from "react";

import { authPrimaryButton, authQuietButton, AuthScreen } from "./AuthScreen";
import { SIGN_IN_FAILED_EVENT, signOutOfDesktop, startDesktopSignIn } from "./bridge";

type Step = { kind: "ready"; error?: string } | { kind: "waiting"; url: string; copied: boolean };

const TRY_AGAIN = "That didn't work. Please try again.";

/** The desktop app's login screen: it hands signing in to the website, in the default browser. */
export function DesktopSignIn() {
  const { isLoaded, isSignedIn } = useAuth();
  const [step, setStep] = useState<Step>({ kind: "ready" });

  useEffect(() => {
    if (!isLoaded) return;
    if (isSignedIn) {
      window.location.replace("/desk");
      return;
    }
    // Signed out, or the session expired: this computer's Screen Coach sign-in ends with it.
    void signOutOfDesktop().catch(() => undefined);
  }, [isLoaded, isSignedIn]);

  useEffect(() => {
    const failed = () => setStep({ kind: "ready", error: TRY_AGAIN });
    window.addEventListener(SIGN_IN_FAILED_EVENT, failed);
    return () => window.removeEventListener(SIGN_IN_FAILED_EVENT, failed);
  }, []);

  const start = async () => {
    try {
      setStep({ kind: "waiting", url: await startDesktopSignIn(), copied: false });
    } catch {
      setStep({ kind: "ready", error: TRY_AGAIN });
    }
  };

  const copy = async (url: string) => {
    await navigator.clipboard.writeText(url);
    setStep({ kind: "waiting", url, copied: true });
  };

  if (!isLoaded || isSignedIn) return <AuthScreen title="neb" />;
  if (step.kind === "waiting") {
    return (
      <AuthScreen title="Finish in your browser">
        <p className="text-muted">
          Sign in on the page that just opened. We&apos;ll bring you back.
        </p>
        <button type="button" onClick={() => void copy(step.url)} className={authQuietButton}>
          {step.copied ? "Link copied" : "Didn't open? Copy the link"}
        </button>
        <button
          type="button"
          onClick={() => setStep({ kind: "ready" })}
          className={authQuietButton}
        >
          Cancel
        </button>
      </AuthScreen>
    );
  }
  return (
    <AuthScreen title="Welcome to neb">
      <p className="text-muted">
        Use your neb account. New here? You can create one in your browser.
      </p>
      <button type="button" onClick={() => void start()} className={authPrimaryButton}>
        Continue with browser
      </button>
      {step.error && (
        <p role="alert" className="text-sm text-muted">
          {step.error}
        </p>
      )}
    </AuthScreen>
  );
}
