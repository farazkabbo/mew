/**
 * Things the real app tells the tour about (docs/NEB_APP_UI.md decision U32): the student wrote
 * on a page, let go of Ctrl + Alt, closed the PDF import, or asked about their screen. Nothing
 * listens outside a tour.
 */
export type TourSignal = "wrote" | "asked" | "pdf" | "screen-asked";

export const TOUR_SIGNAL_EVENT = "neb:tour-signal";

export function tourSignal(signal: TourSignal): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<TourSignal>(TOUR_SIGNAL_EVENT, { detail: signal }));
}
