# Project state — 2.0.0

**Start with [HANDOFF](worklog/biblio-mcp-review/HANDOFF.md).** Review evidence, stage reports,
patches, snapshots, audit logs and release receipts are archived under
`docs/worklog/biblio-mcp-review/`; they are historical checkpoints, not the current roadmap.

## Release and support

- Public npm: [`@vernikr/biblio-mcp@2.0.0`](https://www.npmjs.com/package/@vernikr/biblio-mcp).
  Registry tarball integrity matches the tested archive; cold npx and pnpm registry launchers pass.
- [GitHub release v2.0.0](https://github.com/vernikr/biblio-mcp/releases/tag/v2.0.0) is published;
  `.tgz`, `.mcpb`, checksums and npm tarball are independently verified. Release checkpoint CI is 7/7 green.
- Node **22+**, pnpm **12.10.1** for maintainers; CI covers 22/24 and exact 22.0.0.
- npm/MCPB use the same compiled stdio runtime. MCPB carries locked production dependencies;
  consumer checkout/TypeScript/build tools are not required. Source installer remains a developer utility.
- Desktop GUI installation is not claimed; archive/runtime acceptance covers Linux/macOS/Windows.

## Verification

```bash
pnpm install --frozen-lockfile
pnpm run verify                       # offline, one top-level build, no live mirrors
pnpm run package:verify               # archives + consumer acceptance; registry access may be needed
node scripts/check-artifacts.mjs --registry  # actual public launchers, only for a published version
pnpm run docs:env                     # fresh compiled environment table
pnpm run verify:live                  # optional live diagnostics, separate from offline gate
```

215/215 offline tests pass without skips; pnpm must be on PATH and its store primed for the clean
installer fixtures. Exact Node 22.0 smoke: 28/28. The cost of genuine install/build tests is kept
rather than dropping coverage to hit an obsolete under-five-second target.

## Next code work

PR3 (F4, F5, F6, R3, R4) is implemented: outage is separated from not-found in download lookups,
mixed Sci-Hub no-PDF/PDF races reach the PDF, Libgen's DOM is parsed once, and HTML interstitials
are rejected without reading their body. The F4 contract is decided: `BIBLIO_DOWNLOAD_TIMEOUT_MS`
covers response headers, and the idle watchdog covers the body (see `docs/decisions.md`).

PR4 is done: shared in-memory MCP test client (`test/helpers/mcp.mjs`), shared HTTP mirror helpers,
libgen/parse leftovers, and the README/AGENTS/dependabot statements the audit marked stale. The
audit worklog is marked as an end-of-wave snapshot. Remaining work is optional P3 (MCP annotations,
`registerTool`, Windows check, R2 SDK AJV validator); see plan.md section 5.
Cached Anna detail pages remain intentionally deferred because loser cancellation is more useful.

## Preserved limits and safety

- Member fast-download key goes only to identity-verified hosts; never commit it.
- Human-verification pages are reported, never solved or saved as books; Z-Library stays off by default.
- Explicit filenames never overwrite; filesystems without hard-link support fail safely.
- Production audit is clean. A dev-only node-forge RSA verification advisory remains in MCPB CLI;
  signing/verification is not used, bundles are unsigned, the library is not shipped to consumers.
- Mirror availability changes independently of code; optional live CI is non-blocking.
