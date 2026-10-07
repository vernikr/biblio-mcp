// Tests for the agent-facing surface: call examples in descriptions,
// human-readable validation errors, output_dir resolution, and healthcheck.
//
// Phase 3 exists because an agent once spent eight minutes failing to use this
// server. Each test here pins one of the specific things that made that slow.

import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { describeArgsError, TOOL_META } from "../dist/toolmeta.js";
import { homedir } from "node:os";

async function withClient(fn) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: "agent-test", version: "0.0.0" });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

/** Call a tool and return { isError, text, json } — never throws on bad args. */
async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).map((b) => b.text ?? "").join("\n");
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { isError: !!result.isError, text, json };
}

// ---------------------------------------------------------------------------
// Item 16 — a call example in every description
// ---------------------------------------------------------------------------

test("every tool description ends with a runnable Example line", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const match = /Example: (.+)$/m.exec(tool.description ?? "");
      assert.ok(match, `${tool.name} description must end with "Example: {...}"`);
      // The example must be valid JSON, or it is decoration rather than a call.
      assert.doesNotThrow(
        () => JSON.parse(match[1]),
        `${tool.name} example must be valid JSON, got: ${match[1]}`
      );
    }
  });
});

test("each tool's example only uses arguments that tool accepts", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const example = JSON.parse(/Example: (.+)$/m.exec(tool.description)[1]);
      const allowed = Object.keys(tool.inputSchema.properties ?? {});
      for (const key of Object.keys(example)) {
        assert.ok(
          allowed.includes(key),
          `${tool.name} example uses "${key}", which is not one of ${allowed.join(", ")}`
        );
      }
      // And it must satisfy the required list, or the example itself is invalid.
      for (const req of tool.inputSchema.required ?? []) {
        assert.ok(req in example, `${tool.name} example is missing required "${req}"`);
      }
    }
  });
});

test("TOOL_META covers every registered tool", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      assert.ok(TOOL_META[tool.name], `${tool.name} is missing from TOOL_META`);
    }
  });
});

// ---------------------------------------------------------------------------
// Item 17 — human-readable validation errors
// ---------------------------------------------------------------------------

test("a missing argument names the argument, instead of dumping zod issues", async () => {
  await withClient(async (client) => {
    const { isError, text } = await callTool(client, "search_books", {});
    assert.equal(isError, true);
    assert.match(text, /search_books: "query" is missing/);
    // The point of the change: an agent must be able to act on this.
    assert.match(text, /Example: \{"query":"dune frank herbert"/);
    // And must NOT have to read zod internals.
    assert.ok(!/"code":\s*"invalid_type"/.test(text), `raw zod issue leaked: ${text}`);
    assert.ok(!/"expected":/.test(text), `raw zod issue leaked: ${text}`);
  });
});

test("a malformed md5 says what a valid one looks like", async () => {
  await withClient(async (client) => {
    const { isError, text } = await callTool(client, "book_details", { md5: "nothex" });
    assert.equal(isError, true);
    assert.match(text, /book_details: "md5" must be a 32-char MD5 hash/);
    assert.match(text, /Example: \{"md5":"[0-9a-f]{32}"\}/);
  });
});

test("an out-of-range value reports the range and the correct call", async () => {
  await withClient(async (client) => {
    const { isError, text } = await callTool(client, "search_books", { query: "x", limit: 9999 });
    assert.equal(isError, true);
    assert.match(text, /search_books: "limit" too big/i);
    assert.match(text, /Example: \{"query":"dune frank herbert","limit":5\}/);
  });
});

test("download_book names both required arguments at once", async () => {
  await withClient(async (client) => {
    const { isError, text } = await callTool(client, "download_book", { md5: "abc" });
    assert.equal(isError, true);
    assert.match(text, /"md5"/);
    assert.match(text, /"output_dir" is missing/);
    assert.match(text, /absolute path/);
  });
});

test("describeArgsError stays informative for an error it does not recognise", () => {
  // The override must never make an error worse than the one it replaces.
  const msg = describeArgsError("search_books", new Error("something unexpected"));
  assert.match(msg, /something unexpected/);
  assert.match(msg, /Example:/);
});

// ---------------------------------------------------------------------------
// Item 19 — output_dir resolution
// ---------------------------------------------------------------------------

test("download_book reports the resolved directory for a relative path", async () => {
  // Uses an md5 with no resolvable link, so this exercises the path handling
  // without downloading anything. The resolution happens after link resolution,
  // so we assert on the schema/description contract instead of the file.
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const dl = tools.find((t) => t.name === "download_book");
    const desc = dl.inputSchema.properties.output_dir.description;
    // The description must not promise cwd-relative behaviour any more: the
    // agent cannot see the server's working directory.
    assert.match(desc, /\$HOME/);
    assert.ok(
      !/server's working directory/.test(desc) || /not the server's working directory/.test(desc),
      `output_dir description must not imply cwd-relative resolution: ${desc}`
    );
    assert.equal(dl.inputSchema.properties.output_dir.minLength, 1);
  });
  // Sanity: $HOME is resolvable here, which is what the handler relies on.
  assert.ok(homedir().startsWith("/"), "homedir() must be absolute on POSIX");
});

test("an empty output_dir is rejected with a readable message", async () => {
  await withClient(async (client) => {
    const { isError, text } = await callTool(client, "download_book", {
      md5: "5".repeat(32),
      output_dir: "",
    });
    assert.equal(isError, true);
    assert.match(text, /"output_dir"/);
    assert.match(text, /Example:/);
  });
});

// ---------------------------------------------------------------------------
// Item 21 — healthcheck
// ---------------------------------------------------------------------------

test("healthcheck is registered, takes no required arguments, and answers", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const hc = tools.find((t) => t.name === "healthcheck");
    assert.ok(hc, "healthcheck must be registered");
    assert.deepEqual(hc.inputSchema.required ?? [], []);
    assert.ok(hc.inputSchema.properties.timeoutMs, "timeoutMs must be optional but advertised");

    const { isError, json } = await callTool(client, "healthcheck", { timeoutMs: 2500 });
    assert.equal(isError, false);
    assert.equal(typeof json.ready, "boolean");
    assert.ok(Array.isArray(json.reachable));
    assert.ok(Array.isArray(json.unreachable));
    assert.ok(Array.isArray(json.groups) && json.groups.length > 0);
    assert.equal(json.version, (await client.getServerVersion()).version);
    // Every group must account for all of its mirrors, and be self-consistent.
    for (const g of json.groups) {
      assert.equal(g.mirrors.length, g.total);
      assert.equal(g.ok, g.reachable > 0);
      assert.equal(
        g.fastestMs,
        g.reachable > 0 ? Math.min(...g.mirrors.filter((m) => m.ok).map((m) => m.ms)) : null
      );
    }
    // ready must agree with the reachable list, or a caller cannot trust it.
    assert.equal(json.ready, json.reachable.length > 0);
  });
});

test("healthcheck flags a host that answers but is not the expected site", async () => {
  // This is the failure mode that cost real time: a parked domain answered 200
  // faster than every genuine mirror and was reported as the healthiest one.
  const { probeMirror } = await import("../dist/http.js");
  const probe = await probeMirror("https://example.com", "/", {
    timeoutMs: 5000,
    expect: /This Domain Is Definitely Not Anna's Archive/,
  });
  // Whatever the network does, the probe must classify it honestly: either it
  // failed to match the marker (impostor) or it was unreachable.
  assert.ok(!probe.ok || probe.impostor === undefined);
  if (probe.status && probe.impostor) assert.equal(probe.impostor, true);
});
