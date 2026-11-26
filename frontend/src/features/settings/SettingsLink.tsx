"use client";

import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";

import { hasCombinedSettings, openSettingsOnThisPc } from "../desktop/bridge";
import type { SettingsSectionId } from "./sections";

/**
 * A link to Settings (at `section`, if given). In the desktop app, Settings is its own window on
 * the computer, so there the link opens that window at the page, and Neb's window stays where it
 * is (rather than going to a page that only says where Settings is).
 */
export function SettingsLink({
  section,
  className,
  role,
  onClick,
  children,
}: {
  section?: SettingsSectionId;
  className?: string;
  role?: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.();
    if (!hasCombinedSettings()) return;
    event.preventDefault();
    void openSettingsOnThisPc(section);
  };
  return (
    <Link
      href={section ? `/settings?section=${section}` : "/settings"}
      className={className}
      role={role}
      onClick={open}
    >
      {children}
    </Link>
  );
}
