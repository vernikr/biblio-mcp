# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [1.3.0] - 2026-10-08

Phase 2 of the improvement plan: report what a page actually says. Every fix below was designed
against live captured markup rather than a hand-written fixture, because the fixture was what
hid the bugs in the first place.

### Fixed
- **`author` is the author again.** The Libgen parser read the first table column, but that
  column combines series, title and ISBNs while the author is the second — so every result
  reported `Wiley Finance 9780471460671; 0471460672 …` as its author. Columns are now resolved
  from the table's `<th>` header row, with a positional fallback for mirrors that ship no header.
- **`title` no longer carries the series and the ISBNs.** Taking "the longest anchor text" in
  that first column concatenated three different fields into one string. `series` is now its own
  field (`Book.series`) and ISBNs are read from their own anchor.
- **A digit run can no longer be reported as a file size.** The size regex was unbounded, so it
  matched `00264mB` out of concatenated page text. `parseSize` is bounded at both ends, rejects
  leading zeros, and refuses values above 100 TB.
- **`book_details` no longer depends on a source that refuses the request.** Anna's Archive is
  tried first, but its genuine mirrors answer HTTP 403 to scraped HTML pages from non-browser
  clients, so the tool usually returned an empty title and no links. Libgen is now the fallback,
  and it is the better source: its `ads.php` page embeds a **BibTeX block** with exact
  title/author/publisher/ISBN/year/series, so nothing is guessed. Responses report `resolvedVia`
  and `annasUnavailable`, and if both sources fail the caller gets an empty record naming both
  failures instead of an exception.
- **Download links that cannot lead to the file are filtered out.** Libgen's `ads.php` page links
  the bare `http://annas-archive.org/` homepage, which `get_download_links` reported as a
  download option; an agent that followed it got nothing and no explanation. A link is now only
  reported if it has a path beyond the domain root and references the requested MD5 (IPFS gateway
  links excepted, since they carry a CID). Applied in both `resolveDownloads` and
  `libgen.details`, because `book_details` embeds the latter directly.

### Added
- **`src/parse.ts`** — pure, I/O-free parsing helpers shared by the providers: `parseSize`,
  `parseYear`, `parseFormat`, `parseLanguage`, `parsePages`, `isIsbnLike`, `parseIsbns`,
  `columnMap`, `LIBGEN_DEFAULT_COLUMNS`, `parseBibtex`, `isUsefulLink`.
- **`libgen.details(md5)`** — resolves metadata from the BibTeX block on `ads.php`, reusing the
  same response for the download links so it costs one request, not two.
- **`Book.series`** — the series name, kept separate from the title.
- **`BookDetailsResult.resolvedVia` / `.annasUnavailable` / `.libgenUnavailable`** — so a caller
  is never left wondering which source answered or why one did not.
- **`test/parse.test.mjs`, `test/details.test.mjs`** — 27 new tests. The suite is 60 tests, all
  passing, and no longer has any `todo` placeholders.

### Changed
- The Libgen search fixture (`test/fixtures/libgen-search.html`) now mirrors the real page:
  `<th>` header row, `<b>` series, `edition.php` title anchors, the ISBN anchor, and the badge
  spans. The previous hand-written fixture did not have these, which is why the parser looked
  correct in tests while being wrong in production.
- `annas.parseMeta` delegates to the shared validators instead of keeping its own looser copies.

### Notes for maintainers
- Provider tests that need different mirrors **must run in a child process**. `ANNAS_MIRRORS` /
  `LIBGEN_MIRRORS` are read once, at module evaluation, and busting the ESM cache with a `?t=N`
  query does not help: a freshly evaluated `providers/index.js` still statically imports the
  already-cached `mirrors.js`. `test/details.test.mjs` documents this and provides
  `runInProcess()`. Writing those tests with in-process env overrides produced tests that
  silently exercised the live internet.

## [1.2.0] - 2026-10-07

First release of the maintained fork. Phases 0–1 of the improvement plan: make the install
impossible to get silently wrong, and make the network layer fast and honest.

### Fixed
- **Hijacked mirrors are no longer trusted.** `annas-archive.li` was taken down under publisher
  pressure in 2026-03 and now answers HTTP 200 in ~0.15 s with a ~27 kB page of advertising
  JavaScript and no `<title>` — faster than every genuine Anna's Archive mirror, so it won the
  race and the parsers turned an ad page into "zero results, no error". Providers now pass a
  content validator to `fetchFromMirrors`, such a host is rejected with an explicit reason and
  cooled down, and `--selfcheck` reports it as `HTTP 200 — NOT the expected site` rather than as
  healthy. The registry drops `.li` and `.gs` and adopts upstream's audited `.gl, .gd, .pk`.
- **The server can no longer install into a state where it starts but cannot serve a single
  request.** `@modelcontextprotocol/sdk` is pinned to `1.29.0`, which declares
  `zod: "^3.25 || ^4.0"`. The previous pairing (`sdk@1.12.1`, whose peer range is `^3.23.8`,
  against `zod@4.4.3`) passed `tools/list` and then failed every `tools/call` with
  `keyValidator._parse is not a function`.
- **Removed `package-lock.json`.** It resolved `sdk@1.12.1` against `zod@4.4.3` — the broken
  pairing — while `pnpm-lock.yaml` resolved the working one, so `npm ci` and `pnpm install`
  produced different servers. One lockfile, one answer.
