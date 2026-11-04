"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { SignOutMenuItem } from "@/components/AccountControls";

const LINKS = [
  { href: "/courses", label: "Courses" },
  { href: "/review", label: "Review" },
  { href: "/teach", label: "Teach neb" },
  { href: "/settings", label: "Settings" },
] as const;

/**
 * The avatar on the desk (docs/NEB_APP_UI.md §5.1, decision U14): the student's initial, opening
 * Courses, Review, Teach neb, Settings and the account.
 */
export function DeskMenu({ name }: { name: string | null }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div ref={root} className="relative shrink-0">
      <button
        type="button"
        aria-label="Your account and more"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="grid size-10 place-items-center rounded-full bg-teal font-serif text-[22px] leading-none text-white"
      >
        {(name?.trim()[0] ?? "n").toUpperCase()}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-12 right-0 z-60 flex w-52 flex-col rounded-[14px] border border-line bg-paper-hi p-1.5 text-sm shadow-sh-2"
        >
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              role="menuitem"
              className="rounded-[10px] px-3 py-2 hover:bg-line/50"
            >
              {link.label}
            </Link>
          ))}
          <div className="mt-1 flex flex-col border-t border-line pt-1">
            <SignOutMenuItem />
          </div>
        </div>
      )}
    </div>
  );
}
