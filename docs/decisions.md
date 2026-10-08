# Design decisions

This file keeps the rationale for non-obvious behavior out of implementation comments.

## Mirror requests

- Mirror order is a preference, not a fail-fast sequence. Start candidates with a small stagger, accept the first response whose body and identity check pass, and cancel losers. Within one mirror, try a route fallback only after HTTP 404/405.
- Remember failed mirrors for a short cooldown, but retry the full group when all candidates are cooling down. Preserve the last successful mirror as preferred; `healthcheck` clears cooldowns without discarding that preference, while `selfcheck` resets both.
- A successful status code is not proof of site identity. `healthcheck`/`selfcheck` use per-group content markers; Anna's scraped requests also pass an identity validator. Provider fetch validators remain provider-specific, and Sci-Hub human-check pages are rejected by its validator (audit item A16); they are never solved.
- `AbortSignal.any` is used when available; the fallback keeps the package compatible with older supported Node 18 releases.

## Timeouts and downloads

- The HTML request budget covers body consumption, not just response headers. Large file downloads have a separate budget and an idle stall watchdog.
- Downloads stream through a hash transform to a `.part` file and are renamed only after success. Reject HTML interstitials instead of saving them as books; report the actual MD5 because mirror links can serve a different file.
- Probe requests without an identity marker cancel unread bodies so health checks do not leave connections open.

## Provider parsing and data

- Parser behavior is grounded in captured provider pages under `test/fixtures/`. Those fixtures are checksum-guarded; do not replace unavailable live HTML with guessed markup.
- Libgen columns are mapped by headers where possible, with a positional fallback for pages without headers. Shared strict validators reject implausible years, sizes, formats, languages, and ISBNs. Details prefer Libgen's BibTeX block over heuristic page text.
- Anna's pages are identity-checked because a parked domain can return a fast HTTP 200. Its scraped metadata is heuristic; the member JSON fast-download endpoint is separate from the HTML path and is enabled only by an environment key.
- Book details race Anna's Archive and Libgen when possible, returning the first usable record; Libgen's structured BibTeX is the reliable metadata fallback. Metadata and links reuse one `ads.php` response.
- Download candidates must point to a specific record (a non-root path and, except for IPFS gateways, the requested MD5); bare homepages are not usable download links.
- Z-Library is off by default because audited public domains were unusable; users can opt in with `sources: ["zlibrary"]` and a working `BIBLIO_ZLIB_MIRRORS` value.
- Tests that override module-level mirror lists use a fresh Node subprocess so environment values are set before the provider graph is imported; ESM query-string cache busting would not refresh its static dependencies.

## Caches and source health

- Provider caches are bounded and process-local. They share in-flight work, start the TTL after a successful load, update LRU order on hits without extending TTL, and never retain thrown failures. Search caches may retain concise failure outcomes briefly to avoid repeating an immediately adjacent failing source call.
- Source-level circuits open after three consecutive real failures and close again after the same cooldown as mirrors (`BIBLIO_MIRROR_DEAD_TTL_MS`, default five minutes). "Record not found on every mirror" is a healthy answer and never counts. A single missing record never cools a mirror down; only network errors, server errors, challenges, and identity failures do.
- The Anna's member key is sent only to hosts whose homepage passes the identity marker, checked without the key and cached for ten minutes.

## MCP surface and startup

- Call examples are manually curated; required/optional field hints come from the registered Zod input schema so validation guidance cannot drift from the tool definition.
- Validation issues are taken from the SDK's original single schema parse. Do not re-parse invalid arguments to format an error.
- Selfchecks use one in-memory MCP client/server lifecycle helper. `selfcheck` verifies preflight, tool registration, mirror reachability, and optionally a real search; startup checks exercise an invalid call before stdio is bound.
- Healthcheck and selfcheck share `probeGroup`, keeping reachability, latency, and impostor summaries consistent.
- `search_papers` resolves direct Sci-Hub PDF URLs only when `resolvePdfs` is explicitly enabled, and caps enrichment at three DOI results. Automatic per-result network lookups would make an otherwise fast catalogue search unexpectedly slow; lookup failures therefore leave the Libgen results intact.

## Installation and project size

- A checkout with `pnpm-lock.yaml` must stop when pnpm is missing; silently falling back to npm can produce a different dependency tree. MCP config writes use a backup and atomic rename.
- Preflight checks the SDK's Zod range and runtime internals because an incompatible pair can answer `tools/list` but fail every `tools/call`. It locates package manifests by filesystem path before resolving an entry point, since `exports` can hide `package.json`; installed-package checks use the consumer's lockfile and dependencies.
- `package.json` is `private: true`: the upstream owns the `biblio-mcp` npm name, and this fork's supported install is from source. Keep `npm pack` tests working, but do not enable publishing without an explicit release/name decision.
- The original Phase 4 ceiling of 4,700 lines was set before Phase 0–3 and the subsequent completed Phase 4 work. The comparable baseline at `f6c4e42` is already 5,487 `.ts`/`.mjs` lines under `src/`, `scripts/`, and `test/`; the post-Phase-3/pre-D1 working tree had 7,127. Meeting 4,700 at that point would have required deleting 2,427 lines, including useful implementation and regression coverage, and is lower than the historical baseline itself.
- D1 condensed or removed long narrative comments while retaining short comments that explain invariants. Across those same `.ts`/`.mjs` files, the measured count is now 6,500 lines (627 fewer than before D1); comment-only lines beginning with `//`, `/*`, `*`, or `*/` fell from 1,124 to 499. This still exceeds the stale ceiling by 1,800 lines. The measured scope excludes Markdown documentation and captured HTML fixtures; the fixtures remain intact because they pin real provider markup.
- The acceptance priority is a green `pnpm run verify` and at least 87 tests, not deleting fixtures or regression tests to satisfy the stale raw-LOC number. D1 finished with 137/137 tests passing and selfcheck green.
