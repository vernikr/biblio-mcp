# Refactor, iteration 2 — draft plan

Iteration 1 is closed (waves 1–5, CI runs #61–#70 green). This is the backlog it left behind:
everything below was found during iteration 1 and deliberately not done, either because the
estimate was wrong or because it did not fit a wave.

**Status: draft.** Nothing here is approved. Each row needs an evidence check before it is
scheduled, because three of iteration 1's estimates turned out to be wrong after measuring
(`C1`'s 11.5 s → 3 s, `E3`, `E4`).

## Where iteration 1 finished against its own targets

| Metric | Target | Now | Gap |
|---|---|---|---|
| Tracked tree | ≤ 4 MB | 2.1 MB | met |
| Unused exports in `src/` | 0 | 0 | met |
| CI jobs per push | ≤ 5 | 6 | near |
| Offline suite wall time | ≤ 12 s | **15.8 s** | **3.8 s** |
| `pnpm run verify` | ≤ 15 s | **16.3 s** | **1.3 s** |
| `README.md` | ≤ 250 lines | **395** | **145** |

The README gap is a judgement call, not an oversight: the maintainer half left the file (581 →
395), and what remains is install, tools, configuration and limitations — all of it read by the
person installing. Cutting to 250 means deleting consumer content. **Recommendation: drop the
target, keep the file honest.** The real question for iteration 2 is whether the *suite* can lose
4 s without losing coverage.

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
| **C1'** | `runInstall({ packageManager })` already exists (`scripts/install.mjs:170`) and skips the ~350 ms pnpm/npm probe, but no caller passes it. Thread it through the test call sites. | `scripts/install.mjs:192` | `install.test.mjs` is the slowest file in the suite (≈7.4 s); the probe fires once per call. | **S** | **S** — the 2 end-to-end tests that really install and build must keep probing. |

### Behaviour and performance

| # | Task | Evidence | Benefit | Cost | Risk |
|---|---|---|---|---|---|
| **E6** | Cache Sci-Hub resolutions with the same TTL pattern as `adsPageCache` — the same DOI is commonly resolved twice (`search_papers` then `get_paper`). | `src/providers/scihub.ts` | Iteration 1's `E2` cut `scihub.resolve` from 57–65 ms to **27–28 ms**; **re-measure before scheduling** — `E2` may have made this unnecessary. | **S** | **S** |
| **E5** | `content-length` sanity cap (e.g. 20 MB) before `res.text()` in `fetchFromMirrors`, so a hostile mirror cannot balloon the process. Up to 7 Libgen mirror bodies are held concurrently. | `src/http.ts` | Hardening only. **Low value — keep deferred** unless an OOM is actually observed. | **S** | **S** |
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

Proposed targets, to be agreed before scheduling:

- offline suite **≤ 13 s** (from 15.8 s) — reachable through `C1'` alone if the probe removal
  lands; otherwise accept 15.8 s and stop chasing it.
- every `src/` symbol that names a version, a source or a tool is defined once.
- no row above is scheduled until its "evidence" cell has been re-checked against the tree.
