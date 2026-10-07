#!/usr/bin/env node
// Pre-install / pre-run health check.
//
// This exists because of a failure mode that is invisible until it is too late:
// @modelcontextprotocol/sdk 1.12.x calls zod 3's internal `_parse` API, which
// zod 4 removed. With that combination the server starts, `tools/list` answers,
// and then EVERY tool call fails with an opaque
//   MCP error -32603: keyValidator._parse is not a function
// so an agent cannot tell "I passed the wrong arguments" from "the server is
// broken" and goes off to read source code instead.
//
// This script answers that question in one second, before anything is started.
// It is deliberately plain JavaScript with no build step and no project
// dependencies, so it can run right after `pnpm install` — or even before it,
// in which case it reports exactly that.
//
// Usage:
//   node scripts/preflight.mjs                   # human-readable
//   node scripts/preflight.mjs --json            # machine-readable, for CI / --selfcheck
//   node scripts/preflight.mjs --require-build   # also fail if dist/ is missing
//
// Without --require-build a missing dist/ is reported as a note rather than a
// failure, because this script is designed to run right after `pnpm install`
// and before `pnpm build`.
//
// Exit code: 0 = ready to run, 1 = something must be fixed first.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * True when this script is running from an installed package rather than a
 * source checkout.
 *
 * The difference matters because two of the checks below are about the
 * *checkout*, not about the package: a published tarball legitimately ships no
 * lockfile and no node_modules of its own. Reporting those as failures made
 * `--selfcheck` fail for every installed copy while saying nothing useful.
 */
const INSTALLED_PACKAGE = /[\\/]node_modules[\\/][^\\/]+[\\/]?$/.test(`${PROJECT_ROOT}/`);

/** Minimum Node this server supports (mirrors "engines" in package.json). */
const MIN_NODE_MAJOR = 18;

/**
 * Read a dependency's package.json without importing it, so a broken or
 * half-installed tree cannot crash the checker itself.
 *
 * `require.resolve("<name>/package.json")` is NOT good enough: packages with an
 * `exports` map usually do not export "./package.json", and
 * @modelcontextprotocol/sdk is exactly such a package — the naive lookup throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED and the check silently reports the SDK as
 * missing. So: look the file up by path first (works through pnpm's symlinked
 * node_modules), and only then fall back to resolving an entry point and walking
 * up to the manifest that owns it.
 */
