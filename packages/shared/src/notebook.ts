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

/** Where a clipped image came from (Screen Coach S3), shown in a line under it. */
export const ImageSource = z.object({
  app: z.string().min(1).max(64),
  title: z.string().max(200).optional(),
  /** https only; checked again before it's rendered as a link. */
  url: z.string().max(2000).optional(),
  timestampSec: z.number().int().nonnegative().optional(),
  capturedAt: z.string().max(40),
});
export type ImageSource = z.infer<typeof ImageSource>;

/**
 * An image on a page (a clip saved from the screen), drawn under the ink. Its pixels are fetched
 * from the clip's own route; only the clip id is kept here.
 */
export const ImageBlock = z.object({
  id: z.uuid(),
  pageId: z.uuid(),
  type: z.literal("image"),
  clipId: z.uuid(),
  /** Top-left and size, in page units. */
  x: z.number(),
  y: z.number(),
  width: z.number().positive().max(10_000),
  height: z.number().positive().max(10_000),
  source: ImageSource.optional(),
  /** Text read from the image on the device: context for the notebook tutor. */
  ocrText: z.string().max(8_000).optional(),
  /** A Circle & Ask entry (S3.2): the explanation shown under the picture. */
  entry: z
    .object({
      sessionId: z.uuid(),
      turns: z
        .array(
          z.object({
            question: z.string().max(500),
            steps: z.array(z.string().max(220)).max(5),
            summary: z.string().max(320),
            followUpQuestion: z.string().max(220).optional(),
          }),
        )
        .max(12),
      /** The tutor strokes' group for each turn's each step (Replay draws them in order). */
      stepGroups: z.array(z.array(z.uuid()).max(5)).max(12),
      /** How many of the clip's tutor strokes are already on the page (follow-ups add more). */
      strokeCount: z.number().int().nonnegative(),
    })
    .optional(),
  createdAt: z.number().int().nonnegative(),
});
export type ImageBlock = z.infer<typeof ImageBlock>;
export type ImageEntry = NonNullable<ImageBlock["entry"]>;

export const PageBackground = z.enum(["dot_grid", "blank", "lined", "grid"]);
export type PageBackground = z.infer<typeof PageBackground>;

export const Page = z.object({
  id: z.uuid(),
  notebookId: z.uuid(),
  index: z.number().int().nonnegative(),
  background: PageBackground,
  createdAt: z.number().int().nonnegative(),
  /** The day's "From screen" page (Circle & Ask's entries stack on it, S3.2 §2.5). */
  fromScreenDay: z.iso.date().optional(),
});
export type Page = z.infer<typeof Page>;

/** What a notebook calls its second level ("New unit"); all of them mean "chapter" to voice. */
export const ChildLabel = z.enum(["Chapters", "Units", "Weeks", "Topics", "Modules"]);
export type ChildLabel = z.infer<typeof ChildLabel>;

/** A notebook's icon (drawn with the app's icon set; never an emoji or an image). */
export const NotebookIcon = z.enum([
  "book",
  "atom",
  "flask",
  "sigma",
  "dna",
  "globe",
  "code",
  "landmark",
  "languages",
  "music",
  "palette",
  "leaf",
  "brain",
  "calculator",
]);
export type NotebookIcon = z.infer<typeof NotebookIcon>;

export const NotebookColor = z.enum(["slate", "teal", "blue", "violet", "rose", "amber", "green"]);
export type NotebookColor = z.infer<typeof NotebookColor>;

/** A fractional index (`fractional-indexing`, base 62): siblings sort by it. */
export const Position = z.string().regex(/^[0-9A-Za-z]{1,64}$/);

/**
 * A node of the notebook tree (K1): a notebook (no parent), a chapter or a section, three levels
 * at most. Pages hang off any node. Rows stored before the tree existed parse as roots.
 */
export const Notebook = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(200),
  parentId: z.uuid().nullable().default(null),
  position: Position.default("a0"),
  childLabel: ChildLabel.default("Chapters"),
  icon: NotebookIcon.optional(),
  color: NotebookColor.optional(),
  /** The course this notebook is for (its tutor draws on the course material). */
  courseId: z.uuid().optional(),
  /** In the trash since (purged after 30 days). */
  deletedAt: z.number().int().nonnegative().optional(),
  /** When the student last changed its title, place or settings: the latest edit wins. */
  editedAt: z.number().int().nonnegative().default(0),
  createdAt: z.number().int().nonnegative(),
  /** Last used (the recency the app opens and sorts by). */
  updatedAt: z.number().int().nonnegative(),
});
export type Notebook = z.infer<typeof Notebook>;
