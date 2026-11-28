import { readFile, mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.dirname(fileURLToPath(import.meta.url));
export function chromiumId(key) {
  return createHash("sha256")
    .update(Buffer.from(key, "base64"))
    .digest("hex")
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (n) => String.fromCharCode(97 + parseInt(n, 16)));
}
export function manifestFor(target, config) {
  const manifest = {
    manifest_version: 3,
    name: "Neb browser companion",
    version: "0.1.0",
    description:
      "Pair a browser profile with Neb for private-window checks and explicitly enabled website media controls.",
    permissions: ["nativeMessaging", "storage", "tabs", "scripting", "webNavigation"],
    optional_host_permissions: ["http://*/*", "https://*/*"],
    action: { default_popup: "popup.html", default_title: "Neb browser companion" },
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'" },
    incognito: "not_allowed",
  };
  if (target === "chromium") {
    if (
      typeof config.chromiumKey !== "string" ||
      config.chromiumKey.length < 100 ||
      !config.chromeExtensionIds?.includes(chromiumId(config.chromiumKey))
    )
      throw new Error(
        "Provide the matching public Chromium key and allowed extension ID in desktop/src-tauri/browser-companion.json.",
      );
    manifest.key = config.chromiumKey;
    manifest.minimum_chrome_version = "120";
    manifest.background = { service_worker: "background.js", type: "module" };
  } else if (target === "firefox") {
    if (!Array.isArray(config.firefoxAddonIds) || !config.firefoxAddonIds[0])
      throw new Error("Provide the fixed Firefox add-on ID.");
    manifest.browser_specific_settings = {
      gecko: {
        id: config.firefoxAddonIds[0],
        strict_min_version: "140.0",
        data_collection_permissions: { required: ["browsingActivity", "websiteActivity"] },
      },
    };
    manifest.background = { scripts: ["background.js"], type: "module" };
  } else if (target === "safari") {
    manifest.background = { scripts: ["background.js"], type: "module" };
    delete manifest.incognito;
  } else throw new Error("Unknown browser target");
  return manifest;
}
export async function buildAll(config) {
  const require = createRequire(new URL("../desktop/package.json", import.meta.url));
  const { build } = require("esbuild");
  for (const target of ["chromium", "firefox", "safari"]) {
    const output = path.join(root, "dist", target);
    await rm(output, { recursive: true, force: true });
    await mkdir(output, { recursive: true });
    await writeFile(
      path.join(output, "manifest.json"),
      JSON.stringify(manifestFor(target, config), null, 2) + "\n",
    );
    await build({
      entryPoints: [path.join(root, "src/background.js"), path.join(root, "src/popup.js")],
      outdir: output,
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      plugins: [
        {
          name: "browser-target",
          setup(build) {
            build.onLoad({ filter: /[\\/]target\.js$/ }, () => ({
              contents: `export const BUILD_TARGET=${JSON.stringify(target)};`,
              loader: "js",
            }));
          },
        },
      ],
    });
    // esbuild must not rename serialized function locals or close over external constants.
    for (const file of ["popup.html", "popup.css"])
      await copyFile(path.join(root, file), path.join(output, file));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(
    await readFile(new URL("../desktop/src-tauri/browser-companion.json", import.meta.url), "utf8"),
  );
  if (!config.chromiumKey)
    config.chromiumKey = (
      await readFile(
        new URL("../desktop/src-tauri/browser-companion-key.txt", import.meta.url),
        "utf8",
      )
    ).trim();
  await buildAll(config);
}
