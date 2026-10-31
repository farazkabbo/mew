/**
 * Upgrade to premium card with benefits and CTA
 */

import { Loader2 } from "lucide-react";

import { useBillingStore } from "./store";

export function UpgradeCard() {
  const { upgrade, loading } = useBillingStore();

  return (
    <div className="rounded-xl border-2 border-ink bg-paper p-6">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xl font-medium">Neb Premium</div>
          <div className="mt-1 text-2xl font-bold">$15/month</div>
        </div>
        <div className="text-2xl">⚡</div>
      </div>

      <ul className="mt-4 space-y-2">
        <Benefit text="Unlimited usage (no time limits)" />
        <Benefit text="ElevenLabs premium voices (100+ options)" />
        <Benefit text="Highest quality voice synthesis" />
        <Benefit text="All features unlocked" />
        <Benefit text="Cancel anytime" />
      </ul>

      <button
        type="button"
        onClick={() => void upgrade()}
        disabled={loading}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-full bg-ink px-6 py-3 font-medium text-paper hover:bg-ink/90 disabled:opacity-50"
      >
        {loading && <Loader2 className="size-4 animate-spin" />}
        Upgrade to Premium
      </button>

      <p className="mt-3 text-center text-xs text-muted">
        Secure payment powered by Stripe • Cancel anytime
      </p>
    </div>
  );
}

function Benefit({ text }: { text: string }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <span className="text-green-600">✓</span>
      <span>{text}</span>
    </li>
  );
}

