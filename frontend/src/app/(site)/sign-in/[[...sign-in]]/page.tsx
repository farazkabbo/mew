import { SignIn } from "@clerk/nextjs";
import { notFound } from "next/navigation";

import { DesktopGate } from "@/features/desktop/DesktopGate";
import { isClerkConfigured } from "@/lib/auth-mode";

export default function SignInPage() {
  if (!isClerkConfigured) notFound();
  return (
    <DesktopGate>
      <main className="grid flex-1 place-items-center px-4 py-16">
        <SignIn />
      </main>
    </DesktopGate>
  );
}
