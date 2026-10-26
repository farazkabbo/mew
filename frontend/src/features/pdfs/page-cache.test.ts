import "fake-indexeddb/auto";

import { describe, expect, it, vi } from "vitest";

import { NotebookDb } from "../notebook/db";
import { PdfPageCache } from "./page-cache";

const PDF = "77777777-7777-4777-8777-777777777777";
let n = 0;

function server(online = { value: true }) {
  return vi.fn((url: string) => {
    if (!online.value) return Promise.reject(new Error("offline"));
    if (url.endsWith("/image")) {
      return Promise.resolve(new Response(new Blob([new Uint8Array(100)], { type: "image/png" })));
    }
    return Promise.resolve(
      Response.json({
        text: `text of ${url}`,
        words: [{ text: "text", box: [0.1, 0.1, 0.2, 0.12] }],
      }),
    );
  });
}

describe("PDF pages kept on the device (K4, decision 9)", () => {
  it("keeps pages as they're viewed, and serves them offline", async () => {
    const online = { value: true };
    const fetchImpl = server(online);
    const cache = new PdfPageCache(new NotebookDb(`pdfcache_${++n}`), fetchImpl);
    const first = await cache.get(PDF, 0);
    expect(first?.text).toContain(`/api/pdfs/${PDF}/pages/0/text`);
    expect(first?.words).toEqual([{ text: "text", box: [0.1, 0.1, 0.2, 0.12] }]);
    online.value = false;
    const offline = await cache.get(PDF, 0);
    expect(offline?.image.size).toBe(100);
    expect(offline?.words).toHaveLength(1); // the word boxes are kept with the page
    // Never viewed and offline: null (the page says it needs a connection).
    expect(await cache.get(PDF, 1)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(4); // image + text for page 0, then page 1 (failed)
  });

  it("drops the least recently used past its size", async () => {
    let clock = 0;
    const cache = new PdfPageCache(new NotebookDb(`pdfcache_${++n}`), server(), 650, () => ++clock);
    // Each page is 100 bytes of picture plus its text and words (about 300 in all): two fit.
    await cache.get(PDF, 0);
    await cache.get(PDF, 1);
    await cache.get(PDF, 0); // used again: newer than page 1
    await cache.get(PDF, 2);
    expect(await cache.has(PDF, 1)).toBe(false);
    expect(await cache.has(PDF, 0)).toBe(true);
    expect(await cache.has(PDF, 2)).toBe(true);
    expect(await cache.size()).toBeLessThanOrEqual(650);
  });

  it("downloads a PDF's pages for offline use", async () => {
    const db = new NotebookDb(`pdfcache_${++n}`);
    await db.pdfs.put({ pdfId: PDF, fileName: "Physics.pdf", pageCount: 5, offline: false });
    const cache = new PdfPageCache(db, server());
    const progress: number[] = [];
    expect(await cache.keep(PDF, [0, 1, 2, 3, 4], (done) => progress.push(done))).toBe(5);
    expect(progress.at(-1)).toBe(5);
    expect((await db.pdfs.get(PDF))?.offline).toBe(true);
    for (const page of [0, 1, 2, 3, 4]) expect(await cache.has(PDF, page)).toBe(true);
  });

  it("keeps a scanned page's recognized text with it, offline too (K4 §5.2)", async () => {
    const online = { value: true };
    const cache = new PdfPageCache(new NotebookDb(`pdfcache_${++n}`), server(online));
    await cache.get(PDF, 0);
    await cache.setText(PDF, 0, "Read from the scan.");
    online.value = false;
    expect((await cache.get(PDF, 0))?.text).toBe("Read from the scan.");
    await cache.setText(PDF, 9, "never viewed"); // nothing kept: nothing to change
    expect(await cache.has(PDF, 9)).toBe(false);
  });
});
