"use client";

import type { Point } from "@mew/shared";
import { useState } from "react";

import { InkBox } from "./InkBox";

const CATEGORIES = [
  "algebra",
  "fractions",
  "exponents",
  "calculus",
  "physics-units",
  "physics-vectors",
  "chemistry",
  "code",
  "prose",
] as const;
const SUBJECT: Record<(typeof CATEGORIES)[number], string> = {
  algebra: "math",
  fractions: "math",
  exponents: "math",
  calculus: "math",
  "physics-units": "physics",
  "physics-vectors": "physics",
  chemistry: "chemistry",
  code: "programming",
  prose: "other",
};

type Captured = {
  id: string;
  category: string;
  subject: string;
  writer: string;
  device: string;
  style: "neat" | "messy";
  text: string;
  latex: string | null;
  previous: string[];
  problem: string | null;
  strokes: [number, number][][];
};

/**
 * Capturing real handwriting for the eval set (evals/handwriting/README.md): a team member types
 * what they'll write, writes it, and adds it; the JSON goes in evals/handwriting/samples. Strokes
 * only, with the writer's initials.
 */
export function HandwritingCapture() {
  const [writer, setWriter] = useState("");
  const [device, setDevice] = useState("pen");
  const [style, setStyle] = useState<"neat" | "messy">("neat");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("algebra");
  const [text, setText] = useState("");
  const [latex, setLatex] = useState("");
  const [problem, setProblem] = useState("");
  const [strokes, setStrokes] = useState<Point[][]>([]);
  const [clearKey, setClearKey] = useState(0);
  const [samples, setSamples] = useState<Captured[]>([]);

  const ready = /^[a-z]{2,4}$/i.test(writer) && text.trim() !== "" && strokes.length > 0;
  const add = () => {
    const previous = samples
      .filter((s) => s.problem === (problem.trim() || null))
      .slice(-2)
      .map((s) => s.latex ?? s.text);
    setSamples([
      ...samples,
      {
        id: `team-${writer.toLowerCase()}-${Date.now().toString(36)}`,
        category,
        subject: SUBJECT[category],
        writer: writer.toLowerCase(),
        device,
        style,
        text: text.trim(),
        latex: latex.trim() || null,
        previous,
        problem: problem.trim() || null,
        strokes: strokes.map((s) =>
          s.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]),
        ),
      },
    ]);
    setText("");
    setLatex("");
    setStrokes([]);
    setClearKey((k) => k + 1);
  };
  const download = () => {
    const blob = new Blob([`${JSON.stringify(samples, null, 1)}\n`], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `team-${writer.toLowerCase() || "x"}-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const field = "rounded-lg border border-rule bg-paper px-2 py-1";
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-8">
      <h1 className="font-serif text-3xl">Handwriting samples</h1>
      <p className="text-sm text-ink-muted">
        For the eval set (evals/handwriting). Initials only, never a name. Write naturally.
      </p>
      <div className="flex flex-wrap gap-3 text-sm">
        <label className="flex flex-col gap-1">
          Writer (initials)
          <input className={field} value={writer} onChange={(e) => setWriter(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          Device
          <select className={field} value={device} onChange={(e) => setDevice(e.target.value)}>
            {["pen", "ipad", "mouse", "trackpad", "finger"].map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Style
          <select
            className={field}
            value={style}
            onChange={(e) => setStyle(e.target.value as "neat" | "messy")}
          >
            <option>neat</option>
            <option>messy</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Category
          <select
            className={field}
            value={category}
            onChange={(e) => setCategory(e.target.value as (typeof CATEGORIES)[number])}
          >
            {CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        The problem (lines with the same problem give each other context)
        <input className={field} value={problem} onChange={(e) => setProblem(e.target.value)} />
      </label>
      <div className="flex flex-wrap gap-3 text-sm">
        <label className="flex flex-1 flex-col gap-1">
          What you&apos;ll write (text)
          <input className={field} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <label className="flex flex-1 flex-col gap-1">
          LaTeX (maths and chemistry)
          <input className={field} value={latex} onChange={(e) => setLatex(e.target.value)} />
        </label>
      </div>
      <InkBox
        label="Write the line here"
        width={720}
        height={110}
        clearKey={clearKey}
        onChange={setStrokes}
      />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!ready}
          onClick={add}
          className="rounded-full bg-ink px-4 py-1.5 text-paper disabled:opacity-50"
        >
          Add
        </button>
        <button
          type="button"
          onClick={() => {
            setStrokes([]);
            setClearKey((k) => k + 1);
          }}
          className="rounded-full border border-rule px-4 py-1.5"
        >
          Clear
        </button>
        <button
          type="button"
          disabled={samples.length === 0}
          onClick={download}
          className="ml-auto rounded-full border border-ink px-4 py-1.5 disabled:opacity-50"
        >
          Download {samples.length} {samples.length === 1 ? "sample" : "samples"}
        </button>
      </div>
    </main>
  );
}
