// Writes a static Tauri updater manifest from already built artifacts and sibling .sig files.
// With no --artifact arguments the existing Windows NSIS release invocation is preserved.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri");
const extensions = {
  "windows-x86_64": "-setup.exe",
  "darwin-aarch64": ".app.tar.gz",
  "darwin-x86_64": ".app.tar.gz",
};

export function artifactArgument(argument) {
  const separator = argument.indexOf("=");
  const platform = argument.slice(0, separator);
  const path = argument.slice(separator + 1);
  if (separator < 1 || !Object.hasOwn(extensions, platform) || !path) {
    throw new Error(
      "Use --artifact PLATFORM=PATH; supported platforms: " + Object.keys(extensions).join(", "),
    );
  }
  return { platform, path: resolve(path) };
}

// This validates local inputs; cryptographic verification remains the updater's responsibility.
export function createManifest({ version, notes = "", baseUrl, artifacts, date = new Date() }) {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error(
      "--base-url must be an HTTPS public folder without credentials, query or fragment.",
    );
  }
  base.pathname = base.pathname.replace(/\/+$/, "") + "/";
  if (!artifacts.length) throw new Error("At least one updater artifact is required.");
  const platforms = {};
  const names = new Set();
  for (const { platform, path } of artifacts) {
    if (!Object.hasOwn(extensions, platform) || !path.endsWith(extensions[platform])) {
      throw new Error(`Wrong updater artifact for ${platform}: ${path}`);
    }
    if (Object.hasOwn(platforms, platform)) throw new Error(`Duplicate platform: ${platform}`);
    const name = basename(path);
    if (names.has(name))
      throw new Error(`Artifact names must be unique in the public folder: ${name}`);
    names.add(name);
    if (!statSync(path).isFile() || statSync(path).size === 0)
      throw new Error(`Empty or missing artifact: ${path}`);
    const signature = readFileSync(`${path}.sig`, "utf8").trim();
    if (!signature) throw new Error(`Empty signature: ${path}.sig`);
    platforms[platform] = { signature, url: new URL(encodeURIComponent(name), base).href };
  }
  return { version, notes, pub_date: date.toISOString(), platforms };
}

function main() {
  const { values } = parseArgs({
    options: {
      "base-url": { type: "string" },
      notes: { type: "string", default: "" },
      artifact: { type: "string", multiple: true },
      out: { type: "string" },
    },
  });
  if (!values["base-url"])
    throw new Error('Pass --base-url "https://…", the public artifact folder.');
  const { version, productName } = JSON.parse(readFileSync(join(root, "tauri.conf.json"), "utf8"));
  const artifacts = values.artifact?.map(artifactArgument) ?? [
    {
      platform: "windows-x86_64",
      path: join(
        root,
        "target",
        "release",
        "bundle",
        "nsis",
        `${productName}_${version}_x64-setup.exe`,
      ),
    },
  ];
  const manifest = createManifest({
    version,
    notes: values.notes,
    baseUrl: values["base-url"],
    artifacts,
  });
  const out = resolve(values.out ?? join(dirname(artifacts[0].path), "latest.json"));
  if (artifacts.some(({ path }) => resolve(path) === out || resolve(`${path}.sig`) === out)) {
    throw new Error("Manifest output must not overwrite an artifact or signature.");
  }
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `Wrote ${out}\nUpload all listed artifacts first, then latest.json, to ${values["base-url"]}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
