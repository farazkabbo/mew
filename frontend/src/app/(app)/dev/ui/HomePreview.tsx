"use client";

import { type ConceptStatus, type CourseDetail, planExam, progressFor } from "@mew/shared";
import { FilePlus, FileUp, Plus } from "lucide-react";
import { useState } from "react";

import { Building } from "@/features/courses/CourseStudy";
import { ExamPlanCard } from "@/features/courses/ExamPlanView";
import { ScopeReview } from "@/features/courses/ScopeReview";
import { ConceptRow, StatusBar } from "@/features/courses/StudyPlan";
import type { Moment } from "@/features/moments/moments";
import { MomentsList } from "@/features/moments/MomentsList";
import {
  CoverMark,
  DividerTabs,
  NebNotice,
  SubjectSelect,
} from "@/features/notebook/home/HomeParts";
import {
  AddTile,
  ChapterCard,
  CourseMaterialCard,
  PageTile,
} from "@/features/notebook/home/PagesParts";

/** The notebook home's pieces (decision U28), with fixed data so the screenshots don't move. */

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOW = Date.parse("2026-11-04T12:00:00Z");
const noop = () => undefined;

const CONCEPTS = [
  ["Arrays and Two Pointers", [2, 3, 4, 6]],
  ["Binary Search", [5]],
  ["Matrix Manipulation", [8, 9]],
  ["Sliding Window and Strings", [10, 11, 12, 13, 14]],
  ["Linked Lists", [15, 16, 17]],
] as const;
const DETAIL = {
  course: {
    id: id(500),
    title: "Advanced DSA",
    status: "ready",
    status_detail: null,
    exam_date: "2026-11-13",
  },
  sources: [],
  concepts: CONCEPTS.map(([title, pages], i) => ({
    id: id(600 + i),
    course_id: id(500),
    title,
    summary: "",
    order_index: i,
    source_pages: [...pages],
  })),
  edges: [1, 2, 3, 4].map((i) => ({ from_concept: id(600), to_concept: id(600 + i) })),
} as unknown as CourseDetail;
const PLAN = planExam({
  orderedIds: DETAIL.concepts.map((c) => c.id),
  progress: progressFor(
    DETAIL.concepts.map((c) => c.id),
    [],
  ),
  examDate: "2026-11-13",
  today: "2026-11-04",
});
const ROWS: { status: ConceptStatus; when: string }[] = [
  { status: "checked", when: "Checked on your own · review in 3 days" },
  { status: "practised_with_hint", when: "Practised with a hint · review tomorrow" },
  { status: "revisit", when: "Time for another look · due now" },
  { status: "explored", when: "Lesson opened · not practised yet" },
  { status: "not_started", when: "Not started" },
];

const PDF = "Chapter ONE- InClassQuestions (3).pdf - Personal";
const moment = (n: number, question: string, sourceName: string, days: number): Moment =>
  ({
    imageId: id(700 + n),
    clipId: id(800 + n),
    pageId: id(900 + n),
    nodeId: id(1),
    question,
    createdAt: NOW - days * 86_400_000,
    kind: sourceName === "Recordly" ? "app" : "pdf",
    sourceName,
    image: {
      id: id(700 + n),
      source: sourceName === "Recordly" ? { title: sourceName } : { title: sourceName },
      ocrText: "Simple interest: I = Prt",
    },
  }) as unknown as Moment;
const MOMENTS: Moment[] = [
  moment(1, "Explain this equation.", PDF, 2),
  moment(2, "The formula that I would have to use for part A. I'm a bit confused.", PDF, 2),
  moment(3, "Can you please help me with the single payment equivalent to multiple debts?", PDF, 2),
  moment(4, "Explain this", PDF, 2),
  moment(
    5,
    "2. A $1200 loan has a maturing value of $1260, due at the end of 9 months.",
    "Recordly",
    2,
  ),
];

