# Project state

Short, current snapshot for anyone (human or agent) picking the fork up. The long audit history is in
[`worklog/biblio-mcp-audit.md`](worklog/biblio-mcp-audit.md); treat that file as an archive. Its
opening sections describe the state after wave 1. The A16 entry (around line 332) is closed.

## Version

`1.8.0` (see `package.json`). Private source fork: install from this checkout with
`node scripts/install.mjs`.

## Open items

- **P4, cached Anna's detail pages:** deliberately not done. A cached load cannot be cancelled, and
  cancelling the losing Anna's request is the bigger saving.
- **Slow install tests:** `test/install.test.mjs` runs one real build (about 5 s). The full offline
  suite takes about 15 s. The "under 5 s" target was dropped rather than losing that coverage.
- **`downloadToFile` is not fully on `fetchWithTimeout`:** its timer must cover the whole body
  transfer. This is intentional.
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
pnpm run verify                        # all of the above plus live selfcheck
node scripts/sync-env-docs.mjs         # after changing src/config.ts
```

Some installer tests need `pnpm` on `PATH`; without it they are reported as skipped, with the reason.
