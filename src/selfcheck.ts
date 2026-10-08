// --selfcheck: prove the server actually works, without an MCP client.
//
// The failure this defends against is specific and expensive: a server that
// starts, answers `tools/list`, and then fails every `tools/call`. Nothing the
// upstream CI checked distinguished those two states, so a broken build looked
// green. This routine drives the real tool surface over an in-memory transport,
// which is the only way to know the difference.
//
// Stages, cheapest first, so a broken install is reported in ~1 s and only a
// healthy one goes on to spend time on the network:
//   1. preflight  — Node version, deps, the zod/SDK pairing, build artefact
//   2. tools      — construct the server and list its tools in-process
//   3. mirrors    — probe every host in src/mirrors.ts, with timings
//   4. live       — one real search, only with --selfcheck --live
//
// Exit code 0 means "ready to serve". Non-zero means something is broken.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";
import { probeMirror, resetMirrorCache } from "./http.js";
import { MIRROR_GROUPS } from "./mirrors.js";
import { BOOK_SOURCES, DISABLED_BOOK_SOURCES } from "./providers/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** dist/ and scripts/ are siblings in the repo and in the published package. */
const PREFLIGHT_SCRIPT = resolve(HERE, "..", "scripts", "preflight.mjs");

/** Tools every working build must expose. A missing one means the registration
 *  changed, which is a breaking change for any agent already using it. */
const REQUIRED_TOOLS = [
  "search_books",
  "book_details",
  "get_download_links",
  "download_book",
  "search_papers",
  "get_paper",
  "healthcheck",
];

async function withInMemoryClient<T>(name: string, run: (client: Client) => Promise<T>): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name, version: "0.0.0" });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return await run(client);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

interface StageResult {
  name: string;
  ok: boolean;
  summary: string;
  details?: unknown;
  problem?: string;
}

/** Run scripts/preflight.mjs as a child process.
 *
 * It is a separate process because that script is deliberately plain JavaScript
 * with no build step, so it can gate `pnpm install` — which means it cannot be
 * imported from compiled TypeScript without breaking `rootDir`. Spawning keeps
 * one source of truth instead of duplicating the checks here. */
