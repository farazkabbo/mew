import type { CodeRunner } from "./checker";

type RunResult = { ok: boolean; output: string; error?: string | undefined };
type Reply = RunResult & { id: number };

/** First run includes loading Python (~10 MB, cached by the browser afterwards). */
const FIRST_RUN_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 5_000;

/**
 * Runs Python snippets in a Pyodide worker (public/workers/code-runner.mjs). A snippet that
 * runs too long (an infinite loop) gets the worker terminated; the next run starts a new one.
 */
export class PyodideCodeRunner implements CodeRunner {
  private worker: Worker | null = null;
  private warm = false;
  private nextId = 1;

  constructor(private readonly createWorker: () => Worker = defaultWorker) {}

  run(code: string): Promise<RunResult> {
    const worker = (this.worker ??= this.createWorker());
    const id = this.nextId++;
    const timeoutMs = this.warm ? RUN_TIMEOUT_MS : FIRST_RUN_TIMEOUT_MS;
    return new Promise<RunResult>((resolve) => {
      const done = (result: RunResult) => {
        clearTimeout(timer);
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        resolve(result);
      };
      const onMessage = (event: MessageEvent<Reply>) => {
        if (event.data.id !== id) return;
        this.warm = true;
        done({ ok: event.data.ok, output: event.data.output, error: event.data.error });
      };
      const onError = () => {
        this.reset(worker);
        done({ ok: false, output: "", error: "The code runner failed to start." });
      };
      const timer = setTimeout(() => {
        this.reset(worker);
        done({
          ok: false,
          output: "",
          error: `Still running after ${timeoutMs / 1000} s (an infinite loop?)`,
        });
      }, timeoutMs);
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.postMessage({ id, code });
    });
  }

  dispose(): void {
    if (this.worker) this.reset(this.worker);
  }

  private reset(worker: Worker): void {
    worker.terminate();
    if (this.worker === worker) {
      this.worker = null;
      this.warm = false;
    }
  }
}

function defaultWorker(): Worker {
  return new Worker("/workers/code-runner.mjs", { type: "module", name: "mew-code-runner" });
}
