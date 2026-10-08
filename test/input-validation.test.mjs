import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { closeServer, listenLocal } from "./helpers/mirror-server.mjs";

let requests = [];
const mirrorServer = createServer((req, res) => {
  requests.push(req.url);
  res.writeHead(200, { "content-type": "text/html" }).end(
    '<title>Library Genesis / Sci-Hub</title><embed id="pdf" src="/paper.pdf">'
  );
});
const mirror = await listenLocal(mirrorServer);
process.env.BIBLIO_LIBGEN_MIRRORS = mirror;
process.env.BIBLIO_ANNAS_MIRRORS = mirror;
process.env.BIBLIO_SCIHUB_MIRRORS = mirror;
process.env.BIBLIO_ZLIB_MIRRORS = mirror;
process.env.BIBLIO_TIMEOUT_MS = "1000";
delete process.env.BIBLIO_ANNAS_API_KEY;
const { createServer: createMcpServer } = await import("../dist/server.js");
test.after(() => closeServer(mirrorServer));

async function call(name, args) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({ name: "input-test", version: "0.0.0" });
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

const searches = [
  ["search_books", "query", { sources: ["libgen"] }],
  ["search_papers", "query", {}],
  ["get_paper", "identifier", {}],
];
for (const [name, field, extra] of searches) {
  for (const blank of ["", " \t\n "]) {
    test(`${name} refuses ${JSON.stringify(blank)} before any provider request`, async () => {
      requests = [];
      const result = await call(name, { ...extra, [field]: blank });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, new RegExp(field));
      assert.match(result.content[0].text, /Example:/);
      assert.doesNotMatch(result.content[0].text, /_parse is not a function/);
      assert.deepEqual(requests, []);
    });
  }
}

for (const [name, field, extra] of searches.slice(0, 2)) {
  test(`${name} trims a non-empty query without changing its contents`, async () => {
    const result = await call(name, { ...extra, [field]: "  dune frank herbert  " });
    assert.notEqual(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).query, "dune frank herbert");
  });
}
for (const identifier of ["10.1234/input-test", "https://example.test/article/input-test"]) {
  test(`get_paper preserves ${identifier} after trimming`, async () => {
    requests = [];
    const result = await call("get_paper", { identifier: ` ${identifier} ` });
    assert.notEqual(result.isError, true);
    assert.ok(requests.includes(`/${encodeURIComponent(identifier)}`));
    assert.equal(JSON.parse(result.content[0].text).pdfUrl, `${mirror}/paper.pdf`);
  });
}
