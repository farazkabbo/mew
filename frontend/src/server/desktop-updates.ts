/**
 * Where installed desktop apps find a new version. The app builds in /desktop/latest.json
 * (desktop/src-tauri/tauri.release.conf.json), which redirects here: by default the newest GitHub
 * Release of the repo (docs/DESKTOP_RELEASE.md), or DESKTOP_UPDATE_MANIFEST_URL. The updater
 * checks the installer's signature against its built-in key, so the redirect never has to be
 * trusted with the files; it only keeps the built-in address stable if the files move.
 */
export const DEFAULT_UPDATE_MANIFEST =
  "https://github.com/farazkabbo/mew/releases/latest/download/latest.json";

export function updateManifestUrl(configured = process.env.DESKTOP_UPDATE_MANIFEST_URL): string {
  const value = configured?.trim();
  if (!value) return DEFAULT_UPDATE_MANIFEST;
  try {
    return new URL(value).protocol === "https:" ? value : DEFAULT_UPDATE_MANIFEST;
  } catch {
    return DEFAULT_UPDATE_MANIFEST;
  }
}
