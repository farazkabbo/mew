import Link from "next/link";

import { AccountControls } from "./AccountControls";

export function SiteHeader() {
  return (
    <header className="flex h-14 items-center justify-between border-b border-rule px-6">
      <Link href="/" className="font-serif text-2xl tracking-tight">
        mew
      </Link>
      <AccountControls />
    </header>
  );
}
