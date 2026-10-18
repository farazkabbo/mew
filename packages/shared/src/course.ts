import { z } from "zod";

/** Courses (M7). Mirrors backend/src/mew_api/courses/models.py. */

export const COURSE_LIMITS = {
  pdfBytes: 15 * 1024 * 1024,
  titleChars: 120,
  excerptChars: 1200,
  excerptsPerTurn: 4,
  queryChars: 600,
} as const;

export const CourseStatus = z.enum(["processing", "review", "ready", "failed"]);
export type CourseStatus = z.infer<typeof CourseStatus>;

export const Course = z.object({
  id: z.uuid(),
  title: z.string(),
  subject: z.string().nullish(),
  exam_date: z.string().nullish(),
  status: CourseStatus,
  status_detail: z.string().nullish(),
  created_at: z.string(),
});
export type Course = z.infer<typeof Course>;

export const Source = z.object({
  id: z.uuid(),
  course_id: z.uuid(),
  kind: z.enum(["pdf", "text", "topic"]),
  title: z.string(),
  page_count: z.number().int().nullish(),
  embedding_model: z.string(),
  storage_path: z.string().nullish(),
});
export type Source = z.infer<typeof Source>;

export const PracticeQuestion = z.object({
  question: z.string(),
  answer: z.string(),
  hint: z.string().default(""),
});
export type PracticeQuestion = z.infer<typeof PracticeQuestion>;

export const Lesson = z.object({
  explanation: z.string(),
  worked_example: z.string().default(""),
  practice: z.array(PracticeQuestion).default([]),
  pages: z.array(z.number().int()).default([]),
  /** False when no model was available: the summary and a source passage instead. */
  generated: z.boolean().default(true),
});
export type Lesson = z.infer<typeof Lesson>;

export const Concept = z.object({
  id: z.uuid(),
  course_id: z.uuid(),
  title: z.string(),
  summary: z.string(),
  order_index: z.number().int(),
  source_pages: z.array(z.number().int()),
  lesson: Lesson.nullish(),
});
export type Concept = z.infer<typeof Concept>;

export const ConceptEdge = z.object({ from_concept: z.uuid(), to_concept: z.uuid() });
export type ConceptEdge = z.infer<typeof ConceptEdge>;

export const CourseDetail = z.object({
  course: Course,
  sources: z.array(Source),
  concepts: z.array(Concept),
  edges: z.array(ConceptEdge),
});
export type CourseDetail = z.infer<typeof CourseDetail>;

export const CourseList = z.array(Course);

export const RetrievedChunk = z.object({
  page: z.number().int(),
  heading: z.string().nullish(),
  text: z.string(),
  similarity: z.number(),
  source_title: z.string(),
});
export type RetrievedChunk = z.infer<typeof RetrievedChunk>;

export const RetrieveResponse = z.object({ chunks: z.array(RetrievedChunk) });

// ─── Requests ───────────────────────────────────────────────────────────────────────────────

const Title = z.string().trim().min(1).max(COURSE_LIMITS.titleChars);

export const CourseUpdate = z
  .object({
    title: Title.optional(),
    exam_date: z.iso.date().nullable().optional(),
    status: z.literal("ready").optional(),
  })
  .strict();
export type CourseUpdate = z.infer<typeof CourseUpdate>;

export const ConceptReview = z
  .object({
    merges: z
      .array(z.object({ into: z.uuid(), sources: z.array(z.uuid()).min(1).max(20) }).strict())
      .max(20)
      .default([]),
    order: z.array(z.uuid()).min(1).max(60),
    titles: z.record(z.uuid(), Title).default({}),
  })
  .strict();
export type ConceptReview = z.infer<typeof ConceptReview>;

export const RetrieveRequest = z
  .object({
    query: z.string().trim().min(1).max(COURSE_LIMITS.queryChars),
    k: z.number().int().min(1).max(8).default(4),
  })
  .strict();
export type RetrieveRequest = z.infer<typeof RetrieveRequest>;

/** A passage of the course material given to the tutor, with its page for citations. */
export const CourseExcerpt = z.object({
  page: z.number().int().min(1).max(2000),
  heading: z.string().max(200).nullable(),
  text: z.string().max(COURSE_LIMITS.excerptChars),
  source: z.string().max(200),
});
export type CourseExcerpt = z.infer<typeof CourseExcerpt>;
