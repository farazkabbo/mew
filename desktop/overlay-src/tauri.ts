/**
 * The overlay pages' only line to Rust: `invoke` from Tauri's global bridge
 * (`withGlobalTauri`). Each page may call just its own commands (its window's capability), and
 * Rust checks the calling window again.
 */
type TauriGlobal = { core: { invoke: (cmd: string, args?: object) => Promise<unknown> } };

export function invoke(command: string, args?: object): Promise<unknown> {
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!tauri) return Promise.reject(new Error("Not running in the Mew desktop app"));
  return tauri.core.invoke(command, args);
}

/** Listens for an event Rust dispatches on this page (`overlay::dispatch`). */
export function on(name: string, handler: (detail: unknown) => void): void {
  window.addEventListener(name, (event) => {
    handler((event as CustomEvent<unknown>).detail);
  });
}
