import { z } from "zod";

/**
 * The subjects the tutor tells apart. A module of its own with no imports but zod, so anything
 * can use it while the rest of the package loads (a cycle through tutor.ts once left it
 * undefined at module evaluation: K10).
 */
export const Subject = z.enum([
  "math",
  "physics",
  "chemistry",
  "biology",
  "history",
  "language",
  "programming",
  "other",
]);
export type Subject = z.infer<typeof Subject>;
