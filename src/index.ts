#!/usr/bin/env node
// biblio-mcp — one MCP server for Anna's Archive, Library Genesis, Sci-Hub, and
// Z-Library. Search books and papers, resolve download links, fetch files.
//
// Transport: stdio. Run with `node dist/index.js`, or through a client such as
// `npx biblio-mcp`.
//
// This file is only the entry point: CLI flags and the stdio transport. The tool
// surface lives in ./server.ts and the health checks in ./selfcheck.ts, so both
// can be exercised without binding a transport.
//
// Usage:
//   node dist/index.js                    start the MCP server on stdio
//   node dist/index.js --selfcheck        verify install, tools and mirrors
//   node dist/index.js --selfcheck --live ...and run one real search
//   node dist/index.js --version
//   node dist/index.js --help
//
// NOTE ON STDOUT: in server mode stdout is the JSON-RPC channel. Anything
// printed there corrupts the protocol, so diagnostics must go to stderr.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { runSelfcheck, printSelfcheck, runStartupSelftest } from "./selfcheck.js";

const USAGE = `${SERVER_NAME} v${SERVER_VERSION}

Usage:
  node dist/index.js                     start the MCP server on stdio
  node dist/index.js --selfcheck         verify install, tool surface, mirrors
  node dist/index.js --selfcheck --live  ...and perform one real search
  node dist/index.js --version           print the version
  node dist/index.js --help              show this help

Environment:
  BIBLIO_TIMEOUT_MS              HTML request budget (default 8000)
  BIBLIO_DOWNLOAD_TIMEOUT_MS     file download budget (default 600000)
  BIBLIO_DOWNLOAD_STALL_MS       abort a download idle this long (default 30000)
  BIBLIO_MIRROR_DEAD_TTL_MS      how long a failed mirror is skipped (default 300000)
  BIBLIO_MIRROR_STAGGER_MS       head start between mirror attempts (default 120)
  BIBLIO_DISABLE_SOURCES         comma list; defaults to "zlibrary"
  BIBLIO_ANNAS_MIRRORS           override the Anna's Archive mirror list
  BIBLIO_LIBGEN_MIRRORS          override the Library Genesis mirror list
  BIBLIO_SCIHUB_MIRRORS          override the Sci-Hub mirror list
  BIBLIO_ZLIB_MIRRORS            override the Z-Library mirror list
  BIBLIO_IPFS_GATEWAYS           override the IPFS gateway list
  BIBLIO_SKIP_STARTUP_CHECK      set to bypass the startup tool-surface check`

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }

  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${SERVER_NAME} v${SERVER_VERSION}\n`);
    return 0;
  }

  if (argv.includes("--selfcheck")) {
    const report = await runSelfcheck({ live: argv.includes("--live") });
    printSelfcheck(report);
    return report.ok ? 0 : 1;
  }

  // Prove the tool surface works before binding stdio. A server that starts and
  // then fails every call is worse than one that refuses to start: the client
  // shows a healthy tool list and every use fails, with no explanation anywhere.
  // Set BIBLIO_SKIP_STARTUP_CHECK=1 to bypass this in an emergency.
  if (!process.env.BIBLIO_SKIP_STARTUP_CHECK) {
    const startup = await runStartupSelftest();
    if (!startup.ok) {
      process.stderr.write(
        `${SERVER_NAME}: refusing to start — ${startup.problem}\n` +
          (startup.fix ? `  fix: ${startup.fix}\n` : "") +
          `  (bypass with BIBLIO_SKIP_STARTUP_CHECK=1 if you need a broken server)\n`
      );
      return 1;
    }
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr, never stdout — see the note at the top of this file.
  process.stderr.write(`${SERVER_NAME} v${SERVER_VERSION} ready on stdio\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    // Always propagate a non-zero result. In server mode the process must stay
    // alive to serve stdio, but setting exitCode does not exit it — it only
    // decides what a client sees when the process does end. Discarding the code
    // here used to make a server that refused to start look like a clean exit.
    if (code !== 0) process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`${SERVER_NAME}: fatal: ${String((err as Error)?.stack ?? err)}\n`);
    process.exitCode = 1;
  }
);
