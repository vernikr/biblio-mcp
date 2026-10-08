// MCP tool surface.
//
// Split out from the entry point so the server can be constructed in-process —
// by `--selfcheck` and by the test suite — without binding a stdio transport.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdir, rename, unlink } from "node:fs/promises";
import { open } from "node:fs/promises";
import { join, isAbsolute, resolve } from "node:path";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { probeMirror, resetMirrorCache } from "./http.js";
import { MIRROR_GROUPS } from "./mirrors.js";
import { describeArgsError, describeTool } from "./toolmeta.js";
import {
  downloadToFile,
  HtmlInsteadOfFileError,
  type DownloadProgress,
} from "./http.js";
import { sniffExt } from "./sniff.js";
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
import type { SourceId } from "./types.js";

const SERVER_NAME = "biblio-mcp";

/**
 * Read from package.json rather than repeated here.
 *
 * This used to be a hardcoded string, so bumping the version in package.json
 * left `--version` and `--selfcheck` reporting the previous one. `createRequire`
 * is used instead of `import ... from "../package.json"` because tsconfig sets
 * `rootDir: "src"`, and importing a file above it breaks the build.
 */
const SERVER_VERSION: string = (() => {
  try {
    const pkg = createRequire(import.meta.url)("../package.json") as {
      name?: string;
      version?: string;
    };
    // Only trust it if it is OUR package.json. Copying dist/ into another
    // project otherwise reports that project's version — observed in the wild as
    // a build that advertised "v1.0.0" while running this code. An unknown
    // version is honest; a plausible wrong one is not.
    if (pkg.name !== SERVER_NAME) return "0.0.0-unknown";
    return pkg.version ?? "0.0.0-unknown";
  } catch {
    return "0.0.0-unknown";
  }
})();

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

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

/**
 * Build a throttled progress reporter for one tool call.
 *
 * MCP clients apply a request timeout (60 s by default in the TypeScript SDK)
 * that is NOT extended by an in-flight response — so a multi-megabyte download
 * could time out on the client while the server was still working and had
 * already written a perfectly good file. Emitting progress notifications keeps
 * the request alive from the client's point of view and gives the caller
 * something to show.
 *
 * No-op when the client did not send a progressToken.
 */
function makeProgressReporter(extra?: {
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
  };
}

/**
 * Replace zod's raw issue dump with a sentence an agent can act on.
 *
 * The SDK validates arguments in `McpServer.validateToolInput` and, on failure,
 * throws an error whose message is the stringified zod issue array. That
 * surfaces to the caller as
 * `Invalid arguments for tool download_book: [{"expected":"string","code":"invalid_type","path":["output_dir"],...}]`
 * — accurate, and useless as an instruction.
 *
 * The method is called as `this.validateToolInput(...)`, so replacing it on the
 * instance is enough; no subclassing and no patching of the SDK. A plain Error
 * is thrown rather than an McpError because the SDK's tool dispatcher turns a
 * plain Error into an `isError: true` tool result carrying just the message,
 * while an McpError prefixes it with `MCP error -32602:`.
 *
 * If the SDK ever stops calling this method the override simply never runs and
 * the original behaviour returns — it cannot make errors worse.
 */
