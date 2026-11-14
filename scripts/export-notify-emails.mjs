// Exports the learners who used all their free questions and are waiting to hear when more open
// up (`question_quota.notify_when_more`, docs/LAUNCH_LIMITS.md), as a CSV to import into a Resend
// audience for a broadcast. Their emails live in Clerk, not in our database, so it asks Clerk.
// Nothing is sent from here.
//
//   node scripts/export-notify-emails.mjs > notify.csv
//
// Needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY and CLERK_SECRET_KEY (from .env.local, or
// set them): production keys only when you mean to export production. The CSV holds people's
// emails: keep it off shared drives and delete it after the import.
import { existsSync } from "node:fs";
import path from "node:path";

const env = path.resolve(import.meta.dirname, "../.env.local");
if (existsSync(env)) process.loadEnvFile(env);

const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const clerk = process.env.CLERK_SECRET_KEY;
if (!supabase || !secret || !clerk) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY and CLERK_SECRET_KEY.");
  process.exit(1);
}

/** Every flagged learner's Clerk id, a page at a time. */
async function flagged() {
  const ids = [];
  for (let from = 0; ; from += 1000) {
    const response = await fetch(
      `${supabase}/rest/v1/question_quota?select=user_id&notify_when_more=is.true&order=user_id`,
      {
        headers: { apikey: secret, Range: `${from}-${from + 999}` },
      },
    );
    if (!response.ok) throw new Error(`Supabase answered ${response.status}`);
    const rows = await response.json();
    ids.push(...rows.map((r) => r.user_id));
    if (rows.length < 1000) return ids;
  }
}

/** Primary emails for up to 100 Clerk ids at once (Clerk's Backend API). */
async function emailsOf(ids) {
  const query = ids.map((id) => `user_id=${encodeURIComponent(id)}`).join("&");
  const response = await fetch(`https://api.clerk.com/v1/users?limit=100&${query}`, {
    headers: { Authorization: `Bearer ${clerk}` },
  });
  if (!response.ok) throw new Error(`Clerk answered ${response.status}`);
  const users = await response.json();
  return users.flatMap((user) => {
    const primary = user.email_addresses?.find((e) => e.id === user.primary_email_address_id);
    if (!primary || primary.verification?.status !== "verified") return [];
    return [{ email: primary.email_address, first: user.first_name ?? "" }];
  });
}

const csv = (value) => `"${String(value).replace(/"/g, '""')}"`;

const ids = await flagged();
console.log("email,first_name");
for (let i = 0; i < ids.length; i += 100) {
  for (const row of await emailsOf(ids.slice(i, i + 100))) {
    console.log(`${csv(row.email)},${csv(row.first)}`);
  }
}
console.error(`export-notify-emails: ${ids.length} learners waiting.`);
