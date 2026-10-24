"use client";

import { type DeviceInfo, DeviceList } from "@mew/shared";
import { useEffect, useState } from "react";

import { Section } from "./controls";

type State =
  { status: "loading" } | { status: "error" } | { status: "ready"; devices: DeviceInfo[] };

/**
 * Settings → Signed-in devices: the Mew desktop apps connected for Screen Coach (decision 8).
 * Revoking one signs it out at once; it can connect again from its own settings.
 */
export function DevicesSection() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadDevices().then(setState);
  }, []);

  const revoke = async (path: string) => {
    setBusy(true);
    await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).catch(() => null);
    setState(await loadDevices());
    setBusy(false);
  };

  const active = state.status === "ready" ? state.devices.filter((d) => !d.revokedAt) : [];

  return (
    <Section title="Signed-in devices">
      <p className="text-sm text-ink-muted">
        Computers where the Neb desktop app is connected to your account for Screen Coach. To
        connect one, open Neb&apos;s tray menu → Screen Coach settings → Connect.
      </p>
      {state.status === "loading" && <p className="text-sm text-ink-muted">Loading…</p>}
      {state.status === "error" && (
        <p className="text-sm text-ink-muted">Your devices couldn&apos;t be loaded right now.</p>
      )}
      {state.status === "ready" && active.length === 0 && (
        <p className="text-sm text-ink-muted">No devices are connected.</p>
      )}
      {active.length > 0 && (
        <ul className="divide-y divide-rule rounded-lg border border-rule">
          {active.map((device) => (
            <li key={device.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <p className="font-medium">{device.deviceName}</p>
                <p className="text-sm text-ink-muted">
                  Connected {formatDate(device.createdAt)}
                  {device.lastUsedAt && ` · last used ${formatDate(device.lastUsedAt)}`}
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void revoke(`/api/devices/${device.id}/revoke`)}
                aria-label={`Sign out ${device.deviceName}`}
                className="rounded-md border border-rule px-3 py-1.5 text-sm hover:bg-paper-raised disabled:opacity-50"
              >
                Sign out
              </button>
            </li>
          ))}
        </ul>
      )}
      {active.length > 1 && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void revoke("/api/devices/revoke-all")}
          className="text-sm text-accent underline-offset-2 hover:underline disabled:opacity-50"
        >
          Sign out all devices
        </button>
      )}
    </Section>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

async function loadDevices(): Promise<State> {
  const response = await fetch("/api/devices", { cache: "no-store" }).catch(() => null);
  const parsed = response?.ok ? DeviceList.safeParse(await response.json()) : null;
  return parsed?.success ? { status: "ready", devices: parsed.data.devices } : { status: "error" };
}
