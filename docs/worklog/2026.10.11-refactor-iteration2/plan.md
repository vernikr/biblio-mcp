# Refactor, iteration 2 — draft plan

Iteration 1 is closed (waves 1–5, CI runs #61–#70 green). This is the backlog it left behind:
everything below was found during iteration 1 and deliberately not done, either because the
estimate was wrong or because it did not fit a wave.

**Status: wave 2 in progress.** Rows are scheduled one wave at a time, each after its evidence
cell has been re-checked against the tree, because three of iteration 1's estimates turned out to
be wrong after measuring (`C1`'s 11.5 s → 3 s, `E3`, `E4`).

## Wave 1 — one definition per fact

Scope: `A7`, `A9`, `A10`, `H1`, `H2`, `F2`, `A11'`. The evidence re-check retired `C1'` before it
was implemented: `installHere` has stubbed the package-manager probe since iteration 1, and the
rest of that file's time is real install/build work. Report and measurements:
[`wave1-report.md`](wave1-report.md). `H1` also covers `scripts/preflight.mjs`, whose advice named
a dependency version by hand.

## Wave 2 — measured hardening

Scope: `E6`, `E5`, with their evidence re-checked first. `E6` was real, measured before it was
built: the same DOI resolved once by an enriched `search_papers` and again by the follow-up
`get_paper` — two mirror races, the second costing a full round trip (159 ms against a mirror
answering in 150 ms; 1 ms after the change). `E5` was scheduled because the owner asked for the
protection rather than waiting for an observed OOM. Report:
[`wave2-report.md`](wave2-report.md).

Nothing in this plan is unscheduled now: every row is either delivered (waves 1–2) or carries a
"do not re-propose" note.

## Where iteration 1 finished against its own targets

| Metric | Target | Now | Gap |
|---|---|---|---|
| Tracked tree | ≤ 4 MB | 2.1 MB | met |
| Unused exports in `src/` | 0 | 0 | met |
| CI jobs per push | ≤ 5 | 6 | near |
| Offline suite wall time | ≤ 12 s | 15.8 s | dropped |
| `pnpm run verify` | ≤ 15 s | 16.3 s | dropped |
| `README.md` | ≤ 250 lines | 395 | dropped |

Both remaining gaps were closed as decisions, not as work: the maintainer half of the README left
the file in iteration 1 and what remains is read by the person installing (cutting to 250 means
deleting consumer content), and the suite's remaining time is genuine install/build coverage.
Confirmed with the owner after wave 1 measured `C1'` as already delivered.

## Candidates

Priority order is unchanged from iteration 1: (1) context and speed for the agent developing the
project, (2) hidden bugs, (3) E2E performance and memory, (4) experience for agents using the
tools.

### Volume — duplicated logic, drift

| # | Task | Evidence in the tree today | Benefit | Cost | Risk |
|---|---|---|---|---|---|
| **A7** | Unify zod-issue extraction. `issuesOf()` in `src/toolmeta.ts:66` and `validationIssuesFrom()` in `src/server.ts:83` do the same job, and `server.ts` additionally re-parses the SDK's flattened error text with regexes. | both functions exist; 10 `input-validation` tests | One implementation; removes the regex-over-error-text fragility that the fork was created to avoid. | **S** | **M** — agent-facing error text; the 10 tests are the guard. Do it only together with a test that fails on the old text. |
| **A9** | One anchor-collection helper. `extractDownloadLinks` is implemented twice: `src/providers/annas.ts:213` and `src/providers/libgen.ts:302`. | both functions | −1 duplicated parser loop; one place to fix link filtering. | **S** | **S** — guarded by captured fixtures, `url-resolution`, `details`. |
| **A10** | One source-name registry. The Zod enum `["annas","libgen","zlibrary"]` is written **twice** (`src/server.ts:227` and `:373`), there are 2 `sources as SourceId[]` casts that defeat the type checker, and `ALL_BOOK_SOURCES` still lives in `src/providers/index.ts:26`. | grep | Adding a source becomes a one-line change the compiler verifies. | **S** | **S** |
| **A11'** | Scripts: 20 → 19. `test:all` (`test` + `test:live`) duplicates `verify:live` (`verify` + `selfcheck:live`) and is referenced only by `AGENTS.md`. | `package.json` | One fewer name to choose between. | **XS** | **XS** — CI calls `verify`, `preflight`, `test:live`, `package:artifacts`, `docs:env`; none is touched. |
| **H1** | `src/selfcheck.ts:94` hard-codes `pnpm add @modelcontextprotocol/sdk@1.32.1 zod@4.6.5` as the fix message. Those versions duplicate `package.json` and will drift. | the string | The one message an agent acts on stops going stale. | **XS** | **XS** — read the versions from `package.json` at build/run time. |
| **H2** | `src/sniff.ts` is 33 lines and decides whether the bytes are a book or HTML. Check its edges against the tests that cover it. | file listing | Invariant 2 in `docs/architecture.md` rests on this file. | **S** | **S** |

### Check speed

| # | Task | Evidence | Benefit | Cost | Risk |
|---|---|---|---|---|---|
| **C1'** | ~~Thread `packageManager` through the test call sites.~~ **Retired** — the call sites already stub the probe (iteration 1's `c1fd358`); the remaining 6.1 s of `install.test.mjs` is genuine install/build work. See [`wave1-report.md`](wave1-report.md). | re-checked | — | — | — |

### Behaviour and performance

| # | Task | Evidence | Benefit | Cost | Risk |
|---|---|---|---|---|---|
| **E6** | **Done (wave 2).** Resolutions are memoized for the provider TTL with shared in-flight work; a miss is not memoized. Re-checked by measurement first: the duplicate resolution was real. | `src/providers/scihub.ts` | — | — | — |
| **E5** | **Done (wave 2).** A 20 MB page budget: a declared length is checked before the body is read, a streaming body is counted and cut off, and `probeMirror`'s identity check uses the same reader. | `src/http.ts` | — | — | — |
| **F2** | `--selfcheck` prints the 8 tool names it verified, not just `8 tools exposed by …` (`src/selfcheck.ts:107` already holds `names`). | the line | An agent diagnosing "no tools appear in my client" can diff the client's list against the server's own answer. | **XS** | **XS** |

## Carried over as rejected — do not re-propose without new evidence

| # | What | Why not |
|---|---|---|
| `E3` / `D6` | Stop serialising every Libgen row (`forEachRow` calls `$row.html()` up to 100×). | **Built and measured slower.** Reverted. |
| `E4` | Stop re-arming the stall timer on every 16 KB chunk. | **Built and measured inside I/O noise** (~3,200 timer pairs for a 50 MB book). Reverted. |
| `B3` | Consolidate 35 test files into ~12. | Measured: per-file process cost is 85 ms, so the whole change saves ~1 s off 15.8 s. 21 of 35 files set `BIBLIO_*` at module scope that `dist/` reads once at import, so each merge needs a hand-built shared stub server. |
| `A8` | One in-memory MCP client helper. | Not duplication: 6 of 10 callers set env **before** importing built modules. |
| `F5` | `nextStep` on the "nothing reachable" healthcheck. | Already covered by the existing error text. |
| `D11` | `AsyncTtlCache` never reaps when traffic stops. | Bounded by `maxEntries`; expiry-on-read already works. |
| — | Replace cheerio with a lighter parser. | The parsers are the fragile part; the captured fixtures are the safety net. High risk, no context benefit. |
| — | Rewrite git history to purge the deleted binaries. | Chosen against in iteration 1: delete from HEAD only. |

## Definition of done for iteration 2

Same non-negotiable as iteration 1: `pnpm run verify` green with **0 skips**, every bug-fix test
demonstrated to fail on the previous commit, and the full CI gate after each wave.

Targets, as agreed after wave 1 measured them:

- **Restated: the offline suite has no absolute ceiling.** Its remaining time is real
  install/build coverage (`C1'` was retired as already delivered), so a fixed second count is not
  a target — but a wave that makes the gate slower than it found it has to say why in its report.
- **Dropped: `README.md` ≤ 250 lines.** What is left is read by the person installing the server.
- Kept: every `src/` symbol that names a version, a source or a tool is defined once — delivered
  across waves 1–2.
- Kept: no row is scheduled until its "evidence" cell has been re-checked against the tree.
