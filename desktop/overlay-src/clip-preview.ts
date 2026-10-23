import { strokePath } from "@mew/ink";
import { HexColor, Point, StrokeTool } from "@mew/shared";
import { z } from "zod";

import { cropBetween, dragCrop, type Handle, handleAt, type Rect } from "./crop";
import { invoke, on } from "./tauri";

/**
 * A clip's preview (S3 §3.2): the only WebView that sees screen pixels, and only after the
 * student asked to save. It has no network, filesystem or shell access (its CSP and window
 * capability): the image comes from Rust's `mewclip://` handler, from memory, and Save hands
 * back only the crop and two choices.
 */

const RectSchema = z.tuple([z.number(), z.number(), z.number().min(0), z.number().min(0)]);
const PreviewInfo = z.object({
  imageUrl: z.string().startsWith("http://mewclip.localhost/"),
  frame: z.tuple([z.number().positive(), z.number().positive()]),
  crop: RectSchema.nullable(),
  strokes: z.array(
    z.object({
      tool: StrokeTool,
      color: HexColor,
      width: z.number().positive(),
      points: z.array(Point).min(1),
    }),
  ),
  cards: z.array(RectSchema),
  source: z.object({
    app: z.string(),
    title: z.string().nullable(),
    link: z.string().nullable(),
    includeLink: z.boolean(),
  }),
  expiresInMs: z.number().nonnegative(),
});
type PreviewInfo = z.infer<typeof PreviewInfo>;

const SVG = "http://www.w3.org/2000/svg";
const image = document.querySelector<HTMLImageElement>("#frame");
const svg = document.querySelector<SVGSVGElement>("#marks");
const notesToggle = document.querySelector<HTMLInputElement>("#include-notes");
const linkToggle = document.querySelector<HTMLInputElement>("#include-link");
const saveButton = document.querySelector<HTMLButtonElement>("#save");
const cancelButton = document.querySelector<HTMLButtonElement>("#cancel");
const hint = document.querySelector<HTMLElement>("#hint");
const status = document.querySelector<HTMLElement>("#status");
const sourceLine = document.querySelector<HTMLElement>("#source");
const linkLine = document.querySelector<HTMLElement>("#link");
const timer = document.querySelector<HTMLElement>("#timer");

let info: PreviewInfo | null = null;
let crop: Rect | null = null;
let deadline = 0;
let countdown = 0;
let busy = false;

async function load(): Promise<void> {
  reset();
  const parsed = PreviewInfo.safeParse(await invoke("screen_clip_ready").catch(() => null));
  if (!parsed.success || !image || !svg) return;
  info = parsed.data;
  crop = info.crop;
  const [w, h] = info.frame;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  image.src = info.imageUrl;
  showSource(info);
  deadline = performance.now() + info.expiresInMs;
  countdown = window.setInterval(tick, 500);
  tick();
  render();
  saveButton?.focus();
}

function reset(): void {
  info = null;
  crop = null;
  busy = false;
  window.clearInterval(countdown);
  if (image) image.removeAttribute("src");
  svg?.replaceChildren();
  if (status) status.textContent = "";
  if (sourceLine) sourceLine.textContent = "";
  if (linkLine) linkLine.textContent = "";
}

function showSource({ source }: PreviewInfo): void {
  if (sourceLine) {
    sourceLine.textContent = [source.app.replace(/\.exe$/, ""), source.title]
      .filter(Boolean)
      .join(" · ");
  }
  if (linkLine) linkLine.textContent = source.link ?? "";
  if (linkToggle) {
    linkToggle.checked = source.includeLink;
    linkToggle.disabled = source.link === null;
  }
}

function tick(): void {
  const left = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
  if (timer) timer.textContent = `Discarded in ${left} s if you don't choose`;
}

