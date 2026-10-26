/**
 * A tiny PDF writer for tests (text layer, Helvetica), one list of lines per page; `outline`
 * gives it a table of contents (title, 0-based page) at the top level.
 */
export function makePdf(pages: string[][], outline: [string, number][] = []): Buffer {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body);

  add(""); // 1: catalog, filled in below
  add(""); // 2: pages
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"); // 3
  const kids: number[] = [];
  for (const lines of pages) {
    const ops = ["BT", "/F1 12 Tf", "14 TL", "56 760 Td"];
    for (const line of lines) {
      ops.push(`(${line.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj T*`);
    }
    ops.push("ET");
    const stream = ops.join("\n");
    add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    const content = objects.length;
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${content} 0 R >>`,
    );
    kids.push(objects.length);
  }
  let outlines = "";
  if (outline.length > 0) {
    add(""); // the outline's root
    const root = objects.length;
    const items = outline.map(() => {
      add("");
      return objects.length;
    });
    outline.forEach(([title, page], i) => {
      const prev = i > 0 ? ` /Prev ${items[i - 1]} 0 R` : "";
      const next = i < items.length - 1 ? ` /Next ${items[i + 1]} 0 R` : "";
      objects[(items[i] ?? 0) - 1] =
        `<< /Title (${title}) /Parent ${root} 0 R${prev}${next} /Dest [${kids[page]} 0 R /Fit] >>`;
    });
    objects[root - 1] =
      `<< /Type /Outlines /First ${items[0]} 0 R /Last ${items.at(-1)} 0 R /Count ${items.length} >>`;
    outlines = ` /Outlines ${root} 0 R`;
  }
  objects[0] = `<< /Type /Catalog /Pages 2 0 R${outlines} >>`;
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A short chapter with three sections over three pages. */
export const CHAPTER = [
  [
    "Chapter 3 Forces and Motion",
    "",
    "3.1 Forces",
    "A force is a push or a pull on an object. Forces are measured in newtons.",
    "When several forces act on an object, their vector sum is the net force.",
    "Balanced forces leave the motion of an object unchanged.",
  ],
  [
    "3.2 Newtons Laws",
    "Newtons first law says an object keeps its velocity unless a net force acts on it.",
    "Newtons second law relates force, mass and acceleration: F = m a.",
    "Newtons third law: every action has an equal and opposite reaction.",
  ],
  [
    "3.3 Friction",
    "Friction is a force that opposes sliding between surfaces in contact.",
    "Static friction stops an object starting to move; kinetic friction slows it down.",
    "The friction force depends on the normal force and the roughness of the surfaces.",
  ],
];
