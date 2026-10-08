// Resilient HTTP layer with mirror rotation.
//
// Shadow libraries move between domains constantly and any given mirror may be
// blocked from a given network. Every provider therefore declares a LIST of
// candidate mirrors; we try them, remember what worked, and skip what did not.
//
// Two properties matter here, because both used to cost real time on every
// single request:
//
//   1. NEGATIVE CACHE. A mirror that just failed is marked dead for a TTL and
//      is not tried again inside that window. Without this, every request paid
//      the full timeout for every dead host — measured at ~14 s for a search
//      against the 2026-10-07 mirror list, where 4 of 6 Libgen hosts were down.
//      The cache is half-open: if *every* candidate is dead we retry all of
//      them, so a network blip can never lock a source out permanently.
//
//   2. STAGGERED CONCURRENCY. Candidates are started concurrently but with a
//      small head start for the earlier ones, so declared preference order
//      still means something while the worst case is bounded by the first
//      mirror that actually answers instead of the sum of all of them.
//
// Timeouts are split by kind of request. Scraping an HTML index and pulling a
// 5 MB ebook have nothing in common, and sharing one 20 s budget made the first
// far too patient and the second far too strict (a book larger than a few MB
// could not finish at all).

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent": USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Budget for scraping an HTML page (search results, ads.php, md5 detail). */
export const TIMEOUT_MS = envNum("BIBLIO_TIMEOUT_MS", 8000);

/** Budget for pulling an actual file. Books are megabytes, not kilobytes. */
export const DOWNLOAD_TIMEOUT_MS = envNum("BIBLIO_DOWNLOAD_TIMEOUT_MS", 600_000);

/** How long a failed mirror is skipped before being given another chance. */
const DEAD_TTL_MS = envNum("BIBLIO_MIRROR_DEAD_TTL_MS", 300_000);

/** Head start between concurrent mirror attempts. 0 disables staggering and
 *  makes the race fully simultaneous (fastest, least polite to the mirrors). */
const STAGGER_MS = envNum("BIBLIO_MIRROR_STAGGER_MS", 120);

/** Abort a download if no bytes arrive for this long. Guards against a mirror
 *  that accepts the connection and then stalls forever. */
const DOWNLOAD_STALL_MS = envNum("BIBLIO_DOWNLOAD_STALL_MS", 30_000);

/** Remembers, per mirror-group, which host last succeeded. */
const preferredMirror = new Map<string, string>();

/** Remembers, per mirror-group + host, when a failure stops being held against
 *  it. Keyed as `${group}\u0000${base}`. */
const deadUntil = new Map<string, number>();

const deadKey = (group: string, base: string) => `${group}\u0000${base}`;

function noteDead(groupKey: string, base: string): void {
  deadUntil.set(deadKey(groupKey, base), Date.now() + DEAD_TTL_MS);
}

function noteAlive(groupKey: string, base: string): void {
  deadUntil.delete(deadKey(groupKey, base));
  preferredMirror.set(groupKey, base);
}

function isDead(groupKey: string, base: string): boolean {
  const until = deadUntil.get(deadKey(groupKey, base));
  if (until === undefined) return false;
  if (until <= Date.now()) {
    deadUntil.delete(deadKey(groupKey, base));
    return false;
  }
  return true;
}

/** Drop the whole dead cache. Used by --selfcheck, which deliberately probes
 *  every host regardless of recent history. */
export function resetMirrorCache(): void {
  deadUntil.clear();
  preferredMirror.clear();
}

/** Test-only / diagnostic view of the negative cache. */
export function mirrorCacheSnapshot(): { dead: string[]; preferred: Record<string, string> } {
  const now = Date.now();
  const dead: string[] = [];
  for (const [k, until] of deadUntil) {
    const base = k.split("\u0000")[1];
    if (until > now && base) dead.push(base);
  }
  return { dead: [...new Set(dead)], preferred: Object.fromEntries(preferredMirror) };
}

