/**
 * Checks that the local web app and API are up: `pnpm health`.
 * The web check goes through /api/health, which also probes the API with the internal secret.
 */
import { ApiHealth, WebHealth } from "../packages/shared/src/health.ts";

const WEB_URL = process.env.WEB_URL ?? "http://localhost:3000";
const API_URL = process.env.API_BASE_URL ?? "http://127.0.0.1:8000";

type Result = { name: string; ok: boolean; detail: string };

async function probe(name: string, url: string, schema: typeof ApiHealth | typeof WebHealth) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) return { name, ok: false, detail: `unexpected body (${response.status})` };
    return { name, ok: response.ok, detail: `${response.status} ${JSON.stringify(parsed.data)}` };
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

const results: Result[] = await Promise.all([
  probe("api", `${API_URL}/health`, ApiHealth),
  probe("web", `${WEB_URL}/api/health`, WebHealth),
]);

for (const { name, ok, detail } of results) {
  console.log(`${ok ? "✔" : "✘"} ${name.padEnd(4)} ${detail}`);
}
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
