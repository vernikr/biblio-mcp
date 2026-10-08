// One missing record must not poison a healthy source. Covers mirror cooldowns,
// the source circuit, and its recovery after the cooldown.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

const good = "a".repeat(32);
const server = createServer((req, res) => {
  if (req.url?.startsWith("/ads.php?md5=" + good)) {
    res.writeHead(200, { "content-type": "text/html; charset=UTF-8" }).end(
      `<html><body>Library Genesis <a href="get.php?md5=${good}&key=K">GET</a> ` +
        `@book{book:1, title={Healthy Book}, author={Tester}}</body></html>`
    );
    return;
  }
  if (req.url === "/boom") {
    res.writeHead(500).end("boom");
    return;
  }
  res.writeHead(404, { "content-type": "text/html" }).end("<html>Not found</html>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
process.env.BIBLIO_LIBGEN_MIRRORS = base;
process.env.BIBLIO_ANNAS_MIRRORS = base;
process.env.BIBLIO_MIRROR_STAGGER_MS = "0";
process.env.BIBLIO_TIMEOUT_MS = "2000";
process.env.BIBLIO_MIRROR_DEAD_TTL_MS = "400";
delete process.env.BIBLIO_ANNAS_API_KEY;

const http = await import("../dist/http.js");
const providers = await import("../dist/providers/index.js");
const circuit = await import("../dist/providers/circuit.js");

test.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));

test("a single 404 for one record does not put the mirror into cooldown", async () => {
  http.resetMirrorCache();
  await assert.rejects(
    http.fetchFromMirrors("libgen", [base], (b) => `${b}/ads.php?md5=${"f".repeat(32)}`)
  );
  assert.deepEqual(http.mirrorCacheSnapshot().dead, []);
  assert.equal(http.areMirrorsCoolingDown("libgen", [base]), false);
});

test("a server error still cools the mirror down", async () => {
  http.resetMirrorCache();
  await assert.rejects(http.fetchFromMirrors("libgen", [base], (b) => `${b}/boom`));
  assert.deepEqual(http.mirrorCacheSnapshot().dead, [base]);
});

test("three missing records do not open the libgen circuit; a healthy record still resolves", async () => {
  http.resetMirrorCache();
  for (let i = 0; i < 3; i++) {
    const missing = String(i + 1).repeat(32);
    const links = await providers.resolveDownloads(missing);
    assert.deepEqual(links, []);
  }
  assert.equal(circuit.sourceCircuitMessage("libgen"), undefined, "missing records are not source failures");

  const healthy = await providers.resolveDownloads(good);
  assert.ok(healthy.some((link) => link.url.includes("get.php")), "libgen still answers");
  const details = await providers.bookDetails(good);
  assert.equal(details.title, "Healthy Book");
});

test("an opened circuit closes again once its cooldown has passed", async () => {
  const zl = "zlibrary";
  for (let i = 0; i < 3; i++) {
    await assert.rejects(
      circuit.withSourceCircuit(zl, async () => {
        throw new Error("All 1 zlibrary mirror(s) failed: x -> ECONNRESET");
      })
    );
  }
  assert.match(circuit.sourceCircuitMessage(zl) ?? "", /circuit open/);

  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(circuit.sourceCircuitMessage(zl), undefined, "the cooldown has elapsed");
  assert.equal(await circuit.withSourceCircuit(zl, async () => "back"), "back");
});
