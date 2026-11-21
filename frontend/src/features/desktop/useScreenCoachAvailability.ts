"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import { isDesktop, screenCoachForOnboarding } from "./bridge";

const noSubscription = () => () => undefined;

/** The existing Screen Coach command returns a boolean even when the feature is turned off. */
export function useScreenCoachAvailability(active: boolean): boolean | undefined {
  const desktop = useSyncExternalStore(noSubscription, isDesktop, () => false);
  const [available, setAvailable] = useState<boolean>();

  useEffect(() => {
    if (!desktop || !active || available !== undefined) return;
    let current = true;
    void screenCoachForOnboarding(false).then((on) => {
      if (current) setAvailable(on !== null);
    });
    return () => {
      current = false;
    };
  }, [desktop, active, available]);

  return desktop ? available : false;
}
