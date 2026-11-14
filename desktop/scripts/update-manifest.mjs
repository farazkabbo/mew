// Writes latest.json, the file installed apps read to find a new version, from the installer and
// signature that `pnpm bundle:release` just built. See README.md, "Releasing an update".
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri");
const { values } = parseArgs({
  options: { "base-url": { type: "string" }, notes: { type: "string", default: "" } },
});

const base = values["base-url"]?.replace(/\/+$/, "");
if (!base?.startsWith("https://")) {
  throw new Error('Pass --base-url "https://…", the public folder the installer is uploaded to.');
}

const { version, productName } = JSON.parse(readFileSync(join(root, "tauri.conf.json"), "utf8"));
const folder = join(root, "target", "release", "bundle", "nsis");
const installer = `${productName}_${version}_x64-setup.exe`;
if (!readdirSync(folder).includes(`${installer}.sig`)) {
  throw new Error(`${installer}.sig isn't in ${folder}. Run pnpm bundle:release first.`);
}

const manifest = {
  version,
  notes: values.notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: readFileSync(join(folder, `${installer}.sig`), "utf8").trim(),
      url: `${base}/${encodeURIComponent(installer)}`,
    },
  },
};
const out = join(folder, "latest.json");
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${out}\nUpload ${installer} first, then latest.json, to ${base}/`);
