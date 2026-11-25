"use client";

import type { HandoffInbox as Inbox } from "@mew/shared";
import Link from "next/link";
import { useEffect, useState } from "react";

const STATUS: Record<Inbox["items"][number]["status"], string> = {
  unopened: "Not opened",
  opened: "Opened",
  picked_up: "Picked up",
  replied: "Replied",
  expired: "Expired",
  revoked: "Revoked",
};

/** Handoffs received and sent (being built), and "Delete my handoff history". */
export function HandoffInbox() {
  const [items, setItems] = useState<Inbox["items"] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/handoffs", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error();
        setItems(((await r.json()) as Inbox).items);
      })
      .catch(() => setNotice("Handoff isn't available for your account yet."));
  }, []);

  const deleteAll = async () => {
    if (!window.confirm("Delete every handoff you sent and received? This can't be undone."))
      return;
    const r = await fetch("/api/handoffs", { method: "DELETE" });
    if (r.ok) setItems([]);
    setNotice(r.ok ? "Your handoff history is deleted." : "Couldn't delete it just now.");
  };

  const received = items?.filter((i) => i.role === "recipient") ?? [];
  const sent = items?.filter((i) => i.role === "sender") ?? [];
  const list = (rows: Inbox["items"], empty: string) =>
    rows.length === 0 ? (
      <p className="text-muted">{empty}</p>
    ) : (
      <ul className="divide-y divide-line border-y border-line">
        {rows.map((i) => (
          <li key={i.id} className="flex items-center justify-between gap-4 py-3">
            <div>
              <Link href={`/h/${i.id}`} className="font-medium hover:underline">
                {i.title}
              </Link>
              <p className="text-sm text-muted">
                {i.role === "recipient" ? `From ${i.senderName}` : `To ${i.recipients.join(", ")}`}{" "}
                · {new Date(i.createdAt).toLocaleDateString()}
              </p>
            </div>
            <span className="text-sm">{STATUS[i.status]}</span>
          </li>
        ))}
      </ul>
    );

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
      <p className="text-sm text-muted">Being built</p>
      <h1 className="font-serif text-4xl tracking-tight">Handoffs</h1>
      {notice && (
        <p role="status" className="mt-4">
          {notice}
        </p>
      )}
      {items && (
        <>
          <h2 className="mt-10 mb-3 font-medium">Received</h2>
          {list(received, "Nothing handed to you yet.")}
          <h2 className="mt-10 mb-3 font-medium">Sent</h2>
          {list(sent, "Hand something off from the desktop app: tray menu → Hand off…")}
          <button
            type="button"
            className="mt-10 text-sm text-danger underline"
            onClick={() => void deleteAll()}
          >
            Delete my handoff history
          </button>
        </>
      )}
    </main>
  );
}