- **Search latency.** A failed mirror is now skipped for a cooldown window instead of being
  retried on every request, and mirrors are tried concurrently with a head start rather than
  sequentially. The same query that took 14.2 s against the previous mirror list now takes
  ~1.0 s, because it no longer pays four timeouts for dead Z-Library hosts.
- **`BIBLIO_TIMEOUT_MS` no longer applies to file downloads.** One 20 s budget made page
  scraping far too patient and downloads far too strict; downloads now get
  `BIBLIO_DOWNLOAD_TIMEOUT_MS` (600 s) plus a stall watchdog.
- **`download_book` no longer saves an HTML page as if it were a book.** Libgen's `get.php`
  serves an interstitial when its one-time key expires; that response is now detected and the
  next candidate link is tried.
- **CI can now tell a working server from one that merely starts.** The smoke check sends a real
  `tools/call` (with a deliberately invalid argument) instead of only `initialize` and
  `tools/list`, both of which succeed on a broken build.

### Added
- `scripts/preflight.mjs` — offline install guard. Checks Node version, lockfile, dependencies,
  the zod/SDK pairing, and the build artefact; on failure it names the symptom and prints the
  command that fixes it. `pnpm preflight`.
- `--selfcheck` — runs preflight, constructs the server and lists its tools over an in-memory
  transport, probes every mirror with timings, and with `--live` performs one real search.
  `pnpm selfcheck` / `pnpm selfcheck:live`.
- **Streaming downloads.** `download_book` writes to disk as it goes, so peak memory no longer
  scales with file size, writes via a `.part` file that is renamed on success, and returns the
  **MD5 of what was written** with `md5MatchesRequest` so a caller can confirm the file is the
  catalogue entry it asked for.
- **Progress notifications** during downloads, so a long transfer does not look like a hung
  request. (Clients must pass `onprogress` and `resetTimeoutOnProgress: true` to benefit —
  documented in the README.)
- Test suite on Node's built-in runner: format sniffing, mirror rotation and the negative cache,
  half-open recovery, streaming downloads including stall and interstitial handling, the tool
  surface over an in-memory transport, and the preflight guard against a real synthetic broken
  tree. No test framework to install; network paths are tested against local servers.
- `--version` and `--help`; all environment variables are listed in `--help` and the README.
- `BIBLIO_DISABLE_SOURCES`, `BIBLIO_DOWNLOAD_STALL_MS`, `BIBLIO_MIRROR_DEAD_TTL_MS`,
  `BIBLIO_MIRROR_STAGGER_MS`, `BIBLIO_DOWNLOAD_TIMEOUT_MS`.

### Changed
- **Z-Library is no longer searched by default.** Every public domain in the built-in list was
  unreachable at the 2026-10-07 mirror audit, so including it added latency and an error the
  caller could not act on. Pass `sources: ["zlibrary"]` to include it.
- **Mirror registry re-audited** and `ZLIBRARY_MIRRORS` moved into `src/mirrors.ts` from
  `src/providers/zlibrary.ts`, restoring the "one file to edit" contract. Added `libgen.bz`;
  demoted hosts that were unreachable. Order is now preference, with unreachable hosts last
  rather than deleted.
- **Package manager is pnpm** (`packageManager` field added); scripts and CI use it.
- Server internals split into `server.ts` (tool definitions), `selfcheck.ts` (health checks) and
  `sniff.ts` (format detection) so each can be exercised without binding a transport.
- Tool descriptions now state which sources are actually searched, and `download_book` documents
  its checksum and progress behaviour.

### Known issues (tracked for phase 2)
- `book_details` usually fails: the genuine Anna's Archive mirrors return HTTP 403 to the
  scraped HTML pages from a non-browser client (their DDoS-Guard challenge). It now reports the
  403 instead of parsing whatever came back. `BIBLIO_ANNAS_API_KEY` enables the member
  fast-download JSON API, which is not behind the challenge.
- Libgen `author` comes from the wrong table column, so it reports the series name and ISBNs.
- Both are pinned with `todo` tests describing the intended behaviour.

[1.2.0]: https://github.com/vernikr/biblio-mcp/compare/v1.1.0...v1.2.0

## [1.1.0] - 2026-07-09

### Fixed
- **Sci-Hub PDF resolution** — added mirrors (`sci-hub.ren`, `sci-hub.mksa.top`, `sci-hub.hkvisa.net`) that embed PDF URLs even behind captcha pages; PDFs now resolve reliably via `sci.bban.top` CDN
- Strip `#view=FitH` fragment from resolved PDF URLs for cleaner direct downloads
- `repository.url` format in package.json (silences npm publish warning)

### Added
- CI status, npm version, and license badges in README

[1.1.0]: https://github.com/yashimosh/biblio-mcp/compare/v1.0.0...v1.1.0

## [1.0.0] - 2026-07-08

Initial release.

### Added
- `search_books` — fan-out search across Anna's Archive, Libgen, and Z-Library, deduped by MD5
- `book_details` — full metadata for a book by MD5
- `get_download_links` — resolvable download URLs for an MD5 (Libgen direct, Anna's partner servers, IPFS gateways)
- `download_book` — fetch a file to a local directory by MD5
- `search_papers` — academic paper search via Library Genesis scimag
- `get_paper` — resolve a paper's PDF via Sci-Hub by DOI, URL, or title
- Mirror rotation with per-host stickiness and env var overrides for every source
- Per-source fault isolation via `Promise.allSettled`

[1.0.0]: https://github.com/yashimosh/biblio-mcp/releases/tag/v1.0.0
