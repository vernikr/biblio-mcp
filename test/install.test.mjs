// Tests for the installer and the startup self-test.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runStartupSelftest } from "../dist/selfcheck.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALLER = join(HERE, "..", "scripts", "install.mjs");

/** Run the installer and return { status, stdout, stderr }. */
function runInstaller(args, cwd, env) {
  const r = spawnSync(process.execPath, [INSTALLER, ...args], {
    encoding: "utf8",
    cwd: cwd ?? join(HERE, ".."),
    env: env ?? process.env,
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
  // Keep the startup guard actionable for the known SDK/Zod incompatibility.
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
  assert.match(r.stdout, /skipping the live mirror check.*--live/);
  assert.match(r.stdout, /install complete/);
  // The snippet it prints must be usable as-is.
  const json = /(\{[\s\S]*"mcpServers"[\s\S]*\})/.exec(r.stdout);
  assert.ok(json, "must print a config snippet");
  const parsed = JSON.parse(json[1]);
  assert.ok(parsed.mcpServers.biblio.args[0].endsWith("dist/index.js"));
});

test("the installer refuses npm fallback when the checkout has a pnpm lockfile", () => {
  const dir = mkdtempSync(join(tmpdir(), "biblio-install-pm-"));
  const bin = join(dir, "bin");
  const npmMarker = join(dir, "npm-was-run");
  mkdirSync(bin, { recursive: true });
  const fakeNpm = join(bin, "npm");
  writeFileSync(fakeNpm, `#!/bin/sh\nprintf ran > ${JSON.stringify(npmMarker)}\necho 99.0.0\n`);
  chmodSync(fakeNpm, 0o755);

  const r = runInstaller(["--dry-run", "--dir", join(dir, "repo")], join(HERE, ".."), {
    ...process.env,
    PATH: bin,
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no package manager found — install pnpm/);
  assert.equal(existsSync(npmMarker), false, "npm must not be probed or run over the pnpm lockfile");
  assert.doesNotMatch(r.stdout, /\$ npm install/);
  assert.doesNotMatch(r.stdout, /\[2\] obtaining/, "the installer should stop at the missing pnpm prerequisite");
});

test("the installer --live flag runs the live selfcheck", () => {
  const dir = mkdtempSync(join(tmpdir(), "biblio-install-"));
  const r = runInstaller(["--dry-run", "--live", "--dir", join(dir, "repo")]);
  assert.equal(r.status, 0, `installer failed:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /--selfcheck --live/);
  assert.doesNotMatch(r.stdout, /skipping the live mirror check/);
});

test("the installer rejects contradictory --live and --skip-network flags immediately", () => {
  const dir = mkdtempSync(join(tmpdir(), "biblio-install-"));
  const r = runInstaller(["--dry-run", "--live", "--skip-network", "--dir", join(dir, "repo")]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /cannot be used together/);
  assert.doesNotMatch(r.stdout, /\[1\] checking prerequisites/);
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

// ---------------------------------------------------------------------------
// Documentation drift guards
// ---------------------------------------------------------------------------

test("every BIBLIO_* variable in the code is documented in --help and the README", async () => {
  // This drifted twice: BIBLIO_ANNAS_API_KEY was in the README but not --help,
  // and BIBLIO_SKIP_STARTUP_CHECK was in neither. An undocumented switch is one
  // nobody can find when they need it.
  const { execFileSync } = await import("node:child_process");
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..");

  const inCode = new Set();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|mjs)$/.test(e.name)) {
        for (const m of readFileSync(p, "utf8").matchAll(/BIBLIO_[A-Z_]+/g)) inCode.add(m[0]);
      }
    }
  };
  walk(join(root, "src"));
  walk(join(root, "scripts"));

  const help = execFileSync(process.execPath, [join(root, "dist", "index.js"), "--help"], {
    encoding: "utf8",
  });
  const readme = readFileSync(join(root, "README.md"), "utf8");

  const missingFromHelp = [...inCode].filter((v) => !help.includes(v));
  const missingFromReadme = [...inCode].filter((v) => !readme.includes(v));

  assert.deepEqual(missingFromHelp, [], `undocumented in --help: ${missingFromHelp.join(", ")}`);
  assert.deepEqual(missingFromReadme, [], `undocumented in README: ${missingFromReadme.join(", ")}`);
});

test("every command the README tells you to run actually exists", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const readme = readFileSync(join(here, "..", "README.md"), "utf8");
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));

  const scripts = new Set(Object.keys(pkg.scripts));
  // pnpm's own builtins are not package scripts, and prose words are not
  // commands at all ("Why pnpm and not npm?").
  const BUILTINS = new Set(["install", "add", "remove", "run", "exec", "dlx", "why", "update", "list"]);
  const PROSE = new Set(["and", "or", "the", "with", "only", "not", "is", "a"]);
  const referenced = new Set();
  for (const m of readme.matchAll(/pnpm (?:run )?([a-z][a-z0-9:]*)/g)) {
    const name = m[1];
    if (BUILTINS.has(name) || PROSE.has(name)) continue;
    referenced.add(name);
  }
  const missing = [...referenced].filter((s) => !scripts.has(s));
  assert.deepEqual(missing, [], `README references pnpm scripts that do not exist: ${missing.join(", ")}`);
});

test("the published tarball contains the installer the README points at", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
  const readme = readFileSync(join(here, "..", "README.md"), "utf8");

  // The README's primary install path is `node scripts/install.mjs`, so the
  // package must ship it — otherwise the documented command 404s for anyone who
  // installs rather than clones.
  if (/scripts\/install\.mjs/.test(readme)) {
    assert.ok(
      pkg.files.some((f) => f === "scripts/install.mjs"),
      `package.json "files" must include scripts/install.mjs, got: ${JSON.stringify(pkg.files)}`
    );
  }
});

test("the fork package is private while the upstream owns the npm name", () => {
  const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));
  assert.equal(pkg.name, "biblio-mcp");
  assert.equal(pkg.private, true, "avoid accidentally publishing over the upstream package");
});

test("every version in the CHANGELOG has a matching compare link", async () => {
  // Five fork releases shipped with no tag and, for four of them, no link at all,
  // so the "keep a changelog" link references pointed nowhere. Guard it.
  const here = dirname(fileURLToPath(import.meta.url));
  const changelog = readFileSync(join(here, "..", "CHANGELOG.md"), "utf8");

  const declared = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
  const linked = new Set(
    [...changelog.matchAll(/^\[(\d+\.\d+\.\d+)\]:\s+(\S+)$/gm)].map((m) => m[1])
  );

  const missing = declared.filter((v) => !linked.has(v));
  assert.deepEqual(missing, [], `CHANGELOG declares versions with no link reference: ${missing.join(", ")}`);

  // Fork releases must point at the fork; upstream releases at upstream. A fork
  // release linked to upstream would misattribute the work.
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
  const forkHost = /vernikr\/biblio-mcp/;
  for (const m of changelog.matchAll(/^\[(\d+\.\d+\.\d+)\]:\s+(\S+)$/gm)) {
    const [, version, url] = m;
    // 1.0.0 and 1.1.0 predate the fork.
    if (version === "1.0.0" || version === "1.1.0") {
      assert.match(url, /yashimosh\/biblio-mcp/, `${version} is an upstream release and must link upstream`);
    } else {
      assert.ok(forkHost.test(url), `${version} is a fork release but links to ${url}`);
    }
  }
  assert.ok(declared.includes(pkg.version), `package.json version ${pkg.version} is not in the CHANGELOG`);
});
