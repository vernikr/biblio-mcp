# biblio-mcp

> ## 🔧 About this fork — in plain terms
>
> This is a maintained fork of [`yashimosh/biblio-mcp`](https://github.com/yashimosh/biblio-mcp).
> The original idea is unchanged and still good: **one tool that lets an AI assistant search
> the world's shadow libraries and download a book or a paper**. What this fork changes is
> everything that happens *around* that idea — how reliably it installs, how honestly it
> reports problems, and how much of your time it wastes when something is wrong.
>
> **The problem we found.** The published version could install cleanly, start up, and appear
> perfectly healthy in your AI client's list of tools — and then fail on *every single request*.
> Nothing in the setup warned you, and the error message it produced was an internal one
> (`keyValidator._parse is not a function`) that tells a human nothing. In practice this sent
> both people and AI agents off on long detours: reading source code, guessing at arguments,
> rewriting working software by hand. One such attempt burned eight minutes and still did not
> download the book.
>
> **What this fork does about it.**
>
> | | Before (upstream) | In this fork |
> |---|---|---|
> | **Broken installs** | Look healthy, then fail on every request | Detected in about one second, with the exact command that fixes it |
> | **Proving it works** | No way short of using it and hoping | `pnpm selfcheck` reports tools, mirror health and timings |
> | **Search speed** | ~14 seconds, mostly waiting on dead websites | ~1 second on the same query |
> | **Downloads** | Saved whatever came back, including stray web pages | Streamed to disk and checksum-verified, so you know it is the right file |
> | **A dead source** | Slowed down every search and reported an error you could not act on | Switched off by default; opt back in when you have a working address |
| **A domain that stopped being the real site** | Answered “OK”, got trusted, and quietly returned nothing | Detected and refused — a status code is not proof of identity |
> | **Long downloads** | Could silently outlast your client's timeout | Reports progress while transferring |
>
> **The honest caveats.** This fork does not fix the accuracy of the catalogue data — some
> fields (notably `author`, and `book_details` via Anna's Archive) are still wrong, and that is
> tracked openly in the issue list and in the roadmap below rather than papered over. Shadow
> libraries also change their websites constantly; no fork can promise they stay reachable.
> What this fork promises is narrower and more useful: **when something is broken, it tells you
> immediately and tells you what to do.**
>
> **Not sure which to use?** If you just want the tools to work and to be told the truth when
> they do not, use this fork. If you specifically need the upstream npm package, note that its
> published dependency set is the combination described above.

[![CI](https://github.com/vernikr/biblio-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/vernikr/biblio-mcp/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/biblio-mcp.svg)](LICENSE)

**One [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that searches Anna's Archive, Library Genesis (Libgen), Sci-Hub, and Z-Library — all at once.**

Search millions of books, academic papers, and research articles across every major shadow library through a single unified interface. Resolve download links and fetch files directly from your AI assistant — Claude Code, Claude Desktop, Cline, Cursor, or any MCP-compatible client.

No API keys. No login. No per-source servers to juggle. One server, six tools, four sources.

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
| **Sci-Hub** | Paper PDF resolution by DOI, URL, or title | On demand, via `get_paper` |
| **Z-Library** | Best-effort public book search (no login required) | **No** — see [Known limitations](#known-limitations) |

## Install

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
exactly the broken pairing described in the banner. `npm ci` therefore produced a server that
started and then failed every tool call. This fork keeps one lockfile so there is one answer.

### Add to Claude Code

```bash
claude mcp add -s user biblio -- node /absolute/path/to/biblio-mcp/dist/index.js
```

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
| `search_books` | Search the enabled sources at once; merged & deduped by MD5. Returns title, author, year, format, size, and md5 for each result, plus `errors` for any source that failed. |
| `book_details` | Full metadata + download options for one book by MD5 hash. |
| `get_download_links` | Every resolvable download URL for an MD5 — Libgen `get.php`, Anna's partner servers, IPFS gateways. Links marked `direct: true` point straight at the file. |
| `download_book` | Stream the actual file to a local directory by MD5. Returns the saved path, the byte count, and **the MD5 of what was written** so you can confirm the file is the one you asked for. Emits progress notifications while transferring. |
| `search_papers` | Academic paper / article search via Library Genesis scimag; returns DOIs and metadata. |
| `get_paper` | Resolve a paper's PDF via Sci-Hub by DOI, URL, or title. Returns the direct PDF URL when available. |

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

1. `search_papers({ query: "CRISPR gene editing" })` → results with DOIs
2. `get_paper({ identifier: "10.1089/crispr.2019.0064" })` → direct PDF URL

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

| Variable | Purpose | Default |
|---|---|---|
| `BIBLIO_ANNAS_MIRRORS` | Comma-separated Anna's Archive base URLs | `.gl, .gd, .pk` |
| `BIBLIO_LIBGEN_MIRRORS` | Comma-separated Libgen base URLs | `.li, .bz, .vg, .is, .rs, .st, .gs` |
| `BIBLIO_SCIHUB_MIRRORS` | Comma-separated Sci-Hub base URLs | `.ru, .ren, .mksa.top, .st, .hkvisa.net, .se` |
| `BIBLIO_ZLIB_MIRRORS` | Comma-separated Z-Library domains | `z-library.sk, 1lib.sk, z-lib.io, zlibrary-global.se` |
| `BIBLIO_IPFS_GATEWAYS` | IPFS gateway bases for CID fallback | `ipfs.io, cloudflare-ipfs, pinata` |
| `BIBLIO_ANNAS_API_KEY` | Anna's Archive member key; enables the fast-download JSON API, which is not behind the DDoS-Guard challenge | unset |
| `BIBLIO_DISABLE_SOURCES` | Sources excluded from the default search set | `zlibrary` |
| `BIBLIO_TIMEOUT_MS` | Timeout for scraping an HTML page | `8000` |
| `BIBLIO_DOWNLOAD_TIMEOUT_MS` | Timeout for fetching a file | `600000` |
| `BIBLIO_DOWNLOAD_STALL_MS` | Abort a download idle for this long | `30000` |
| `BIBLIO_MIRROR_DEAD_TTL_MS` | How long a failed mirror is skipped | `300000` |
| `BIBLIO_MIRROR_STAGGER_MS` | Head start between concurrent mirror attempts | `120` |

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

## Known limitations

These are stated plainly because a tool that hides its failures costs you more time than one
that admits them.

- **`book_details` usually fails.** It resolves only against Anna's Archive, and the genuine
  Anna's Archive mirrors answer **HTTP 403** to the scraped HTML pages (`/search`, `/md5/...`)
  from any non-browser client — that is their DDoS-Guard challenge. The tool reports the 403
  rather than guessing. Use `search_books` plus `get_download_links`, which go through Libgen
  and work. Members can set `BIBLIO_ANNAS_API_KEY` to use the fast-download JSON API, which is
  not behind the challenge.
  > Worth knowing: an earlier version of this README blamed "an advertising interstitial" on
  > Anna's Archive. That was wrong, and the mistake is instructive. The ad page was coming from
  > `annas-archive.li`, a domain that is **no longer Anna's Archive** — see the next item.
- **Abandoned domains get re-registered, and this one bit us.** `annas-archive.li` was taken
  down under publisher pressure in March 2026. As of October 2026 it answers HTTP 200 in ~0.15 s
  — faster than every genuine mirror — but serves a 27 kB page of advertising JavaScript with no
  `<title>`. A liveness check that trusts status codes therefore ranked it *first*, and the
  parsers quietly turned an ad page into "zero results, no error". Providers now pass a content
  validator, so such a host is rejected with an explicit reason, and `pnpm selfcheck` reports it
  as `HTTP 200 — NOT the expected site` instead of as healthy. If you add mirrors, add a marker
  to check for.
- **`author` is often wrong in Libgen results.** The parser reads the first table column, but
  Libgen puts the author in the second, so you get the series name and ISBNs instead. Also a
  phase-2 fix; there are `todo` tests in [`test/providers.test.mjs`](test/providers.test.mjs)
  that pin the expected behaviour so the fix is verified when it lands.
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

Phases 0 and 1 of the improvement plan are implemented in this fork: a build that cannot
silently produce a broken server, a health check, faster and more honest mirror handling,
streaming verified downloads, and progress reporting.

Still open: parser accuracy (`author`, `title`, `size`), a `book_details` path that does not
depend on Anna's Archive, human-readable argument-validation errors, and a `healthcheck` tool.

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
described in the banner and the message includes the exact command to fix it. This fork pins
compatible versions and CI checks the pairing on every push, so you should only hit it after
manually changing dependencies.

## Development

```bash
pnpm run dev          # run from source via tsx
pnpm run build        # compile to dist/
pnpm run preflight    # offline install/dependency check
pnpm run test         # build + unit and integration tests (no external network)
pnpm run selfcheck    # tools + mirror reachability with timings
pnpm run selfcheck:live  # ...plus one real search
pnpm run smoke        # legacy: live end-to-end exercise of each provider
pnpm run verify       # build + test + selfcheck
```

`pnpm test` uses Node's built-in test runner — there is no test framework to install. The
network-facing parts are tested against local HTTP servers on `127.0.0.1`, so the suite runs in
CI without reaching the shadow libraries.

```
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

### Contributing

PRs welcome — especially for parser fixes when sites change their HTML. The most common
maintenance task is updating [`src/mirrors.ts`](src/mirrors.ts) when domains rotate; run
`pnpm selfcheck` first, since it measures every host and prints the timings you need to order
them.

Two rules this fork holds to:

1. **A red build must mean "something regressed", not "something we already know about."**
   Known-bad behaviour is pinned with `todo` tests that describe the intended fix.
2. **CI must be able to tell a working server from one that merely starts.** The smoke check
   sends a real `tools/call`, because `tools/list` succeeds even on a build that cannot serve a
   single request.

## Legal

This tool is a client that queries publicly reachable third-party websites; it
hosts no content itself. Copyright law varies by country. You are responsible
for ensuring your use complies with the laws of your jurisdiction and with the
rights of copyright holders. Provided for research, archival, and accessibility
purposes. The authors do not endorse copyright infringement.

## License

[MIT](LICENSE)
