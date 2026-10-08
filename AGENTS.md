# Maintainer and coding-agent guide

This repository is a private source fork of the upstream npm package. Use Node.js 18+ and pnpm;
keep changes testable without live access to shadow-library mirrors.

## Verification

```bash
pnpm run typecheck
pnpm run build
pnpm run test          # offline suite, local HTTP servers and captured HTML only
pnpm run verify        # typecheck + build + offline suite + live mirror selfcheck
```

`pnpm run verify` includes `selfcheck`, which probes live mirror roots. If the network is blocked,
run the first three commands separately and report that the live check could not run. Optional live
integration tests are under `test/live/` and run with `pnpm run test:live`; do not add them to the
default offline suite.

## Updating mirrors

- Edit the defaults and `MIRROR_GROUPS` identity markers in `src/mirrors.ts`; environment overrides
  are parsed there as well.
- A status code is not proof that a host is the expected site. Check the returned content, update
  the group's identity marker, and run `pnpm run selfcheck` before changing preference order.
- Provider fetch validation is per-provider. Anna's scraped pages have an identity validator; the
  Sci-Hub ALTCHA/HTTP-200 case remains tracked as A16 in `docs/worklog/biblio-mcp-audit.md`.
- Keep unreachable domains only when they may recover or are useful as user-configurable fallbacks;
  explain non-obvious ordering in `docs/decisions.md`.

## Adding or changing a provider

1. Implement the provider under `src/providers/` and return the shared `Book` or `Paper` shape from
   `src/types.ts`.
2. Reuse `fetchFromMirrors` from `src/http.ts` and validators in `src/parse.ts`; avoid positional
   field guesses when the page exposes headers.
3. Register the provider in `src/providers/index.ts`. If it is a new source, also update `SourceId`,
   default/disabled source handling, the relevant Zod schema and description in `src/server.ts`,
   and the tool examples/tests.
4. Add regression tests against a local HTTP server or captured markup. Environment variables that
   define mirror lists are read at module import time; set them before importing built modules (use
   a child process when the test needs an isolated provider graph).
5. Run the offline checks above and inspect the full diff before committing.

## Capturing HTML fixtures

- `pnpm run fixtures:capture` contacts configured public sites and refreshes the supported real
  captures in `test/fixtures/`. It checks HTTP status, expected content markers, challenge pages,
  and response size before replacing a fixture.
- Only commit genuine, reviewable provider responses; do not handcraft substitute HTML for a site
  that is unavailable. Anna's Archive and Z-Library are intentionally absent from the capture list
  while their pages cannot be captured reliably.
- After a capture, update the SHA-256 entry and semantic assertions in `test/fixtures.test.mjs`,
  then run `pnpm run test`.

## README cover

The text between `<!-- cover:start -->` and `<!-- cover:end -->` in `README.md` is the
user-facing summary of what this fork gives people. It is written for end users, in plain
language, without implementation detail. Update it in the same commit whenever a change alters
what a user gets (a new benefit, a removed limitation, a changed default), and keep it short.

## Packaging and credentials

- `package.json` is marked `private` because the `biblio-mcp` npm name belongs to upstream. Supported
  installation is from this checkout via `node scripts/install.mjs`; do not remove `private` or
  publish this fork under the upstream name without an explicit release decision.
- Never commit PATs, API keys, or user-specific config. Keep `BIBLIO_ANNAS_API_KEY` in the runtime
  environment, and use temporary credential handling for Git pushes.