/** Redraws the tutor's ink, the dimmed area outside the crop and the crop's handles. */
function render(): void {
  if (!svg || !info) return;
  const [fw, fh] = info.frame;
  const scale = fw / Math.max(1, svg.getBoundingClientRect().width);
  svg.replaceChildren();

  if (notesToggle?.checked !== false) {
    const notes = document.createElementNS(SVG, "g");
    for (const [x, y, w, h] of info.cards) {
      notes.append(element("rect", { x, y, width: w, height: h, rx: 8, class: "card" }));
    }
    for (const stroke of info.strokes) {
      notes.append(element("path", { d: strokePath(stroke), fill: stroke.color }));
    }
    svg.append(notes);
  }

  if (crop) {
    const [x, y, w, h] = crop;
    svg.append(
      element("path", {
        d: `M0 0H${fw}V${fh}H0Z M${x} ${y}V${y + h}H${x + w}V${y}Z`,
        class: "dim",
        "fill-rule": "evenodd",
      }),
      element("rect", { x, y, width: w, height: h, class: "crop", "stroke-width": 2 * scale }),
    );
    const size = 10 * scale;
    for (const [hx, hy] of [
      [x, y],
      [x + w, y],
      [x, y + h],
      [x + w, y + h],
      [x + w / 2, y],
      [x + w / 2, y + h],
      [x, y + h / 2],
      [x + w, y + h / 2],
    ] as const) {
      svg.append(
        element("rect", {
          x: hx - size / 2,
          y: hy - size / 2,
          width: size,
          height: size,
          class: "handle",
        }),
      );
    }
  }
  if (saveButton) saveButton.disabled = busy || crop === null;
  if (hint) hint.hidden = crop !== null;
}

function element(name: string, attributes: Record<string, string | number>): SVGElement {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

/** Pointer position in frame pixels. */
function framePoint(event: PointerEvent): [number, number] | null {
  if (!svg || !info) return null;
  const box = svg.getBoundingClientRect();
  const [fw, fh] = info.frame;
  return [
    ((event.clientX - box.left) / box.width) * fw,
    ((event.clientY - box.top) / box.height) * fh,
  ];
}

let drag: { handle: Handle; from: [number, number]; start: Rect | null } | null = null;

svg?.addEventListener("pointerdown", (event) => {
  const point = framePoint(event);
  if (!point || !info || busy) return;
  const tolerance = (12 * info.frame[0]) / Math.max(1, svg.getBoundingClientRect().width);
  const handle = crop ? handleAt(crop, point, tolerance) : "new";
  drag = { handle, from: point, start: crop };
  svg.setPointerCapture(event.pointerId);
});

svg?.addEventListener("pointermove", (event) => {
  const point = framePoint(event);
  if (!drag || !point || !info) return;
  const frame = info.frame;
  crop =
    drag.handle === "new" || !drag.start
      ? (cropBetween(drag.from, point, frame) ?? crop)
      : dragCrop(drag.start, drag.handle, point[0] - drag.from[0], point[1] - drag.from[1], frame);
  render();
});

svg?.addEventListener("pointerup", () => {
  drag = null;
});

async function save(): Promise<void> {
  if (!crop || busy) return;
  busy = true;
  render();
  if (status) status.textContent = "Saving…";
  try {
    await invoke("screen_clip_save", {
      crop,
      includeNotes: notesToggle?.checked ?? true,
      includeLink: (linkToggle?.checked ?? false) && !linkToggle?.disabled,
    });
  } catch (error) {
    busy = false;
    if (status) status.textContent = typeof error === "string" ? error : "Couldn't save the clip.";
    render();
  }
}

function cancel(): void {
  void invoke("screen_clip_cancel").catch(() => undefined);
  reset();
}

saveButton?.addEventListener("click", () => void save());
cancelButton?.addEventListener("click", cancel);
notesToggle?.addEventListener("change", render);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") cancel();
  if (event.key === "Enter" && !event.isComposing) void save();
});
window.addEventListener("resize", render);
image?.addEventListener("load", render);
// Nothing in the preview can be copied out by dragging or the context menu.
window.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});
window.addEventListener("dragstart", (event) => {
  event.preventDefault();
});

on("mew:clip-open", () => void load());
on("mew:clip-reset", reset);
