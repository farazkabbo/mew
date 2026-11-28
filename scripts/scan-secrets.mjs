// Fails when an API key or secret shows up where a learner's computer could read it
// (docs/LAUNCH_LIMITS.md): the desktop app's sources and pages, and the web app's browser bundle
// (.next/static, after a build). Server code and tests aren't scanned: keys live in the server's
// environment, and the tests' fake keys are fixtures.
//
//   node scripts/scan-secrets.mjs [extra paths…]
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

/** What a real key looks like (names only in the report, never the match). */
export const PATTERNS = [
  ["Google API key", /AIza[0-9A-Za-z_-]{35}/],
  ["Clerk or Stripe secret key", /\bsk_(live|test)_[0-9A-Za-z]{20,}/],
  ["ElevenLabs key", /\bsk_[0-9a-f]{48}\b/],
  ["Supabase secret key", /\bsb_secret_[0-9A-Za-z_-]{20,}/],
  [
    "Supabase service-role JWT",
    /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[0-9A-Za-z_-]*c2VydmljZV9yb2xl/,
  ],
  ["Resend key", /\bre_[0-9A-Za-z]{8}_[0-9A-Za-z]{20,}/],
  ["Upstash token", /\bA[A-Za-z0-9]{3}AAIncDE[0-9A-Za-z_-]{20,}/],
  ["Webhook signing secret", /\bwhsec_[0-9A-Za-z+/]{20,}/],
  // With its body: the header alone is how the redaction code recognises one.
  ["Private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----\s*[A-Za-z0-9+/=\s]{64,}/],
];

/** Shipped to the learner: the desktop app and the browser's JavaScript. */
const SHIPPED = [
  "browser-extension",
  "desktop/src-tauri/src",
  "desktop/overlay-src",
  "desktop/shell",
  "frontend/.next/static",
  "frontend/public",
];
/** Fixtures that are fake on purpose (a redaction test needs a key-shaped string). */
const FAKE = /AIzaSyD-1234567890abcdefghijklmnopqrstu/g;
const TEXT = /\.(rs|ts|tsx|js|mjs|cjs|html|css|json|map|toml)$/;
const SKIP =
  /(^|[\\/])(node_modules|target|models|\.git)([\\/]|$)|\.test\.(ts|tsx)$|[\\/]tests?[\\/]/;

function* files(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    if (SKIP.test(full)) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) yield* files(full);
    else if (TEXT.test(name) && stat.size < 20_000_000) yield full;
  }
}

export function scan(dirs) {
  const found = [];
  for (const dir of dirs) {
    for (const file of files(path.resolve(root, dir))) {
      const text = readFileSync(file, "utf8").replace(FAKE, "");
      for (const [name, pattern] of PATTERNS) {
        if (pattern.test(text)) found.push(`${path.relative(root, file)}: ${name}`);
      }
    }
  }
  return found;
}

if (
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
  process.argv[1]?.endsWith("scan-secrets.mjs")
) {
  const extra = process.argv.slice(2);
  const found = scan([...SHIPPED, ...extra]);
  if (found.length > 0) {
    console.error(`Secrets where a learner's computer can read them:\n  ${found.join("\n  ")}`);
    console.error("Move them to the server's environment and rotate them.");
    process.exit(1);
  }
  console.log("scan-secrets: nothing found in what ships.");
}
