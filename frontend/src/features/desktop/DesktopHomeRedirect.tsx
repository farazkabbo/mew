"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

import { isDesktop } from "./bridge";

/** The desktop app has no use for the marketing page (signing out lands there): log in instead. */
export function DesktopHomeRedirect() {
  const pathname = usePathname();
  useEffect(() => {
    if (pathname === "/" && isDesktop()) window.location.replace("/sign-in");
  }, [pathname]);
  return null;
}