function readPkgJson(name) {
  const direct = join(PROJECT_ROOT, "node_modules", name, "package.json");
  try {
    return JSON.parse(readFileSync(direct, "utf8"));
  } catch {
    /* fall through to resolution */
  }

  let entry;
  try {
    entry = require_.resolve(name);
  } catch {
    try {
      entry = require_.resolve(`${name}/package.json`);
    } catch {
      return null;
    }
  }

  let dir = dirname(entry);
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf8"));
        if (pkg.name === name) return pkg;
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function majorMinor(version) {
  const m = String(version ?? "").match(/^(\d+)\.(\d+)/);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

/**
 * Decide whether the installed zod can satisfy the installed SDK.
 *
 * Two supported shapes:
 *   - SDK declares a peer/dep range that admits zod 4 (e.g. "^3.25 || ^4.0"),
 *     so zod 4 is fine;
 *   - SDK is zod-3-only (e.g. "^3.23.8") AND the installed zod still exposes
 *     the v3 internals the SDK reaches for.
 *
 * Anything else is the broken combination.
 */
export function checkZodSdkCompat() {
  const zodPkg = readPkgJson("zod");
  const sdkPkg = readPkgJson("@modelcontextprotocol/sdk");

  if (!zodPkg) return { ok: false, reason: "zod is not installed (run pnpm install)" };
  if (!sdkPkg)
    return {
      ok: false,
      reason: "@modelcontextprotocol/sdk is not installed (run pnpm install)",
    };

  const zod = majorMinor(zodPkg.version);
  const declaredRange =
    sdkPkg.peerDependencies?.zod ?? sdkPkg.dependencies?.zod ?? "";
  const sdkAdmitsZod4 = /(?:\^|~|>=)?\s*4/.test(String(declaredRange));

  // Runtime probe: v3 schemas carry `_parse`, v4 replaced it with `_zod`.
  let zodHasV3Internals = null;
  try {
    const { z } = require_("zod");
    zodHasV3Internals = typeof z?.string?.()._parse === "function";
  } catch {
    zodHasV3Internals = null;
  }

  const detail = {
    zod: zodPkg.version,
    sdk: sdkPkg.version,
    sdkZodRange: String(declaredRange),
    sdkAdmitsZod4,
    zodHasV3Internals,
  };

  if (zod && zod.major >= 4 && !sdkAdmitsZod4) {
    return {
      ok: false,
      detail,
      reason:
        `zod ${zodPkg.version} is installed but @modelcontextprotocol/sdk ` +
        `${sdkPkg.version} only accepts "${declaredRange}". The server will ` +
        `start and then fail every tool call with ` +
        `"keyValidator._parse is not a function". ` +
        `Fix: raise the SDK to a zod-4-aware release ` +
        `(pnpm add @modelcontextprotocol/sdk@^1.29.0 --save-exact), ` +
        `or pin zod back to 3 (pnpm add zod@3.23.8 --save-exact).`,
    };
  }

  if (zod && zod.major < 4 && zodHasV3Internals === false) {
    return {
      ok: false,
      detail,
      reason:
        `zod ${zodPkg.version} does not expose the v3 internals this SDK needs. ` +
        `The install is inconsistent — remove node_modules and reinstall.`,
    };
  }

  return { ok: true, detail };
}

export function runPreflight({ requireBuild = false } = {}) {
  const checks = [];
  // `blocking: false` marks a check that is informational until the caller asks
  // for it to gate. The build artefact is the one case: preflight is meant to
  // run right after `pnpm install`, i.e. BEFORE `pnpm build`, so a missing
  // dist/ must not fail it — but `--require-build` (used after a build, and by
  // CI) turns it into a hard gate.
  const push = (name, ok, info = {}) =>
    checks.push({ name, ok, blocking: true, ...info });

  // 1. Node version -----------------------------------------------------------
  const node = majorMinor(process.versions.node);
  const nodeOk = !!node && node.major >= MIN_NODE_MAJOR;
  push(
    "node",
    nodeOk,
    nodeOk
      ? { info: `v${process.versions.node}` }
      : {
          info: `v${process.versions.node}`,
          problem: `Node >= ${MIN_NODE_MAJOR} is required`,
        }
  );

  // 2. Package manager lock alignment ----------------------------------------
  // The project standardises on pnpm. A stray package-lock.json resolved by npm
  // can produce a different (and previously broken) dependency tree, so warn
  // rather than fail — both files may legitimately coexist during migration.
  //
  // This check only means anything in a source checkout. An installed package
  // ships no lockfile by design, so reporting "FAIL lockfiles" there would be a
  // false alarm about something the user cannot fix — which is how this check
  // used to make `--selfcheck` fail for everyone who installed the package.
  if (INSTALLED_PACKAGE) {
    push("lockfiles", true, { info: "n/a (installed package, not a source checkout)" });
  } else {
    const hasPnpmLock = existsSync(join(PROJECT_ROOT, "pnpm-lock.yaml"));
    const hasNpmLock = existsSync(join(PROJECT_ROOT, "package-lock.json"));
    push(
      "lockfiles",
      hasPnpmLock,
      hasPnpmLock
        ? {
            info: hasNpmLock ? "pnpm-lock.yaml (+ package-lock.json present)" : "pnpm-lock.yaml",
            note: hasNpmLock
              ? "package-lock.json also present; this project installs with pnpm"
              : undefined,
          }
        : { info: "none", problem: "pnpm-lock.yaml missing — dependency versions are unpinned" }
    );
  }

  // 3. Dependencies installed -------------------------------------------------
  // In a source checkout they are in <root>/node_modules. In an installed copy
  // the package lives at <consumer>/node_modules/<name>, so its dependencies
  // are two levels up — in the consuming project's tree. Only report "missing"
  // when neither location has them.
  const hasNodeModules =
    existsSync(join(PROJECT_ROOT, "node_modules")) ||
    existsSync(resolve(PROJECT_ROOT, "..", "node_modules")) ||
    existsSync(resolve(PROJECT_ROOT, "..", "..", "node_modules"));
  push(
    "dependencies",
    hasNodeModules,
    hasNodeModules
      ? { info: "node_modules present" }
      : { info: "missing", problem: "run `pnpm install`" }
  );

  // 4. The zod / SDK combination that actually decides whether tools work -----
  const compat = checkZodSdkCompat();
  push(
    "zod-sdk-compat",
    compat.ok,
    compat.ok
      ? {
          info: `sdk ${compat.detail?.sdk} + zod ${compat.detail?.zod} (range "${compat.detail?.sdkZodRange}")`,
        }
      : { info: compat.detail ? `sdk ${compat.detail.sdk} + zod ${compat.detail.zod}` : "n/a", problem: compat.reason }
  );

  // 5. Build artefact ---------------------------------------------------------
  const distEntry = join(PROJECT_ROOT, "dist", "index.js");
  const built = existsSync(distEntry);
  if (requireBuild || hasNodeModules) {
    checks.push({
      name: "build",
      ok: built,
      blocking: requireBuild,
      info: built ? distEntry : "dist/index.js missing",
      problem: built ? undefined : "run `pnpm build`",
    });
  }

  const ok = checks.every((c) => c.ok || c.blocking === false);
  return { ok, checks, projectRoot: PROJECT_ROOT, node: process.versions.node };
}

function printHuman(report) {
  // "note" = informational and non-blocking; "FAIL" = blocking.
  const icon = (c) => (c.ok ? "  ok  " : c.blocking === false ? " note " : " FAIL ");
  console.log(`biblio-mcp preflight — Node v${report.node}`);
  console.log(`project: ${report.projectRoot}\n`);
  for (const c of report.checks) {
    console.log(`${icon(c)} ${c.name.padEnd(15)} ${c.info ?? ""}`);
    if (c.problem) console.log(`        ↳ ${c.problem}`);
    if (c.note) console.log(`        · ${c.note}`);
  }
  const built = report.checks.find((c) => c.name === "build")?.ok;
  console.log(
    !report.ok
      ? "\nnot ready — fix the FAIL lines above, then re-run this script."
      : built
        ? "\nready to run: node dist/index.js"
        : "\ndependencies OK — run `pnpm build`, then `node dist/index.js`."
  );
}

// Run directly (not when imported by dist/index.js --selfcheck or by tests).
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const report = runPreflight({ requireBuild: process.argv.includes("--require-build") });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }
  process.exit(report.ok ? 0 : 1);
}