/**
 * Build the attempt order for a request.
 *
 * Preferred (last-known-good) host first, then the declared preference order
 * minus anything currently marked dead. If that leaves nothing — every host is
 * in its cooldown — we fall back to the full list so the circuit breaker can
 * close again instead of failing the request outright.
 */
function orderMirrors(groupKey: string, mirrors: string[]): string[] {
  const preferred = preferredMirror.get(groupKey);
  const ordered =
    preferred && mirrors.includes(preferred)
      ? [preferred, ...mirrors.filter((m) => m !== preferred)]
      : [...mirrors];

  const alive = ordered.filter((m) => !isDead(groupKey, m));
  return alive.length > 0 ? alive : ordered;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchWithTimeout<T>(
  url: string,
  init: RequestInit,
  consume: (response: Response) => Promise<T>,
  externalSignal?: AbortSignal,
  timeoutMs = TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    const response = await fetch(url, {
      ...init,
      redirect: "follow",
      signal: controller.signal,
      headers: { ...DEFAULT_HEADERS, ...(init.headers as object) },
    });
    // Keep the timeout and external-abort listener alive until the body has
    // been consumed; otherwise a fast 200 header can leave a stalled HTML body
    // hanging a tool call indefinitely.
    return await consume(response);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

export interface MirrorFetchResult {
  html: string;
  /** The base mirror that served the request (e.g. "https://libgen.li"). */
  base: string;
  finalUrl: string;
  /** Mirrors that were skipped or failed, with reasons. Surfaces in tool
   *  output so a degraded source is visible instead of silently absent. */
  attempts: string[];
}

/**
 * Decide whether a 2xx response really came from the site we asked for.
 *
 * A status code is not evidence of identity, and shadow-library domains get
 * abandoned and re-registered: `annas-archive.li` answers HTTP 200 in ~0.15 s
 * — faster than any genuine mirror — but serves a ~27 kB advertising page. A
 * liveness check that trusts the status code ranks such a host first, and the
 * provider then parses the ad page as catalogue data, returning zero results
 * with no error at all. Providers pass a validator so that a host which answers
 * but is not the expected site is rejected and cooled down like any other
 * failure.
 */
export type MirrorValidator = (html: string, base: string) => boolean | string;

/**
 * Fetch an HTML page, racing the group's mirrors until one returns 2xx.
 *
 * @param groupKey  Stable key naming the mirror set (used for stickiness and
 *                  for the negative cache).
 * @param mirrors   Ordered list of base URLs (no trailing slash).
 * @param buildPath Given a base, return the full URL to fetch.
 * @param init      Optional fetch init.
 * @param validate  Optional identity check applied to the response body. Return
 *                  `false` (or a reason string) to reject the mirror.
 */
export async function fetchFromMirrors(
  groupKey: string,
  mirrors: string[],
  buildPath: (base: string) => string,
  init?: RequestInit,
  validate?: MirrorValidator
): Promise<MirrorFetchResult> {
  const ordered = orderMirrors(groupKey, mirrors);
  if (ordered.length === 0) {
    const envName = `BIBLIO_${groupKey.toUpperCase()}_MIRRORS`;
    throw new Error(
      `No ${groupKey} mirrors configured; set ${envName} to one or more base URLs.`
    );
  }
  const attempts: string[] = [];

  return await new Promise<MirrorFetchResult>((resolve, reject) => {
    let remaining = ordered.length;
    let settled = false;
    const controllers: AbortController[] = [];

    const cancelOthers = (except: AbortController) => {
      for (const c of controllers) if (c !== except && !c.signal.aborted) c.abort();
    };

    ordered.forEach((base, index) => {
      const controller = new AbortController();
      controllers.push(controller);

      const run = async (): Promise<MirrorFetchResult> => {
        // Stagger so declared order still decides who wins a close race.
        await sleep(index * STAGGER_MS, controller.signal);
        const url = buildPath(base);
        return fetchWithTimeout(
          url,
          init ?? {},
          async (res) => {
            if (!res.ok) {
              await res.body?.cancel().catch(() => {});
              throw new Error(`${base} -> HTTP ${res.status}`);
            }
            // Read the body BEFORE winning the race: aborting the losers must
            // not tear down the response we are about to return.
            const html = await res.text();
            if (validate) {
              const verdict = validate(html, base);
              if (verdict !== true) {
                const why =
                  typeof verdict === "string" ? verdict : "response is not the expected site";
                throw new Error(`${base} -> ${why}`);
              }
            }
            return { html, base, finalUrl: res.url || url, attempts };
          },
          controller.signal
        );
      };

      run().then(
        (result) => {
          if (settled) return;
          settled = true;
          noteAlive(groupKey, base);
          cancelOthers(controller);
          resolve(result);
        },
        (err: unknown) => {
          const message = String((err as Error)?.message ?? err);
          // Our own cancellation is not evidence about the mirror.
          if (!controller.signal.aborted) {
            noteDead(groupKey, base);
            attempts.push(message);
          }
          if (--remaining === 0 && !settled) {
            settled = true;
            reject(
              new Error(
                `All ${mirrors.length} ${groupKey} mirror(s) failed: ` +
                  `${(attempts.length ? attempts : ["cancelled"]).join("; ")}`
              )
            );
          }
        }
      );
    });
  });
}

/** Single-URL GET returning text, with timeout. Throws on non-2xx. */
export async function getText(url: string, init?: RequestInit): Promise<string> {
  return fetchWithTimeout(url, init ?? {}, async (res) => {
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return res.text();
  });
}

/** Fetch binary content fully into memory.
 *
 * Prefer {@link downloadToFile} for user-visible downloads: it streams, so peak
 * memory does not scale with file size, and it verifies the hash. This helper
 * remains for small payloads where buffering is simpler. */
export async function getBuffer(
  url: string,
  init?: RequestInit
): Promise<{ buffer: Buffer; contentType: string | null }> {
  return fetchWithTimeout(url, init ?? {}, async (res) => {
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    const arrayBuf = await res.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuf),
      contentType: res.headers.get("content-type"),
    };
  });
}

