import { Show, SignInButton, SignOutButton, UserButton } from "@clerk/nextjs";

import { isClerkConfigured } from "@/lib/auth-mode";

/**
 * Signing out from inside a menu. Clerk's UserButton opens its popover outside the menu, so a press
 * on its "Sign out" counts as a press outside: the menu closes and takes the popover with it.
 */
export function SignOutMenuItem() {
  if (!isClerkConfigured) return null;
  return (
    <Show when="signed-in">
      <SignOutButton redirectUrl="/sign-in">
        <button
          type="button"
          role="menuitem"
          className="rounded-[10px] px-3 py-2 text-left hover:bg-line/50"
        >
          Sign out
        </button>
      </SignOutButton>
    </Show>
  );
}

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
