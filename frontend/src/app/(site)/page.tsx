import { Show, SignUpButton } from "@clerk/nextjs";
import Link from "next/link";

import { isClerkConfigured } from "@/lib/auth-mode";

const primaryButton = "rounded-full bg-ink px-5 py-2.5 text-sm text-paper hover:opacity-90";

export default function Home() {
  const openNotebook = (
    <Link href="/desk" className={primaryButton}>
      Open notebook
    </Link>
  );

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 px-6 py-24">
      <h1 className="font-serif text-5xl leading-tight tracking-tight sm:text-6xl">
        A tutor that waits <br />
        until you need it.
      </h1>
      <p className="max-w-lg text-lg text-muted">
        Write and think out loud in your notebook. Neb stays quiet — and when you&apos;re stuck,
        answers with a short hint in ink, right on the page.
      </p>
      <div className="flex gap-3">
        {isClerkConfigured ? (
          <>
            <Show when="signed-out">
              <SignUpButton>
                <button className={primaryButton}>Get started</button>
              </SignUpButton>
            </Show>
            <Show when="signed-in">{openNotebook}</Show>
          </>
        ) : (
          openNotebook
        )}
      </div>
    </main>
  );
}