export function HomePreview({
  Block,
}: {
  Block(props: { id: string; title: string; children: React.ReactNode }): React.ReactNode;
}) {
  const [tab, setTab] = useState<"pages" | "study" | "moments">("pages");
  return (
    <>
      <Block id="home-header" title="Notebook home · header">
        <div className="flex flex-wrap items-center gap-5">
          <CoverMark node={{ icon: "book", color: "amber" }} />
          <div>
            <p className="font-serif text-[56px] leading-none">Advanced DSA</p>
            <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-muted">
              <span>1 chapter · 47 pages</span>
              <span aria-hidden className="size-1 rounded-full bg-line" />
              <SubjectSelect value="programming" onChange={noop} />
            </div>
          </div>
        </div>
        <NebNotice
          voice="from what you saved here"
          text="1 check due · about 2 min"
          action={{ label: "Quick check", neb: true, run: noop }}
        />
        <NebNotice
          voice="neb found the topics in your pdf."
          text="Check them so it can quiz you and track what you know."
          action={{ label: "Review topics", neb: false, run: noop }}
        />
        <div data-testid="ui-home-tabs">
          <DividerTabs<"pages" | "study" | "moments">
            tabs={[
              { id: "pages", label: "Pages", count: 47 },
              { id: "study", label: "Study", count: 12 },
              { id: "moments", label: "Moments", count: 10 },
            ]}
            selected={tab}
            onSelect={setTab}
            label="Notebook"
            idPrefix="ui-home"
          >
            <p className="text-sm text-muted">The {tab} sheet.</p>
          </DividerTabs>
        </div>
      </Block>

      <Block id="home-pages" title="Notebook home · Pages">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
          <ChapterCard
            number={1}
            title="Chapter 1"
            cover="#D4B45A"
            due={0}
            progress={{ checked: 1, total: 12 }}
            meta="2 pages · edited 27 minutes ago"
            dropping={false}
            onOpen={noop}
            onDropPage={noop}
            onDragOver={noop}
            onDragLeave={noop}
          />
          <ChapterCard
            number={2}
            title="Trees"
            cover="#D4B45A"
            due={2}
            progress={null}
            meta="5 pages · 1 section · edited yesterday"
            dropping
            onOpen={noop}
            onDropPage={noop}
            onDragOver={noop}
            onDragLeave={noop}
          />
          <AddTile tall icon={Plus} label="Add chapter" keys="Alt+N" onClick={noop} />
        </div>
        <div className="mt-6 grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-x-3.5 gap-y-5">
          <AddTile icon={FilePlus} label="New page" keys="Alt+P" onClick={noop} />
          <AddTile icon={FileUp} label="Import PDF" keys="Ctrl+O" onClick={noop} />
          {[2, 3, 4, 5].map((n) => (
            <PageTile
              key={n}
              id={id(n)}
              label={`Page ${n}`}
              dragging={n === 4}
              onOpen={noop}
              onMove={noop}
              onDragStart={noop}
              onDragEnd={noop}
            />
          ))}
        </div>
        <CourseMaterialCard
          courses={[{ id: id(500), title: "Business Mathematics" }]}
          onAdd={noop}
          onLink={noop}
        />
      </Block>

      <Block id="home-study" title="Notebook home · Study">
        <StatusBar
          counts={{ checked: 1, practised_with_hint: 1, revisit: 1, explored: 1, not_started: 8 }}
        />
        <div className="flex flex-wrap items-start gap-8">
          <ol className="min-w-0 flex-[999_1_480px] overflow-hidden rounded-xl bg-paper-hi shadow-sh-2">
            {DETAIL.concepts.map((concept, i) => (
              <ConceptRow
                key={concept.id}
                href="#"
                number={i + 1}
                title={concept.title}
                status={ROWS[i]?.status ?? null}
                when={ROWS[i]?.when ?? ""}
                after={i === 0 ? [] : [{ number: 1, title: "Arrays and Two Pointers" }]}
                pages={i === 0 ? "pp. 2–4, 6" : `p. ${i + 4}`}
              />
            ))}
          </ol>
          <ExamPlanCard detail={DETAIL} onChange={noop} plan={PLAN} />
        </div>
        <div data-testid="ui-plan-editor">
          <ScopeReview
            detail={{ ...DETAIL, course: { ...DETAIL.course, status: "review", exam_date: null } }}
            onSaved={noop}
          />
        </div>
        <Building />
      </Block>

      <Block id="home-moments" title="Notebook home · Moments">
        <MomentsList
          moments={MOMENTS}
          now={NOW}
          onOpen={noop}
          onReplay={noop}
          onCheckNotes={noop}
          dueClipIds={new Set([id(803)])}
          thumbnail={() => null}
        />
      </Block>
    </>
  );
}
