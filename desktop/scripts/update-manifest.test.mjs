import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { artifactArgument, createManifest } from "./update-manifest.mjs";

function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(), "neb-manifest-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return (platform, name) => {
    const path = join(folder, name);
    writeFileSync(path, "synthetic updater fixture");
    writeFileSync(`${path}.sig`, " signed-fixture \n");
    return { platform, path };
  };
}
const defaults = {
  version: "0.1.7",
  baseUrl: "https://example.com/desktop/",
  date: new Date("2026-11-25T00:00:00Z"),
};

test("combines both Mac architectures and Windows without changing Windows platform keys", (t) => {
  const artifact = fixture(t);
  const manifest = createManifest({
    ...defaults,
    artifacts: [
      artifact("windows-x86_64", "Neb_0.1.7_x64-setup.exe"),
      artifact("darwin-aarch64", "Neb arm.app.tar.gz"),
      artifact("darwin-x86_64", "Neb intel.app.tar.gz"),
    ],
  });
  assert.deepEqual(Object.keys(manifest.platforms), [
    "windows-x86_64",
    "darwin-aarch64",
    "darwin-x86_64",
  ]);
  assert.equal(
    manifest.platforms["darwin-aarch64"].url,
    "https://example.com/desktop/Neb%20arm.app.tar.gz",
  );
  assert.equal(manifest.platforms["windows-x86_64"].signature, "signed-fixture");
  assert.equal(manifest.pub_date, "2026-11-25T00:00:00.000Z");
});

test("rejects DMGs, missing signatures, blank signatures and duplicate platforms", (t) => {
  const artifact = fixture(t);
  const mac = artifact("darwin-aarch64", "Neb.app.tar.gz");
  assert.throws(
    () => createManifest({ ...defaults, artifacts: [{ ...mac, path: mac.path + ".dmg" }] }),
    /Wrong updater artifact/,
  );
  assert.throws(() => createManifest({ ...defaults, artifacts: [mac, mac] }), /Duplicate platform/);
  writeFileSync(`${mac.path}.sig`, " \n");
  assert.throws(() => createManifest({ ...defaults, artifacts: [mac] }), /Empty signature/);
  rmSync(`${mac.path}.sig`);
  assert.throws(() => createManifest({ ...defaults, artifacts: [mac] }), /ENOENT/);
});

test("refuses colliding public filenames and unsafe public folder URLs", (t) => {
  const artifact = fixture(t);
  const mac = artifact("darwin-aarch64", "Neb.app.tar.gz");
  assert.throws(
    () => createManifest({ ...defaults, artifacts: [mac, { ...mac, platform: "darwin-x86_64" }] }),
    /unique/,
  );
  for (const baseUrl of [
    "http://example.com/",
    "https://user:pass@example.com/",
    "https://example.com/?token=x",
    "https://example.com/#fragment",
  ]) {
    assert.throws(
      () => createManifest({ ...defaults, baseUrl, artifacts: [mac] }),
      /HTTPS public folder/,
    );
  }
});

test("requires explicit supported architecture and artifact path", () => {
  assert.equal(artifactArgument("darwin-aarch64=/tmp/Neb.app.tar.gz").platform, "darwin-aarch64");
  for (const argument of ["darwin-universal=a", "darwin-x86_64=", "Neb.app.tar.gz"]) {
    assert.throws(() => artifactArgument(argument), /PLATFORM=PATH/);
  }
});
