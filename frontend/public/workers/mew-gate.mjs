// Mew v2 (M10): the gate classifier, running in the browser with transformers.js.
// Everything is self-hosted under /workers/ (no remote models, no CDN); this script runs under the
// workers' own CSP (next.config.ts). The model is optional: without one, or with one trained on
// different features, every request answers "unavailable" and the app uses the v1 gate.
//
// Messages in:  { type: "init", features }  then  { id, text }
// Messages out: { type: "ready" } | { type: "unavailable", reason }  and  { id, label, score, ms }

const MODEL = "mew-gate";
const MODEL_URL = `/workers/models/${MODEL}`;
const MAX_TEXT = 2000;

let classify = null;
let minConfidence = 1;
let setup = null;

async function load(features) {
  const meta = await fetch(`${MODEL_URL}/mew.json`, { cache: "no-cache" });
  if (!meta.ok) throw new Error("no on-device model");
  const info = await meta.json();
  if (info.features !== features) throw new Error(`model expects ${info.features}`);
  minConfidence = Math.min(1, Math.max(0.5, Number(info.min_confidence) || 1));

  const { pipeline, env } = await import("/workers/vendor/transformers.min.js");
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = "/workers/models/";
  env.backends.onnx.wasm.wasmPaths = "/workers/vendor/";
  env.backends.onnx.wasm.numThreads = 1; // no SharedArrayBuffer needed
  env.backends.onnx.wasm.proxy = false;
  const model = await pipeline("text-classification", MODEL, { dtype: "q8", device: "wasm" });
  await model("warm up"); // the first run is slow (compiling); pay it before saying "ready"
  classify = model;
}

self.onmessage = async (event) => {
  const message = event.data ?? {};
  if (message.type === "init") {
    setup ??= load(String(message.features ?? "")).then(
      () => self.postMessage({ type: "ready", minConfidence }),
      (error) => self.postMessage({ type: "unavailable", reason: String(error?.message ?? error) }),
    );
    return;
  }
  const { id, text } = message;
  if (!classify || typeof text !== "string" || text.length > MAX_TEXT) {
    self.postMessage({ id, error: "not ready" });
    return;
  }
  try {
    const started = performance.now();
    const [top] = await classify(text);
    self.postMessage({ id, label: top?.label, score: top?.score, ms: performance.now() - started });
  } catch (error) {
    self.postMessage({ id, error: String(error?.message ?? error) });
  }
};
