// Concurrent and repeated downloads must not corrupt each other's files, and a
// filename the caller chose must never be silently overwritten.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const md5 = "d".repeat(32);
const body = Buffer.concat([Buffer.from("%PDF-1.4 race test "), Buffer.alloc(256 * 1024, 7)]);

const server = createServer((req, res) => {
  if (req.url?.startsWith("/ads.php")) {
    res.writeHead(200, { "content-type": "text/html; charset=UTF-8" }).end(
      `<html><body>Library Genesis <a href="get.php?md5=${md5}&key=K">GET</a> ` +
        `@book{book:1, title={Race Book}, author={Tester}}</body></html>`
    );
    return;
  }
  if (req.url?.startsWith("/get.php")) {
    // Slow enough that two calls overlap on disk.
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.length });
    res.write(body.subarray(0, body.length / 2));
    setTimeout(() => res.end(body.subarray(body.length / 2)), 150);
    return;
  }
  res.writeHead(404).end("not found");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const mirror = `http://127.0.0.1:${server.address().port}`;
process.env.BIBLIO_LIBGEN_MIRRORS = mirror;
process.env.BIBLIO_ANNAS_MIRRORS = mirror;
process.env.BIBLIO_MIRROR_STAGGER_MS = "0";
process.env.BIBLIO_TIMEOUT_MS = "2000";
delete process.env.BIBLIO_ANNAS_API_KEY;

const { createServer: createMcpServer } = await import("../dist/server.js");

test.after(() => new Promise((resolve) => server.close(resolve)));

async function download(args) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = createMcpServer();
  const client = new Client({ name: "test", version: "0.0.0" });
  try {
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: "download_book", arguments: { md5, ...args } });
    return { isError: result.isError === true, payload: JSON.parse(result.content[0].text) };
  } finally {
    await client.close().catch(() => {});
    await mcp.close().catch(() => {});
  }
}

test("two concurrent downloads of the same md5 into one directory both succeed intact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "biblio-race-"));
  try {
    const [a, b] = await Promise.all([
      download({ output_dir: dir }),
      download({ output_dir: dir }),
    ]);
    assert.equal(a.payload.saved, true, JSON.stringify(a.payload));
    assert.equal(b.payload.saved, true, JSON.stringify(b.payload));
    assert.equal(a.payload.md5MatchesRequest, false, "the fake bytes differ from the catalog md5");
    const written = readFileSync(join(dir, `${md5}.pdf`));
    assert.equal(written.equals(body), true, "the final file is the complete download");
    const leftovers = readdirSync(dir).filter((name) => name.endsWith(".downloading"));
    assert.deepEqual(leftovers, [], "no staging file may be left behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a filename that already exists is refused, and the existing file is untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "biblio-race-"));
  try {
    const keep = join(dir, "mine.pdf");
    writeFileSync(keep, "my notes, not a book");
    const result = await download({ output_dir: dir, filename: "mine.pdf" });
    assert.equal(result.isError, true);
    assert.match(result.payload.reason, /already exists/);
    assert.equal(readFileSync(keep, "utf8"), "my notes, not a book");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
