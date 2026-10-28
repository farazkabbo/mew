"use client";

import Link from "next/link";
import type { ReactNode } from "react";

type Props = {
  /** The notebook tree (`TreeNav`). */
  notebooks: ReactNode;
};

export function Sidebar({ notebooks }: Props) {
  return (
    <aside className="hidden w-60 shrink-0 flex-col bg-paper text-ink md:flex">
      <Link href="/desk" className="px-5 pt-5 pb-6 font-serif text-2xl tracking-tight">
        neb
      </Link>

      <nav
        aria-label="Notebooks"
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3"
      >
        {notebooks}
      </nav>
    </aside>
  );
}
