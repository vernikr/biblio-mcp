// Tests for the install-time guard.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PREFLIGHT_SRC = resolve(HERE, "..", "scripts", "preflight.mjs");

/** Build a throwaway project tree with a chosen zod/SDK pairing and run the
 *  real preflight script inside it. */
async function runPreflightAgainst({ zodVersion, sdkVersion, sdkZodRange }) {
  const root = await mkdtemp(join(tmpdir(), "biblio-preflight-"));
  await mkdir(join(root, "scripts"), { recursive: true });
  await copyFile(PREFLIGHT_SRC, join(root, "scripts", "preflight.mjs"));

  const writePkg = async (name, version, extra = {}) => {
    const dir = join(root, "node_modules", ...name.split("/"));
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name, version, ...extra }, null, 2)
    );
  };

  await writePkg("zod", zodVersion);
  await writePkg("@modelcontextprotocol/sdk", sdkVersion, {
    dependencies: { zod: sdkZodRange },
  });
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "x", version: "0.0.0" }));

  const out = await new Promise((done) => {
    const child = spawn(process.execPath, [join(root, "scripts", "preflight.mjs"), "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", (code) => done({ code, stdout }));
  });

  return { code: out.code, report: JSON.parse(out.stdout) };
}

const compatOf = (report) => report.checks.find((c) => c.name === "zod-sdk-compat");

test("preflight passes the known-good pairing (SDK 1.29 + zod 4.4.3)", async () => {
  const { report } = await runPreflightAgainst({
    zodVersion: "4.4.3",
    sdkVersion: "1.29.0",
    sdkZodRange: "^3.25 || ^4.0",
  });
  const compat = compatOf(report);
  assert.equal(compat.ok, true, JSON.stringify(compat));
});

test("preflight passes a zod-3-only SDK paired with zod 3", async () => {
  const { report } = await runPreflightAgainst({
    zodVersion: "3.23.8",
    sdkVersion: "1.12.1",
    sdkZodRange: "^3.23.8",
  });
  assert.equal(compatOf(report).ok, true);
});

test("preflight FAILS the broken pairing (SDK 1.12.1 + zod 4.4.3) with an actionable message", async () => {
  const { code, report } = await runPreflightAgainst({
    zodVersion: "4.4.3",
    sdkVersion: "1.12.1",
    sdkZodRange: "^3.23.8",
  });
  const compat = compatOf(report);

  assert.equal(compat.ok, false, "this combination must be rejected");
  assert.equal(report.ok, false);
  assert.equal(code, 1, "the script must exit non-zero so CI can gate on it");
  // The message has to name the symptom and the fix, not just say "incompatible".
  assert.match(compat.problem, /keyValidator\._parse is not a function/);
  assert.match(compat.problem, /pnpm add @modelcontextprotocol\/sdk/);
});

test("preflight reports a missing dependency tree instead of crashing", async () => {
  const root = await mkdtemp(join(tmpdir(), "biblio-preflight-empty-"));
  await mkdir(join(root, "scripts"), { recursive: true });
  await copyFile(PREFLIGHT_SRC, join(root, "scripts", "preflight.mjs"));

  const out = await new Promise((done) => {
    const child = spawn(process.execPath, [join(root, "scripts", "preflight.mjs"), "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", (code) => done({ code, stdout }));
  });

  const report = JSON.parse(out.stdout);
  assert.equal(report.ok, false);
  assert.equal(compatOf(report).ok, false);
  assert.match(compatOf(report).problem, /pnpm install/);
});

test("the shipped tree passes preflight", async () => {
  // Guards the repo itself: if someone bumps a dependency into the broken
  // pairing, this fails locally before it ever reaches a user.
  const { runPreflight } = await import("../scripts/preflight.mjs");
  const report = runPreflight();
  const failures = report.checks.filter((c) => !c.ok);
  assert.deepEqual(
    failures.map((f) => `${f.name}: ${f.problem}`),
    [],
    "the working tree must pass its own preflight"
  );
});

test("a missing build is a note by default but a failure with --require-build", async () => {
  // preflight is designed to run right after `pnpm install`, i.e. BEFORE
  // `pnpm build`. Failing on a missing dist/ there would make the guard unusable
  // in exactly the place it is needed; CI escalates it with --require-build.
  const { runPreflight } = await import("../scripts/preflight.mjs");

  const lenient = runPreflight();
  const build = lenient.checks.find((c) => c.name === "build");
  if (build && !build.ok) {
    assert.equal(build.blocking, false, "missing build must not block by default");
    assert.equal(lenient.ok, true, "a clean install without dist/ must still pass");
  }

  const strict = runPreflight({ requireBuild: true });
  const strictBuild = strict.checks.find((c) => c.name === "build");
  assert.ok(strictBuild, "requireBuild must always include the build check");
  assert.equal(strictBuild.blocking, true);
  // In a repo where dist/ exists both agree; where it does not, strict fails.
  assert.equal(strict.ok, strictBuild.ok && strict.checks.every((c) => c.ok));
});

test("preflight passes for an installed package, not just a source checkout", async () => {
  // Installed packages rely on the consumer's lockfile and node_modules.
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, cpSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");

  const consumer = mkdtempSync(join(tmpdir(), "biblio-installed-"));
  const pkgDir = join(consumer, "node_modules", "biblio-mcp");
  mkdirSync(join(pkgDir, "scripts"), { recursive: true });
  mkdirSync(join(consumer, "node_modules", "zod"), { recursive: true });
  mkdirSync(join(consumer, "node_modules", "@modelcontextprotocol", "sdk"), { recursive: true });

  const here = join(dirname(fileURLToPath(import.meta.url)), "..");
  cpSync(join(here, "scripts", "preflight.mjs"), join(pkgDir, "scripts", "preflight.mjs"));
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "biblio-mcp", version: "1.0.0" }));
  // Minimal manifests so the compat check has something to read.
  writeFileSync(
    join(consumer, "node_modules", "zod", "package.json"),
    JSON.stringify({ name: "zod", version: "4.4.3", main: "index.js" })
  );
  writeFileSync(
    join(consumer, "node_modules", "@modelcontextprotocol", "sdk", "package.json"),
    JSON.stringify({
      name: "@modelcontextprotocol/sdk",
      version: "1.29.0",
      peerDependencies: { zod: "^3.25 || ^4.0" },
    })
  );

  const r = spawnSync(process.execPath, [join(pkgDir, "scripts", "preflight.mjs"), "--json"], {
    encoding: "utf8",
  });
  const report = JSON.parse(r.stdout);
  const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));

  // The lockfile check must not fire: there is no lockfile in a tarball, and
  // that is correct.
  assert.equal(byName.lockfiles.ok, true, `lockfiles failed: ${byName.lockfiles.problem}`);
  assert.match(byName.lockfiles.info ?? "", /installed package/);
  // Dependencies live in the consuming project's tree, two levels up.
  assert.equal(byName.dependencies.ok, true, `dependencies failed: ${byName.dependencies.problem}`);
  assert.ok(existsSync(join(pkgDir, "scripts", "preflight.mjs")));
});
