import Link from "next/link";
import type { ReactNode } from "react";

import { Keys } from "@/components/ui/Keycap";

import { CourseShell } from "../courses/CourseShell";

/**
 * "How to use neb" (docs/NEB_APP_UI.md decision U30): the things a student comes to do, each as
 * a few numbered steps naming the exact buttons. Reached from the desk's menu and from the last
 * step of the introduction. Plain text on purpose: it must be right at a glance, on any screen.
 */
export function Guide() {
  return (
    <CourseShell
      back={{ href: "/desk", label: "Your desk" }}
      title="How to use neb"
      subtitle={
        <>
          What you can do, and where to click for each. Two minutes to read. Prefer to try it?{" "}
          <Link href="/tour" className="font-medium text-ink underline underline-offset-2">
            Take the interactive tour
          </Link>
          .
        </>
      }
    >
      <nav aria-label="On this page" className="mb-10 flex flex-wrap gap-2 text-sm">
        {TOPICS.map((topic) => (
          <a
            key={topic.id}
            href={`#${topic.id}`}
            className="rounded-full border border-line bg-paper-hi px-3.5 py-1.5 hover:border-ink/40"
          >
            {topic.short}
          </a>
        ))}
      </nav>
      <div className="space-y-12" data-testid="guide">
        {TOPICS.map((topic) => (
          <section key={topic.id} id={topic.id} aria-labelledby={`${topic.id}-title`}>
            <h2 id={`${topic.id}-title`} className="font-serif text-[30px] leading-tight">
              {topic.title}
            </h2>
            {topic.intro && <p className="mt-2 text-muted">{topic.intro}</p>}
            <ol className="mt-4 space-y-2.5">
              {topic.steps.map((step, index) => (
                <li key={index} className="flex gap-3 leading-relaxed">
                  <span
                    aria-hidden
                    className="mt-0.5 grid size-6 flex-none place-items-center rounded-full bg-ink text-xs font-semibold text-paper"
                  >
                    {index + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
            {topic.note && (
              <p className="mt-4 rounded-[10px] border border-line bg-paper-hi px-4 py-3 text-[15px] leading-relaxed">
                {topic.note}
              </p>
            )}
          </section>
        ))}
      </div>
    </CourseShell>
  );
}

const B = ({ children }: { children: ReactNode }) => (
  <strong className="font-semibold">{children}</strong>
);
const CtrlAlt = () => <Keys keys={["Ctrl", "Alt"]} size="sm" />;

type Topic = {
  id: string;
  short: string;
  title: string;
  intro?: ReactNode;
  steps: ReactNode[];
  note?: ReactNode;
};

const TOPICS: Topic[] = [
  {
    id: "around",
    short: "Finding your way",
    title: "Finding your way around",
    intro: "neb has three places. Everything else is inside them.",
    steps: [
      <>
        <B>Your desk</B> is home: your notebooks, what&apos;s due tonight, and how many questions
        you have left. The neb logo, top left, always brings you back.
      </>,
      <>
        <B>A notebook</B> is one class. Open it to see its <B>Pages</B>, its <B>Study</B> tab (once
        it has course material) and its <B>Moments</B> (things saved from your screen).
      </>,
      <>
        <B>Review</B>, top right of the desk, is everything due today.
      </>,
      <>
        Your initial, top right, opens <B>Settings</B>, <B>Teach neb</B> and this guide.
      </>,
    ],
  },
  {
    id: "pdf-quiz",
    short: "PDF → quiz",
    title: "Turn a PDF into lessons and a quiz",
    intro: "Your slides, a textbook chapter or the syllabus. Text PDFs work best.",
    steps: [
      <>
        On your desk, open the notebook for that class, or press <B>New notebook</B> and name it
        after the class.
      </>,
      <>
        On the notebook&apos;s first screen, press <B>Add course material</B> (or <B>Import PDF</B>
        , <Keys keys={["Ctrl", "O"]} size="sm" />) and choose your PDF.
      </>,
      <>
        Leave <B>Use as course material</B> ticked and import. neb reads it, which takes a minute or
        two for a long file. You can keep working.
      </>,
      <>
        Open the notebook&apos;s <B>Study</B> tab. Under <B>Review the plan</B>, rename or remove
        any topic that doesn&apos;t fit, then press <B>Start studying</B>.
      </>,
      <>
        Press <B>Quiz me</B>. neb asks a question out loud. Write your answer on the page, or say
        it, and neb marks it. <B>Hint</B> helps without giving it away.
      </>,
    ],
    note: (
      <>
        A quiz comes from a notebook&apos;s course material. <B>Coach mode</B> is something else: it
        walks you through doing a task in another app (see below), so it won&apos;t quiz you on a
        PDF.
      </>
    ),
  },
  {
    id: "notebook",
    short: "Write and ask",
    title: "Write, and ask neb as you go",
    steps: [
      <>
        Open a page and write with a pen, your finger or the mouse. <Keys keys={["P"]} size="sm" />{" "}
        is the pen, <Keys keys={["E"]} size="sm" /> the eraser.
      </>,
      <>
        Ask out loud (&ldquo;why is this negative?&rdquo;), or tap the neb dot. neb answers in
        speech and writes on your page in violet.
      </>,
      <>
        Say &ldquo;is this right?&rdquo; or press <Keys keys={["Alt", "C"]} size="sm" /> and neb
        checks your working line by line.
      </>,
      <>
        Too many marks, or too few? Change <B>Quiet / Hint / Coach</B> from the neb dot.
      </>,
    ],
    note: "neb stays quiet until you ask or get stuck. Silence means it has nothing to add.",
  },
  {
    id: "screen",
    short: "Ask about your screen",
    title: "Ask about anything on your screen",
    intro: "In the Windows app only. It works over any app: a video, a slide, a website.",
    steps: [
      <>
        Hold <CtrlAlt /> and ask your question out loud. Let go when you&apos;ve finished.
      </>,
      <>
        To point at something, hold <CtrlAlt /> and circle it with the mouse while you ask.
      </>,
      <>
        With a pen or touch screen, tap <CtrlAlt /> twice for draw mode, then circle.
      </>,
      <>
        neb explains beside what you circled, step by step, and saves it to your notebook. A
        follow-up on the same circle doesn&apos;t use another question.
      </>,
    ],
    note: (
      <>
        Violet edges around a window mean neb is looking at it, only then, and only at that window.
        Password boxes and private browser windows are never captured.
      </>
    ),
  },
  {
    id: "say",
    short: "Things to say",
    title: "Things to say while holding Ctrl + Alt",
    intro: "In the Windows app. Each one starts something different.",
    steps: [
      <>
        <B>&ldquo;Quiz me on this&rdquo;</B>: 1 to 3 questions about what&apos;s on your screen.
      </>,
      <>
        <B>&ldquo;Teach me how to make a pivot table&rdquo;</B>: Coach mode, a walkthrough of a task
        in the app you have open, one step at a time. Say &ldquo;done&rdquo; after each step, or
        &ldquo;I&apos;m stuck&rdquo;. Stop it from its pill, or from neb&apos;s icon in the taskbar
        tray.
      </>,
      <>
        <B>&ldquo;Check my notes&rdquo;</B>: compares the screen with your notebook and marks what
        you missed.
      </>,
      <>
        <B>&ldquo;Save this to Physics&rdquo;</B>: saves what&apos;s on screen to that notebook.
      </>,
      <>
        <B>&ldquo;neb, pause&rdquo;</B>: neb stops looking until you resume it from the tray.
      </>,
    ],
  },
  {
    id: "review",
    short: "Review",
    title: "Review what's due",
    steps: [
      <>
        Press <B>Review</B> on your desk (<Link href="/review">or open it here</Link>).
      </>,
      <>
        <B>Quiz me</B> on course topics that are due, and <B>Quick check</B> on things you saved
        from your screen.
      </>,
      <>Topics come back just before you&apos;d forget them. A few minutes a day is enough.</>,
    ],
  },
  {
    id: "questions",
    short: "Questions left",
    title: "Your free questions",
    steps: [
      <>
        Your desk shows how many questions you have left. A new question to neb uses one; a
        follow-up on the same thing, and the later steps of a walkthrough, don&apos;t.
      </>,
      <>If neb can&apos;t answer (a dropped connection, say), you get the question back.</>,
      <>
        At zero, your notebooks, saved moments, Replay and PDF export all keep working, and neb
        emails you when more questions open up.
      </>,
    ],
  },
  {
    id: "fix",
    short: "Fix something",
    title: "Change or redo something",
    steps: [
      <>
        <B>Handwriting didn&apos;t come out right?</B> <Link href="/settings">Settings</Link> →
        Handwriting → <B>Calibrate again</B>, or <B>Reset</B> to make neb forget it.
      </>,
      <>
        <B>Voice, language, shortcuts, what neb may see:</B> all in{" "}
        <Link href="/settings">Settings</Link>.
      </>,
      <>
        <B>Want the first-run introduction again?</B> Settings → <B>Show the introduction again</B>.
      </>,
    ],
  },
];
