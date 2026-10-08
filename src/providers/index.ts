// Aggregation layer.
//
// Fans a query out to every book provider concurrently, merges the results, and
// dedups by md5 (the universal key) while keeping the richest record. Per-source
// failures are collected, not thrown, so one dead mirror never blanks the search.

import * as annas from "./annas.js";
import * as libgen from "./libgen.js";
import * as scihub from "./scihub.js";
import * as zlibrary from "./zlibrary.js";
import { ANNAS_MIRRORS, IPFS_GATEWAYS } from "../mirrors.js";
import { areMirrorsCoolingDown } from "../http.js";
import { isUsefulLink } from "../parse.js";
import {
  isSourceCircuitOpen,
  sourceCircuitMessage,
  summarizeSourceFailure,
  withSourceCircuit,
} from "./circuit.js";
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
  const active = [...new Set(sources)].filter((s) => Object.hasOwn(bookSearchers, s));
  if (active.length === 0) {
    throw new Error("At least one book source must be selected.");
  }

  const settled = await Promise.allSettled(
    active.map((s) => withSourceCircuit(s, () => bookSearchers[s]!(query, limit)))
  );

  const errors: SourceError[] = [];
  const byMd5 = new Map<string, Book>();
  const noMd5: Book[] = [];

  settled.forEach((r, i) => {
    const source = active[i]!;
    if (r.status === "rejected") {
      errors.push({ source, error: summarizeSourceFailure(source, r.reason) });
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

/** Which source first produced usable details. */
export type BookDetailsResult = (Book & { downloadLinks: DownloadLink[] }) & {
  /** Provider that returned the first usable metadata result. */
  resolvedVia?: "annas" | "libgen";
  /** Anna's failure reason, when it is known by the time Libgen wins. */
  annasUnavailable?: string;
  /** Present when the Libgen fallback also failed to produce metadata. */
  libgenUnavailable?: string;
};

/**
 * Full metadata + download links for one md5.
 *
 * Anna's Archive and Library Genesis are queried in parallel; the first one
 * with usable metadata wins. Anna's HTML pages often answer HTTP 403 to
 * non-browser clients (the DDoS-Guard challenge), so serially waiting for it
 * made book_details slow before the reliable Libgen BibTeX fallback ran.
 *
 * The response always says which source answered, so a caller is never left
 * wondering why the shape of the data changed.
 */
export async function bookDetails(md5: string): Promise<BookDetailsResult> {
  const hash = md5.toLowerCase();
  let annasReason: string | undefined;
  let libgenReason: string | undefined;

  // Both sources are started together. Promise.any returns the first source
  // that produced usable metadata instead of making Libgen wait through all of
  // Anna's DDoS-Guard mirror failures first.
  const annasCandidate = withSourceCircuit("annas", async () => {
    const book = await annas.details(hash);
    if (!book.title.trim()) throw new Error("Anna's Archive answered with no usable title");
    return { source: "annas" as const, book };
  }).catch((error: unknown) => {
    annasReason = summarizeSourceFailure("annas", error);
    throw error;
  });

  const libgenCandidate = withSourceCircuit("libgen", async () => {
    const book = await libgen.details(hash);
    if (!book.title.trim()) throw new Error("Libgen answered with no usable title");
    return { source: "libgen" as const, book };
  }).catch((error: unknown) => {
    libgenReason = summarizeSourceFailure("libgen", error);
    throw error;
  });

  try {
    const winner = await Promise.any([annasCandidate, libgenCandidate]);
    return {
      ...winner.book,
      resolvedVia: winner.source,
      ...(winner.source === "libgen" && annasReason
        ? { annasUnavailable: annasReason }
        : {}),
    };
  } catch {
    // Neither source produced usable metadata. Report both concise failures
    // instead of throwing or returning a plausible-looking empty record.
    return {
      source: "libgen",
      md5: hash,
      title: "",
      downloadLinks: [],
      resolvedVia: "libgen",
      annasUnavailable:
        annasReason ?? sourceCircuitMessage("annas") ?? "unavailable — no usable metadata",
      libgenUnavailable:
        libgenReason ?? sourceCircuitMessage("libgen") ?? "unavailable — no usable metadata",
    };
  }
}

/** Resolve every download candidate we can find for an md5. */
export async function resolveDownloads(md5: string): Promise<DownloadLink[]> {
  const links: DownloadLink[] = [];
  const shouldFetchAnnasDetails =
    !isSourceCircuitOpen("annas") && !areMirrorsCoolingDown("annas", ANNAS_MIRRORS);
  const annasDetails = shouldFetchAnnasDetails
    ? withSourceCircuit("annas", () => annas.details(md5))
    : Promise.resolve(undefined);

  const [fastRes, libgenRes, annasRes] = await Promise.allSettled([
    // The JSON member endpoint does not use the HTML mirrors' negative cache;
    // keep it available even while scraped Anna's pages are circuit-broken.
    annas.fastDownload(md5),
    withSourceCircuit("libgen", () => libgen.downloadLinks(md5)),
    annasDetails,
  ]);

  // Member fast-download goes first when available: it is a direct file URL and
  // the only path that survives the DDoS-Guard challenge on the HTML mirrors.
  // Resolves to null when no API key is configured, so unsubscribed setups are
  // unaffected.
  if (fastRes.status === "fulfilled" && fastRes.value) links.push(fastRes.value);
  if (libgenRes.status === "fulfilled") links.push(...libgenRes.value);
  if (annasRes.status === "fulfilled" && annasRes.value)
    links.push(...annasRes.value.downloadLinks);

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
  const useful = links.filter((l) => l.verified === true || isUsefulLink(l.url, hash));
  return useful;
}

// isUsefulLink lives in ../parse.js, not here: libgen.ts needs it too, and
// libgen.ts cannot import from this module (this module imports libgen).
export { isUsefulLink } from "../parse.js";

export { annas, libgen, scihub, zlibrary };
export { DISABLED_BOOK_SOURCES as DEFAULT_DISABLED_SOURCES };
export type { Book, Paper, DownloadLink, SearchResult, SourceId };
