"use client";

import Link from "next/link";
import { useEffect } from "react";

/** A page crashed while rendering: say so calmly, and offer a way back. Notes are local and safe. */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset(): void;
}) {
  useEffect(() => {
    console.error("[app] page error", error.digest ?? error.message);
  }, [error]);

  return (
    <main className="grid min-h-dvh place-items-center bg-paper px-6 text-ink">
      <div className="max-w-md text-center">
        <h1 className="font-serif text-4xl">Something went wrong</h1>
        <p className="mt-3 text-ink-muted">
          This page hit an unexpected problem. Your notes are saved on this device, so nothing is
          lost.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-paper"
          >
            Try again
          </button>
          <Link
            href="/notebook"
            className="rounded-full border border-rule px-5 py-2 text-sm hover:border-accent"
          >
            Back to the notebook
          </Link>
        </div>
      </div>
    </main>
  );
}
