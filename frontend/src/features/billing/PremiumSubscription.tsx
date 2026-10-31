/**
 * Premium subscription display with status and management options
 */

import type { SubscriptionStatus } from "@mew/shared/src/billing";

export function PremiumSubscription({ subscription }: { subscription: SubscriptionStatus }) {
  const periodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end)
    : null;

  return (
    <div className="rounded-xl border border-line bg-paper p-6">
      <div className="flex items-center gap-3">
        <div className="flex size-12 items-center justify-center rounded-full bg-ink">
          <span className="text-xl text-paper">⚡</span>
        </div>
        <div>
          <div className="font-medium">Premium</div>
          <div className="text-sm text-muted">Unlimited access • ElevenLabs voices</div>
        </div>
        <StatusBadge status={subscription.status || "active"} />
      </div>

      {periodEnd && (
        <div className="mt-4 border-t border-line pt-4">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted">
              {subscription.cancel_at_period_end ? "Active until" : "Renews on"}
            </span>
            <span className="font-medium">
              {periodEnd.toLocaleDateString("en-US", {
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
            </span>
          </div>
          {subscription.cancel_at_period_end && (
            <div className="mt-2 text-sm text-muted">
              Your subscription will end on this date. You can reactivate anytime before then.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusBadge({
  status,
}: {
  status: "free" | "active" | "canceled" | "past_due" | "incomplete" | "trialing";
}) {
  const styles = {
    free: "bg-gray-100 text-gray-700",
    active: "bg-green-100 text-green-700",
    trialing: "bg-blue-100 text-blue-700",
    canceled: "bg-gray-100 text-gray-700",
    past_due: "bg-red-100 text-red-700",
    incomplete: "bg-yellow-100 text-yellow-700",
  };

  const labels = {
    free: "Free",
    active: "Active",
    trialing: "Trial",
    canceled: "Canceled",
    past_due: "Past Due",
    incomplete: "Incomplete",
  };

  return (
    <span
      className={`ml-auto rounded-full px-2.5 py-0.5 text-xs font-medium ${styles[status]}`}
    >
      {labels[status]}
    </span>
  );
}

