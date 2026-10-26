"use client";

import {
  type ChildLabel,
  childTitles,
  cleanTitle,
  type Course,
  type Notebook,
  type NotebookColor,
  type NotebookIcon,
  type NotebookTree,
  singular,
  suggestStyle,
  TREE_LIMITS,
} from "@mew/shared";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { coursesApi } from "../../courses/api";
import type { NewNotebook } from "../tree-repository";
import { Dialog } from "./Dialog";
import { COLORS, ICONS } from "./node-style";

const LABELS: readonly ChildLabel[] = ["Chapters", "Units", "Weeks", "Topics", "Modules"];

type Props = {
  open: boolean;
  tree: NotebookTree<Notebook>;
  onCreate(notebook: NewNotebook): void;
  /** K4: make it, then import a PDF into it (its outline proposes the chapters). */
  onFromPdf?(notebook: NewNotebook): void;
  onCancel(): void;
  /** What's typed so far, for the row the sidebar shows meanwhile. */
  onDraft(draft: Pick<Notebook, "title" | "icon" | "color"> | null): void;
};

/**
 * Naming a notebook as it's made (K1, docs/NOTEBOOKS_K.md §2.2): its name (focused, with the
 * placeholder selected so typing replaces it), an icon and colour suggested from the name, an
 * optional course, what its parts are called, and its chapters, typed one by one or made by
 * number and renamed here. Enter creates it from any field but the "add" box; Esc cancels.
 */
export function CreateNotebookDialog(props: Props) {
  return (
    <Dialog
      open={props.open}
      onClose={props.onCancel}
      label="New notebook"
      className="fixed top-16 left-4 m-0 w-[min(28rem,calc(100vw-2rem))] md:left-64"
    >
      <CreateNotebookForm {...props} />
    </Dialog>
  );
}

