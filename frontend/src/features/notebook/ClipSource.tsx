import type { ImageBlock } from "@mew/shared";

import { safeLink, sourceLabel } from "./clip-page";

type Props = {
  image: ImageBlock;
  /** Offers to check the clip against the rest of the notes (Notes Check). */
  onCheck?: () => void;
  /** A scanned PDF page: offers to read its text (K4 §5.2); `reading` while it's being read. */
  onRecognize?: () => void;
  reading?: boolean;
};

/**
 * Where the page's clip came from (Screen Coach S3), or which PDF page it is (K4), with a link
 * back to it (a video opens at the saved moment). Links open in a new tab, or in the desktop
 * app, in the default browser.
 */
export function ClipSource({ image, onCheck, onRecognize, reading = false }: Props) {
  const link = safeLink(image.source?.url);
  return (
    <p
      data-testid="clip-source"
      className="pointer-events-auto flex max-w-[min(36rem,90vw)] items-center gap-2 truncate rounded-full bg-paper/90 px-3 py-1 text-xs text-ink-muted shadow-sm ring-1 ring-ink/10"
    >
      <span className="truncate">
        {image.pdf ? sourceLabel(image) : `From your screen · ${sourceLabel(image)}`}
      </span>
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
      {onRecognize && (
        <button
          type="button"
          onClick={onRecognize}
          disabled={reading}
          data-testid="recognize-text"
          title="This page is a scan: Neb can read its text so the tutor and search can use it."
          className="shrink-0 font-medium text-ink underline underline-offset-2 disabled:no-underline disabled:opacity-60"
        >
          {reading ? "Reading the page…" : "Recognize text"}
        </button>
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
