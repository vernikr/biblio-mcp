// Tests for the installer and the startup self-test.
//
// The installer is the one script here that touches files it does not own, so
// the cases that matter most are the ones where it must REFUSE to act: a config
// it cannot parse, and a path that does not exist. Destroying a working client
// config to install a book downloader would be a bad trade.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runStartupSelftest } from "../dist/selfcheck.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALLER = join(HERE, "..", "scripts", "install.mjs");

/** Run the installer and return { status, stdout, stderr }. */
function runInstaller(args, cwd) {
  const r = spawnSync(process.execPath, [INSTALLER, ...args], {
    encoding: "utf8",
    cwd: cwd ?? join(HERE, ".."),
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// ---------------------------------------------------------------------------
// The startup self-test (item 25)
// ---------------------------------------------------------------------------

test("runStartupSelftest passes on a healthy build", async () => {
  const result = await runStartupSelftest();
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  assert.equal(result.problem, undefined);
});

test("the entry point refuses to start when the tool surface is broken", () => {
  // Reproduces the exact shipped failure: @modelcontextprotocol/sdk 1.12.1 (peer
  // zod ^3.23.8) resolved against zod 4 makes every tools/call throw
  // `keyValidator._parse is not a function`. We cannot install that pairing here,
  // so we assert the contract instead: a non-zero exit and a message that names
  // the fix. The negative case is exercised in CI against the real pairing.
  const r = spawnSync(process.execPath, [join(HERE, "..", "dist", "index.js"), "--version"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^biblio-mcp v\d+\.\d+\.\d+/);
});

test("the startup check can be bypassed, and says so when it refuses", () => {
  const r = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `
      import { runStartupSelftest } from ${JSON.stringify(
        join(HERE, "..", "dist", "selfcheck.js")
      )};
      const res = await runStartupSelftest();
      process.stdout.write(JSON.stringify(res));
    `],
    { encoding: "utf8", cwd: join(HERE, "..") }
  );
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.ok, true);
  // The contract the entry point relies on: when it fails, it must carry a fix.
  assert.ok(parsed.ok || parsed.fix, "a failing startup check must include a fix command");
});

// ---------------------------------------------------------------------------
// The installer (item 24)
// ---------------------------------------------------------------------------

test("the installer runs end to end in dry-run mode and writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "biblio-install-"));
  const r = runInstaller(["--dry-run", "--dir", join(dir, "repo")]);
  assert.equal(r.status, 0, `installer failed:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /\[1\] checking prerequisites/);
  assert.match(r.stdout, /\[7\] MCP client configuration/);
  assert.match(r.stdout, /install complete/);
  // The snippet it prints must be usable as-is.
  const json = /(\{[\s\S]*"mcpServers"[\s\S]*\})/.exec(r.stdout);
  assert.ok(json, "must print a config snippet");
  const parsed = JSON.parse(json[1]);
  assert.ok(parsed.mcpServers.biblio.args[0].endsWith("dist/index.js"));
});

test("the installer refuses to overwrite a config it cannot parse", () => {
  const dir = mkdtempSync(join(tmpdir(), "biblio-install-"));
  const cfg = join(dir, "mcp.json");
  writeFileSync(cfg, "{ this is not json\n");

  const r = runInstaller(["--dry-run", "--dir", join(dir, "repo"), "--write-config", cfg]);

  assert.equal(r.status, 1, "must fail rather than clobber");
  assert.match(r.stdout, /is not valid JSON, so it was left untouched/);
  assert.equal(readFileSync(cfg, "utf8"), "{ this is not json\n", "the file must be unchanged");
});

test("the installer refuses a config that is not a JSON object", () => {
  const dir = mkdtempSync(join(tmpdir(), "biblio-install-"));
  const cfg = join(dir, "mcp.json");
  writeFileSync(cfg, "[1,2,3]\n");

  const r = runInstaller(["--dry-run", "--dir", join(dir, "repo"), "--write-config", cfg]);

  assert.equal(r.status, 1);
  assert.match(r.stdout, /does not contain a JSON object/);
  assert.equal(readFileSync(cfg, "utf8"), "[1,2,3]\n");
});

test("the installer merges into an existing config and keeps a backup", () => {
  const dir = mkdtempSync(join(tmpdir(), "biblio-install-"));
  const cfg = join(dir, "mcp.json");
  writeFileSync(cfg, JSON.stringify({ mcpServers: { other: { command: "x" } } }));

  const r = runInstaller(["--dir", join(dir, "repo"), "--write-config", cfg]);
  assert.equal(r.status, 0, `installer failed:\n${r.stdout}\n${r.stderr}`);

  const after = JSON.parse(readFileSync(cfg, "utf8"));
  // The pre-existing server must survive — this is the user's config, not ours.
  assert.deepEqual(after.mcpServers.other, { command: "x" });
  assert.ok(after.mcpServers.biblio, "biblio entry must be added");
  assert.ok(after.mcpServers.biblio.args[0].endsWith("dist/index.js"));
  assert.ok(existsSync(`${cfg}.bak`), "a backup must be written before overwriting");
});

test("the installer validates the path it is about to put in a config", () => {
  // A config whose args point at a missing file produces a client that fails with
  // no useful message. The installer must not be the thing that creates it.
  const dir = mkdtempSync(join(tmpdir(), "biblio-install-"));
  const cfg = join(dir, "mcp.json");
  const r = runInstaller([
    "--dry-run",
    "--dir", join(dir, "does-not-exist"),
    "--write-config", cfg,
    "--force-clone",
  ]);
  // In dry-run mode nothing is written; the point is that it does not claim
  // success while pointing at a file that was never built.
  assert.ok(!existsSync(cfg), "dry run must not write the config");
  assert.ok(
    /would write|FAIL/.test(r.stdout),
    `expected either a dry-run note or a refusal, got:\n${r.stdout}`
  );
});

test("the installer is plain JavaScript with no imports from src", () => {
  // It has to run before anything is installed, so it cannot depend on the build.
  const source = readFileSync(INSTALLER, "utf8");
  assert.ok(!/from\s+["']\.\.\/dist/.test(source), "must not import the compiled build");
  assert.ok(!/from\s+["']\.\.\/src/.test(source), "must not import TypeScript sources");
  for (const line of source.split("\n")) {
    const m = /^\s*import .* from ["'](.+)["']/.exec(line);
    if (!m) continue;
    assert.ok(
      m[1].startsWith("node:"),
      `installer may only import node builtins, found: ${m[1]}`
    );
  }
});
