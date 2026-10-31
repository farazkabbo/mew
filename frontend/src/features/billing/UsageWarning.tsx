/**
 * Usage warning banner - shows at 80%, 90%, or 100% usage
 */

import type { UsageInfo } from "@mew/shared/src/billing";
import { AlertTriangle, Clock } from "lucide-react";
import Link from "next/link";

export function UsageWarning({ usage }: { usage: UsageInfo }) {
  // Don't show if under 80%
  if (usage.percentage_used < 80) {
    return null;
  }

  // In cooldown
  if (usage.in_cooldown) {
    return (
      <div
        role="alert"
        className="border-b border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
      >
        <div className="mx-auto flex max-w-4xl items-center gap-3">
          <Clock className="size-5 flex-shrink-0" />
          <div className="flex-1">
            <strong className="font-medium">Session limit reached.</strong> Your session resets
            when the cooldown ends. Want unlimited access?
          </div>
          <Link
            href="/billing"
            className="whitespace-nowrap rounded-full bg-red-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-800"
          >
            Upgrade
          </Link>
        </div>
      </div>
    );
  }

  // At limit (100%)
  if (usage.percentage_used >= 100) {
    return (
      <div
        role="alert"
        className="border-b border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
      >
        <div className="mx-auto flex max-w-4xl items-center gap-3">
          <AlertTriangle className="size-5 flex-shrink-0" />
          <div className="flex-1">
            <strong className="font-medium">You've used all 5 free hours.</strong> Upgrade to
            Premium for unlimited access, or wait for the cooldown to reset.
          </div>
          <Link
            href="/billing"
            className="whitespace-nowrap rounded-full bg-red-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-800"
          >
            Upgrade
          </Link>
        </div>
      </div>
    );
  }

  // Warning (80-99%)
  const hoursLeft = Math.floor((usage.seconds_limit - usage.seconds_used) / 3600);
  const minutesLeft = Math.floor(((usage.seconds_limit - usage.seconds_used) % 3600) / 60);

  return (
    <div
      role="alert"
      className="border-b border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-900"
    >
      <div className="mx-auto flex max-w-4xl items-center gap-3">
        <AlertTriangle className="size-5 flex-shrink-0" />
        <div className="flex-1">
          <strong className="font-medium">Running low on free hours.</strong> You have {hoursLeft}h{" "}
          {minutesLeft}m left. Want unlimited?
        </div>
        <Link
          href="/billing"
          className="whitespace-nowrap rounded-full border border-yellow-900 px-4 py-1.5 text-sm font-medium hover:bg-yellow-100"
        >
          Upgrade
        </Link>
      </div>
    </div>
  );
}

