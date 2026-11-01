"use client";

import { useClerk, useSignIn } from "@clerk/nextjs";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { authPrimaryButton, AuthScreen } from "./AuthScreen";
import { takeDesktopSignInTicket } from "./bridge";

/**
 * In the desktop window, once the browser has finished: takes the ticket from the app (Rust, so
 * it's never in a URL) and starts the window's own session as the same user.
 */
export function FinishDesktopSignIn() {
  const clerk = useClerk();
  const { signIn } = useSignIn();
  const [failed, setFailed] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    // The ticket works once (React may run this twice in development).
    if (!clerk.loaded || started.current) return;
    started.current = true;
    void (async () => {
      try {
        // Sign-in only starts from the signed-out login screen, so this is a reload.
        if (clerk.session) {
          window.location.replace("/desk");
          return;
        }
        const ticket = await takeDesktopSignInTicket();
        if (!ticket) throw new Error("no ticket");
        const { error } = await signIn.ticket({ ticket });
        if (error || signIn.status !== "complete") throw new Error("ticket refused");
        await signIn.finalize({
          navigate: ({ decorateUrl }) => {
            window.location.replace(decorateUrl("/desk"));
          },
        });
      } catch {
        setFailed(true);
      }
    })();
  }, [clerk, signIn]);

  if (failed) {
    return (
      <AuthScreen title="That didn't work">
        <p role="alert" className="text-muted">
          Your browser signed in, but this window couldn&apos;t. Please try again.
        </p>
        <Link href="/sign-in" className={authPrimaryButton}>
          Try again
        </Link>
      </AuthScreen>
    );
  }
  return <AuthScreen title="Signing you in…" />;
}
