// Each tool's description and example live in one place (src/toolmeta.ts).
// These tests keep that place honest: every served tool has an entry, no entry
// is stale, and every example is a valid call under the tool's own schema.

import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { TOOL_META, toolDescription } from "../dist/toolmeta.js";

async function listTools() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: "test", version: "0.0.0" });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return (await client.listTools()).tools;
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

const tools = await listTools();
const served = new Set(tools.map((t) => t.name));

test("every served tool has a TOOL_META entry, and no entry is stale", () => {
  assert.deepEqual(
    [...served].filter((name) => !(name in TOOL_META)),
    [],
    "served tools missing from TOOL_META"
  );
  assert.deepEqual(
    Object.keys(TOOL_META).filter((name) => !served.has(name)),
    [],
    "TOOL_META entries for tools that are not served"
  );
});

test("the served description is exactly the one src/toolmeta.ts defines", () => {
  for (const tool of tools) {
    assert.equal(tool.description, toolDescription(tool.name), `${tool.name} description drifted`);
    assert.ok(tool.description.includes("\n\nExample: "), `${tool.name} must end with an example`);
  }
});

test("every example is a valid call under its tool's input schema", () => {
  for (const tool of tools) {
    const args = JSON.parse(TOOL_META[tool.name].example);
    const schema = tool.inputSchema ?? {};
    const properties = schema.properties ?? {};
    const required = schema.required ?? [];

    for (const key of required) {
      assert.ok(key in args, `${tool.name} example lacks required "${key}"`);
    }
    for (const key of Object.keys(args)) {
      assert.ok(key in properties, `${tool.name} example uses unknown argument "${key}"`);
      const prop = properties[key];
      if (prop.pattern) {
        assert.match(String(args[key]), new RegExp(prop.pattern), `${tool.name}.${key} violates its pattern`);
      }
      if (prop.type === "string") assert.equal(typeof args[key], "string", `${tool.name}.${key} must be a string`);
      if (prop.type === "number" || prop.type === "integer") {
        assert.equal(typeof args[key], "number", `${tool.name}.${key} must be a number`);
        if (prop.maximum !== undefined) assert.ok(args[key] <= prop.maximum, `${tool.name}.${key} above maximum`);
        if (prop.minimum !== undefined) assert.ok(args[key] >= prop.minimum, `${tool.name}.${key} below minimum`);
      }
    }
  }
});
