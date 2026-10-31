import type { ReactNode } from "react";

import { NebMark } from "@/components/ui/NebDot";

/** The calm full-window page around every step of signing the desktop app in. */
export function AuthScreen({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <main className="fixed inset-0 z-50 grid place-items-center overflow-auto bg-paper px-6 py-12">
      <div className="flex w-full max-w-sm flex-col items-center gap-5 text-center">
        <NebMark className="h-12 w-12" />
        <h1 className="font-serif text-4xl leading-tight tracking-tight">{title}</h1>
        {children}
      </div>
    </main>
  );
}

export const authPrimaryButton =
  "w-full rounded-full bg-ink px-5 py-3 font-medium text-paper hover:opacity-90 disabled:opacity-60";
export const authQuietButton = "text-sm text-muted underline-offset-2 hover:underline";
