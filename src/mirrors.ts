import { probeMirror, type MirrorProbe } from "./http.js";

// Centralized mirror registry and probe summaries.
function fromEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

/**
 * Anna's Archive.
 *
 * Refreshed 2026-08-28 upstream, re-measured 2026-10-07. The old defaults were
 * stale and mostly dead:
 *   .org — taken offline by the registrar 2026-01-11
 *   .li  — permanently deleted 2026-03-01 under publisher legal pressure
 *   .se  — no longer resolving
 * Anna's Archive tells users to check its Wikipedia article for the current
 * list, since these rotate under takedown pressure. Verify there before editing;
 * do not trust the SEO "current links" blogspam, which is where fake mirrors live.
 *
 * WARNING ABOUT DEAD DOMAINS — measured 2026-10-07. `annas-archive.li` answers
 * HTTP 200 in ~0.15 s, faster than any real mirror, but it is NO LONGER Anna's
 * Archive: it serves a ~27 kB page with no <title> whose body is advertising
 * JavaScript ("rapidresultsearch.com/.../SAFEFRAME.html"). The real mirrors
 * return the same ~174 kB page with the expected title. Because a hijacked
 * domain answers 200, a naive liveness check ranks it FIRST and every provider
 * then silently parses an ad page as if it were catalogue data — `search`
 * returns zero results with no error, and `details` returns an empty title.
 * That is why providers pass a content validator to fetchFromMirrors (see
 * src/providers/annas.ts) instead of trusting the status code alone.
 *
 * Note also that the real mirrors answer HTTP 403 to the scraped HTML pages
 * (/search, /md5/...) from a non-browser client — that is the DDoS-Guard
 * challenge. The member fast-download JSON API is the path that works without a
 * browser; see BIBLIO_ANNAS_API_KEY and annas.fastDownload().
 */
export const ANNAS_MIRRORS = fromEnv("BIBLIO_ANNAS_MIRRORS", [
  "https://annas-archive.gl", // 200, ~1.2 s, real site
  "https://annas-archive.gd", // 200, ~1.1 s, real site
  "https://annas-archive.pk", // 200, ~1.1 s, real site
  // Deliberately absent: annas-archive.li (hijacked, serves an ad page),
  // annas-archive.gs (429 at last audit), annas-archive.org / .se (dead).
]);

/** Library Genesis. Only the `.li` family was reachable at last audit; the
 *  `.is` / `.rs` / `.st` family hung until timeout, and `.gs` failed DNS.
 *  `.bz` was reachable and is NOT in the upstream list — it is added here. */
export const LIBGEN_MIRRORS = fromEnv("BIBLIO_LIBGEN_MIRRORS", [
  "https://libgen.li", // 200, ~0.7 s
  "https://libgen.bz", // 200, ~0.7 s
  "https://libgen.vg", // 200, ~0.9 s
  "https://libgen.is", // unreachable at last audit
  "https://libgen.rs", // unreachable at last audit
  "https://libgen.st", // unreachable at last audit
  "https://libgen.gs", // DNS failure at last audit
]);

/** Sci-Hub. The hosts marked "varies" flip between 200 and 403 between
 *  consecutive measurements, so treat Sci-Hub ordering as a weak preference
 *  rather than a ranking. `.se` has not resolved at any point. */
export const SCIHUB_MIRRORS = fromEnv("BIBLIO_SCIHUB_MIRRORS", [
  "https://sci-hub.ru", // 200, ~0.8 s
  "https://sci-hub.ren", // 200, ~1.2 s
  "https://sci-hub.mksa.top", // 200, ~1.4 s
  "https://sci-hub.st", // 200 or 403, varies
  "https://sci-hub.hkvisa.net", // 200 or 403, varies
  "https://sci-hub.se", // DNS failure at last audit
]);

/** Z-Library. Every public domain in this list was unusable at the 2026-10-07
 *  audit: `.io` and `-global.se` did not resolve or hung, while `.sk` redirected
 *  away from search. Kept for completeness and because a user-supplied personal
 *  domain is the only reliable way in — see BIBLIO_ZLIB_MIRRORS. This source is
 *  therefore DISABLED BY DEFAULT; opt in with `sources: ["zlibrary"]`.
 *
 *  NOTE: this list used to live inside src/providers/zlibrary.ts, which broke
 *  the "one file to rule them all" contract documented at the top of this file.
 *  It now lives here with the others; the env var name is unchanged. */
export const ZLIBRARY_MIRRORS = fromEnv("BIBLIO_ZLIB_MIRRORS", [
  "https://z-library.sk", // redirected away from search at last audit
  "https://1lib.sk", // redirected away from search at last audit
  "https://z-lib.io", // DNS failure at last audit
  "https://zlibrary-global.se", // hung until timeout at last audit
]);

// Public IPFS gateways used as a last-resort download path for records that
// expose an IPFS CID (common on Anna's Archive).
export const IPFS_GATEWAYS = fromEnv("BIBLIO_IPFS_GATEWAYS", [
  "https://ipfs.io/ipfs",
  "https://cloudflare-ipfs.com/ipfs",
  "https://gateway.pinata.cloud/ipfs",
]);

/**
 * Every mirror group the selfcheck probe walks.
 *
 * `expect` is a marker the real site's homepage contains. It exists because a
 * status code is not evidence of identity: annas-archive.li returns 200 and is
 * not Anna's Archive. A host that answers but lacks its marker is reported as
 * "not the expected site" rather than as reachable — otherwise the health check
 * would rank a hijacked domain as the best mirror available.
 */
export interface MirrorGroup {
  group: string;
  mirrors: string[];
  probePath: string;
  expect?: RegExp;
}

export interface MirrorGroupProbe {
  group: string;
  results: MirrorProbe[];
  reachable: number;
  total: number;
  ok: boolean;
  fastestMs: number | null;
  impostors: string[];
}

export const MIRROR_GROUPS: ReadonlyArray<MirrorGroup> = [
  {
    group: "annas",
    mirrors: ANNAS_MIRRORS,
    probePath: "/",
    expect: /Anna[’']s Archive/i,
  },
  {
    group: "libgen",
    mirrors: LIBGEN_MIRRORS,
    probePath: "/",
    expect: /Library Genesis/i,
  },
  {
    group: "scihub",
    mirrors: SCIHUB_MIRRORS,
    probePath: "/",
    expect: /Sci-Hub/i,
  },
  {
    group: "zlibrary",
    mirrors: ZLIBRARY_MIRRORS,
    probePath: "/",
    expect: /Z[- ]Library/i,
  },
];

export async function probeGroup(
  group: MirrorGroup,
  options: { timeoutMs?: number } = {}
): Promise<MirrorGroupProbe> {
  const results = await Promise.all(
    group.mirrors.map((base) =>
      probeMirror(base, group.probePath, { timeoutMs: options.timeoutMs, expect: group.expect })
    )
  );
  const alive = results.filter((result) => result.ok);
  return {
    group: group.group,
    results,
    reachable: alive.length,
    total: group.mirrors.length,
    ok: alive.length > 0,
    fastestMs: alive.length ? Math.min(...alive.map((result) => result.ms)) : null,
    impostors: results.filter((result) => result.impostor).map((result) => result.base),
  };
}

export function toHealthcheckGroup(probe: MirrorGroupProbe) {
  const { results, ...summary } = probe;
  return {
    ...summary,
    mirrors: results.map((result) => ({
      base: result.base,
      ok: result.ok,
      status: result.status,
      ms: result.ms,
      ...(result.impostor ? { impostor: true } : {}),
      ...(result.error ? { error: result.error } : {}),
    })),
  };
}
