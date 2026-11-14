/** Whether this student has been shown the tour on this device (decision U31): kept locally,
 * like the writing hand, so no account setting or migration is needed. */
const key = (userId: string) => `neb.tour.seen.${userId}`;

export function tourSeen(userId: string): boolean {
  try {
    return window.localStorage.getItem(key(userId)) === "1";
  } catch {
    return true; // storage blocked: never trap them in a tour that can't be marked done
  }
}

export function markTourSeen(userId: string): void {
  try {
    window.localStorage.setItem(key(userId), "1");
  } catch {
    // nothing to do
  }
}
