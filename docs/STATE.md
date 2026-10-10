# Project state

**Start with [`AGENTS.md`](../AGENTS.md).** Review evidence, stage reports, patches, snapshots,
audit logs and release receipts are archived under `docs/worklog/archive/`; they are historical
checkpoints, not the current roadmap.

## Release and support

- Public npm: [`@vernikr/biblio-mcp`](https://www.npmjs.com/package/@vernikr/biblio-mcp); the current
  version is the one in `package.json`. Cold npx and pnpm registry launchers pass.
- Releases, with their `.tgz`, `.mcpb` and checksums, are on the
  [releases page](https://github.com/vernikr/biblio-mcp/releases).
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

The offline suite passes without skips; pnpm must be on PATH and its store primed for the clean
installer fixtures. The cost of genuine install/build tests is kept
rather than dropping coverage to hit an obsolete under-five-second target.

## Next code work

The audit that drove PR1–PR4 is closed and archived. The current backlog is the refactor plan
(`biblio-mcp-refactor-plan.md`): shrink what an agent has to read, cut CI time, then fix the
remaining behaviour and performance findings.

Wave 1 (volume, CI, de-guarded docs) is done — see
[`docs/worklog/2026.10.10-refactor-wave1/`](2026.10.10-refactor-wave1/report.md).

Open findings, in priority order:

- `fetch_book` re-runs a full source search on every failed copy instead of reusing the ranked
  candidate list it already holds.
- `get_download_links` can report a source as unavailable while that same source supplied links.
- Sci-Hub parses each mirror's page twice; Libgen serialises the DOM for every result row.
- `downloadToFile` re-arms a timer on every chunk of a download.

Cached Anna detail pages remain intentionally deferred because loser cancellation is more useful.

## Preserved limits and safety

- Member fast-download key goes only to identity-verified hosts; never commit it.
- Human-verification pages are reported, never solved or saved as books; Z-Library stays off by default.
- Explicit filenames never overwrite; filesystems without hard-link support fail safely.
- Production audit is clean. A dev-only node-forge RSA verification advisory remains in MCPB CLI;
  signing/verification is not used, bundles are unsigned, the library is not shipped to consumers.
- Mirror availability changes independently of code; optional live CI is non-blocking.
