// download_book must write only inside output_dir: a caller-supplied filename
// is a plain name, never a path. Driven through the real MCP tool surface
// against a local fake Libgen mirror.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const md5 = "7".repeat(32);
const server = createServer((req, res) => {
  if (req.url?.startsWith("/ads.php")) {
    res.writeHead(200, { "content-type": "text/html; charset=UTF-8" });
    res.end(
      `<html><body>Library Genesis <a href="get.php?md5=${md5}&key=K">GET</a> ` +
        `@book{book:1, title={Plain Book}, author={Tester}}</body></html>`
    );
    return;
  }
  if (req.url?.startsWith("/get.php")) {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(Buffer.concat([Buffer.from("%PDF-1.4 test"), Buffer.alloc(64, 1)]));
    return;
  }
  res.writeHead(404).end("not found");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const mirror = `http://127.0.0.1:${server.address().port}`;
process.env.BIBLIO_LIBGEN_MIRRORS = mirror;
process.env.BIBLIO_ANNAS_MIRRORS = mirror;
process.env.BIBLIO_MIRROR_STAGGER_MS = "0";
process.env.BIBLIO_TIMEOUT_MS = "1000";
delete process.env.BIBLIO_ANNAS_API_KEY;

const { createServer: createMcpServer } = await import("../dist/server.js");

test.after(() => new Promise((resolve) => server.close(resolve)));

async function callDownload(args) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = createMcpServer();
  const client = new Client({ name: "test", version: "0.0.0" });
  try {
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
    return await client.callTool({ name: "download_book", arguments: { md5, ...args } });
  } finally {
    await client.close().catch(() => {});
    await mcp.close().catch(() => {});
  }
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "biblio-fname-"));
  const outDir = join(root, "books");
  return { root, outDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a filename with parent-directory segments is rejected and writes nothing", async () => {
  const box = sandbox();
  try {
    const escaped = join(box.root, "escaped.pdf");
    const result = await callDownload({ output_dir: box.outDir, filename: "../escaped.pdf" });
    assert.equal(result.isError, true, "the call must fail, not report a saved file");
    assert.equal(existsSync(escaped), false, "nothing may land outside output_dir");
    assert.equal(existsSync(join(box.outDir, `${md5}.downloading`)), false);
  } finally {
    box.cleanup();
  }
});

test("a filename containing a path separator is rejected", async () => {
  const box = sandbox();
  try {
    const result = await callDownload({ output_dir: box.outDir, filename: "sub/x.pdf" });
    assert.equal(result.isError, true);
    assert.equal(existsSync(join(box.outDir, "sub")), false);
  } finally {
    box.cleanup();
  }
});

test("a plain filename is saved inside output_dir", async () => {
  const box = sandbox();
  try {
    const result = await callDownload({ output_dir: box.outDir, filename: "plain-book.pdf" });
    assert.notEqual(result.isError, true);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.saved, true);
    assert.equal(dirname(payload.path), box.outDir);
    assert.ok(existsSync(join(box.outDir, "plain-book.pdf")));
  } finally {
    box.cleanup();
  }
});
