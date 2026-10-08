// Aggregation layer.

import * as annas from "./annas.js";
import * as libgen from "./libgen.js";
import * as scihub from "./scihub.js";
import * as zlibrary from "./zlibrary.js";
import { ANNAS_MIRRORS, IPFS_GATEWAYS } from "../mirrors.js";
import { AsyncTtlCache, PROVIDER_CACHE_TTL_MS } from "../cache.js";
import { areMirrorsCoolingDown } from "../http.js";
import { isUsefulLink } from "../parse.js";
import {
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

/** Sources that are off unless explicitly requested. */
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

type BookSearchOutcome = { ok: true; books: Book[] } | { ok: false; error: string };

// Cache both successful results and concise provider failures for the short
// agent loop; do not retry the same dead source/query on every adjacent call.
const bookSearchCache = new AsyncTtlCache<string, BookSearchOutcome>(PROVIDER_CACHE_TTL_MS, 128);

function searchSource(source: SourceId, query: string, limit: number): Promise<BookSearchOutcome> {
  const key = JSON.stringify([source, query, limit]);
  return bookSearchCache.getOrLoad(key, async () => {
    try {
      const books = await withSourceCircuit(source, () => bookSearchers[source]!(query, limit));
      return { ok: true, books };
    } catch (error) {
      return { ok: false, error: summarizeSourceFailure(source, error) };
    }
  });
}

function annasHtmlSkipReason(): string | undefined {
  const circuit = sourceCircuitMessage("annas");
  if (circuit) return circuit;
  if (ANNAS_MIRRORS.length === 0) {
    return "unavailable — no Anna's Archive mirrors configured; set BIBLIO_ANNAS_MIRRORS";
  }
  if (areMirrorsCoolingDown("annas", ANNAS_MIRRORS)) {
    return "unavailable — all Anna's Archive mirrors are cooling down; retry after the cooldown";
  }
  return undefined;
}

function shouldQueryAnnasHtml(): boolean {
  return annasHtmlSkipReason() === undefined;
}

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

  const sourceResults = await Promise.all(active.map((source) => searchSource(source, query, limit)));

  const errors: SourceError[] = [];
  const byMd5 = new Map<string, Book>();
  const noMd5: Book[] = [];

  sourceResults.forEach((result, i) => {
    const source = active[i]!;
    if (!result.ok) {
      errors.push({ source, error: result.error });
      return;
    }
    for (const book of result.books) {
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

/** Full metadata + download links for one md5. */
export async function bookDetails(md5: string): Promise<BookDetailsResult> {
  const hash = md5.toLowerCase();
  let annasReason: string | undefined;
  let libgenReason: string | undefined;

  // Both sources are started together when Anna's mirrors are available.
  const skippedAnnasReason = annasHtmlSkipReason();
  const canQueryAnnas = skippedAnnasReason === undefined;
  // Anna's detail pages are not cached, so a losing Anna's request can be
  // cancelled. Libgen's ads page is cached and reused by downloads, so it is not.
  const annasAbort = new AbortController();
  const annasCandidate = canQueryAnnas
    ? withSourceCircuit(
        "annas",
        async () => {
          const book = await annas.details(hash, annasAbort.signal);
          if (!book.title.trim()) throw new Error("Anna's Archive answered with no usable title");
          return { source: "annas" as const, book };
        },
        { signal: annasAbort.signal }
      ).catch((error: unknown) => {
        annasReason = summarizeSourceFailure("annas", error);
        throw error;
      })
    : Promise.reject(
        new Error(skippedAnnasReason ?? "unavailable — Anna's Archive request skipped")
      );
  if (skippedAnnasReason) annasReason = skippedAnnasReason;

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
    if (winner.source === "libgen") annasAbort.abort();
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
  const annasDetails = shouldQueryAnnasHtml()
    ? withSourceCircuit("annas", () => annas.details(md5))
    : Promise.resolve(undefined);

  const [fastRes, libgenRes, annasRes] = await Promise.allSettled([
    // The JSON member endpoint does not use the HTML mirrors' negative cache;
    // keep it available even while scraped Anna's pages are circuit-broken.
    annas.fastDownload(md5),
    withSourceCircuit("libgen", () => libgen.downloadLinks(md5)),
    annasDetails,
  ]);

  // Try the verified member endpoint before scraped partner links.
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
