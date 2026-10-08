// Table and field parsing helpers.
//
// Shared by the Library Genesis book and paper scrapers, and by the Anna's
// Archive metadata parser. Everything here is pure: no I/O, no cheerio, so it
// can be unit-tested against strings.
//
// The reason this module exists is that the parsers it replaces guessed at
// fields by position and by loose regular expressions, and both guesses were
// wrong on real data:
//   - author came from cell 0, but Libgen puts the series+title there and the
//     author in cell 1, so every Libgen result reported the series name and a
//     list of ISBNs as the author;
//   - size came from an unbounded regex, which matched "00264mB" out of
//     concatenated page text and reported it as a file size.
// Column names are now read from the table's own header row, and field
// extraction is validated rather than assumed.

/** Languages Libgen uses in its Language column. Matching against a known set
 *  stops arbitrary words from being reported as a language. */
export const KNOWN_LANGUAGES: ReadonlySet<string> = new Set([
  "english","spanish","french","german","russian","chinese","arabic","portuguese",
  "italian","dutch","japanese","korean","turkish","persian","hindi","polish",
  "ukrainian","czech","swedish","norwegian","danish","finnish","hungarian",
  "romanian","greek","hebrew","indonesian","vietnamese","thai","latin",
  "multiple","other","n/a",
]);

/** File extensions Libgen puts in its "Ext." column. */
const KNOWN_FORMATS = new Set([
  "pdf","epub","mobi","djvu","azw3","fb2","cbr","cbz","txt","rtf","doc","docx",
  "chm","lit","pdb","azw","azw4","jpg","png","zip","rar","mp3","audiobook",
]);

/**
 * Extract a file size such as "4 MB".
 *
 * Deliberately strict. The naive pattern `(\d+(?:\.\d+)?\s?(?:KB|MB|GB))`
 * matches inside longer digit runs, which is how "00264mB" ended up reported as
 * a size. Rules applied here:
 *   - the number must be a standalone token, not part of a longer digit run;
 *   - no leading zeros (so "00264" cannot start a match);
 *   - the value must be plausible (< 100 TB);
 *   - the result is normalised to "<number> <UNIT>".
 */
export function parseSize(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  const re = /(?:^|[\s(,])(\d{1,4}(?:[.,]\d{1,2})?)\s?(KB|MB|GB|TB)(?=[\s),.;]|$)/gi;
  for (const m of text.matchAll(re)) {
    const raw = m[1];
    const rawUnit = m[2];
    if (!raw || !rawUnit) continue;
    if (/^0\d/.test(raw)) continue; // leading zero: part of an ID, not a size
    const value = Number(raw.replace(",", "."));
    if (!Number.isFinite(value) || value <= 0) continue;
    const unit = rawUnit.toUpperCase();
    const asTb =
      value * (unit === "KB" ? 1 / 1048576 : unit === "MB" ? 1 / 1024 : unit === "GB" ? 1 : 1024);
    if (asTb >= 100) continue; // implausible for a book; almost certainly an ID
    return `${raw.replace(",", ".")} ${unit}`;
  }
  return undefined;
}

/** Extract a 4-digit year from text such as "2004" or "2020 April 03". */
export function parseYear(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  // Bounded so it cannot match inside an ISBN or an internal ID.
  const m = text.match(/(?:^|[^\d])(1[4-9]\d{2}|20\d{2}|21\d{2})(?:[^\d]|$)/);
  return m?.[1];
}

/** Normalise the "Ext." column to an upper-case extension. */
export function parseFormat(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  const token = text.trim().toLowerCase().replace(/^\./, "");
  return KNOWN_FORMATS.has(token) ? token.toUpperCase() : undefined;
}

