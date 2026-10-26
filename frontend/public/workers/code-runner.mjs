// Runs a student's Python snippet with Pyodide, isolated in a module worker (the code checker,
// brief §7). The page kills this worker on timeout. Served with its own strict CSP (same-origin
// fetches only, WebAssembly allowed); see next.config.ts. Before any student code runs, the
// worker's network and storage APIs are removed, so a snippet can only compute and print.
import { loadPyodide } from "/pyodide/pyodide.mjs";

const MAX_OUTPUT = 2000;
const REMOVED = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "importScripts",
  "indexedDB",
  "caches",
  "BroadcastChannel",
  "Worker",
];

let output = "";
const capture = (text) => {
  if (output.length < MAX_OUTPUT) output += `${text}\n`;
};

const ready = loadPyodide({
  indexURL: "/pyodide/",
  stdLibURL: "/pyodide/python_stdlib.dat",
  stdout: capture,
  stderr: capture,
}).then((pyodide) => {
  for (const name of REMOVED) {
    try {
      Object.defineProperty(self, name, { value: undefined, configurable: false });
    } catch {
      // Already gone.
    }
  }
  return pyodide;
});

self.onmessage = async (event) => {
  const { id, code } = event.data ?? {};
  if (typeof id !== "number" || typeof code !== "string" || code.length > 5000) return;
  output = "";
  try {
    const pyodide = await ready;
    // A fresh namespace per run, so snippets don't see each other's variables.
    const globals = pyodide.globals.get("dict")();
    try {
      await pyodide.runPythonAsync(code, { globals });
    } finally {
      globals.destroy();
    }
    self.postMessage({ id, ok: true, output: output.slice(0, MAX_OUTPUT) });
  } catch (error) {
    const message = String(error?.message ?? error);
    // Python tracebacks end with the useful line ("NameError: name 'x' is not defined").
    const last = message.trim().split("\n").filter(Boolean).at(-1) ?? message;
    // The snippet's own line that failed: its last frame in the traceback ("<exec>").
    const frames = [...message.matchAll(/File "<exec>", line (\d+)/g)];
    const line = Number(frames.at(-1)?.[1]) || undefined;
    self.postMessage({
      id,
      ok: false,
      output: output.slice(0, MAX_OUTPUT),
      error: last.slice(0, 300),
      line,
    });
  }
};
