// Tests for book_details metadata resolution and download-link filtering.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolvePath(HERE, "..");

/** Run `body` in a fresh Node process against the built dist/, with `env` applied */
function runInProcess(env, ctx, body) {
  const program = `
    const ctx = ${JSON.stringify(ctx)};
    const fn = ${body.toString()};
    fn(ctx).then(
      (v) => { process.stdout.write("\\n@@RESULT@@" + JSON.stringify(v ?? null)); },
      (e) => { process.stdout.write("\\n@@ERROR@@" + JSON.stringify({ message: String(e && e.message ? e.message : e) })); }
    );
  `;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", program], {
      cwd: PROJECT,
      env: { ...process.env, ...env },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      const marker = out.lastIndexOf("@@RESULT@@");
      if (marker !== -1) {
        try {
          resolvePromise(JSON.parse(out.slice(marker + "@@RESULT@@".length)));
          return;
        } catch {
          /* fall through to the error path below */
        }
      }
      const errMarker = out.lastIndexOf("@@ERROR@@");
      const message =
        errMarker !== -1
          ? JSON.parse(out.slice(errMarker + "@@ERROR@@".length)).message
          : `child exited ${code}\n${err.slice(-800)}`;
      reject(new Error(message));
    });
  });
}

/** Start a stub mirror and return its origin plus a shutdown handle. */
function startStub(handler) {
  return new Promise((resolvePromise) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolvePromise({
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// Port 1 is reserved and always refuses connections, so it stands in for
// "this source is not available" without touching the network.
const UNREACHABLE = "http://127.0.0.1:1";

// ---------------------------------------------------------------------------
// isUsefulLink — the junk download links
// ---------------------------------------------------------------------------

test("isUsefulLink rejects links that are not about this book", async () => {
  const md5 = "524037f395462d37b31f2b28fede24fb";
  const got = await runInProcess({}, { md5 }, async (c) => {
    const { isUsefulLink } = await import("./dist/providers/index.js");
    return [
      // Real junk emitted by get_download_links: Libgen's ads.php page links the
      // Anna's Archive domain root, which downloads nothing.
      isUsefulLink("http://annas-archive.org/", c.md5),
      isUsefulLink("https://annas-archive.gs/", c.md5),
      isUsefulLink("https://libgen.li/", c.md5),
      // Anything not naming the hash is not a link to this book.
      isUsefulLink("https://libgen.li/ads.php?md5=deadbeef", c.md5),
      isUsefulLink("https://example.com/book/12345", c.md5),
      // Malformed input must not throw.
      isUsefulLink("not a url", c.md5),
    ];
  });
  assert.deepEqual(got, [false, false, false, false, false, false]);
});

test("isUsefulLink accepts the mirrors that actually serve this book", async () => {
  const md5 = "524037f395462d37b31f2b28fede24fb";
  const got = await runInProcess({}, { md5 }, async (c) => {
    const { isUsefulLink } = await import("./dist/providers/index.js");
    return [
      isUsefulLink(`https://libgen.li/get.php?md5=${c.md5}&key=ABC`, c.md5),
      isUsefulLink(`https://library.sk/download/${c.md5}`, c.md5),
      isUsefulLink(`https://z-lib.to/md5/${c.md5}`, c.md5),
      // Case-insensitive, because mirrors differ.
      isUsefulLink(`https://x.test/${c.md5.toUpperCase()}`, c.md5),
      // IPFS gateway links carry a CID, not the md5.
      isUsefulLink("https://ipfs.io/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", c.md5),
    ];
  });
  assert.deepEqual(got, [true, true, true, true, true]);
});

test("resolveDownloads drops the bare-domain link Libgen's ads page advertises", async () => {
  const md5 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  // A realistic ads.php page: one genuine get.php link plus the domain-root
  // junk that used to reach the caller.
  const adsPage = `<html><body>
      <a href="get.php?md5=${md5}&key=SECRET123">GET</a>
      <a href="http://annas-archive.org/">Anna's Archive</a>
      <a href="https://libgen.pw/">Libgen PW</a>
    </body></html>`;

  const stub = await startStub((req, res) => {
    if (req.url?.startsWith("/ads.php")) {
      res.writeHead(200, { "content-type": "text/html; charset=UTF-8" });
      res.end(adsPage);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  try {
    const links = await runInProcess(
      {
        BIBLIO_LIBGEN_MIRRORS: stub.origin,
        BIBLIO_ANNAS_MIRRORS: UNREACHABLE, // 404/fail: Anna's contributes nothing
        BIBLIO_ZLIB_MIRRORS: UNREACHABLE,
        BIBLIO_ANNAS_API_KEY: "", // no member fast-download
      },
      { md5 },
      async (c) => {
        const { resolveDownloads } = await import("./dist/providers/index.js");
        return resolveDownloads(c.md5);
      }
    );

    const urls = links.map((l) => l.url);
    assert.deepEqual(urls, [`${stub.origin}/get.php?md5=${md5}&key=SECRET123`]);
    assert.equal(links[0].direct, true);
    assert.ok(
      !urls.some((u) => /annas-archive\.org\/?$/.test(u) || /libgen\.pw\/?$/.test(u)),
      `bare-domain links must be filtered out, got: ${JSON.stringify(urls)}`
    );
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// bookDetails — Anna's Archive, then Libgen BibTeX
// ---------------------------------------------------------------------------

const BIBTEX = (md5) =>
  `@book{book:{91346036}, title = {Pairs Trading: Quantitative Methods and Analysis},
    author = {Ganapathy Vidyamurthy}, publisher = {Wiley},
    isbn = {9780471460671; 0471460672}, year = {2004}, series = {Wiley Finance},
    url = {libgen.li/file.php?md5=${md5}}}`;

test("bookDetails falls back to Libgen when Anna's Archive is unavailable", async () => {
  const md5 = "524037f395462d37b31f2b28fede24fb";

  const stub = await startStub((req, res) => {
    // Anna's HTML mirrors currently answer 403 to non-browser clients.
    if (req.url?.startsWith("/md5/")) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("Forbidden");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=UTF-8" });
    // The real ads.php page carries both the BibTeX block and the download
    // anchors, so the stub does too.
    res.end(
      `<html><body><table><tr><td>${BIBTEX(md5)}</td></tr></table>` +
        `<a href="get.php?md5=${md5}&key=KEY123">GET</a></body></html>`
    );
  });

  try {
    const result = await runInProcess(
      {
        BIBLIO_ANNAS_MIRRORS: stub.origin,
        BIBLIO_LIBGEN_MIRRORS: stub.origin,
        BIBLIO_ZLIB_MIRRORS: UNREACHABLE,
        BIBLIO_ANNAS_API_KEY: "",
      },
      { md5 },
      async (c) => {
        const { bookDetails } = await import("./dist/providers/index.js");
        return bookDetails(c.md5);
      }
    );

    assert.equal(result.resolvedVia, "libgen");
    assert.equal(result.title, "Pairs Trading: Quantitative Methods and Analysis");
    assert.equal(result.author, "Ganapathy Vidyamurthy");
    assert.equal(result.series, "Wiley Finance");
    assert.equal(result.isbn, "9780471460671; 0471460672");
    assert.match(result.annasUnavailable ?? "", /DDoS-Guard challenge/i);
    assert.ok((result.downloadLinks ?? []).length > 0, "must still return download links");
  } finally {
    await stub.close();
  }
});

test("bookDetails starts Anna's and Libgen concurrently and returns the first usable result", async () => {
  const md5 = "524037f395462d37b31f2b28fede24fb";
  let annasStartedResolve;
  let libgenStartedResolve;
  let releaseAnnas;
  let annasFinishedResolve;
  const annasStarted = new Promise((resolve) => (annasStartedResolve = resolve));
  const libgenStarted = new Promise((resolve) => (libgenStartedResolve = resolve));
  const annasFinished = new Promise((resolve) => (annasFinishedResolve = resolve));
  const annasResponse = new Promise((resolve) => (releaseAnnas = resolve));

  const annasStub = await startStub((req, res) => {
    if (req.url?.startsWith("/md5/")) {
      annasStartedResolve();
      annasResponse.then(() => {
        annasFinishedResolve();
        res.writeHead(403, { "content-type": "text/plain" }).end("Forbidden");
      });
      return;
    }
    res.writeHead(404).end("not found");
  });
  const libgenStub = await startStub((req, res) => {
    if (req.url?.startsWith("/ads.php")) {
      libgenStartedResolve();
      res.writeHead(200, { "content-type": "text/html; charset=UTF-8" });
      res.end(
        `<html><body><table><tr><td>${BIBTEX(md5)}</td></tr></table>` +
          `<a href="get.php?md5=${md5}&key=KEY123">GET</a></body></html>`
      );
      return;
    }
    res.writeHead(404).end("not found");
  });

  process.env.BIBLIO_ANNAS_MIRRORS = annasStub.origin;
  process.env.BIBLIO_LIBGEN_MIRRORS = libgenStub.origin;
  process.env.BIBLIO_TIMEOUT_MS = "2000";
  process.env.BIBLIO_MIRROR_STAGGER_MS = "0";

  try {
    const { bookDetails } = await import("../dist/providers/index.js");
    const resultPromise = bookDetails(md5);
    await Promise.all([annasStarted, libgenStarted]);
    const result = await Promise.race([
      resultPromise,
      new Promise((resolve) => setTimeout(() => resolve("timed out"), 400)),
    ]);
    assert.notEqual(result, "timed out", "Libgen must not wait for the slow Anna's request");
    assert.equal(result.resolvedVia, "libgen");
    assert.equal(result.title, "Pairs Trading: Quantitative Methods and Analysis");
    assert.equal(result.annasUnavailable, undefined, "the Anna's request is still in flight");

    releaseAnnas();
    await annasFinished;
  } finally {
    releaseAnnas();
    await Promise.all([annasStub.close(), libgenStub.close()]);
  }
});

test("bookDetails identifies an explicitly empty Anna's mirror list", async () => {
  const md5 = "524037f395462d37b31f2b28fede24fb";
  const result = await runInProcess(
    {
      BIBLIO_ANNAS_MIRRORS: " ",
      BIBLIO_LIBGEN_MIRRORS: UNREACHABLE,
    },
    { md5 },
    async (c) => {
      const { bookDetails } = await import("./dist/providers/index.js");
      return bookDetails(c.md5);
    }
  );
  assert.match(result.annasUnavailable, /no Anna's Archive mirrors configured/i);
  assert.match(result.annasUnavailable, /BIBLIO_ANNAS_MIRRORS/);
});

test("bookDetails reports both failures instead of a plausible-looking stub", async () => {
  const md5 = "524037f395462d37b31f2b28fede24fb";

  // A parked/impostor page answers 200 but carries no book metadata. The old
  // code accepted it and returned a record with an empty title and no links.
  const stub = await startStub((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=UTF-8" });
    res.end("<html><body><p>Advertisement</p></body></html>");
  });

  try {
    const result = await runInProcess(
      {
        BIBLIO_ANNAS_MIRRORS: stub.origin,
        BIBLIO_LIBGEN_MIRRORS: UNREACHABLE, // no fallback available
        BIBLIO_ZLIB_MIRRORS: UNREACHABLE,
        BIBLIO_ANNAS_API_KEY: "",
      },
      { md5 },
      async (c) => {
        const { bookDetails } = await import("./dist/providers/index.js");
        return bookDetails(c.md5);
      }
    );

    // Anna's answered with something that is not a book page and Libgen is
    // unreachable, so the caller must get an honest empty record that names
    // both failures — not a throw, and not fabricated metadata.
    assert.equal(result.title, "");
    assert.ok(
      result.annasUnavailable,
      `annasUnavailable must explain the rejection, got ${JSON.stringify(result)}`
    );
    assert.match(
      result.annasUnavailable,
      /non-archive page|no title|HTTP \d+/i,
      `annasUnavailable should say what went wrong, got ${JSON.stringify(result.annasUnavailable)}`
    );
    assert.ok(result.libgenUnavailable, "libgenUnavailable must explain the fallback failure");
    assert.deepEqual(result.downloadLinks, []);
  } finally {
    await stub.close();
  }
});

test("download_book preserves a successful staging file and warns on an MD5 mismatch", async () => {
  const md5 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const content = Buffer.from("%PDF-1.7\\nnot the requested catalog file\\n");
  const actualMd5 = createHash("md5").update(content).digest("hex");
  const stub = await startStub((req, res) => {
    if (req.url?.startsWith("/ads.php")) {
      res.writeHead(200, { "content-type": "text/html; charset=UTF-8" });
      res.end(`<a href="get.php?md5=${md5}&key=KEY123">GET</a>`);
      return;
    }
    if (req.url?.startsWith("/get.php")) {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(content);
      return;
    }
    res.writeHead(404).end("not found");
  });
  const outputDir = await mkdtemp(join(tmpdir(), "biblio-download-book-"));
  const filename = `${md5}.downloading`;

  try {
    const result = await runInProcess(
      {
        BIBLIO_LIBGEN_MIRRORS: stub.origin,
        BIBLIO_ANNAS_MIRRORS: UNREACHABLE,
        BIBLIO_ZLIB_MIRRORS: UNREACHABLE,
        BIBLIO_ANNAS_API_KEY: "",
      },
      { md5, outputDir, filename },
      async (c) => {
        const [{ Client }, { InMemoryTransport }, { createServer }] = await Promise.all([
          import("@modelcontextprotocol/sdk/client/index.js"),
          import("@modelcontextprotocol/sdk/inMemory.js"),
          import("./dist/server.js"),
        ]);
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const server = createServer();
        const client = new Client({ name: "download-test", version: "0.0.0" });
        try {
          await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
          const response = await client.callTool({
            name: "download_book",
            arguments: { md5: c.md5, output_dir: c.outputDir, filename: c.filename },
          });
          return JSON.parse(response.content[0].text);
        } finally {
          await client.close().catch(() => {});
          await server.close().catch(() => {});
        }
      }
    );

    const savedPath = join(outputDir, filename);
    assert.equal(result.saved, true);
    assert.equal(result.path, savedPath);
    assert.equal(result.md5, actualMd5);
    assert.equal(result.md5MatchesRequest, false);
    assert.match(result.warning, /does not match the requested catalog MD5/i);
    assert.deepEqual(await readdir(outputDir), [filename]);
    assert.deepEqual(await readFile(savedPath), content);
  } finally {
    await stub.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("Libgen reuses ads.php HTML across details and download-link lookups", async () => {
  const md5 = "cccccccccccccccccccccccccccccccc";
  let adsRequests = 0;
  const stub = await startStub((req, res) => {
    if (req.url?.startsWith("/ads.php")) {
      adsRequests += 1;
      res.writeHead(200, { "content-type": "text/html; charset=UTF-8" });
      res.end(
        `<html><body><table><tr><td>${BIBTEX(md5)}</td></tr></table>` +
          `<a href="get.php?md5=${md5}&key=KEY123">GET</a></body></html>`
      );
      return;
    }
    res.writeHead(404).end("not found");
  });

  try {
    const result = await runInProcess(
      { BIBLIO_LIBGEN_MIRRORS: stub.origin },
      { md5 },
      async (c) => {
        const { libgen } = await import("./dist/providers/index.js");
        const details = await libgen.details(c.md5);
        const firstLinks = await libgen.downloadLinks(c.md5);
        const secondLinks = await libgen.downloadLinks(c.md5);
        return { title: details.title, firstCount: firstLinks.length, secondCount: secondLinks.length };
      }
    );
    assert.equal(result.title, "Pairs Trading: Quantitative Methods and Analysis");
    assert.ok(result.firstCount > 0);
    assert.equal(result.secondCount, result.firstCount);
    assert.equal(adsRequests, 1, "one fresh ads.php response should serve all three lookups");
  } finally {
    await stub.close();
  }
});

test("libgen.details filters junk links too, not only resolveDownloads", async () => {
  // book_details embeds libgen's own link list, which bypasses resolveDownloads.
  // Without the same filter there, a details response still offered the bare
  // Anna's Archive homepage.
  const md5 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const adsPage = `<html><body>
      <table><tr><td>@book{b, title = {A Real Title}, author = {Some Author}, year = {2004}}</td></tr></table>
      <a href="get.php?md5=${md5}&key=KEY999">GET</a>
      <a href="http://annas-archive.org/">Anna's Archive</a>
    </body></html>`;

  const stub = await startStub((req, res) => {
    if (req.url?.startsWith("/ads.php")) {
      res.writeHead(200, { "content-type": "text/html; charset=UTF-8" });
      res.end(adsPage);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  try {
    const result = await runInProcess(
      {
        BIBLIO_LIBGEN_MIRRORS: stub.origin,
        BIBLIO_ANNAS_MIRRORS: UNREACHABLE,
        BIBLIO_ZLIB_MIRRORS: UNREACHABLE,
        BIBLIO_ANNAS_API_KEY: "",
      },
      { md5 },
      async (c) => {
        const { bookDetails } = await import("./dist/providers/index.js");
        return bookDetails(c.md5);
      }
    );

    assert.equal(result.title, "A Real Title");
    const urls = result.downloadLinks.map((l) => l.url);
    assert.deepEqual(urls, [`${stub.origin}/get.php?md5=${md5}&key=KEY999`]);
    assert.ok(
      !urls.some((u) => /annas-archive\.org\/?$/.test(u)),
      `details() must not offer the bare homepage, got: ${JSON.stringify(urls)}`
    );
  } finally {
    await stub.close();
  }
});