/** Normalise the Language column, rejecting free text that is not a language. */
export function parseLanguage(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  const token = text.trim().toLowerCase();
  if (!token || !KNOWN_LANGUAGES.has(token)) return undefined;
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/** "223 / 223" -> "223"; "" or "0" -> undefined. */
export function parsePages(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  const m = text.match(/\b(\d{1,5})\b/);
  const n = m?.[1];
  if (!n || Number(n) === 0) return undefined;
  return n;
}

/** True for strings that look like one or more ISBNs, e.g.
 *  "9780471460671; 0471460672". Used to keep ISBNs out of the title. */
export function isIsbnLike(text: string | undefined | null): boolean {
  if (!text) return false;
  const parts = text.split(/[;,]/).map((s) => s.replace(/[\s-]/g, ""));
  if (parts.length === 0) return false;
  return parts.every((p) => /^(?:\d[\dXx]{8,16})$/.test(p));
}

/** Extract ISBNs from free text, if a run of them is present. */
export function parseIsbns(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  const m = text.match(/(?:\d[\dXx-]{8,16}\d)(?:\s*;\s*\d[\dXx-]{8,16}\d)*/);
  return m?.[0]?.replace(/\s+/g, " ").trim();
}

/** Logical field names the Libgen tables expose. */
export type LibgenColumn =
  | "title"
  | "author"
  | "publisher"
  | "year"
  | "language"
  | "pages"
  | "size"
  | "format"
  | "mirrors";

/**
 * Map a table's header cells to logical field names.
 *
 * Libgen renders a real header row — `Author(s) ↕`, `Publisher ↕`, `Year ↕`,
 * `Size ↕`, `Ext. ↕`, `Mirrors`, and a wide first column combining
 * "ID / Time add. / Title / Series". Reading it means the parser does not care
 * which column order a given mirror family uses, and it keeps working if a
 * column is inserted. Positional fallbacks live in the caller for pages that
 * ship no header row at all.
 */
export function columnMap(headers: string[]): Partial<Record<LibgenColumn, number>> {
  const map: Partial<Record<LibgenColumn, number>> = {};
  headers.forEach((raw, index) => {
    // Strip the sort arrows and collapse whitespace.
    const h = raw.replace(/[↕↑↓]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    if (!h) return;
    // Order matters: "Title" is checked before the wide first column matches
    // anything else, and "Ext." must not be caught by a broader rule.
    if (map.author === undefined && /author/.test(h)) map.author = index;
    else if (map.publisher === undefined && /publisher/.test(h)) map.publisher = index;
    else if (map.year === undefined && /\byear\b/.test(h)) map.year = index;
    else if (map.language === undefined && /language/.test(h)) map.language = index;
    else if (map.pages === undefined && /pages/.test(h)) map.pages = index;
    else if (map.size === undefined && /\bsize\b/.test(h)) map.size = index;
    else if (map.format === undefined && /\bext\b/.test(h)) map.format = index;
    else if (map.mirrors === undefined && /mirror/.test(h)) map.mirrors = index;
    else if (map.title === undefined && /title/.test(h)) map.title = index;
  });
  return map;
}

/** Positional fallback for the common `.li` layout when no header row exists. */
export const LIBGEN_DEFAULT_COLUMNS: Partial<Record<LibgenColumn, number>> = {
  title: 0,
  author: 1,
  publisher: 2,
  year: 3,
  language: 4,
  pages: 5,
  size: 6,
  format: 7,
  mirrors: 8,
};

/**
 * Parse a BibTeX entry into flat key/value pairs.
 *
 * Library Genesis embeds a machine-readable `@book{...}` block on the ads.php
 * page. It carries the exact title, author, publisher, ISBN, year and series —
 * which is strictly better than scraping rendered HTML, and it is what makes
 * `book_details` work without depending on Anna's Archive.
 *
 * Only the flat `key = {value}` form Libgen emits is supported; nested braces
 * inside a value are handled by counting depth.
 */
export function parseBibtex(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Find the entry body between the first "{" after @type and its match.
  const start = text.search(/@\w+\s*\{/);
  if (start < 0) return out;
  let i = text.indexOf("{", start);
  let depth = 0;
  let bodyStart = -1;
  let bodyEnd = -1;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      depth += 1;
      if (depth === 1) bodyStart = i + 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        bodyEnd = i;
        break;
      }
    }
  }
  if (bodyStart < 0 || bodyEnd < 0) return out;

  const body = text.slice(bodyStart, bodyEnd);
  // Skip the citation key ("book:{91346036}, ").
  const firstComma = body.indexOf(",");
  const fields = firstComma >= 0 ? body.slice(firstComma + 1) : "";

  // Walk `key = {value}` pairs, tracking brace depth so a value containing
  // braces does not terminate early.
  const re = /(\w+)\s*=\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fields)) !== null) {
    const key = m[1]?.toLowerCase();
    if (!key) continue;
    let j = re.lastIndex;
    let d = 1;
    let valueStart = j;
    for (; j < fields.length; j++) {
      if (fields[j] === "{") d += 1;
      else if (fields[j] === "}") {
        d -= 1;
        if (d === 0) break;
      }
    }
    out[key] = fields.slice(valueStart, j).replace(/\s+/g, " ").trim();
    re.lastIndex = j + 1;
  }
  return out;
}

/**
 * Reject "download links" that cannot lead to the file.
 *
 * Providers scrape anchors, and some anchors are not downloads. The clearest
 * case observed in the wild: Libgen's ads.php page links to the bare Anna's
 * Archive homepage, so get_download_links returned
 * `{"label":"mirror: Anna's Archive","url":"http://annas-archive.org/"}` as one
 * of two results. An agent that follows it finds nothing and cannot tell why.
 *
 * Rules: the URL must have a path beyond the domain root, and — for anything
 * that is not an IPFS gateway link — it must actually reference the md5.
 *
 * Kept in this module rather than in providers/index.ts because libgen.ts needs
 * it too, and it cannot import from index.ts (index.ts imports libgen.ts).
 */
export function isUsefulLink(url: string, md5: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  if (path === "") return false; // bare domain root
  if (/^\/ipfs\//.test(path)) return true; // gateway link, md5 is not expected
  return url.toLowerCase().includes(md5.toLowerCase());
}
