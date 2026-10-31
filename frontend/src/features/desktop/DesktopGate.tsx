"use client";

import { type ReactNode, useEffect, useState } from "react";

import { isDesktop } from "./bridge";
import { DesktopSignIn } from "./DesktopSignIn";

/**
 * /sign-in and /sign-up: on the website, Clerk's forms (`children`); in the desktop app, its login
 * screen, because nobody types a password into the app. Decided after mounting: the server can't
 * tell, and showing neither first means neither flashes.
 */
export function DesktopGate({ children }: { children: ReactNode }) {
  const [desktop, setDesktop] = useState<boolean | null>(null);
  useEffect(() => {
    queueMicrotask(() => setDesktop(isDesktop()));
  }, []);
  if (desktop === null) return null;
  return desktop ? <DesktopSignIn /> : children;
}
