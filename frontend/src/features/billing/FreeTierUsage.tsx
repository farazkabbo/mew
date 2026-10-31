/**
 * Free tier usage display with session limit and cooldown timer
 */

import type { UsageInfo } from "@mew/shared/src/billing";
import { useEffect, useState } from "react";

export function FreeTierUsage({ usage }: { usage: UsageInfo }) {
  const [now, setNow] = useState(Date.now());

  // Update every second for cooldown timer
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const hoursUsed = Math.floor(usage.seconds_used / 3600);
  const minutesUsed = Math.floor((usage.seconds_used % 3600) / 60);
  const secondsUsed = usage.seconds_used % 60;

  const hoursLimit = Math.floor(usage.seconds_limit / 3600);

  return (
    <div className="rounded-xl border border-line bg-paper p-6">
      {usage.in_cooldown && usage.cooldown_ends_at ? (
        <CooldownView cooldownEndsAt={usage.cooldown_ends_at} now={now} />
      ) : (
        <ActiveView
          hoursUsed={hoursUsed}
          minutesUsed={minutesUsed}
          secondsUsed={secondsUsed}
          hoursLimit={hoursLimit}
          percentage={usage.percentage_used}
        />
      )}
    </div>
  );
}

function ActiveView({
  hoursUsed,
  minutesUsed,
  secondsUsed,
  hoursLimit,
  percentage,
}: {
  hoursUsed: number;
  minutesUsed: number;
  secondsUsed: number;
  hoursLimit: number;
  percentage: number;
}) {
  const isWarning = percentage >= 80;

  return (
    <>
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted">Session usage</span>
        <span className="tabular-nums text-sm text-muted">
          {hoursUsed}h {minutesUsed}m {secondsUsed}s of {hoursLimit}h
        </span>
      </div>

      {/* Progress Bar */}
      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-line">
        <div
          className={`h-full transition-all ${
            percentage >= 100 ? "bg-red-500" : isWarning ? "bg-yellow-500" : "bg-ink"
          }`}
          style={{ width: `${Math.min(percentage, 100)}%` }}
        />
      </div>

      <div className="mt-2 flex items-center justify-between">
        <span className={`text-sm ${isWarning ? "text-yellow-600" : "text-muted"}`}>
          {percentage.toFixed(1)}% used
        </span>
        {isWarning && percentage < 100 && (
          <span className="text-sm text-yellow-600">Running low!</span>
        )}
        {percentage >= 100 && <span className="text-sm text-red-600">Limit reached</span>}
      </div>

      {isWarning && (
        <div className="mt-4 rounded-lg bg-yellow-50 px-3 py-2 text-sm text-yellow-800">
          {percentage >= 100
            ? "You've used your free session. Wait for cooldown or upgrade to Premium."
            : "You're running low on free hours. Consider upgrading for unlimited access."}
        </div>
      )}
    </>
  );
}

function CooldownView({ cooldownEndsAt, now }: { cooldownEndsAt: string; now: number }) {
  const endsAt = new Date(cooldownEndsAt).getTime();
  const remaining = Math.max(0, Math.floor((endsAt - now) / 1000));

  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  const seconds = remaining % 60;

  return (
    <div className="text-center">
      <div className="mb-4 text-4xl">🕐</div>
      <div className="font-medium">Session in cooldown</div>
      <div className="mt-2 text-sm text-muted">Your session resets in:</div>
      <div className="mt-3 font-mono text-2xl tabular-nums text-ink">
        {hours.toString().padStart(2, "0")}:{minutes.toString().padStart(2, "0")}:
        {seconds.toString().padStart(2, "0")}
      </div>
      <div className="mt-4 rounded-lg bg-ink/5 px-4 py-3 text-sm text-muted">
        You'll get your full 5 hours back when the timer reaches zero.
      </div>
    </div>
  );
}

