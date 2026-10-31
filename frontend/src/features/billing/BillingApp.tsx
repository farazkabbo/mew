"use client";

import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";

import { CourseShell } from "../courses/CourseShell";
import { FreeTierUsage } from "./FreeTierUsage";
import { PremiumSubscription } from "./PremiumSubscription";
import { useBillingStore } from "./store";
import { UpgradeCard } from "./UpgradeCard";

/**
 * Billing dashboard: shows current plan, usage (if free), and upgrade/manage options
 */
export function BillingApp() {
  const { billing, loaded, error, load } = useBillingStore();

  useEffect(() => {
    void load();
  }, [load]);

  if (!loaded) {
    return (
      <CourseShell back={{ href: "/settings", label: "Settings" }} title="Billing">
        <div className="flex items-center justify-center py-20">
          <Loader2 className="size-8 animate-spin text-muted" />
        </div>
      </CourseShell>
    );
  }

  if (error) {
    return (
      <CourseShell back={{ href: "/settings", label: "Settings" }} title="Billing">
        <div className="rounded-xl border border-line bg-paper p-6 text-center">
          <p className="text-muted">Failed to load billing information</p>
          <p className="mt-2 text-sm text-muted">{error}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-4 rounded-full border border-line px-4 py-2 text-sm hover:border-ink"
          >
            Try Again
          </button>
        </div>
      </CourseShell>
    );
  }

  if (!billing) {
    return null;
  }

  const isPremium = billing.subscription.is_premium;

  return (
    <CourseShell back={{ href: "/settings", label: "Settings" }} title="Billing">
      <div className="space-y-8">
        {/* Current Plan */}
        <section>
          <h2 className="font-serif text-2xl">Current Plan</h2>
          <div className="mt-4">
            {isPremium ? (
              <PremiumSubscription subscription={billing.subscription} />
            ) : (
              <div className="rounded-xl border border-line bg-paper p-6">
                <div className="flex items-center gap-3">
                  <div className="flex size-12 items-center justify-center rounded-full bg-ink/10">
                    <span className="text-xl">✨</span>
                  </div>
                  <div>
                    <div className="font-medium">Free Tier</div>
                    <div className="text-sm text-muted">5-hour session limit</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Usage (Free Tier Only) */}
        {!isPremium && billing.usage && (
          <section>
            <h2 className="font-serif text-2xl">Usage</h2>
            <div className="mt-4">
              <FreeTierUsage usage={billing.usage} />
            </div>
          </section>
        )}

        {/* Upgrade/Manage */}
        <section>
          <h2 className="font-serif text-2xl">
            {isPremium ? "Manage Subscription" : "Upgrade to Premium"}
          </h2>
          <div className="mt-4">
            {isPremium ? (
              <div className="rounded-xl border border-line bg-paper p-6">
                <p className="text-sm text-muted">
                  Manage your subscription, update payment method, or view invoices through Stripe's
                  customer portal.
                </p>
                <ManageButton />
              </div>
            ) : (
              <UpgradeCard />
            )}
          </div>
        </section>

        {/* Features Comparison */}
        <section>
          <h2 className="font-serif text-2xl">What You Get</h2>
          <div className="mt-4">
            <ComparisonTable />
          </div>
        </section>
      </div>
    </CourseShell>
  );
}

function ManageButton() {
  const { manageSubscription, loading } = useBillingStore();

  return (
    <button
      type="button"
      onClick={() => void manageSubscription()}
      disabled={loading}
      className="mt-4 inline-flex items-center gap-2 rounded-full bg-ink px-6 py-2 font-medium text-paper hover:bg-ink/90 disabled:opacity-50"
    >
      {loading && <Loader2 className="size-4 animate-spin" />}
      Manage Subscription
    </button>
  );
}

function ComparisonTable() {
  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <table className="w-full">
        <thead>
          <tr className="border-b border-line bg-ink/5">
            <th className="px-4 py-3 text-left text-sm font-medium">Feature</th>
            <th className="px-4 py-3 text-center text-sm font-medium">Free</th>
            <th className="px-4 py-3 text-center text-sm font-medium">Premium</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          <TableRow feature="Usage Limit" free="5 hours (resets after cooldown)" premium="Unlimited" />
          <TableRow feature="Voice System" free="Kokoro AI (8 voices)" premium="ElevenLabs (100+ voices)" />
          <TableRow feature="Voice Quality" free="Good" premium="Excellent" />
          <TableRow feature="Tutoring" free="✓ Full access" premium="✓ Full access" />
          <TableRow feature="Courses" free="✓ Full access" premium="✓ Full access" />
          <TableRow feature="Notebooks" free="✓ Full access" premium="✓ Full access" />
          <TableRow feature="Handwriting" free="✓ Full access" premium="✓ Full access" />
          <TableRow feature="Price" free="$0" premium="$15/month" />
        </tbody>
      </table>
    </div>
  );
}

function TableRow({ feature, free, premium }: { feature: string; free: string; premium: string }) {
  return (
    <tr>
      <td className="px-4 py-3 text-sm font-medium">{feature}</td>
      <td className="px-4 py-3 text-center text-sm text-muted">{free}</td>
      <td className="px-4 py-3 text-center text-sm text-ink">{premium}</td>
    </tr>
  );
}

