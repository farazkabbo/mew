// Copies transformers.js (self-contained build) and the ONNX Runtime WebAssembly it loads into
// public/workers/vendor/, so Mew v2's worker runs from our own origin (no CDN) under the
// workers' CSP. Runs before dev and build; the copy is gitignored.
import { copyFileSync, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const frontend = path.resolve(import.meta.dirname, "..");
const transformers = realpathSync(path.join(frontend, "node_modules/@huggingface/transformers"));
// pnpm keeps a package's dependencies next to it.
const ort = path.join(transformers, "../../onnxruntime-web/dist");

// The WebAssembly (CPU) builds of ONNX Runtime: transformers.js picks "asyncify" for the wasm
// device (the plain build is its fallback). The WebGPU ("jsep") build isn't used.
const FILES = [
  [path.join(transformers, "dist/transformers.min.js"), "transformers.min.js"],
  [path.join(ort, "ort-wasm-simd-threaded.asyncify.mjs"), "ort-wasm-simd-threaded.asyncify.mjs"],
  [path.join(ort, "ort-wasm-simd-threaded.asyncify.wasm"), "ort-wasm-simd-threaded.asyncify.wasm"],
  [path.join(ort, "ort-wasm-simd-threaded.mjs"), "ort-wasm-simd-threaded.mjs"],
  [path.join(ort, "ort-wasm-simd-threaded.wasm"), "ort-wasm-simd-threaded.wasm"],
];

const target = path.join(frontend, "public/workers/vendor");
mkdirSync(target, { recursive: true });

let copied = 0;
for (const [from, published] of FILES) {
  const to = path.join(target, published);
  if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
  copyFileSync(from, to);
  copied++;
}
if (copied > 0) console.log(`transformers: copied ${copied} file(s) to public/workers/vendor`);
