// File-format sniffing.
//
// Many mirrors (e.g. Libgen get.php) serve everything as
// application/octet-stream, so content-type alone cannot tell an EPUB from a
// PDF. We sniff the actual file signature instead, falling back to content-type
// and finally "bin".
//
// Lives in its own module so it can be unit-tested against byte fixtures
// without starting a server or touching the network.

const MAGIC: ReadonlyArray<{ ext: string; match: (b: Buffer) => boolean }> = [
  { ext: "pdf", match: (b) => b.subarray(0, 4).toString("latin1") === "%PDF" },
  {
    // ZIP-based: EPUB has "mimetype" as the first archive entry naming
    // application/epub+zip; CBZ/plain ZIP will not. Cheap heuristic: scan the
    // first few KB for the EPUB mimetype string.
    ext: "epub",
    match: (b) =>
      b.subarray(0, 2).toString("latin1") === "PK" &&
      b.subarray(0, 4096).toString("latin1").includes("application/epub+zip"),
  },
  {
    ext: "zip",
    match: (b) => b.subarray(0, 2).toString("latin1") === "PK",
  },
  { ext: "rar", match: (b) => b.subarray(0, 4).toString("latin1") === "Rar!" },
  { ext: "mobi", match: (b) => b.subarray(60, 68).toString("latin1") === "BOOKMOBI" },
  { ext: "djvu", match: (b) => b.subarray(0, 8).toString("latin1") === "AT&TFORM" },
];

/**
 * Guess a file extension from the leading bytes, then from content-type.
 *
 * Only the first few KB are inspected, which is enough for every container
 * above and keeps this usable on a stream's head chunk.
 */
export function sniffExt(buffer: Buffer, contentType?: string | null): string {
  if (buffer.length >= 4) {
    for (const { ext, match } of MAGIC) {
      if (match(buffer)) return ext;
    }
  }
  if (contentType?.includes("epub")) return "epub";
  if (contentType?.includes("pdf")) return "pdf";
  return "bin";
}