async function runPreflightStage(): Promise<StageResult> {
  if (!existsSync(PREFLIGHT_SCRIPT)) {
    return {
      name: "preflight",
      ok: false,
      summary: "scripts/preflight.mjs not found",
      problem: `expected it at ${PREFLIGHT_SCRIPT}`,
    };
  }
  const out = await new Promise<{ code: number; stdout: string; stderr: string }>(
    (done) => {
      const child = spawn(process.execPath, [PREFLIGHT_SCRIPT, "--json"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
      child.on("error", (e) => done({ code: 1, stdout, stderr: String(e) }));
    }
  );

  let report: { ok: boolean; checks?: Array<{ name: string; ok: boolean; problem?: string }> } = {
    ok: false,
  };
  try {
    report = JSON.parse(out.stdout);
  } catch {
    return {
      name: "preflight",
      ok: false,
      summary: "preflight produced no parsable output",
      problem: out.stderr.slice(0, 300) || out.stdout.slice(0, 300),
    };
  }

  const failed = (report.checks ?? []).filter((c) => !c.ok);
  return {
    name: "preflight",
    ok: !!report.ok,
    summary: `${(report.checks ?? []).length - failed.length}/${(report.checks ?? []).length} checks passed`,
    details: report.checks,
    problem: failed.map((c) => `${c.name}: ${c.problem ?? "failed"}`).join(" | ") || undefined,
  };
}

async function runToolsStage(): Promise<StageResult> {
  try {
    return await withInMemoryClient("biblio-selfcheck", async (client) => {
      const info = await client.getServerVersion();
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      const missing = REQUIRED_TOOLS.filter((t) => !names.includes(t));
      return {
        name: "tools",
        ok: missing.length === 0,
        summary: `${names.length} tools exposed by ${info?.name} v${info?.version}`,
        details: { names, serverInfo: info },
        problem: missing.length ? `missing required tools: ${missing.join(", ")}` : undefined,
      };
    });
  } catch (e) {
    return {
      name: "tools",
      ok: false,
      summary: "could not list tools",
      problem: String((e as Error)?.message ?? e),
    };
  }
}

async function runMirrorsStage(): Promise<StageResult> {
  // Probe everything, including hosts the negative cache would normally skip —
  // the whole point is to show what is reachable right now.
  resetMirrorCache();
  const groups: Array<{ group: string; results: Awaited<ReturnType<typeof probeMirror>>[] }> = [];
  let anyAlive = false;

  for (const { group, mirrors, probePath, expect } of MIRROR_GROUPS) {
    const results = await Promise.all(
      mirrors.map((base) => probeMirror(base, probePath, { expect }))
    );
    if (results.some((r) => r.ok)) anyAlive = true;
    groups.push({ group, results });
  }

  const alive = groups.filter((g) => g.results.some((r) => r.ok)).map((g) => g.group);
  return {
    name: "mirrors",
    ok: anyAlive,
    summary: `reachable sources: ${alive.length ? alive.join(", ") : "none"}`,
    details: groups,
    problem: anyAlive
      ? undefined
      : "no mirror in any group answered — this looks like a network or DNS block, not a code fault",
  };
}

async function runLiveStage(): Promise<StageResult> {
  try {
    return await withInMemoryClient("biblio-selfcheck", async (client) => {
      const result = await client.callTool(
        { name: "search_books", arguments: { query: "dune frank herbert", limit: 3 } },
        undefined,
        { timeout: 120_000 }
      );
      const text = String((result.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "");
      let parsed: { total?: number; errors?: unknown[] } = {};
      try {
        parsed = JSON.parse(text);
      } catch {
        /* fall through with the raw text below */
      }
      return {
        name: "live",
        ok: !result.isError && (parsed.total ?? 0) > 0,
        summary: `search_books returned ${parsed.total ?? 0} results`,
        details: { isError: !!result.isError, errors: parsed.errors, sample: text.slice(0, 400) },
        problem:
          result.isError || (parsed.total ?? 0) === 0
            ? "the tool surface is reachable but a live search produced nothing"
            : undefined,
      };
    });
  } catch (e) {
    return {
      name: "live",
      ok: false,
      summary: "live search_books call failed",
      problem: String((e as Error)?.message ?? e),
    };
  }
}

export interface SelfcheckReport {
  ok: boolean;
  stages: StageResult[];
  defaults: { sources: string[]; disabledByDefault: string[] };
}

/** Result of the in-process check run before the server binds stdio. */
export interface StartupCheck {
  ok: boolean;
  /** What is broken, in one line. */
  problem?: string;
  /** The command that fixes it, when one is known. */
  fix?: string;
}

/**
 * Prove the tool surface actually works, before serving a single request.
 *
 * The failure this exists for is the one that started this fork: a server that
 * starts, answers `tools/list`, and then fails *every* `tools/call` with
 * `keyValidator._parse is not a function`, because `@modelcontextprotocol/sdk`
 * 1.12.1 declares a `zod: ^3.23.8` peer range and was installed against zod 4.
 * Nothing about that state is visible until a real call is made — so the client
 * shows a healthy tool list and every use fails.
 *
 * Listing tools is not enough to detect it. Calling one is, and calling it with
 * a deliberately INVALID argument costs no network: a healthy server answers
 * with a validation error, a broken one crashes inside its own validator.
 *
 * Runs in-process over an in-memory transport, so it adds milliseconds and no
 * network to startup.
 */
export async function runStartupSelftest(): Promise<StartupCheck> {
  const FIX =
    'pnpm add @modelcontextprotocol/sdk@^1.29.0 zod@^4.4.3 && pnpm run build  ' +
    "(then re-run: pnpm preflight)";

  try {
    return await withInMemoryClient("biblio-startup", async (client) => {
      const { tools } = await client.listTools();
      const missing = REQUIRED_TOOLS.filter((t) => !tools.some((x) => x.name === t));
      if (missing.length > 0) {
        return {
          ok: false,
          problem: `tool surface is incomplete — missing ${missing.join(", ")}`,
          fix: "pnpm run build",
        };
      }

      const result = await client.callTool({
        name: "book_details",
        arguments: { md5: "not-an-md5" },
      });
      const text = String(
        (result.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? ""
      );

      if (/_parse is not a function/.test(text)) {
        return {
          ok: false,
          problem:
            "the argument validator is broken — @modelcontextprotocol/sdk and zod are an " +
            "incompatible pair, so every tool call would fail",
          fix: FIX,
        };
      }
      if (!result.isError) {
        return {
          ok: false,
          problem: `argument validation accepted an invalid md5 (got: ${text.slice(0, 120)})`,
          fix: FIX,
        };
      }
      return { ok: true };
    });
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    return {
      ok: false,
      problem:
        /_parse is not a function/.test(message)
          ? "the argument validator is broken — @modelcontextprotocol/sdk and zod are an " +
            "incompatible pair, so every tool call would fail"
          : `the tool surface could not be exercised: ${message.slice(0, 200)}`,
      fix: /_parse is not a function/.test(message) ? FIX : "pnpm run build",
    };
  }
}

export async function runSelfcheck(opts: { live?: boolean } = {}): Promise<SelfcheckReport> {
  const stages: StageResult[] = [];
  stages.push(await runPreflightStage());
  stages.push(await runToolsStage());
  stages.push(await runMirrorsStage());
  if (opts.live) stages.push(await runLiveStage());

  // A dead mirror group is degraded, not broken: report it, but only fail the
  // run when nothing at all is reachable.
  const ok = stages.every((s) => s.ok);
  return {
    ok,
    stages,
    defaults: {
      sources: BOOK_SOURCES,
      disabledByDefault: DISABLED_BOOK_SOURCES,
    },
  };
}

const ICON = (ok: boolean) => (ok ? "  ok  " : " FAIL ");

export function printSelfcheck(report: SelfcheckReport): void {
  console.log("biblio-mcp selfcheck\n");
  for (const stage of report.stages) {
    console.log(`${ICON(stage.ok)} ${stage.name.padEnd(9)} ${stage.summary}`);
    if (stage.problem) console.log(`        ↳ ${stage.problem}`);
    if (stage.name === "mirrors" && Array.isArray(stage.details)) {
      for (const g of stage.details as Array<{
        group: string;
        results: Array<{
          base: string;
          ok: boolean;
          status?: number;
          ms: number;
          impostor?: boolean;
        }>;
      }>) {
        for (const r of g.results) {
          // Distinguish "down" from "answers but is not the site we expect":
          // the second is worse, because it silently returns plausible garbage.
          const verdict = r.impostor
            ? `HTTP ${r.status} — NOT the expected site`
            : r.status
              ? `HTTP ${r.status}`
              : "unreachable";
          console.log(`          ${r.ok ? "·" : "✗"} ${g.group.padEnd(9)} ${r.base.padEnd(30)} ${verdict} ${r.ms}ms`);
        }
      }
    }
  }
  console.log(
    `\ndefault sources: ${report.defaults.sources.join(", ")}` +
      (report.defaults.disabledByDefault.length
        ? ` (excluded by default: ${report.defaults.disabledByDefault.join(", ")})`
        : "")
  );
  console.log(report.ok ? "\nselfcheck passed." : "\nselfcheck FAILED — see the lines above.");
}
