// Member fast-download URLs are authenticated API responses for a specific
// MD5. They need not repeat that hash in a signed CDN URL.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

const md5 = "5".repeat(32);
const cdnUrl = "https://cdn.example.test/dl/opaque-token/book.epub";
let apiCalls = 0;
const server = createServer((req, res) => {
  if (req.url?.startsWith("/dyn/api/fast_download.json")) {
    apiCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ download_url: cdnUrl, downloads_left: 4 }));
    return;
  }
  if (req.url?.startsWith("/ads.php")) {
    res.writeHead(200, { "content-type": "text/html; charset=UTF-8" });
    res.end('<a href="https://annas-archive.org/">mirror</a>');
    return;
  }
  res.writeHead(404).end("not found");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const mirror = `http://127.0.0.1:${server.address().port}`;
process.env.BIBLIO_ANNAS_MIRRORS = mirror;
process.env.BIBLIO_LIBGEN_MIRRORS = mirror;
process.env.BIBLIO_ANNAS_API_KEY = "test-key";
process.env.BIBLIO_MIRROR_STAGGER_MS = "0";
process.env.BIBLIO_TIMEOUT_MS = "1000";

const { resolveDownloads } = await import("../dist/providers/index.js");

test.after(() => new Promise((resolve) => server.close(resolve)));

test("resolveDownloads keeps a verified member URL without an MD5 in its signed URL", async () => {
  const links = await resolveDownloads(md5);
  const memberLink = links.find((link) => link.url === cdnUrl);

  assert.equal(apiCalls, 1);
  assert.ok(memberLink, "the verified fast-download URL must survive filtering");
  assert.equal(memberLink.source, "annas");
  assert.equal(memberLink.direct, true);
  assert.equal(memberLink.verified, true);
  assert.ok(!links.some((link) => link.url === "https://annas-archive.org/"));
});
