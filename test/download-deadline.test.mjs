// BIBLIO_DOWNLOAD_TIMEOUT_MS bounds how long a file server may take to answer
// with headers. Once bytes flow, only the idle watchdog applies: a slow but
// steady transfer longer than the header budget must still complete.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeServer, listenLocal } from "./helpers/mirror-server.mjs";

process.env.BIBLIO_DOWNLOAD_TIMEOUT_MS = "150";
process.env.BIBLIO_DOWNLOAD_STALL_MS = "1000";

const { downloadToFile } = await import("../dist/http.js");

const CHUNK = Buffer.alloc(16 * 1024, 0x61);
const CHUNKS = 12; // 12 chunks, one every 60 ms: ~720 ms, well past the 150 ms header budget.

const server = createServer((req, res) => {
  if (req.url === "/steady") {
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(CHUNK.length * CHUNKS),
    });
    let sent = 0;
    const tick = setInterval(() => {
      res.write(CHUNK);
      sent += 1;
      if (sent === CHUNKS) {
        clearInterval(tick);
        res.end();
      }
    }, 60);
    res.on("close", () => clearInterval(tick));
    return;
  }
  if (req.url === "/no-headers") {
    // Never answers: the header budget must cut this off.
    return;
  }
  if (req.url === "/stalled-body") {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.write(CHUNK);
    // Then silence: the idle watchdog must cut this off.
  }
});
const base = await listenLocal(server);
test.after(() => closeServer(server));

test("a steady transfer longer than the header budget completes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "biblio-deadline-"));
  try {
    const started = Date.now();
    const result = await downloadToFile(`${base}/steady`, join(dir, "book.bin"));
    const elapsed = Date.now() - started;
    assert.equal(result.bytes, CHUNK.length * CHUNKS);
    assert.ok(elapsed > 150, `the transfer must outlast the header budget (took ${elapsed}ms)`);
    assert.equal((await readFile(join(dir, "book.bin"))).length, CHUNK.length * CHUNKS);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a server that never sends headers is cut off by the header budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "biblio-deadline-"));
  try {
    const started = Date.now();
    await assert.rejects(downloadToFile(`${base}/no-headers`, join(dir, "book.bin")));
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `header budget is 150ms, took ${elapsed}ms`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a body that goes silent is cut off by the idle watchdog, not the header budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "biblio-deadline-"));
  try {
    const started = Date.now();
    await assert.rejects(
      downloadToFile(`${base}/stalled-body`, join(dir, "book.bin")),
      /stalled|aborted/i
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 900 && elapsed < 3000, `idle budget is 1000ms, took ${elapsed}ms`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
