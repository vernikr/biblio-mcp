// Aggregation layer.
//
// Fans a query out to every book provider concurrently, merges the results, and
// dedups by md5 (the universal key) while keeping the richest record. Per-source
// failures are collected, not thrown, so one dead mirror never blanks the search.

import * as annas from "./annas.js";
import * as libgen from "./libgen.js";
import * as scihub from "./scihub.js";
import * as zlibrary from "./zlibrary.js";
import { IPFS_GATEWAYS } from "../mirrors.js";
import { isUsefulLink } from "../parse.js";
import type {
  Book,
  DownloadLink,
  Paper,
  SearchResult,
  SourceId,
  SourceError,
} from "../types.js";

/** Every book source this server knows how to query. */
export const ALL_BOOK_SOURCES: SourceId[] = ["annas", "libgen", "zlibrary"];

/** Sources that are off unless explicitly requested.
 *
 * Z-Library ships in this list because of the 2026-10-07 mirror audit: every
 * public Z-Library domain was unreachable or redirecting away from search, so
 * including it by default meant every search paid for four failed mirrors and
 * then reported an error the caller could do nothing about. Excluding it by
 * default is not a removal — an explicit `sources: ["zlibrary"]` still queries
 * it, which is what you want when BIBLIO_ZLIB_MIRRORS points at a working
 * personal domain.
 *
 * Override the whole list with BIBLIO_DISABLE_SOURCES (comma-separated; set it
 * to an empty string to disable nothing and restore upstream behaviour). */
function resolveDisabledSources(): SourceId[] {
  const raw = process.env.BIBLIO_DISABLE_SOURCES;
  const list = (raw === undefined ? "zlibrary" : raw)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.filter((s): s is SourceId =>
    (ALL_BOOK_SOURCES as string[]).includes(s)
  );
}

export const DISABLED_BOOK_SOURCES: SourceId[] = resolveDisabledSources();

/** Sources searched when the caller does not specify any. */
export const BOOK_SOURCES: SourceId[] = ALL_BOOK_SOURCES.filter(
  (s) => !DISABLED_BOOK_SOURCES.includes(s)
);

const bookSearchers: Record<
  string,
  (q: string, limit: number) => Promise<Book[]>
> = {
  annas: annas.search,
  libgen: libgen.search,
  zlibrary: zlibrary.search,
};

/** Merge two records for the same md5, preferring non-empty fields. */
function mergeBook(a: Book, b: Book): Book {
  const pick = <K extends keyof Book>(k: K) => a[k] || b[k];
  return {
    ...a,
    title: a.title.length >= b.title.length ? a.title : b.title,
    author: pick("author"),
    publisher: pick("publisher"),
    year: pick("year"),
    language: pick("language"),
    format: pick("format"),
    size: pick("size"),
    pages: pick("pages"),
    isbn: pick("isbn"),
    coverUrl: pick("coverUrl"),
    url: pick("url"),
    mirrors: [...(a.mirrors ?? []), ...(b.mirrors ?? [])],
  };
}

export async function searchBooks(
  query: string,
  sources: SourceId[],
  limit: number
): Promise<SearchResult<Book>> {
  const active = sources.filter((s) => s in bookSearchers);
  const settled = await Promise.allSettled(
    active.map((s) => bookSearchers[s]!(query, limit))
  );

  const errors: SourceError[] = [];
  const byMd5 = new Map<string, Book>();
  const noMd5: Book[] = [];

  settled.forEach((r, i) => {
    const source = active[i]!;
    if (r.status === "rejected") {
      errors.push({ source, error: String(r.reason?.message ?? r.reason) });
      return;
    }
    for (const book of r.value) {
      if (book.md5) {
        const existing = byMd5.get(book.md5);
        byMd5.set(book.md5, existing ? mergeBook(existing, book) : book);
      } else {
        noMd5.push(book);
      }
    }
  });

  return {
    query,
    results: [...byMd5.values(), ...noMd5],
    errors,
  };
}