/** Thrown when a "direct" download URL serves an HTML page instead of a file.
 *
 * Libgen's get.php does this when the one-time `key` in the URL has expired or
 * was minted by a different mirror host. Callers should move on to the next
 * candidate link rather than save the page as if it were the book. */
export class HtmlInsteadOfFileError extends Error {
  readonly status: number;
  readonly contentType: string | null;
  readonly bytes: number;
  readonly snippet: string;

  constructor(opts: {
    url: string;
    status: number;
    contentType: string | null;
    bytes: number;
    snippet: string;
  }) {
    super(
      `${opts.url} returned an HTML page (${opts.bytes} bytes, ` +
        `content-type ${opts.contentType ?? "unknown"}), not a file`
    );
    this.name = "HtmlInsteadOfFileError";
    this.status = opts.status;
    this.contentType = opts.contentType;
    this.bytes = opts.bytes;
    this.snippet = opts.snippet;
  }
}

export interface DownloadProgress {
  bytes: number;
  /** Total size when the server advertised one, else undefined. */
  total?: number;
}

export interface DownloadToFileResult {
  /** Final path on disk. */
  path: string;
  bytes: number;
  contentType: string | null;
  /** Hex MD5 of the bytes actually written — compare against the catalog md5. */
  md5: string;
}

/**
 * Stream a URL straight to disk and hash it on the way through.
 *
 * Writes to `<dest>.part` and renames on success, so a partial download never
 * leaves a file that looks complete. Three failure modes are handled
 * explicitly, because all three were observed in the wild:
 *   - non-2xx status;
 *   - an HTML interstitial served where a file was promised;
 *   - a connection that opens and then stops sending bytes.
 */