function useReadableValidationErrors(server: McpServer): void {
  // The SDK declares validateToolInput private, but it is called as
  // `this.validateToolInput(...)` at runtime, so replacing it on the instance
  // works. Reaching it needs a structural cast; that is the price of not
  // forking the SDK, and it is confined to these four lines.
  type ValidatingServer = {
    validateToolInput: (tool: unknown, args: unknown, toolName: string) => Promise<unknown>;
  };
  const target = server as unknown as Partial<ValidatingServer>;
  // Not every SDK version exposes this method. If it is absent, leave the
  // server alone: validation errors keep the SDK's own wording, which is worse
  // but correct. Binding an undefined method here used to throw a cryptic
  // "Cannot read properties of undefined (reading 'bind')" at startup, which is
  // exactly the kind of unactionable message this fork exists to eliminate.
  if (typeof target.validateToolInput !== "function") return;
  const original = target.validateToolInput.bind(server);

  target.validateToolInput = async (tool, args, toolName) => {
    // Re-run the parse ourselves so we get structured issues. `inputSchema` is a
    // zod object schema by the time it reaches here; if a future SDK hands us
    // something without safeParseAsync we delegate and keep the old message.
    const schema = (tool as { inputSchema?: unknown })?.inputSchema as
      | { safeParseAsync?: (v: unknown) => Promise<{ success: boolean; error?: unknown }> }
      | undefined;
    if (schema && typeof schema.safeParseAsync === "function") {
      const result = await schema.safeParseAsync(args);
      if (!result.success) throw new Error(describeArgsError(String(toolName), result.error));
    }
    return original(tool, args, toolName);
  };
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
        .optional()
        .describe(
          `Which sources to search. Default: ${BOOK_SOURCES.join(", ")}.` +
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
      const result = await searchBooks(
        query,
        (sources as SourceId[]) ?? BOOK_SOURCES,
        limit ?? 20
      );
      return json({
        ...result,
        total: result.results.length,
        sourcesSearched: (sources as SourceId[]) ?? BOOK_SOURCES,
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
        "(from a search_books result). Tries Anna's Archive first and falls back " +
        "to Library Genesis, whose metadata comes from a BibTeX block and is " +
        "exact. The response says which source answered in `resolvedVia`, and " +
        "why Anna's Archive was skipped in `annasUnavailable`.",
    ),
    {
      md5: z.string().regex(/^[a-fA-F0-9]{32}$/, "must be a 32-char MD5 hash"),
    },
    async ({ md5 }) => json(await bookDetails(md5.toLowerCase()))
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
        "path, the byte count, and the MD5 of what was written — compare it with " +
        "the `md5` you passed to confirm the file is intact. Emits progress " +
        "notifications while transferring.",
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
      const links = await resolveDownloads(hash);
      const direct = links.filter((l) => l.direct);
      if (direct.length === 0)
        return json({
          saved: false,
          reason: "No direct download link resolved. Use these links manually.",
          links,
        });

      // A relative path used to resolve against the server's working directory —
      // which is wherever the client happened to launch the process, and is
      // invisible to the agent asking for the download. $HOME is predictable
      // from both sides, and the resolved directory is reported back below.
      const wasRelative = !isAbsolute(output_dir);
      const dir = wasRelative ? resolve(homedir(), output_dir) : output_dir;
      await mkdir(dir, { recursive: true });

      const onProgress = makeProgressReporter(extra);
      // Staging name, so the extension can be sniffed from the bytes we just
      // wrote rather than guessed from a content-type the mirror may not set.
      const staging = join(dir, `${hash}.downloading`);
      const errors: string[] = [];

      for (const link of direct) {
        await unlink(staging).catch(() => {});
        try {
          const result = await downloadToFile(link.url, staging, {
            onProgress,
            signal: extra?.signal,
          });

          const ext =
            filename?.split(".").pop() ||
            sniffExt(await readFileHead(staging, 4096), result.contentType);
          const name = filename ?? `${hash}.${ext}`;
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
            contentType: result.contentType,
          });
        } catch (e) {
          if (e instanceof HtmlInsteadOfFileError) {
            // The one-time key in a Libgen get.php URL expires, and the page it
            // then serves is HTML. Move on to the next candidate; never save it.
            errors.push(`${link.label}: served an HTML page, not a file`);
            continue;
          }
          errors.push(`${link.label}: ${(e as Error).message}`);
        } finally {
          await unlink(staging).catch(() => {});
        }
      }
      return json({ saved: false, errors, links });
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
        "DOI via Library Genesis scimag. Returns DOIs and mirror links. To fetch a " +
        "PDF, pass the DOI to get_paper.",
    ),
    {
      query: z.string().describe("Keywords, title, author, or DOI."),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async ({ query, limit }) => {
      const papers = await libgen.searchPapers(query, limit ?? 20);
      return json({ query, total: papers.length, results: papers });
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
    async ({ identifier }) => json(await scihub.resolve(identifier))
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
      resetMirrorCache();
      const groups = await Promise.all(
        MIRROR_GROUPS.map(async ({ group, mirrors, probePath, expect }) => {
          const results = await Promise.all(
            mirrors.map((base) => probeMirror(base, probePath, { timeoutMs, expect }))
          );
          const alive = results.filter((r) => r.ok);
          const fastest = alive.reduce<number | undefined>(
            (min, r) => (min === undefined || r.ms < min ? r.ms : min),
            undefined
          );
          return {
            group,
            reachable: alive.length,
            total: mirrors.length,
            ok: alive.length > 0,
            // null rather than undefined, so the field is always present in the
            // JSON and a caller can render it without a special case.
            fastestMs: fastest ?? null,
            impostors: results.filter((r) => r.impostor).map((r) => r.base),
            mirrors: results.map((r) => ({
              base: r.base,
              ok: r.ok,
              status: r.status,
              ms: r.ms,
              ...(r.impostor ? { impostor: true } : {}),
              ...(r.error ? { error: r.error } : {}),
            })),
          };
        })
      );

      const reachable = groups.filter((g) => g.ok).map((g) => g.group);
      const impostors = groups.flatMap((g) => g.impostors);
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