/** Which source actually answered a details lookup. */
export type BookDetailsResult = (Book & { downloadLinks: DownloadLink[] }) & {
  /** Present when the preferred source failed and a fallback answered. */
  resolvedVia?: "annas" | "libgen";
  /** Why the preferred source was not used, when applicable. */
  annasUnavailable?: string;
  /** Present when the Libgen fallback also failed to produce metadata. */
  libgenUnavailable?: string;
};

/**
 * Full metadata + download links for one md5.
 *
 * Anna's Archive is tried first because it aggregates the most sources, but its
 * HTML pages answer HTTP 403 to non-browser clients (the DDoS-Guard challenge),
 * so relying on it alone made book_details return an empty title and no links.
 * Library Genesis is the fallback, and it is the better source anyway: its
 * ads.php page embeds a BibTeX block with exact title/author/publisher/ISBN/
 * year/series, which needs no guessing.
 *
 * The response always says which source answered, so a caller is never left
 * wondering why the shape of the data changed.
 */
export async function bookDetails(md5: string): Promise<BookDetailsResult> {
  const hash = md5.toLowerCase();

  let annasReason = "answered with no title";
  try {
    const fromAnnas = await annas.details(hash);
    // Anna's can also "succeed" with an empty shell when a mirror answers 200
    // but serves something that is not a book page. Treat that as unavailable
    // rather than returning blank metadata.
    if (fromAnnas.title && fromAnnas.title.trim()) {
      return { ...fromAnnas, resolvedVia: "annas" };
    }
  } catch (e) {
    annasReason = String((e as Error)?.message ?? e).slice(0, 200);
  }

  let libgenReason: string | undefined;
  let fromLibgen: (Book & { downloadLinks: DownloadLink[] }) | undefined;
  try {
    fromLibgen = await libgen.details(hash);
  } catch (e) {
    libgenReason = String((e as Error)?.message ?? e).slice(0, 200);
  }

  if (fromLibgen) {
    return {
      ...fromLibgen,
      resolvedVia: "libgen",
      annasUnavailable: annasReason,
    };
  }

  // Neither source produced usable metadata. Report both failures instead of
  // throwing, so the caller learns what was tried and why it did not work.
  return {
    source: "libgen",
    md5: hash,
    title: "",
    downloadLinks: [],
    resolvedVia: "libgen",
    annasUnavailable: annasReason,
    libgenUnavailable: libgenReason,
  };
}

/** Resolve every download candidate we can find for an md5. */
export async function resolveDownloads(md5: string): Promise<DownloadLink[]> {
  const links: DownloadLink[] = [];

  const [fastRes, libgenRes, annasRes] = await Promise.allSettled([
    annas.fastDownload(md5),
    libgen.downloadLinks(md5),
    annas.details(md5),
  ]);

  // Member fast-download goes first when available: it is a direct file URL and
  // the only path that survives the DDoS-Guard challenge on the HTML mirrors.
  // Resolves to null when no API key is configured, so unsubscribed setups are
  // unaffected.
  if (fastRes.status === "fulfilled" && fastRes.value) links.push(fastRes.value);
  if (libgenRes.status === "fulfilled") links.push(...libgenRes.value);
  if (annasRes.status === "fulfilled") links.push(...annasRes.value.downloadLinks);

  // Surface an IPFS CID as gateway links if one appears among Anna's links.
  const cid = links
    .map((l) => l.url.match(/\/ipfs\/([A-Za-z0-9]+)/)?.[1])
    .find(Boolean);
  if (cid) {
    for (const gw of IPFS_GATEWAYS) {
      const url = `${gw}/${cid}`;
      if (!links.some((l) => l.url === url))
        links.push({ source: "ipfs", label: "IPFS gateway", url, direct: true });
    }
  }

  const hash = md5.toLowerCase();
  const useful = links.filter((l) => isUsefulLink(l.url, hash));
  return useful;
}

// isUsefulLink lives in ../parse.js, not here: libgen.ts needs it too, and
// libgen.ts cannot import from this module (this module imports libgen).
export { isUsefulLink } from "../parse.js";

export { annas, libgen, scihub, zlibrary };
export { DISABLED_BOOK_SOURCES as DEFAULT_DISABLED_SOURCES };
export type { Book, Paper, DownloadLink, SearchResult, SourceId };
