// Build the native messaging helper before Tauri copies/signs its sidecar into Neb.app.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../src-tauri/", import.meta.url));
export function buildPlan(target, profile, environment = {}) {
  if (!/^(aarch64|x86_64)-apple-darwin$/.test(target)) throw new Error("Unsupported Mac target");
  if (!["debug", "release"].includes(profile)) throw new Error("Unsupported build profile");
  const config = JSON.parse(environment.TAURI_CONFIG || "{}");
  config.bundle = { ...config.bundle, externalBin: [] };
  const args = [
    "build",
    "--manifest-path",
    path.join(root, "Cargo.toml"),
    "--locked",
    "--offline",
    "--bin",
    "neb-browser-host",
    "--target",
    target,
  ];
  if (profile === "release") args.push("--release");
  return {
    args,
    env: { ...environment, MACOSX_DEPLOYMENT_TARGET: "14.0", TAURI_CONFIG: JSON.stringify(config) },
    source: path.join(root, "target", target, profile, "neb-browser-host"),
    destination: path.join(root, "binaries", `neb-browser-host-${target}`),
  };
}
export function buildHelper({ target, profile, env = process.env, run = spawnSync } = {}) {
  const plan = buildPlan(target, profile, env);
  const result = run("cargo", plan.args, { cwd: root, env: plan.env, stdio: "inherit" });
  if (result.error || result.status !== 0)
    throw new Error("Native browser helper build failed", { cause: result.error });
  mkdirSync(path.dirname(plan.destination), { recursive: true });
  copyFileSync(plan.source, plan.destination);
  chmodSync(plan.destination, 0o755);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== "darwin") process.exit(0);
  if (process.argv[2] !== "build")
    throw new Error(
      "Usage: browser-companion.mjs build [--target triple] [--profile debug|release]",
    );
  const flags = new Map();
  for (let i = 3; i < process.argv.length; i += 2) {
    if (!["--target", "--profile"].includes(process.argv[i]) || !process.argv[i + 1])
      throw new Error("Invalid build argument");
    flags.set(process.argv[i], process.argv[i + 1]);
  }
  const target =
    flags.get("--target") ??
    process.env.TAURI_ENV_TARGET_TRIPLE ??
    `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`;
  const profile =
    flags.get("--profile") ?? (process.env.TAURI_ENV_DEBUG === "true" ? "debug" : "release");
  buildHelper({ target, profile });
}
