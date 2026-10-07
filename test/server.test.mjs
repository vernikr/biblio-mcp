// Tests for the MCP tool surface, driven over an in-memory transport.
//
// This is the check whose absence let a broken build look healthy: upstream CI
// only sent `initialize` and `tools/list`, both of which succeed even when every
// `tools/call` fails. Talking to a real server in-process is what closes that
// gap, and doing it here keeps it off the critical path of a live install.

import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";

const REQUIRED_TOOLS = [
  "search_books",
  "book_details",
  "get_download_links",
  "download_book",
  "search_papers",
  "get_paper",
];

async function withClient(fn) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: "test", version: "0.0.0" });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

test("the server exposes exactly the documented tool set", async () => {
  await withClient(async (client) => {
    const info = await client.getServerVersion();
    assert.equal(info.name, "biblio-mcp");

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...REQUIRED_TOOLS].sort());
  });
});

test("every tool advertises an input schema with its required fields", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      assert.ok(tool.inputSchema, `${tool.name} must publish an inputSchema`);
      assert.ok(
        Array.isArray(tool.inputSchema.required) && tool.inputSchema.required.length > 0,
        `${tool.name} must declare at least one required argument`
      );
      assert.ok(tool.description && tool.description.length > 20, `${tool.name} needs a description`);
    }
  });
});

test("download_book requires md5 and output_dir", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const dl = tools.find((t) => t.name === "download_book");
    assert.deepEqual([...dl.inputSchema.required].sort(), ["md5", "output_dir"]);
  });
});

test("argument validation names the field an agent got wrong", async () => {
  // An agent that guesses `dest` instead of `output_dir` must be told which
  // field was wanted — that is the difference between a one-turn correction and
  // an agent going off to read the source code.
  //
  // Note the contract: the SDK reports this as an isError result, not a thrown
  // exception. The payload is still a raw zod issue dump, which phase 3 of the
  // improvement plan replaces with a human-readable hint plus an example.
  await withClient(async (client) => {
    const result = await client.callTool({
      name: "download_book",
      arguments: { md5: "524037f395462d37b31f2b28fede24fb", dest: "/tmp" },
    });
    assert.equal(result.isError, true);
    const text = String(result.content?.[0]?.text ?? "");
    assert.match(text, /output_dir/);
  });
});

test("search_books documents which sources are searched by default", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const sb = tools.find((t) => t.name === "search_books");
    const sourcesDesc = sb.inputSchema.properties.sources.description;
    assert.match(sourcesDesc, /annas/);
    assert.match(sourcesDesc, /libgen/);
    // The description must stay truthful about zlibrary being off by default,
    // otherwise an agent will assume three sources answered and got nothing.
    assert.match(sourcesDesc, /zlibrary/);
  });
});
