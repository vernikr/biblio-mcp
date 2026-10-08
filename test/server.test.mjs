// Tests for the MCP tool surface, driven over an in-memory transport.

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
  "healthcheck",
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
      // Empty required lists are valid; tools needing arguments must declare them.
      const required = tool.inputSchema.required;
      assert.ok(
        required === undefined || Array.isArray(required),
        `${tool.name} must publish "required" as an array when present`
      );
      if (tool.name !== "healthcheck") {
        assert.ok(
          Array.isArray(required) && required.length > 0,
          `${tool.name} must declare at least one required argument`
        );
      }
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
  // Validation errors must name fields so an agent can correct its call.
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

test("search_books advertises that an explicit source list must be non-empty", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const sb = tools.find((t) => t.name === "search_books");
    assert.equal(sb.inputSchema.properties.sources.minItems, 1);
  });
});

test("the reported version matches package.json", async () => {
  // SERVER_VERSION used to be a hardcoded string, so bumping the version left
  // `--version` and `--selfcheck` advertising the previous release.
  const { readFile } = await import("node:fs/promises");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(await readFile(join(here, "..", "package.json"), "utf8"));

  await withClient(async (client) => {
    const info = await client.getServerVersion();
    assert.equal(info.name, "biblio-mcp");
    assert.equal(info.version, pkg.version);
  });
});
