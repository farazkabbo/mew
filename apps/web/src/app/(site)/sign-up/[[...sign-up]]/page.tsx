import { SignUp } from "@clerk/nextjs";
import { notFound } from "next/navigation";

import { isClerkConfigured } from "@/lib/auth-mode";

export default function SignUpPage() {
  if (!isClerkConfigured) notFound();
  return (
    <main className="grid flex-1 place-items-center px-4 py-16">
      <SignUp />
    </main>
  );
}
