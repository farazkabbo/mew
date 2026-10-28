import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";

import { isClerkConfigured } from "@/lib/auth-mode";
import { type Check, checkApiAuth, checkSupabaseRls } from "@/server/diagnostics";

export const metadata: Metadata = { title: "Status · Neb" };

export default async function StatusPage() {
  const checks = isClerkConfigured ? await authChainChecks() : [CLERK_MISSING];

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-16">
      <h1 className="font-serif text-4xl tracking-tight">System status</h1>
      <p className="mt-2 text-muted">End-to-end checks of the auth chain for your account.</p>
      <ul className="mt-10 divide-y divide-line border-y border-line">
        {checks.map((check) => (
          <li key={check.name} className="flex gap-4 py-4">
            <span
              aria-hidden
              className={`mt-1.5 size-2.5 shrink-0 rounded-full ${check.ok ? "bg-ink" : "bg-danger"}`}
            />
            <div>
              <p className="font-medium">
                {check.name}
                <span className="sr-only">{check.ok ? " — passing" : " — failing"}</span>
              </p>
              <p className="text-sm text-muted">{check.detail}</p>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}

const CLERK_MISSING: Check = {
  name: "Clerk configured",
  ok: false,
  detail:
    "Running in local mode. Set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY (see README) to test the auth chain.",
};

async function authChainChecks(): Promise<Check[]> {
  const { userId, getToken } = await auth.protect();
  return [
    { name: "Signed in with Clerk", ok: true, detail: "Session verified by the web server." },
    ...(await Promise.all([checkApiAuth(userId, await getToken()), checkSupabaseRls(userId)])),
  ];
}
