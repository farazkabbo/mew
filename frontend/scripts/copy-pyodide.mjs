// Copies the Pyodide runtime (Python in WebAssembly) from node_modules into public/pyodide/, so
// the code checker's worker loads it from our own origin (no CDN). Runs before dev and build;
// the copy is gitignored. Only files the runtime needs are copied.
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// [source name, published name]. The standard library (a zip) is published as .dat: some
// browsers/networks refuse URLs ending in .zip or .bin outright (seen on a dev machine: blocked
// before the request left the browser). Pyodide takes the stdlib URL as an option.
const FILES = [
  ["pyodide.mjs", "pyodide.mjs"],
  ["pyodide.asm.mjs", "pyodide.asm.mjs"],
  ["pyodide.asm.wasm", "pyodide.asm.wasm"],
  ["python_stdlib.zip", "python_stdlib.dat"],
  ["pyodide-lock.json", "pyodide-lock.json"],
];

const require = createRequire(import.meta.url);
const source = path.dirname(require.resolve("pyodide/package.json"));
const target = path.resolve(import.meta.dirname, "../public/pyodide");
mkdirSync(target, { recursive: true });

let copied = 0;
for (const [file, published] of FILES) {
  const from = path.join(source, file);
  const to = path.join(target, published);
  if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
  copyFileSync(from, to);
  copied++;
}
if (copied > 0) console.log(`pyodide: copied ${copied} file(s) to public/pyodide`);
