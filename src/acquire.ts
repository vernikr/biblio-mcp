// Turning a catalogue MD5 into a file on disk. Shared by download_book and fetch_book,
// so both obey the same rules: direct links only, HTML never saved, MD5 reported,
// caller-chosen names never overwritten.

import { access, link as linkFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { join, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { downloadToFile, HtmlInsteadOfFileError, type DownloadProgress } from "./http.js";
import { sniffExt } from "./sniff.js";
import { resolveDownloadReport } from "./providers/index.js";

export interface SaveRequest {
  /** Absolute, or relative to $HOME. Created if missing. */
  outputDir: string;
  /** A caller-chosen plain file name; when set, an existing file is never replaced. */
  plainName?: string;
  onProgress: (p: DownloadProgress) => Promise<void>;
  signal?: AbortSignal;
}

export interface SaveOutcome {
  saved: boolean;
  /** JSON body for the tool result; `saved` mirrors the outcome. */
  body: Record<string, unknown>;
}

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

/** Resolve the candidate links for `hash` and save the first one that yields a real file. */
export async function saveBook(hash: string, req: SaveRequest): Promise<SaveOutcome> {
  const { links, errors: sourceErrors } = await resolveDownloadReport(hash);
  const direct = links.filter((l) => l.direct);
  if (direct.length === 0)
    return {
      saved: false,
      body: {
        saved: false,
        reason:
          sourceErrors.length > 0
            ? "No direct download link resolved, and at least one source was unavailable. " +
              "Retry later, or use these links manually."
            : "No direct download link resolved. Use these links manually.",
        links,
        ...(sourceErrors.length ? { sourceErrors } : {}),
      },
    };

  // Resolve relative output paths from $HOME, a predictable location for both sides.
  const wasRelative = !isAbsolute(req.outputDir);
  const dir = wasRelative ? resolve(homedir(), req.outputDir) : req.outputDir;
  await mkdir(dir, { recursive: true });

  // A file the caller named is theirs: refuse rather than overwrite it.
  const plainName = req.plainName;
  if (plainName !== undefined) {
    const taken = await access(join(dir, plainName)).then(() => true, () => false);
    if (taken) {
      return {
        saved: false,
        body: { saved: false, reason: `${plainName} already exists in ${dir}; choose another filename.` },
      };
    }
  }

  // A staging name unique to this call, so concurrent downloads of the same
  // md5 into the same directory cannot write or delete each other's bytes.
  const staging = join(dir, `${hash}.${randomUUID()}.downloading`);
  const errors: string[] = [];

  for (const link of direct) {
    try {
      const result = await downloadToFile(link.url, staging, {
        onProgress: req.onProgress,
        signal: req.signal,
      });

      const name = plainName ?? `${hash}.${sniffExt(await readFileHead(staging, 4096), result.contentType)}`;
      const path = join(dir, name);
      try {
        // A precheck cannot prevent a concurrent writer. link is atomic and
        // refuses an existing caller-chosen name; never fall back to rename.
        if (plainName !== undefined) await linkFile(staging, path);
        else await rename(staging, path);
      } catch (e) {
        await unlink(staging).catch(() => {});
        // Publication is a local failure, not a reason to try another URL.
        return {
          saved: false,
          body: {
            saved: false,
            reason: (e as NodeJS.ErrnoException).code === "EEXIST"
              ? `${name} already exists in ${dir}; choose another filename.`
              : `Cannot publish ${name} in ${dir}: ${(e as Error).message}`,
          },
        };
      }
      if (plainName !== undefined) await unlink(staging).catch(() => {});

      return {
        saved: true,
        body: {
          saved: true,
          path,
          /** Absolute directory the file landed in — always resolved, so a
           *  relative `output_dir` never leaves the caller guessing. */
          outputDir: dir,
          ...(wasRelative
            ? { note: `"${req.outputDir}" was relative; resolved to ${dir}. Pass an absolute path to avoid surprises.` }
            : {}),
          bytes: result.bytes,
          via: link.label,
          ...(sourceErrors.length ? { sourceErrors } : {}),
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
        },
      };
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
  return {
    saved: false,
    body: {
      saved: false,
      errors,
      links,
      ...(sourceErrors.length ? { sourceErrors } : {}),
    },
  };
}
