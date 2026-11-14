"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { markTourSeen } from "./seen";
import { startTour } from "./store";

/**
 * `/tour` (decision U32): starts the guided tour and goes to the desk, where it begins. The
 * guide itself lives in the app's layout, over the real screens.
 */
export function StartTour({ userId }: { userId: string }) {
  const router = useRouter();
  useEffect(() => {
    markTourSeen(userId);
    startTour();
    router.replace("/desk");
  }, [router, userId]);
  return (
    <p className="grid min-h-dvh place-items-center bg-desk text-muted" role="status">
      Starting the tour…
    </p>
  );
}
