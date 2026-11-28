import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlan, buildHelper } from "./browser-companion.mjs";
test("helper build disables sidecar bootstrap copying and preserves other Tauri settings", () => {
  const plan = buildPlan("aarch64-apple-darwin", "release", {
    TAURI_CONFIG: JSON.stringify({
      bundle: { externalBin: ["old"], macOS: { hardenedRuntime: true } },
      identifier: "app.mew.desktop",
    }),
  });
  assert.deepEqual(JSON.parse(plan.env.TAURI_CONFIG).bundle.externalBin, []);
  assert.equal(JSON.parse(plan.env.TAURI_CONFIG).bundle.macOS.hardenedRuntime, true);
  assert.equal(JSON.parse(plan.env.TAURI_CONFIG).identifier, "app.mew.desktop");
  assert.equal(plan.env.MACOSX_DEPLOYMENT_TARGET, "14.0");
  assert.ok(plan.args.includes("--locked"));
  assert.ok(plan.args.includes("--offline"));
  assert.ok(plan.args.includes("--release"));
  assert.match(plan.destination, /neb-browser-host-aarch64-apple-darwin$/);
});
test("debug uses the debug executable and invalid target/profile never reaches Cargo", () => {
  const plan = buildPlan("x86_64-apple-darwin", "debug");
  assert.ok(!plan.args.includes("--release"));
  assert.match(plan.source, /x86_64-apple-darwin\/debug\/neb-browser-host$/);
  for (const target of ["../../escape", "aarch64-pc-windows-msvc", "$(whoami)"])
    assert.throws(() => buildPlan(target, "debug"));
  assert.throws(() => buildPlan("aarch64-apple-darwin", "custom"));
  assert.throws(
    () =>
      buildHelper({ target: "aarch64-apple-darwin", profile: "debug", run: () => ({ status: 1 }) }),
    /build failed/,
  );
});
