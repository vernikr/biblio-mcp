# Project state

Short, current snapshot for anyone (human or agent) picking the fork up. The long audit history is in
[`worklog/biblio-mcp-audit.md`](worklog/biblio-mcp-audit.md); treat that file as an archive. Its
opening sections describe the state after wave 1. The A16 entry (around line 332) is closed.

## Version

`2.0.0` (see `package.json`), Node 22+. Scoped identity `@vernikr/biblio-mcp`; npm publication
is pending. CI creates `.tgz`/`.mcpb` artifacts and exercises actual consumer installs/stdio/downloads.
The checkout installer is for development, not a consumer prerequisite.

## Open items

- **P4, cached Anna's detail pages:** deliberately not done. A cached load cannot be cancelled, and
  cancelling the losing Anna's request is the bigger saving.
- **Slow install tests:** `test/install.test.mjs` uses clean offline installation/build fixtures and a fresh docs build.
  The full offline suite takes roughly 13–20 s. The "under 5 s" target was dropped rather than losing that coverage.
- **`downloadToFile` is not fully on `fetchWithTimeout`:** the request timer currently covers headers, with a
  separate body idle watchdog. The total-deadline contract remains an open decision.
- **Live checks:** mirror availability changes often. The last recorded live run was
  `node dist/index.js --selfcheck`, which passed; re-run it before relying on a mirror list.

## Known limits

- Anna's Archive fast-download needs `BIBLIO_ANNAS_API_KEY` and only goes to hosts that pass the
  identity check.
- Sci-Hub may answer with a human-verification (ALTCHA) page on HTTP 200. The server reports this as
  an error and does not try to solve it.
- Z-Library is off by default (`BIBLIO_DISABLE_SOURCES`).

## Commands

```bash
pnpm run typecheck
pnpm run build
pnpm run test                          # offline suite
node --test test/<file>.test.mjs       # one file
pnpm run verify                        # deterministic offline gate, one build
pnpm run verify:live                   # additionally mirrors + a real search
pnpm run docs:env                      # rebuild after changing src/config.ts
pnpm run package:verify                # archives + real consumer acceptance
```

Some installer tests need `pnpm` on `PATH`; without it they are reported as skipped, with the reason.
