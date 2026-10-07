// MCP tool surface.
//
// Split out from the entry point so the server can be constructed in-process —
// by `--selfcheck` and by the test suite — without binding a stdio transport.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdir, rename, unlink } from "node:fs/promises";
import { open } from "node:fs/promises";
import { join, isAbsolute, resolve } from "node:path";
import {
  downloadToFile,
  HtmlInsteadOfFileError,
  type DownloadProgress,
} from "./http.js";
import { sniffExt } from "./sniff.js";
import {
  searchBooks,
  resolveDownloads,
  annas,
  libgen,
  scihub,
  BOOK_SOURCES,
  ALL_BOOK_SOURCES,
  DISABLED_BOOK_SOURCES,
} from "./providers/index.js";
import type { SourceId } from "./types.js";

const SERVER_NAME = "biblio-mcp";
const SERVER_VERSION = "1.2.0";

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

export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // -------------------------------------------------------------------------
  // search_books — the headline tool
  // -------------------------------------------------------------------------
  server.tool(
    "search_books",
    "Search for books/documents across Anna's Archive, Library Genesis, and " +
      "Z-Library at once. Results are merged and de-duplicated by MD5 hash. Each " +
      "result includes an `md5` you can pass to get_download_links or " +
      "download_book. Per-source failures are reported in `errors` without " +
      "failing the call.",
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
    "Get full metadata and download options for a single book by its MD5 hash " +
      "(from a search_books result). Resolves against Anna's Archive.",
    {
      md5: z.string().regex(/^[a-fA-F0-9]{32}$/, "must be a 32-char MD5 hash"),
    },
    async ({ md5 }) => json(await annas.details(md5.toLowerCase()))
  );

  // -------------------------------------------------------------------------
  // get_download_links — every resolvable download URL for an md5
  // -------------------------------------------------------------------------
  server.tool(
    "get_download_links",
    "Resolve every available download link for a book by MD5 — Libgen direct " +
      "(get.php), Anna's Archive partners, and IPFS gateways. Links marked " +
      "`direct: true` point straight at the file.",
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
    "Download a book file to a local directory by MD5. Streams direct links " +
      "(Libgen/IPFS) to disk in order and keeps the first that yields a real " +
      "file, so peak memory does not scale with book size. Returns the saved " +
      "path, the byte count, and the MD5 of what was written — compare it with " +
      "the `md5` you passed to confirm the file is intact. Emits progress " +
      "notifications while transferring.",
    {
      md5: z.string().regex(/^[a-fA-F0-9]{32}$/, "must be a 32-char MD5 hash"),
      output_dir: z
        .string()
        .describe(
          "Directory to save into; created if missing. Relative paths resolve " +
            "against the server's working directory, so prefer an absolute path."
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

      const dir = isAbsolute(output_dir) ? output_dir : resolve(process.cwd(), output_dir);
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
    "Search academic papers / journal articles by keyword, author, title, or " +
      "DOI via Library Genesis scimag. Returns DOIs and mirror links. To fetch a " +
      "PDF, pass the DOI to get_paper.",
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
    "Resolve a paper's PDF via Sci-Hub. Accepts a DOI (best), an article URL, or " +
      "a title. Returns metadata and a direct `pdfUrl` when available.",
    {
      identifier: z
        .string()
        .describe("DOI (e.g. 10.1038/nature12373), article URL, or title."),
    },
    async ({ identifier }) => json(await scihub.resolve(identifier))
  );

  return server;
}

export { SERVER_NAME, SERVER_VERSION, ALL_BOOK_SOURCES };
