// Load test for the launch limits (docs/LAUNCH_LIMITS.md), against a staging deploy, with no
// model call at all: it reads the allowance and asks as accounts that have used up their free
// questions, so every ask stops at the gate (auth → Redis limits → cap → Postgres) and costs
// nothing. Never point it at production, and never with an account that has questions left.
//
//   k6 run -e BASE_URL=https://staging.app.myneb.si -e DEVICE_TOKENS=mewdt_a,mewdt_b loadtest/limits.k6.js
//
// DEVICE_TOKENS: device tokens of test accounts whose 8 questions are already used.
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const BASE = __ENV.BASE_URL;
const TOKENS = (__ENV.DEVICE_TOKENS || "").split(",").filter(Boolean);
const limited = new Counter("limited_by_redis");
const quota = new Counter("stopped_by_postgres_quota");

export const options = {
  stages: [
    { duration: "30s", target: 50 },
    { duration: "2m", target: 50 },
    { duration: "15s", target: 0 },
  ],
  thresholds: {
    http_req_duration: ["p(95)<800"],
    // Only the answers the gate is meant to give: no 5xx.
    "http_req_failed{expected:false}": ["rate<0.01"],
  },
};

const IMAGE =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

export default function () {
  if (!BASE || TOKENS.length === 0) throw new Error("Set BASE_URL and DEVICE_TOKENS");
  const token = TOKENS[(__VU + __ITER) % TOKENS.length];
  const auth = { Authorization: `Bearer ${token}` };

  const left = http.get(`${BASE}/api/screen/quota`, { headers: auth, tags: { expected: "false" } });
  check(left, { "allowance read": (r) => r.status === 200 });

  const asked = http.post(
    `${BASE}/api/screen/ask`,
    JSON.stringify({
      transcript: "what does this button do?",
      app: "load-test.exe",
      scope: "window",
      image: { jpeg: IMAGE, width: 1, height: 1 },
    }),
    {
      headers: {
        ...auth,
        "Content-Type": "application/json",
        "X-Neb-Device": "00000000-0000-4000-8000-000000000000",
      },
      responseCallback: http.expectedStatuses(429, 503),
      tags: { expected: "true" },
    },
  );
  const code = asked.status === 429 ? JSON.parse(asked.body || "{}").code : null;
  if (code === "RATE_LIMITED") limited.add(1);
  if (code === "QUOTA_EXCEEDED") quota.add(1);
  check(asked, {
    "stopped at the gate, never answered": (r) => r.status === 429 || r.status === 503,
  });
}
