import type { Deflate } from "@mew/ink";

/** zlib-wrapped deflate with the browser's CompressionStream (PNG image data). */
export const browserDeflate: Deflate = async (bytes) => {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};
