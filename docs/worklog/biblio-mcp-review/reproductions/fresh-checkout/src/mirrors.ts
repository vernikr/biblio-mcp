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

/** Identity marker: a host is Anna's Archive only if its pages say so. */
export const ANNAS_IDENTITY = /Anna[’']s Archive/i;

/** Anna's Archive. */
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

/** Public Z-Library mirrors; none worked in the 2026-10-07 probe. */
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

/** Every mirror group the selfcheck probe walks. */
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
    expect: ANNAS_IDENTITY,
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
