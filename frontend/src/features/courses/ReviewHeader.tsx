"use client";

import { ChevronLeft, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { Keys } from "@/components/ui/Keycap";
import { NebMark } from "@/components/ui/NebDot";

import { Wordmark } from "../desk/Desk";
import { DeskMenu } from "../desk/DeskMenu";
import { treeShortcut } from "../notebook/tree/useTreeShortcuts";
import { useShortcutKeys } from "../shortcuts/useShortcutKeys";

/** The desk with its jump palette open (the palette needs the notebook tree, which lives there). */
export const JUMP_HREF = "/desk?jump=1";

/**
 * The desk's header on the Review page (docs/NEB_APP_UI.md decision U25): back to the desk, neb,
 * the jump search and the avatar menu. The jump key works here too.
 */
export function ReviewHeader({ name }: { name: string | null }) {
  const router = useRouter();
  const keys = useShortcutKeys();
  const { platform, own } = keys;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (treeShortcut(event, platform, own) !== "jump") return;
      event.preventDefault();
      router.push(JUMP_HREF);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [platform, own, router]);
  const jump = keys.shown("jump");

  return (
    <header className="box-border flex min-h-[76px] flex-wrap items-center gap-5 border-b border-line px-10 py-3.5 max-sm:px-4">
      <Link
        href="/desk"
        className="flex h-11 items-center gap-1.5 rounded-full pr-3.5 pl-2 text-sm font-medium text-ink no-underline hover:text-muted"
      >
        <ChevronLeft className="size-5" strokeWidth={1.8} aria-hidden />
        Desk
      </Link>
      <span className="flex items-center gap-2.5" aria-label="neb">
        <NebMark className="h-[26px] w-[34px]" stroke="var(--neb)" />
        <Wordmark />
      </span>
      <div className="flex-[1_1_40px]" />
      <Link
        href={JUMP_HREF}
        className="hidden h-11 items-center gap-2.5 rounded-full border border-line bg-paper pr-2 pl-4 text-sm whitespace-nowrap text-muted no-underline transition-colors duration-[120ms] hover:border-ink/40 hover:text-muted md:flex"
        title={`Jump to any page or moment (${jump}) · or say “open physics chapter 3”`}
        aria-keyshortcuts={keys.aria("jump")}
      >
        <Search className="size-[18px] shrink-0" strokeWidth={1.8} aria-hidden />
        Jump to any page or moment
        <span className="ml-3">
          <Keys keys={jump.split("+")} size="md" />
        </span>
      </Link>
      <DeskMenu name={name} />
    </header>
  );
}