function CreateNotebookForm({ tree, onCreate, onFromPdf, onCancel, onDraft }: Props) {
  const ids = useId();
  const nameField = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("Untitled notebook");
  const [style, setStyle] = useState<{ icon: NotebookIcon; color: NotebookColor } | null>(null);
  const [label, setLabel] = useState<ChildLabel>("Chapters");
  const [chapters, setChapters] = useState<string[]>([]);
  const [newChapter, setNewChapter] = useState("");
  const [courseId, setCourseId] = useState("");
  const [courses, setCourses] = useState<Course[]>([]);

  const shown = style ?? suggestStyle(name);
  const title = cleanTitle(name);
  const taken = title !== null && tree.nameTaken(null, title);
  const noun = singular(label).toLowerCase();

  useEffect(() => {
    nameField.current?.select();
    let live = true;
    coursesApi
      .list()
      .then((list) => live && setCourses(list.filter((c) => c.status !== "failed")))
      .catch(() => undefined); // offline or signed out: no course to link, that's all
    return () => {
      live = false;
    };
  }, []);

  const { icon, color } = shown;
  useEffect(() => {
    onDraft({ title: name, icon, color });
  }, [onDraft, name, icon, color]);

  const setCount = (raw: string) => {
    const count = Math.max(
      0,
      Math.min(Number.parseInt(raw, 10) || 0, TREE_LIMITS.chaptersAtCreation),
    );
    setChapters((now) =>
      count <= now.length
        ? now.slice(0, count)
        : [...now, ...childTitles(count - now.length, label, now.length + 1)],
    );
  };

  const move = (index: number, step: -1 | 1) =>
    setChapters((now) => {
      const next = [...now];
      const [item] = next.splice(index, 1);
      if (item !== undefined) next.splice(index + step, 0, item);
      return next;
    });

  const create = () => {
    if (!title || taken) {
      nameField.current?.focus();
      return;
    }
    onCreate({
      title,
      ...shown,
      childLabel: label,
      chapters,
      ...(courseId && { courseId }),
    });
  };

  return (
    <form
      className="flex max-h-[calc(100dvh-6rem)] flex-col gap-4 overflow-y-auto p-5"
      onSubmit={(event) => {
        event.preventDefault();
        create();
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-serif text-2xl">New notebook</h2>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel"
          className="grid size-8 place-items-center rounded-lg text-ink-muted hover:bg-rule/60"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${ids}-name`} className="text-xs font-medium text-ink-muted">
          Name
        </label>
        <input
          id={`${ids}-name`}
          ref={nameField}
          autoFocus
          value={name}
          maxLength={TREE_LIMITS.titleChars}
          onChange={(event) => setName(event.target.value)}
          aria-invalid={!title || taken}
          aria-describedby={`${ids}-name-note`}
          className="rounded-lg border border-rule bg-paper px-3 py-2 text-base outline-none focus:border-accent"
        />
        <p id={`${ids}-name-note`} className="min-h-4 text-xs text-error" aria-live="polite">
          {!title && "Give it a name."}
          {taken && (
            <>
              You already have a notebook called “{title}”.{" "}
              <button
                type="button"
                className="underline"
                onClick={() => setName(tree.freeName(null, title))}
              >
                Use “{tree.freeName(null, title)}”
              </button>
            </>
          )}
        </p>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-medium text-ink-muted">Icon and colour</legend>
        <div role="radiogroup" aria-label="Icon" className="flex flex-wrap gap-1">
          {(Object.keys(ICONS) as NotebookIcon[]).map((key) => {
            const Icon = ICONS[key].icon;
            return (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={shown.icon === key}
                aria-label={ICONS[key].label}
                onClick={() => setStyle({ ...shown, icon: key })}
                className="grid size-8 place-items-center rounded-lg border border-transparent hover:bg-rule/50 aria-checked:border-ink/40 aria-checked:bg-rule/60"
              >
                <Icon className="size-4" style={{ color: COLORS[shown.color].hex }} aria-hidden />
              </button>
            );
          })}
        </div>
        <div role="radiogroup" aria-label="Colour" className="flex flex-wrap gap-1.5">
          {(Object.keys(COLORS) as NotebookColor[]).map((key) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={shown.color === key}
              aria-label={COLORS[key].label}
              onClick={() => setStyle({ ...shown, color: key })}
              className="size-6 rounded-full ring-offset-2 ring-offset-paper-raised aria-checked:ring-2 aria-checked:ring-ink/60"
              style={{ background: COLORS[key].hex }}
            />
          ))}
        </div>
      </fieldset>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${ids}-label`} className="text-xs font-medium text-ink-muted">
            Divided into
          </label>
          <select
            id={`${ids}-label`}
            value={label}
            onChange={(event) => setLabel(event.target.value as ChildLabel)}
            className="rounded-lg border border-rule bg-paper px-2 py-2 text-sm"
          >
            {LABELS.map((each) => (
              <option key={each}>{each}</option>
            ))}
          </select>
        </div>
        {courses.length > 0 && (
          <div className="flex flex-col gap-1">
            <label htmlFor={`${ids}-course`} className="text-xs font-medium text-ink-muted">
              Course (optional)
            </label>
            <select
              id={`${ids}-course`}
              value={courseId}
              onChange={(event) => setCourseId(event.target.value)}
              className="rounded-lg border border-rule bg-paper px-2 py-2 text-sm"
            >
              <option value="">Not linked</option>
              {courses.map((course) => (
                <option key={course.id} value={course.id}>
                  {course.title}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <fieldset className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <legend className="text-xs font-medium text-ink-muted">{label} (optional)</legend>
          <label className="flex items-center gap-2 text-xs text-ink-muted">
            How many
            <input
              type="number"
              min={0}
              max={TREE_LIMITS.chaptersAtCreation}
              value={chapters.length}
              onChange={(event) => setCount(event.target.value)}
              aria-label={`Number of ${label.toLowerCase()}`}
              className="w-16 rounded-lg border border-rule bg-paper px-2 py-1 text-sm text-ink"
            />
          </label>
        </div>

        {chapters.length > 0 && (
          <ol className="flex flex-col gap-1" aria-label={label}>
            {chapters.map((chapter, index) => (
              <li key={index} className="flex items-center gap-1">
                <span className="w-6 text-right text-xs text-ink-muted tabular-nums">
                  {index + 1}
                </span>
                <input
                  value={chapter}
                  maxLength={TREE_LIMITS.titleChars}
                  aria-label={`${singular(label)} ${index + 1} name`}
                  onChange={(event) =>
                    setChapters((now) =>
                      now.map((each, i) => (i === index ? event.target.value : each)),
                    )
                  }
                  className="min-w-0 flex-1 rounded-lg border border-rule bg-paper px-2 py-1 text-sm outline-none focus:border-accent"
                />
                <SmallButton
                  label={`Move ${chapter} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp className="size-3.5" aria-hidden />
                </SmallButton>
                <SmallButton
                  label={`Move ${chapter} down`}
                  disabled={index === chapters.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown className="size-3.5" aria-hidden />
                </SmallButton>
                <SmallButton
                  label={`Remove ${chapter}`}
                  onClick={() => setChapters((now) => now.filter((_, i) => i !== index))}
                >
                  <X className="size-3.5" aria-hidden />
                </SmallButton>
              </li>
            ))}
          </ol>
        )}

        <input
          value={newChapter}
          maxLength={TREE_LIMITS.titleChars}
          placeholder={`Add a ${noun}, then press Enter`}
          aria-label={`Add a ${noun}`}
          onChange={(event) => setNewChapter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault(); // adds a row here; Enter elsewhere creates the notebook
            const chapter = cleanTitle(newChapter);
            if (chapter && chapters.length < TREE_LIMITS.chaptersAtCreation) {
              setChapters((now) => [...now, chapter]);
              setNewChapter("");
            }
          }}
          className="rounded-lg border border-dashed border-rule bg-transparent px-2 py-1.5 text-sm outline-none focus:border-accent"
        />
      </fieldset>

      <div className="flex justify-end gap-2 pt-1">
        {onFromPdf && (
          <button
            type="button"
            onClick={() => {
              if (!title || taken) {
                nameField.current?.focus();
                return;
              }
              onFromPdf({ title, ...shown, childLabel: label, ...(courseId && { courseId }) });
            }}
            className="mr-auto rounded-lg px-3 py-2 text-sm text-ink-muted underline-offset-2 hover:underline"
          >
            Chapters from a PDF…
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-3 py-2 text-sm text-ink-muted hover:bg-rule/50"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="rounded-lg bg-ink px-4 py-2 text-sm font-medium text-paper hover:opacity-90"
        >
          Create
        </button>
      </div>
    </form>
  );
}

function SmallButton(props: {
  label: string;
  disabled?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      className="grid size-7 shrink-0 place-items-center rounded-md text-ink-muted hover:bg-rule/60 disabled:opacity-30"
    >
      {props.children}
    </button>
  );
}
