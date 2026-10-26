"""A tiny PDF writer for tests: real PDFs (text layer, Helvetica) with one list of lines per page.
An empty page (no lines) looks like a scanned page to the parser."""


def make_pdf(
    pages: list[list[str]],
    outline: list[tuple[str, int]] | None = None,
    encrypted: bool = False,
) -> bytes:
    """`outline`: (title, 0-based page) entries at the top level. `encrypted`: the trailer names an
    /Encrypt dictionary pdfium can't open without a password (what a protected file looks like)."""
    objects: list[bytes] = []

    def add(body: bytes) -> int:
        objects.append(body)
        return len(objects)

    catalog = add(b"")  # filled in below
    pages_id = add(b"")
    font = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    kids: list[int] = []
    for lines in pages:
        ops = [b"BT", b"/F1 12 Tf", b"14 TL", b"56 760 Td"]
        for line in lines:
            escaped = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            ops.append(f"({escaped}) Tj T*".encode("latin-1"))
        ops.append(b"ET")
        stream = b"\n".join(ops)
        content = add(b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream))
        kids.append(
            add(
                b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 612 792] "
                b"/Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>"
                % (pages_id, font, content)
            )
        )
    outlines = b""
    if outline:
        root = add(b"")
        items = [add(b"") for _ in outline]
        for i, (title, page) in enumerate(outline):
            links = b""
            if i > 0:
                links += b" /Prev %d 0 R" % items[i - 1]
            if i < len(items) - 1:
                links += b" /Next %d 0 R" % items[i + 1]
            objects[items[i] - 1] = b"<< /Title (%s) /Parent %d 0 R%s /Dest [%d 0 R /Fit] >>" % (
                title.encode("latin-1"),
                root,
                links,
                kids[page],
            )
        objects[root - 1] = b"<< /Type /Outlines /First %d 0 R /Last %d 0 R /Count %d >>" % (
            items[0],
            items[-1],
            len(items),
        )
        outlines = b" /Outlines %d 0 R" % root
    encrypt = add(b"<< /Filter /Standard /V 2 /R 3 /O <00> /U <00> /P -4 >>") if encrypted else 0
    objects[catalog - 1] = b"<< /Type /Catalog /Pages %d 0 R%s >>" % (pages_id, outlines)
    objects[pages_id - 1] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (
        b" ".join(b"%d 0 R" % k for k in kids),
        len(kids),
    )

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (number, body)
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    extra = b" /Encrypt %d 0 R /ID [<00> <00>]" % encrypt if encrypt else b""
    out += b"trailer\n<< /Size %d /Root %d 0 R%s >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1,
        catalog,
        extra,
        xref,
    )
    return bytes(out)


#: A short "chapter" with headings over three pages, plus a blank (scanned-looking) page.
CHAPTER = [
    [
        "Chapter 3 Forces and Motion",
        "",
        "3.1 Forces",
        "A force is a push or a pull on an object. Forces are measured in newtons.",
        "When several forces act on an object, their vector sum is the net force.",
        "Balanced forces leave the motion of an object unchanged.",
    ],
    [
        "3.2 Newton's Laws",
        "Newton's first law says an object keeps its velocity unless a net force acts on it.",
        "Newton's second law relates force, mass and acceleration: F = m a.",
        "Newton's third law: every action has an equal and opposite reaction.",
        "This is why the forces between two objects always come in pairs.",
    ],
    [
        "3.3 Friction",
        "Friction is a force that opposes sliding between surfaces in contact.",
        "Static friction stops an object starting to move; kinetic friction slows it down.",
        "The friction force depends on the normal force and the roughness of the surfaces.",
    ],
    [],
]
