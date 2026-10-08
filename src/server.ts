// MCP tool surface.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { access, mkdir, open, rename, unlink } from "node:fs/promises";
import { join, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import {
  downloadToFile,
  HtmlInsteadOfFileError,
  resetDeadCache,
  type DownloadProgress,
} from "./http.js";
import { MIRROR_GROUPS, probeGroup, toHealthcheckGroup } from "./mirrors.js";
import { describeArgsError, describeTool } from "./toolmeta.js";
import { sniffExt } from "./sniff.js";
import { withSourceCircuit } from "./providers/circuit.js";
import {
  searchBooks,
  resolveDownloads,
  bookDetails,
  libgen,
  scihub,
  BOOK_SOURCES,
  ALL_BOOK_SOURCES,
  DISABLED_BOOK_SOURCES,
} from "./providers/index.js";
import type { Paper, SourceId } from "./types.js";

const SERVER_NAME = "biblio-mcp";

/** Read from package.json rather than repeated here. */
const SERVER_VERSION: string = (() => {
  try {
    const pkg = createRequire(import.meta.url)("../package.json") as {
      name?: string;
      version?: string;
    };
    // Reject another project's manifest; an unknown version is safer than a wrong one.
    if (pkg.name !== SERVER_NAME) return "0.0.0-unknown";
    return pkg.version ?? "0.0.0-unknown";
  } catch {
    return "0.0.0-unknown";
  }
})();

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

/** Same body as `json`, flagged so clients see a failed outcome as a failure. */
const jsonError = (data: unknown) => ({ ...json(data), isError: true });

/** Read the first `bytes` of a file. Used to sniff a container format after a
 *  streamed download, when we never held the whole file in memory. */
async function readFileHead(path: string, bytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Build a throttled progress reporter for one tool call. */
export function makeProgressReporter(extra?: {
  _meta?: { progressToken?: string | number };
  sendNotification?: (n: never) => Promise<void>;
}) {
  const token = extra?._meta?.progressToken;
  const send = extra?.sendNotification;
  if (token === undefined || typeof send !== "function") {
    return async (_p: DownloadProgress) => {};
  }
  const MIN_INTERVAL_MS = 250;
  let lastSent = 0;
  return async ({ bytes, total }: DownloadProgress) => {
    const now = Date.now();
    const done = total !== undefined && bytes >= total;
    if (!done && now - lastSent < MIN_INTERVAL_MS) return;
    lastSent = now;
    try {
      await send({
        method: "notifications/progress",
        params: {
          progressToken: token,
          progress: bytes,
          ...(total !== undefined ? { total } : {}),
          message: total
            ? `${(bytes / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`
            : `${(bytes / 1048576).toFixed(1)} MB`,
        },
      } as never);
    } catch {
      // Progress is best-effort; a disconnected client must not reject from
      // this fire-and-forget callback and become an unhandled rejection.
    }
  };
}

/** Replace zod's raw issue dump with a sentence an agent can act on. */
function validationIssuesFrom(error: unknown): unknown[] | undefined {
  if (!error || typeof error !== "object") return undefined;
  const direct = (error as { issues?: unknown }).issues;
  if (Array.isArray(direct)) return direct;

  // The SDK currently includes Zod's serialized issue array in its message.
  // Parse that diagnostic instead of validating the same arguments a second time.
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") return undefined;
  const start = message.indexOf("[");
  if (start < 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(message.slice(start));
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function useReadableValidationErrors(server: McpServer): void {
  // The SDK invokes this private method dynamically, so an instance override is enough.
  type ValidatingServer = {
    validateToolInput: (tool: unknown, args: unknown, toolName: string) => Promise<unknown>;
  };
  const target = server as unknown as Partial<ValidatingServer>;
  // Skip the override when this SDK version does not expose the method.
  if (typeof target.validateToolInput !== "function") return;
  const original = target.validateToolInput.bind(server);

  target.validateToolInput = async (tool, args, toolName) => {
    try {
      // Let the SDK perform its one authoritative parse, then translate its
      // structured issue array into the agent-facing sentence.
      return await original(tool, args, toolName);
    } catch (error) {
      const issues = validationIssuesFrom(error);
      if (!issues) throw error;
      const inputSchema =
        tool && typeof tool === "object" ? (tool as { inputSchema?: unknown }).inputSchema : undefined;
      throw new Error(describeArgsError(String(toolName), { issues }, inputSchema));
    }
  };
}

/** A caller-supplied filename is one plain name: no separators, drive
 *  prefixes, NUL bytes, or the `.`/`..` entries that climb out of the directory. */
function plainFileName(name: string): string {
  const trimmed = name.trim();
  if (
    trimmed === "" ||
    trimmed === "." ||
    trimmed === ".." ||
    /[\\/:\0]/.test(trimmed)
  ) {
    throw new Error(
      `filename must be a plain file name, not a path (got "${name}"). ` +
        "Use output_dir for the directory."
    );
  }
  return trimmed;
}

const MAX_SEARCH_PDF_RESOLUTIONS = 3;

/** Best-effort, bounded Sci-Hub enrichment; search results must survive mirror failures. */
async function resolvePaperPdfs(papers: Paper[]): Promise<Paper[]> {
  const pdfUrls = new Map<Paper, string>();
  let attempts = 0;

  for (const paper of papers) {
    const doi = paper.doi;
    if (!doi || attempts >= MAX_SEARCH_PDF_RESOLUTIONS) continue;
    attempts += 1;
    try {
      const resolved = await withSourceCircuit("scihub", () => scihub.resolve(doi));
      if (resolved.pdfUrl) pdfUrls.set(paper, resolved.pdfUrl);
    } catch {
      // Optional PDF resolution never turns a successful Libgen search into an error.
    }
  }

  return papers.map((paper) => {
    const pdfUrl = pdfUrls.get(paper);
    return pdfUrl ? { ...paper, pdfUrl } : paper;
  });
}

export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  useReadableValidationErrors(server);

  // -------------------------------------------------------------------------
  // search_books — the headline tool
  // -------------------------------------------------------------------------
  server.tool(
    "search_books",
    describeTool(
      "search_books",
      "Search for books/documents across Anna's Archive, Library Genesis, and " +
        "Z-Library at once. Results are merged and de-duplicated by MD5 hash. Each " +
        "result includes an `md5` you can pass to get_download_links or " +
        "download_book. Per-source failures are reported in `errors` without " +
        "failing the call.",
    ),
    {
      query: z.string().describe("Title, author, ISBN, or topic to search for."),
      sources: z
        .array(z.enum(["annas", "libgen", "zlibrary"]))
        .min(1, "select at least one source")
        .optional()
        .describe(
          `Which sources to search; pass at least one. Duplicate names are ignored. Default: ${BOOK_SOURCES.join(", ")}.` +
            (DISABLED_BOOK_SOURCES.length
              ? ` (${DISABLED_BOOK_SOURCES.join(", ")} excluded by default — pass it` +
                ` explicitly to include; see BIBLIO_DISABLE_SOURCES.)`
              : "")
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Max results per source (default 20)."),
    },
    async ({ query, sources, limit }) => {
      const selectedSources = [...new Set((sources as SourceId[]) ?? BOOK_SOURCES)];
      const result = await searchBooks(query, selectedSources, limit ?? 20);
      return json({
        ...result,
        total: result.results.length,
        sourcesSearched: selectedSources,
      });
    }
  );

  // -------------------------------------------------------------------------
  // book_details — full metadata + download options for one record
  // -------------------------------------------------------------------------
  server.tool(
    "book_details",
    describeTool(
      "book_details",
      "Get full metadata and download options for a single book by its MD5 hash " +
        "(from a search_books result). Queries Anna's Archive and Library Genesis " +
        "in parallel and returns the first usable result; Libgen metadata comes " +
        "from a structured BibTeX block. The response says which source answered " +
        "in `resolvedVia`, and a concise `annasUnavailable` reason when Anna's " +
        "Archive did not answer first.",
    ),
    {
      md5: z.string().regex(/^[a-fA-F0-9]{32}$/, "must be a 32-char MD5 hash"),
    },
    async ({ md5 }) => {
      const details = await bookDetails(md5.toLowerCase());
      // No usable metadata from any source is a failed lookup, not a book.
      return details.title ? json(details) : jsonError(details);
    }
  );

  // -------------------------------------------------------------------------
  // get_download_links — every resolvable download URL for an md5
  // -------------------------------------------------------------------------
  server.tool(
    "get_download_links",
    describeTool(
      "get_download_links",
      "Resolve every available download link for a book by MD5 — Libgen direct " +
        "(get.php), Anna's Archive partners, and IPFS gateways. Links marked " +
        "`direct: true` point straight at the file.",
    ),
    {
      md5: z.string().regex(/^[a-fA-F0-9]{32}$/, "must be a 32-char MD5 hash"),
    },
    async ({ md5 }) => {
      const links = await resolveDownloads(md5.toLowerCase());
      return json({ md5: md5.toLowerCase(), count: links.length, links });
    }
  );

  // -------------------------------------------------------------------------
  // download_book — fetch the file to disk
  // -------------------------------------------------------------------------
  server.tool(
    "download_book",
    describeTool(
      "download_book",
      "Download a book file to a local directory by MD5. Streams direct links " +
        "(Libgen/IPFS) to disk in order and keeps the first that yields a real " +
        "file, so peak memory does not scale with book size. Returns the saved " +
        "path, byte count, and the MD5 of what was written. Check " +
        "`md5MatchesRequest`; a mismatch includes an explicit warning. Emits " +
        "progress notifications while transferring.",
    ),
    {
      md5: z.string().regex(/^[a-fA-F0-9]{32}$/, "must be a 32-char MD5 hash"),
      output_dir: z
        .string()
        .min(1)
        .describe(
          "Directory to save into; created if missing. Use an absolute path. " +
            "A relative path is resolved against $HOME (not the server's working " +
            "directory, which you cannot see), and the resolved directory is " +
            "reported back as `outputDir`."
        ),
      filename: z
        .string()
        .optional()
        .describe("Optional filename; defaults to <md5>.<ext>."),
    },
    async ({ md5, output_dir, filename }, extra) => {
      const hash = md5.toLowerCase();
      // Validate before any network work: a bad name must never reach the disk.
      const plainName = filename === undefined ? undefined : plainFileName(filename);
      const links = await resolveDownloads(hash);
      const direct = links.filter((l) => l.direct);
      if (direct.length === 0)
        return jsonError({
          saved: false,
          reason: "No direct download link resolved. Use these links manually.",
          links,
        });

      // Resolve relative output paths from $HOME, a predictable location for both sides.
      const wasRelative = !isAbsolute(output_dir);
      const dir = wasRelative ? resolve(homedir(), output_dir) : output_dir;
      await mkdir(dir, { recursive: true });

      // A file the caller named is theirs: refuse rather than overwrite it.
      if (plainName !== undefined) {
        const taken = await access(join(dir, plainName)).then(() => true, () => false);
        if (taken) {
          return jsonError({
            saved: false,
            reason: `${plainName} already exists in ${dir}; choose another filename.`,
          });
        }
      }

      const onProgress = makeProgressReporter(extra);
      // A staging name unique to this call, so concurrent downloads of the same
      // md5 into the same directory cannot write or delete each other's bytes.
      const staging = join(dir, `${hash}.${randomUUID()}.downloading`);
      const errors: string[] = [];

      for (const link of direct) {
        try {
          const result = await downloadToFile(link.url, staging, {
            onProgress,
            signal: extra?.signal,
          });

          const name =
            plainName ??
            `${hash}.${sniffExt(await readFileHead(staging, 4096), result.contentType)}`;
          const path = join(dir, name);
          await rename(staging, path);

          return json({
            saved: true,
            path,
            /** Absolute directory the file landed in — always resolved, so a
             *  relative `output_dir` never leaves the caller guessing. */
            outputDir: dir,
            ...(wasRelative
              ? { note: `"${output_dir}" was relative; resolved to ${dir}. Pass an absolute path to avoid surprises.` }
              : {}),
            bytes: result.bytes,
            via: link.label,
            /** Hex MD5 of the bytes on disk. */
            md5: result.md5,
            /** True when the file's own hash equals the catalog hash requested. */
            md5MatchesRequest: result.md5 === hash,
            ...(result.md5 !== hash
              ? {
                  warning:
                    "Downloaded file MD5 does not match the requested catalog MD5; " +
                    "verify it before use.",
                }
              : {}),
            contentType: result.contentType,
          });
        } catch (e) {
          await unlink(staging).catch(() => {});
          if (e instanceof HtmlInsteadOfFileError) {
            // The one-time key in a Libgen get.php URL expires, and the page it
            // then serves is HTML. Move on to the next candidate; never save it.
            errors.push(`${link.label}: served an HTML page, not a file`);
            continue;
          }
          errors.push(`${link.label}: ${(e as Error).message}`);
        }
      }
      return jsonError({ saved: false, errors, links });
    }
  );

  // -------------------------------------------------------------------------
  // search_papers — academic articles via Library Genesis scimag
  // -------------------------------------------------------------------------
  server.tool(
    "search_papers",
    describeTool(
      "search_papers",
      "Search academic papers / journal articles by keyword, author, title, or " +
        "DOI via Library Genesis scimag. Returns DOIs and mirror links. Set " +
        "`resolvePdfs: true` to best-effort resolve direct PDF URLs via Sci-Hub " +
        "for up to three results (extra network requests; off by default).",
    ),
    {
      query: z.string().describe("Keywords, title, author, or DOI."),
      limit: z.number().int().min(1).max(100).optional(),
      resolvePdfs: z
        .boolean()
        .optional()
        .describe(
          "Best-effort direct PDF lookup via Sci-Hub for up to three DOI results; adds network requests."
        ),
    },
    async ({ query, limit, resolvePdfs: shouldResolvePdfs }) => {
      const papers = await withSourceCircuit("libgen", () =>
        libgen.searchPapers(query, limit ?? 20)
      );
      const results = shouldResolvePdfs ? await resolvePaperPdfs(papers) : papers;
      return json({ query, total: results.length, results });
    }
  );

  // -------------------------------------------------------------------------
  // get_paper — resolve a PDF via Sci-Hub by DOI / URL / title
  // -------------------------------------------------------------------------
  server.tool(
    "get_paper",
    describeTool(
      "get_paper",
      "Resolve a paper's PDF via Sci-Hub. Accepts a DOI (best), an article URL, or " +
        "a title. Returns metadata and a direct `pdfUrl` when available.",
    ),
    {
      identifier: z
        .string()
        .describe("DOI (e.g. 10.1038/nature12373), article URL, or title."),
    },
    async ({ identifier }) =>
      json(await withSourceCircuit("scihub", () => scihub.resolve(identifier)))
  );

  // -------------------------------------------------------------------------
  // healthcheck — is anything reachable, without touching a catalogue
  // -------------------------------------------------------------------------
  server.tool(
    "healthcheck",
    describeTool(
      "healthcheck",
      "Report whether this server can reach its sources, with per-mirror latency. " +
        "Probes host roots only — it never queries a catalogue, so it is cheap and " +
        "safe to call before a search. Use it to tell 'the network is blocked' " +
        "apart from 'the query matched nothing'. A mirror that answers but is not " +
        "the site it claims to be is reported as `impostor`, not as healthy.",
    ),
    {
      timeoutMs: z
        .number()
        .int()
        .min(250)
        .max(30000)
        .optional()
        .describe("Per-mirror probe timeout in ms (default 8000)."),
    },
    async ({ timeoutMs }) => {
      // Bypass the negative cache: the point of a healthcheck is to show what is
      // reachable right now, not what was unreachable a minute ago.
      resetDeadCache();
      const probes = await Promise.all(
        MIRROR_GROUPS.map((group) => probeGroup(group, { timeoutMs }))
      );
      const groups = probes.map(toHealthcheckGroup);
      const reachable = probes.filter((group) => group.ok).map((group) => group.group);
      const impostors = probes.flatMap((group) => group.impostors);
      return json({
        version: SERVER_VERSION,
        ready: reachable.length > 0,
        reachable,
        unreachable: groups.filter((g) => !g.ok).map((g) => g.group),
        // Called out separately because it is a different failure from "down":
        // the host answers, so a status-code-only check would call it healthy.
        impostors,
        defaults: { sources: BOOK_SOURCES, disabledByDefault: DISABLED_BOOK_SOURCES },
        groups,
      });
    }
  );

  return server;
}

export { SERVER_NAME, SERVER_VERSION, ALL_BOOK_SOURCES };
