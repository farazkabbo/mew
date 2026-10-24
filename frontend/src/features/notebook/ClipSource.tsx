import type { ImageBlock } from "@mew/shared";

import { safeLink, sourceLabel } from "./clip-page";

/**
 * Where the page's clip came from (Screen Coach S3), with a link back to it (a video opens at
 * the saved moment). Links open in a new tab, or in the desktop app, in the default browser.
 * With `onCheck`, also offers to check the clip against the rest of the notes (Notes Check).
 */
export function ClipSource({ image, onCheck }: { image: ImageBlock; onCheck?: () => void }) {
  const link = safeLink(image.source?.url);
  return (
    <p
      data-testid="clip-source"
      className="pointer-events-auto flex max-w-[min(36rem,90vw)] items-center gap-2 truncate rounded-full bg-paper/90 px-3 py-1 text-xs text-ink-muted shadow-sm ring-1 ring-ink/10"
    >
      <span className="truncate">From your screen · {sourceLabel(image)}</span>
      {link && (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 font-medium text-ink underline underline-offset-2"
        >
          Open source
        </a>
      )}
      {onCheck && (
        <button
          type="button"
          onClick={onCheck}
          className="shrink-0 font-medium text-ink underline underline-offset-2"
        >
          Check against my notes
        </button>
      )}
    </p>
  );
}
