import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { manifestFor, chromiumId } from "../build.mjs";
const { publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "der" },
});
const config = {
  chromiumKey: publicKey.toString("base64"),
  chromeExtensionIds: [chromiumId(publicKey.toString("base64"))],
  firefoxAddonIds: ["neb-browser-companion@example.test"],
};
test("build variants preserve fixed identities and narrow optional permissions", () => {
  for (const target of ["chromium", "firefox", "safari"]) {
    const m = manifestFor(target, config);
    assert.equal(m.manifest_version, 3);
    assert.ok(m.permissions.includes("webNavigation"));
    assert.ok(!m.permissions.includes("activeTab"));
    assert.deepEqual(m.optional_host_permissions, ["http://*/*", "https://*/*"]);
    assert.equal(m.externally_connectable, undefined);
    assert.equal(m.content_scripts, undefined);
  }
  assert.equal(manifestFor("chromium", config).key, config.chromiumKey);
  assert.equal(
    manifestFor("firefox", config).browser_specific_settings.gecko.id,
    config.firefoxAddonIds[0],
  );
  assert.equal(manifestFor("chromium", config).background.service_worker, "background.js");
  assert.deepEqual(manifestFor("firefox", config).background.scripts, ["background.js"]);
});
test("unconfigured or mismatched publishing identities refuse a Chromium build", () => {
  assert.throws(() => manifestFor("chromium", {}));
  assert.throws(() => manifestFor("chromium", { ...config, chromeExtensionIds: ["a".repeat(32)] }));
});
