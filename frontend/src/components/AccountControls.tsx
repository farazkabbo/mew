import { Show, SignInButton, UserButton } from "@clerk/nextjs";

import { isClerkConfigured } from "@/lib/auth-mode";

export function AccountControls() {
  if (!isClerkConfigured) {
    return (
      <span
        className="rounded-full border border-line px-3 py-1 text-xs text-muted"
        title="Clerk keys are not configured; notes stay in this browser."
      >
        Local mode
      </span>
    );
  }
  return (
    <>
      <Show when="signed-out">
        <SignInButton>
          <button className="rounded-full border border-line px-4 py-1.5 text-sm hover:bg-paper-hi">
            Sign in
          </button>
        </SignInButton>
      </Show>
      <Show when="signed-in">
        <UserButton />
      </Show>
    </>
  );
}
