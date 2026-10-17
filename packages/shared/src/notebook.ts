import { z } from "zod";

/** [x, y, pressure 0–1, t ms since the stroke started], in page coordinates. */
export const Point = z.tuple([z.number(), z.number(), z.number().min(0).max(1), z.number().min(0)]);
export type Point = z.infer<typeof Point>;

/** [x, y, width, height], in page coordinates. */
export const BBox = z.tuple([z.number(), z.number(), z.number().min(0), z.number().min(0)]);
export type BBox = z.infer<typeof BBox>;

export const StrokeAuthor = z.enum(["student", "tutor"]);
export type StrokeAuthor = z.infer<typeof StrokeAuthor>;

export const StrokeTool = z.enum(["pen", "highlighter"]);
export type StrokeTool = z.infer<typeof StrokeTool>;

export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);

export const MAX_POINTS_PER_STROKE = 10_000;

export const Stroke = z.object({
  id: z.uuid(),
  pageId: z.uuid(),
  author: StrokeAuthor,
  tool: StrokeTool,
  points: z.array(Point).min(1).max(MAX_POINTS_PER_STROKE),
  color: HexColor,
  width: z.number().positive().max(100),
  bbox: BBox,
  createdAt: z.number().int().nonnegative(),
  /** Tutor strokes from one response share a group. */
  groupId: z.uuid().optional(),
});
export type Stroke = z.infer<typeof Stroke>;

export const PageBackground = z.enum(["dot_grid", "blank", "lined", "grid"]);
export type PageBackground = z.infer<typeof PageBackground>;

export const Page = z.object({
  id: z.uuid(),
  notebookId: z.uuid(),
  index: z.number().int().nonnegative(),
  background: PageBackground,
  createdAt: z.number().int().nonnegative(),
});
export type Page = z.infer<typeof Page>;

export const Notebook = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(200),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type Notebook = z.infer<typeof Notebook>;
