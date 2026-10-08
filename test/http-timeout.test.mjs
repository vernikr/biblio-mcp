// HTML response deadlines must cover the body, not only the response headers.
// All routes are local and deliberately leave their response open after a byte.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.BIBLIO_TIMEOUT_MS = "500";
process.env.BIBLIO_DOWNLOAD_TIMEOUT_MS = "500";
process.env.BIBLIO_DOWNLOAD_STALL_MS = "500";
process.env.BIBLIO_MIRROR_STAGGER_MS = "0";

const { getText, getBuffer, fetchFromMirrors, downloadToFile } = await import("../dist/http.js");
const server = createServer((req, res) => {
  const html = req.url?.startsWith("/html");
  res.writeHead(200, {
    "content-type": html ? "text/html; charset=UTF-8" : "application/octet-stream",
  });
  res.write(html ? "<html>" : "x");
  // Intentionally do not finish the body. Client-side timeout must abort it.
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function assertFastRejection(operation, label) {
  const started = Date.now();
  await assert.rejects(operation);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1500, `${label} took ${elapsed}ms despite a 500ms deadline`);
}

test("getText times out while reading a stalled response body", async () => {
  await assertFastRejection(() => getText(`${base}/text`), "getText");
});

test("getBuffer times out while reading a stalled response body", async () => {
  await assertFastRejection(() => getBuffer(`${base}/buffer`), "getBuffer");
});

test("fetchFromMirrors times out while reading a stalled response body", async () => {
  await assertFastRejection(
    () => fetchFromMirrors("timeout", [base], (mirror) => `${mirror}/text`),
    "fetchFromMirrors"
  );
});

test("downloadToFile times out while reading an HTML interstitial body", async () => {
  const dir = await mkdtemp(join(tmpdir(), "biblio-timeout-"));
  try {
    await assertFastRejection(
      () => downloadToFile(`${base}/html`, join(dir, "book.pdf"), { timeoutMs: 500 }),
      "downloadToFile"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
