// The 20-in-parallel check on real Postgres (docs/LAUNCH_LIMITS.md): fires 20 reserve_question
// calls at once for a throwaway learner and computer, and expects exactly 8 through and 12
// QUOTA_EXCEEDED. Against a STAGING Supabase project only, with the migration applied:
//
//   STAGING_SUPABASE_URL=https://<staging-ref>.supabase.co STAGING_SUPABASE_SECRET_KEY=sb_secret_… \
//     node scripts/staging-quota-race.mjs
//
// It refuses the production project, and never reads .env.local (which holds production keys).
import { randomUUID } from "node:crypto";

/** The production project (docs/HANDOFF.md §6): never raced. */
const PRODUCTION_REF = "gvwynloprjomqqovpoem";
const LIMIT = 8;

const url = process.env.STAGING_SUPABASE_URL?.replace(/\/$/, "");
const key = process.env.STAGING_SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error("Set STAGING_SUPABASE_URL and STAGING_SUPABASE_SECRET_KEY (a staging project).");
  process.exit(1);
}
if (url.includes(PRODUCTION_REF)) {
  console.error("That's the production project. This only runs against staging.");
  process.exit(1);
}

const user = `user_race_${randomUUID().replace(/-/g, "")}`;
const device = randomUUID().replace(/-/g, "").repeat(2);
const reserve = () =>
  fetch(`${url}/rest/v1/rpc/reserve_question`, {
    method: "POST",
    headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ p_user: user, p_device: device, p_limit: LIMIT }),
  }).then(async (r) => ({ status: r.status, text: await r.text() }));

const results = await Promise.all(Array.from({ length: 20 }, reserve));
const through = results.filter((r) => r.status === 200).length;
const refused = results.filter((r) => r.status >= 400 && r.text.includes("QUOTA_EXCEEDED")).length;
console.log(
  `20 at once: ${through} through, ${refused} QUOTA_EXCEEDED (expected ${LIMIT} and ${20 - LIMIT}).`,
);
console.log(`Test rows: question_quota.user_id = ${user}; delete them when done.`);
process.exit(through === LIMIT && refused === 20 - LIMIT ? 0 : 1);
