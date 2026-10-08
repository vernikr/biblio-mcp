# biblio-mcp

[![CI](https://github.com/vernikr/biblio-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/vernikr/biblio-mcp/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/biblio-mcp.svg)](LICENSE)

<!-- cover:start -->
## Why this fork

The idea is the same as the original: one tool that lets your AI assistant find books and
research papers across the shadow libraries and get them for you. This fork is about making
that something you can rely on.

- **It works the first time.** One setup command installs what is missing and checks the
  server before you use it. A broken setup is caught on the spot, with the fix spelled out,
  instead of failing every request. Invalid client configuration is left untouched.
- **Faster answers.** Searches come back many times faster, because the server stops waiting on
  websites that are no longer there.
- **Honest results.** A source that is down is reported, not silently dropped. A website that
  has stopped being the real library is refused, and a page that asks you to prove you are a
  human is reported as such, not handed over as the book. Downloaded files are checked, so you know you
  got the right book. Files you name explicitly won't replace an existing file.
- **Cleaner information.** Titles, authors and formats come from the right fields, and broken
  or useless links are filtered out.
- **Less time lost.** When something goes wrong, the message says what happened and what to do
  next, and a one-call health check tells you whether anything is reachable at all.

One honest caveat: the sources are third-party websites that can go offline or change at any
time. This fork cannot promise they stay reachable, but it promises that you will know right
away when they do not.
<!-- cover:end -->

## Quick start

```bash
git clone https://github.com/vernikr/biblio-mcp.git
cd biblio-mcp
node scripts/install.mjs
```

Requires Node.js 18+ and pnpm. The installer builds and verifies the server, then prints the MCP
client configuration. See [Install](#install) for manual setup and configuration options.

**One [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that searches Anna's Archive, Library Genesis (Libgen), Sci-Hub, and Z-Library — all at once.**

Search millions of books, academic papers, and research articles across every major shadow library through a single unified interface. Resolve download links and fetch files directly from your AI assistant — Claude Code, Claude Desktop, Cline, Cursor, or any MCP-compatible client.

No API keys. No login. No per-source servers to juggle. One server, seven tools, four sources.

---

## What is biblio-mcp?

biblio-mcp is an open-source MCP server that acts as a unified search layer across the four largest shadow libraries on the internet. Instead of installing and configuring separate MCP servers for each source, biblio-mcp combines them into a single server with a shared data model and automatic deduplication.

It connects to any MCP client (Claude, Cline, Cursor, Windsurf, or custom agents) and gives your AI assistant the ability to search for books, find academic papers by DOI, resolve download links, and download files — all through natural language.

### How it works

1. **Fan-out search** — a single query hits every enabled source concurrently.
2. **MD5-based deduplication** — results from different sources for the same book are merged by MD5 hash (the universal identifier these libraries share), keeping the richest metadata from each.
3. **Mirror rotation with memory** — every source declares a list of mirror domains. They are tried concurrently with a head start for the preferred one; a host that fails is skipped for a cooldown window instead of being retried on every request, and the host that worked is remembered.
4. **Fault isolation** — if one source is down, the others still return results. Failures are reported separately, never silently swallowed.

### Sources covered

| Source | What it provides | Searched by default? |
|---|---|---|
| **Anna's Archive** | Book search, metadata, download links (partner servers, IPFS) | Yes |
| **Library Genesis (Libgen)** | Book search, academic paper search (scimag), direct `get.php` downloads | Yes |
| **Sci-Hub** | Paper PDF resolution by DOI, URL, or title | On demand via `get_paper` or `search_papers({ resolvePdfs: true })` |
| **Z-Library** | Best-effort public book search (no login required) | **No** — see [Known limitations](#known-limitations) |

## Install

### One command

Use the [Quick start](#quick-start) command above.

The installer checks Node and your package manager, installs locked dependencies, checks the
SDK/Zod pairing, builds, and verifies a real tool call before printing your MCP config.
Add `--write-config <path>` to merge the entry into your config and keep a `.bak` copy.
Invalid JSON or a non-object `mcpServers` value is refused before changing the file or its backup.
Add `--dry-run` to see every step without writing anything. Live mirror checks are skipped by default; pass `--live` to run
`dist/index.js --selfcheck --live` after the build, or `--skip-network` to explicitly skip them.
Dependency installation may still need registry access. A checkout with `pnpm-lock.yaml`
requires pnpm and installs with `--frozen-lockfile`; npm is not used as a substitute.

```bash
node scripts/install.mjs --write-config ~/.config/claude/mcp.json
```

### Why not `npm install biblio-mcp`?

**This fork is not published to npm, on purpose.** The `biblio-mcp` package on npm is the
upstream release, and its published dependency set is the combination that breaks: it resolves
`@modelcontextprotocol/sdk@1.12.1` — whose peer range is `zod: ^3.23.8` — against `zod@4.4.3`.
That server starts, answers `tools/list`, and then fails every `tools/call`. Publishing a
same-named package that silently replaced it would be worse than the situation it fixes, and
publishing under a new name would fragment the search results people already use. So the
supported install is from source, and `package.json` is marked private to prevent accidental
publishing under the upstream name. The installer above makes source installation one command.

### Manual install

Requires **Node.js ≥ 18** and **pnpm**. This fork installs with pnpm and ships a
`pnpm-lock.yaml`; it deliberately does **not** ship an npm lockfile, because the two
resolved different dependency trees and one of them was broken (see
[Why pnpm?](#why-pnpm-and-not-npm)).

```bash
git clone https://github.com/vernikr/biblio-mcp.git
cd biblio-mcp
pnpm install
pnpm build
```

Then check it before you wire it into anything:

```bash
pnpm preflight   # dependencies and the zod/SDK pairing — offline, ~1 s
pnpm selfcheck   # ...plus the tool surface and every mirror, with timings
pnpm selfcheck:live   # ...plus one real search against live mirrors
```

`pnpm verify` runs the build, the test suite and the selfcheck in one go.

A healthy `preflight` looks like this:

```
  ok   node            v20.20.2
  ok   lockfiles       pnpm-lock.yaml
  ok   dependencies    node_modules present
  ok   zod-sdk-compat  sdk 1.29.0 + zod 4.4.3 (range "^3.25 || ^4.0")
  ok   build           /path/to/biblio-mcp/dist/index.js

ready to run: node dist/index.js
```

### Why pnpm and not npm?

The upstream repository shipped both `package-lock.json` and (in forks) `pnpm-lock.yaml`, and
they disagreed: npm resolved `@modelcontextprotocol/sdk@1.12.1` against `zod@4.4.3`, which is
exactly the broken pairing described in [About this fork](#about-this-fork). `npm ci` therefore
produced a server that started and then failed every tool call. This fork keeps one lockfile so
there is one answer.

### Add to Claude Code

```bash
claude mcp add -s user biblio -- node /absolute/path/to/biblio-mcp/dist/index.js
```

`node scripts/install.mjs` prints this line with the absolute path already filled in, so you do
not have to work out where the checkout landed. The path **must** be absolute: a relative one is
resolved against wherever your client happens to start the process, which is not predictable.

### Add to Claude Desktop / Cline / Cursor / any MCP client

biblio-mcp uses **stdio transport**, so any MCP client that can launch a subprocess works. Add
to your MCP configuration (`claude_desktop_config.json`, `cline_mcp_settings.json`,
`~/.agents/mcp.json`, etc.):

```jsonc
{
  "mcpServers": {
    "biblio": {
      "command": "node",
      "args": ["/absolute/path/to/biblio-mcp/dist/index.js"]
    }
  }
}
```

Use an **absolute** path. Validate the file afterwards — a typo here fails silently in most
clients:

```bash
python3 -m json.tool ~/.agents/mcp.json   # or: jq . <your config>
```

## Tools

| Tool | What it does |
|---|---|
| `search_books` | Search the enabled sources at once; merged & deduped by MD5. Returns title, author, year, format, size, and md5 for each result, plus concise source-level `errors`. If you pass `sources`, select at least one; duplicates are ignored. An exact `(source, query, limit)` result—including a source error—is reused for 45 seconds within this process. |
| `book_details` | Full metadata + download options for one book by MD5 hash. Queries Anna's Archive and Libgen in parallel when mirrors are available, returns the first usable result, and reports which one answered (`resolvedVia`). Libgen's `ads.php` response is reused for 45 seconds across details and download-link lookups. |
| `get_download_links` | Every resolvable download URL for an MD5 — Libgen `get.php`, Anna's partner servers, IPFS gateways. Links marked `direct: true` point straight at the file; unrelated scraped links are dropped, while member API URLs are trusted for the requested MD5 even when their signed URL is opaque. A recent Libgen `ads.php` response is reused. |
| `download_book` | Stream the actual file to a local directory by MD5. Returns the saved path, byte count, and **the MD5 of what was written**; a mismatch sets `md5MatchesRequest: false` and includes a warning. Emits progress notifications while transferring. |
| `search_papers` | Search Library Genesis scimag for papers; returns title, journal, authors, DOI and year. Set `resolvePdfs: true` to best-effort add direct `pdfUrl` values for up to three DOI results (extra Sci-Hub requests). |
| `get_paper` | Resolve a paper's PDF via Sci-Hub by DOI, URL, or title. Returns the direct PDF URL when available. |
| `healthcheck` | Can this server reach its sources? Per-mirror status and latency, without querying a catalogue. Use it to tell "the network is blocked" apart from "the query matched nothing". |

### Built for AI agents, not just for people

An MCP server is usually driven by a model that cannot read the source code, cannot see the
server's working directory, and will keep retrying until something works. Four things in this
fork are there specifically for that reader:

- **Every tool description ends with a runnable example**, e.g.
  `Example: {"query":"dune frank herbert","limit":5}`. One MCP bridge advertised `search_books`
  as taking no parameters at all; the example in the schema is what stops an agent from guessing.
- **Argument errors are sentences, not validation dumps.** Instead of
  `[{"expected":"string","code":"invalid_type","path":["output_dir"]}]` you get:

  ```
  download_book: "md5" is missing; "output_dir" is missing. It needs an "md5"
  (32-character hex hash) and an "output_dir" (absolute path to a directory).
  Optional: "filename". Example: {"md5":"524037f3...","output_dir":"/home/me/books"}
  ```

- **`output_dir` resolves predictably.** A relative path resolves against `$HOME`, not the
  server's working directory — which the agent has no way of knowing — and the response reports
  the resolved `outputDir` plus a `note` explaining what happened.
- **`healthcheck` answers "can this server reach anything?"** in a few seconds, without querying
  a catalogue. Without it, a blocked network and an unmatched query look identical from the
  caller's side, and the agent investigates the wrong one.

### Typical flow

**Books:**

1. `search_books({ query: "dune frank herbert" })` → results, each with an `md5`
2. `get_download_links({ md5: "..." })` → pick a `direct: true` link, **or**
3. `download_book({ md5: "...", output_dir: "/absolute/path/Downloads/books" })` → saved file

`download_book` answers with something like:

```json
{
  "saved": true,
  "path": "/home/me/books/524037f395462d37b31f2b28fede24fb.pdf",
  "bytes": 3798473,
  "via": "Libgen direct (get.php)",
  "md5": "524037f395462d37b31f2b28fede24fb",
  "md5MatchesRequest": true,
  "contentType": "application/octet-stream"
}
```

`md5MatchesRequest: true` is the useful bit: the file on disk hashes to the catalogue entry you
asked for. When it is `false`, the mirror served a different file and you should not trust it.

**Papers:**

1. `search_papers({ query: "CRISPR gene editing", resolvePdfs: true })` → results with DOIs and
   best-effort direct PDF URLs
2. If a result has no `pdfUrl`, call `get_paper({ identifier: "10.1089/crispr.2019.0064" })` →
   direct PDF URL when available

### A note on client timeouts (important)

`download_book` can legitimately take longer than a minute — a throttled mirror serving a 5 MB
book has been measured at 96 seconds. MCP clients apply a request timeout, **60 seconds by
default in the TypeScript SDK**, and that timeout is *not* extended by work in progress unless
the client asks for it.

This server emits progress notifications throughout a transfer, but the client has to opt in to
benefit:

```ts
await client.callTool(
  { name: "download_book", arguments: { md5, output_dir } },
  undefined,
  { onprogress: (p) => console.log(p), resetTimeoutOnProgress: true }
);
```

Without `resetTimeoutOnProgress: true`, a slow download can be reported to the user as a failure
even though the server completed it and wrote a correct file. If you cannot change the client,
raise its timeout instead.

## Configuration

All optional — sensible defaults ship built-in. Override via environment variables:

<!-- env-table:start (generated from src/config.ts) -->
| Variable | Purpose | Default |
|---|---|---|
| `BIBLIO_TIMEOUT_MS` | Timeout for scraping an HTML page, including reading its response body | 8000 |
| `BIBLIO_DOWNLOAD_TIMEOUT_MS` | Timeout for fetching a file | 600000 |
| `BIBLIO_DOWNLOAD_STALL_MS` | Abort a download idle for this long | 30000 |
| `BIBLIO_MIRROR_DEAD_TTL_MS` | How long a failed mirror is skipped | 300000 |
| `BIBLIO_MIRROR_STAGGER_MS` | Head start between concurrent mirror attempts | 120 |
| `BIBLIO_ANNAS_API_KEY` | Anna's Archive member key; enables the fast-download JSON API, which is not behind the DDoS-Guard challenge | unset |
| `BIBLIO_DISABLE_SOURCES` | Sources excluded from the default search set | zlibrary |
| `BIBLIO_ANNAS_MIRRORS` | Comma-separated Anna's Archive base URLs | built-in list (src/mirrors.ts) |
| `BIBLIO_LIBGEN_MIRRORS` | Comma-separated Libgen base URLs | built-in list (src/mirrors.ts) |
| `BIBLIO_SCIHUB_MIRRORS` | Comma-separated Sci-Hub base URLs | built-in list (src/mirrors.ts) |
| `BIBLIO_ZLIB_MIRRORS` | Comma-separated Z-Library domains | built-in list (src/mirrors.ts) |
| `BIBLIO_IPFS_GATEWAYS` | IPFS gateway bases for CID fallback | built-in list (src/mirrors.ts) |
| `BIBLIO_SKIP_STARTUP_CHECK` | Set to any value to skip the startup tool-surface check and serve even if it is broken | unset |
<!-- env-table:end -->

Mirror lists are ordered by preference: earlier hosts get a head start, and hosts that were
unreachable at the last audit are kept at the end rather than deleted, so a domain that comes
back is still used. `pnpm selfcheck` prints the current reachability of every host with timings.

Two of these deserve a note:

- **`BIBLIO_TIMEOUT_MS` fell from 20 s to 8 s**, and downloads got their own, much larger budget.
  Sharing one 20 s number made page scraping far too patient and file downloads far too strict —
  a book larger than a few megabytes could not finish at all.
- **`BIBLIO_MIRROR_DEAD_TTL_MS`** is what makes search fast. Without a negative cache, every
  request paid the full timeout for every dead mirror on every call.

## Why biblio-mcp instead of separate servers?

| | biblio-mcp | Separate MCP servers |
|---|---|---|
| **Setup** | One clone, one install, one self-check | Install 4 servers in 3 languages (Go, Python, Node) |
| **Config** | One entry in MCP settings | Four entries, four sets of env vars |
| **Dedup** | Automatic — same book from 3 sources = 1 result | Manual — you see duplicates |
| **Mirrors** | Built-in rotation with a negative cache, one file to update | Each server manages its own |
| **Fault tolerance** | Source down? Others still work | Server down? That source is gone |
| **Papers + Books** | Both in one server | Need separate servers for Sci-Hub vs Libgen |

## About this fork

This is a maintained fork of [`yashimosh/biblio-mcp`](https://github.com/yashimosh/biblio-mcp).
The original idea is unchanged and still good: **one tool that lets an AI assistant search
the world's shadow libraries and download a book or a paper**. What this fork changes is
everything that happens *around* that idea — how reliably it installs, how honestly it
reports problems, and how much of your time it wastes when something is wrong.

**The problem we found.** The published version could install cleanly, start up, and appear
perfectly healthy in your AI client's list of tools — and then fail on *every single request*.
Nothing in the setup warned you, and the error message it produced was an internal one
(`keyValidator._parse is not a function`) that tells a human nothing. In practice this sent
both people and AI agents off on long detours: reading source code, guessing at arguments,
rewriting working software by hand. One such attempt burned eight minutes and still did not
download the book.

**What this fork does about it.**

| | Before (upstream) | In this fork |
|---|---|---|
| **Broken installs** | Look healthy, then fail on every request | Detected in about one second, with the exact command that fixes it |
| **A broken build that starts anyway** | Listed its tools cheerfully, then failed every one of them | Refuses to start, and says which two packages to fix |
| **Installing it** | Six commands, and the npm package is the broken one | `node scripts/install.mjs` — and it checks itself before handing you a config |
| **Proving it works** | No way short of using it and hoping | `pnpm selfcheck` reports tools, mirror health and timings |
| **Search speed** | ~14 seconds, mostly waiting on dead websites | ~1 second on the same query |
| **Downloads** | Saved whatever came back, including stray web pages | Streamed to disk and checksum-verified, so you know it is the right file |
| **A dead source** | Slowed down every search and reported an error you could not act on | Switched off by default; opt back in when you have a working address |
| **A domain that stopped being the real site** | Answered “OK”, got trusted, and quietly returned nothing | Detected and refused — a status code is not proof of identity |
| **Wrong book data** | Reported the series name and a list of ISBNs as the author | Read from the column the page actually labels, so `author` is the author |
| **Useless download links** | Offered a bare homepage as a way to download the book | Filtered out — a link is only offered if it can reach that file |
| **Long downloads** | Could silently outlast your client's timeout | Reports progress while transferring |
| **A wrong tool call** | Answered with a validation dump only a programmer could read | Answers with the argument that is missing and a working example |
| **“Is anything even reachable?”** | No way to ask; a blocked network looked like an empty search | `healthcheck` says which sources answer, and how fast |

**The honest caveats.** Catalogue data now comes from the column a page actually labels, and
`book_details` reads structured metadata (a BibTeX block) instead of guessing at a web page —
but these are third-party sites with no stability guarantees. They change their layout, they
go offline, and domains get re-registered by other people. No fork can promise they stay
reachable. What this fork promises is narrower and more useful: **when something is broken, it
tells you immediately and tells you what to do.**

**Not sure which to use?** If you just want the tools to work and to be told the truth when
they do not, use this fork. If you specifically need the upstream npm package, note that its
published dependency set is the combination described above.

## Known limitations

These are stated plainly because a tool that hides its failures costs you more time than one
that admits them.

- **`book_details` races Anna's Archive and Libgen in parallel.** Anna's scraped HTML often
  answers **HTTP 403** to non-browser clients because of DDoS-Guard; Libgen's `ads.php` page
  embeds a **BibTeX block** with exact title/author/publisher/ISBN/year/series. The first usable
  metadata result wins, and the response reports `resolvedVia` plus a concise `annasUnavailable`
  reason when known. After three consecutive real failures (not counting a record that simply
  does not exist), that provider is paused for five minutes and then tried again. Members can
  still use `BIBLIO_ANNAS_API_KEY` for the independent fast-download JSON endpoint; the key is
  sent only to a mirror that proves it is Anna's Archive.
  > Worth knowing: an earlier version of this README blamed "an advertising interstitial" on
  > Anna's Archive, and an earlier version of this fork assumed `book_details` could be fixed by
  > scraping Anna's Archive better. Both were wrong, and the mistakes are instructive. The ad
  > page was coming from `annas-archive.li`, a domain that is **no longer Anna's Archive** — see
  > the next item — and the real fix was to stop depending on a source that refuses non-browser
  > clients at all.
- **Provider results are cached briefly, in process.** Exact `(source, query, limit)` searches
  (including source-level failures) and Libgen `ads.php` pages keyed by MD5 are reused for 45
  seconds. This avoids repeat mirror latency across an agent's search→details→links cycle; a newly
  recovered mirror may not be retried for that exact query until the short TTL expires. Restarting
  the server clears these caches.
- **Abandoned domains get re-registered, and this one bit us.** `annas-archive.li` was taken
  down under publisher pressure in March 2026. As of October 2026 it answers HTTP 200 in ~0.15 s
  — faster than every genuine mirror — but serves a 27 kB page of advertising JavaScript with no
  `<title>`. A liveness check that trusts status codes therefore ranked it *first*, and the
  parsers could quietly turn an ad page into "zero results, no error". Anna's scraped pages pass a
  content validator, and `healthcheck`/`selfcheck` use positive identity markers for every source
  group. Provider fetch validation is still provider-specific. Sci-Hub can return a human-check
  (ALTCHA) page with HTTP 200; such a page is treated as a failed mirror, so the next mirror is
  tried and the caller is told when every mirror asks for a check (A16). If you add mirrors, keep
  the corresponding identity marker accurate.
- **Libgen columns are read by header name, not by position.** Libgen's first column combines
  series, title and ISBNs; the author is the second. A parser that assumed positions reported the
  series name and a list of ISBNs as the author, and glued `Wiley Finance` onto the front of every
  title. Columns are now resolved from the table's `<th>` row, with a positional fallback for
  mirrors that ship no header, and `series` is its own field. File sizes go through a bounded
  parser, so a digit run from the pages column (`00264mB`) can no longer be reported as a size.
- **Explicit download filenames are never overwritten**, even if a file appears during the
  transfer. This needs hard-link support in the output filesystem; without it, the tool fails
  safely rather than risking an overwrite. Without `filename`, existing MD5-based files may
  still be replaced.
- **Download links are filtered before they reach you.** Providers scrape anchors, and some
  anchors are not downloads — Libgen's `ads.php` page links the bare `http://annas-archive.org/`
  homepage, which used to appear as a download option. A link is only reported if it has a path
  beyond the domain root and actually references the requested MD5 (IPFS gateway links are the
  documented exception, since they carry a CID instead).
- **Z-Library is off by default.** Every public domain in the built-in list was unreachable at
  the last mirror audit, so querying it by default only added latency and an error you could not
  act on. Pass `sources: ["zlibrary"]` explicitly, or set `BIBLIO_ZLIB_MIRRORS` to a working
  personal domain, to bring it back. Anna's Archive indexes the Z-Library collection anyway.
- **Sci-Hub** mirrors sometimes gate behind captcha, but the PDF embed URL is still present in
  the HTML for most mirrors. `get_paper` extracts it successfully in the vast majority of cases.
  If all mirrors fail, it returns fallback URLs so you can open the article in a browser.
- **These sites change their HTML often.** Parsers live in
  [`src/providers/`](src/providers/) and mirrors in
  [`src/mirrors.ts`](src/mirrors.ts) — both are small and easy to patch.

### Roadmap

Phases 0–5 of the improvement plan are implemented: strict offline verification, captured parser
fixtures, resilient mirrors, streaming downloads, source circuits and caches, schema-derived tool
hints, a maintainer guide, optional paper-PDF enrichment, and an updated quick start.

Sci-Hub's human-check pages (A16) are detected and skipped rather than returned as papers. The
server does not solve those checks; if every mirror asks for one, `get_paper` says so. The full
audit and remaining follow-up notes are in
[`docs/worklog/biblio-mcp-audit.md`](docs/worklog/biblio-mcp-audit.md).

## FAQ

### How do I search for books with Claude?

Add the server to Claude (`claude mcp add -s user biblio -- node /absolute/path/to/biblio-mcp/dist/index.js`), then ask naturally: "Find me Dune by Frank Herbert as an EPUB." Claude calls `search_books` and `get_download_links` automatically.

### Does this work with ChatGPT or other AI assistants?

Any client that speaks MCP over stdio. If your client cannot launch subprocesses, wrap the server with a stdio-to-HTTP bridge such as `mcp-remote`.

### Do I need an account on any of these sites?

No. Every source used by default is queried without credentials. Z-Library's full catalogue does require a login, which is why its public search is best-effort and off by default.

### What happens when a mirror goes down?

The other mirrors for that source are tried concurrently, so a single dead host costs milliseconds rather than a timeout. The failed host is then skipped for `BIBLIO_MIRROR_DEAD_TTL_MS`. If *every* mirror in a group is in cooldown, the cache opens again and all of them are retried — a temporary network problem can never lock a source out permanently. Run `pnpm selfcheck` to see current reachability.

### Can I add my own mirrors?

Yes. Set the matching `BIBLIO_*_MIRRORS` variable, or edit [`src/mirrors.ts`](src/mirrors.ts) — it is the single source of truth and every provider reads from it.

### The server starts but every tool call fails. What now?

Run `pnpm preflight`. If it reports `zod-sdk-compat: FAIL`, you have the dependency mismatch
described in [About this fork](#about-this-fork), and the message includes the exact command to
fix it. This fork pins compatible versions and CI checks the pairing on every push, so you should
only hit it after manually changing dependencies.

## Development

```bash
pnpm run dev             # run from source via tsx
pnpm run typecheck       # strict checks for src/
pnpm run build           # compile to dist/
pnpm run preflight       # offline install/dependency check (before or after build)
pnpm run preflight:strict # ...and fail if dist/ is missing
pnpm run fixtures:capture # refresh the verified provider-page fixtures (uses the network)
pnpm run test            # offline tests only
pnpm run benchmark      # opt-in live provider timing (before/after comparison)
pnpm run test:live       # optional live mirror/provider checks
pnpm run test:all        # offline suite, then live suite
pnpm run selfcheck       # tools + mirror reachability with timings
pnpm run selfcheck:live  # ...plus one real search
pnpm run verify          # strict typecheck + build + offline tests + selfcheck
```

`pnpm test` uses Node's built-in test runner — there is no test framework to install. The
network-facing parts are tested against local HTTP servers on `127.0.0.1`, so the suite runs in
CI without reaching the shadow libraries.

```
AGENTS.md          maintainer and coding-agent workflow
src/
  index.ts          entry point: CLI flags (--selfcheck, --version) + stdio transport
  server.ts         MCP tool definitions
  selfcheck.ts      the --selfcheck routine (preflight, tools, mirrors, live)
  http.ts           mirror rotation, negative cache, timeouts, streaming downloads
  mirrors.ts        all mirror domains — the one file to edit when hosts change
  sniff.ts          file-format detection from magic bytes
  types.ts          shared Book / Paper / DownloadLink data model
  providers/
    annas.ts        Anna's Archive (md5 resolver)
    libgen.ts       Library Genesis (books + scimag papers + direct downloads)
    scihub.ts       Sci-Hub (paper PDF resolution by DOI)
    zlibrary.ts     Z-Library (best-effort public search; off by default)
    index.ts        aggregation: fan-out, merge, dedup-by-md5, source defaults
scripts/
  preflight.mjs     install-time dependency guard (plain JS, no build step)
test/
  *.test.mjs        unit + integration tests, including captured HTML fixtures
```

Design rationale and the reasons for the current source/test footprint are recorded in
[`docs/decisions.md`](docs/decisions.md); the full audit and worklog are in
[`docs/worklog/biblio-mcp-audit.md`](docs/worklog/biblio-mcp-audit.md).

### Contributing

PRs welcome — especially for parser fixes when sites change their HTML. The most common
maintenance task is updating [`src/mirrors.ts`](src/mirrors.ts) when domains rotate; run
`pnpm selfcheck` first, since it measures every host and prints the timings you need to order
them.

Two rules this fork holds to:

1. **A red build must mean "something regressed", not "something we already know about."**
   Known-bad behaviour is pinned with `todo` tests that describe the intended fix.
2. **CI must be able to tell a working server from one that merely starts.** The offline
   integration suite sends a real `tools/call` over an in-memory transport, because `tools/list`
   succeeds even on a build that cannot serve a single request.

## Legal

This tool is a client that queries publicly reachable third-party websites; it
hosts no content itself. Copyright law varies by country. You are responsible
for ensuring your use complies with the laws of your jurisdiction and with the
rights of copyright holders. Provided for research, archival, and accessibility
purposes. The authors do not endorse copyright infringement.

## License

[MIT](LICENSE)