export async function downloadToFile(
  url: string,
  destPath: string,
  opts: {
    signal?: AbortSignal;
    onProgress?: (p: DownloadProgress) => void;
    /** Overrides DOWNLOAD_TIMEOUT_MS for the initial request. */
    timeoutMs?: number;
  } = {}
): Promise<DownloadToFileResult> {
  const controller = new AbortController();
  const budget = opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const requestTimer = setTimeout(() => controller.abort(), budget);
  const onExternalAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onExternalAbort, { once: true });

  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: DEFAULT_HEADERS,
    });
  } finally {
    clearTimeout(requestTimer);
  }

  const contentType = res.headers.get("content-type");

  try {
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }

    // An HTML answer here means the link was an interstitial, not a file.
    if (contentType?.includes("text/html")) {
      const bodyTimer = setTimeout(() => controller.abort(), budget);
      try {
        const text = await res.text();
        throw new HtmlInsteadOfFileError({
          url,
          status: res.status,
          contentType,
          bytes: Buffer.byteLength(text),
          snippet: text.replace(/\s+/g, " ").trim().slice(0, 160),
        });
      } finally {
        clearTimeout(bodyTimer);
      }
    }

    if (!res.body) throw new Error(`Empty response body from ${url}`);

    const totalHeader = Number(res.headers.get("content-length"));
    const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : undefined;

    const hash = createHash("md5");
    let bytes = 0;
    // Stall watchdog: the request timer above only covers the headers, so a
    // mirror that dribbles nothing after connecting needs its own deadline.
    let stallTimer = setTimeout(() => controller.abort(), DOWNLOAD_STALL_MS);
    const touch = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => controller.abort(), DOWNLOAD_STALL_MS);
    };

    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        hash.update(chunk);
        touch();
        opts.onProgress?.({ bytes, total });
        cb(null, chunk);
      },
    });

    const partPath = `${destPath}.part`;
    try {
      await pipeline(
        Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
        counter,
        createWriteStream(partPath)
      );
      await rename(partPath, destPath);
    } catch (err) {
      await unlink(partPath).catch(() => {});
      throw controller.signal.aborted && !(opts.signal?.aborted ?? false)
        ? new Error(`download stalled or timed out after ${bytes} bytes: ${url}`)
        : err;
    } finally {
      clearTimeout(stallTimer);
    }

    return { path: destPath, bytes, contentType, md5: hash.digest("hex") };
  } finally {
    opts.signal?.removeEventListener("abort", onExternalAbort);
  }
}

export interface MirrorProbe {
  base: string;
  /** True only when the host answered 2xx AND passed the identity check. */
  ok: boolean;
  status?: number;
  ms: number;
  error?: string;
  /** Set when the host answered but did not look like the expected site. */
  impostor?: boolean;
}

/**
 * Probe a single mirror base for liveness AND identity. Used by --selfcheck.
 *
 * `expect` matters as much as the status code: a parked or hijacked domain
 * answers 200 and would otherwise be reported as the healthiest mirror in its
 * group. Those hosts get `impostor: true` so the health check says what is
 * actually going on instead of recommending a domain that is no longer the site.
 */
export async function probeMirror(
  base: string,
  probePath = "/",
  opts: { timeoutMs?: number; expect?: RegExp } = {}
): Promise<MirrorProbe> {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${probePath}`, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: DEFAULT_HEADERS,
    });
    if (!res.ok) {
      return { base, ok: false, status: res.status, ms: Date.now() - started };
    }
    if (opts.expect) {
      const body = await res.text();
      if (!opts.expect.test(body)) {
        return {
          base,
          ok: false,
          impostor: true,
          status: res.status,
          ms: Date.now() - started,
          error: "answered, but the page is not the expected site",
        };
      }
    }
    return { base, ok: true, status: res.status, ms: Date.now() - started };
  } catch (err) {
    return {
      base,
      ok: false,
      ms: Date.now() - started,
      error: String((err as Error)?.message ?? err),
    };
  } finally {
    clearTimeout(timer);
  }
}
