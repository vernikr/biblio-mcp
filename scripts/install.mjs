#!/usr/bin/env node
// One-command installer for biblio-mcp.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = "https://github.com/vernikr/biblio-mcp.git";
const NODE_MIN_MAJOR = 18;

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
};

const REPO_URL = valueOf("--repo") ?? DEFAULT_REPO;
const TARGET = valueOf("--dir") ?? join(homedir(), "Tools", "biblio-mcp");
const CONFIG_PATH = valueOf("--write-config");
const DRY_RUN = has("--dry-run");
const SKIP_NETWORK = has("--skip-network");
const LIVE = has("--live");

let failures = 0;
const step = (n, msg) => process.stdout.write(`\n[${n}] ${msg}\n`);
const ok = (msg) => process.stdout.write(`  ok   ${msg}\n`);
const note = (msg) => process.stdout.write(`  ·    ${msg}\n`);
const bad = (msg) => {
  process.stdout.write(`  FAIL ${msg}\n`);
  failures += 1;
};

/** Run a command, streaming its output. Returns the exit code. */
function run(cmd, args, opts = {}) {
  process.stdout.write(`  $ ${cmd} ${args.join(" ")}\n`);
  if (DRY_RUN) return 0;
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: false, ...opts });
  if (r.error) {
    bad(`${cmd} could not be started: ${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
}

/** Locate a package manager without replacing a pnpm-locked tree with npm. */
function findPackageManager() {
  const pnpm = spawnSync("pnpm", ["--version"], { encoding: "utf8" });
  if (pnpm.status === 0) return { name: "pnpm", version: (pnpm.stdout || "").trim() };

  // This repository deliberately pins dependency resolution with pnpm. Falling
  // back to npm here can create a different tree or fail inside npm's resolver.
  if (existsSync(join(HERE, "..", "pnpm-lock.yaml"))) return null;

  const npm = spawnSync("npm", ["--version"], { encoding: "utf8" });
  if (npm.status === 0) return { name: "npm", version: (npm.stdout || "").trim() };
  return null;
}

async function main() {
  process.stdout.write(`biblio-mcp installer${DRY_RUN ? " (dry run — nothing is written)" : ""}\n`);
  if (LIVE && SKIP_NETWORK) {
    bad("--live and --skip-network cannot be used together");
    return finish();
  }

  // ---------------------------------------------------------------- 1. check
  step(1, "checking prerequisites");
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= NODE_MIN_MAJOR) ok(`node ${process.versions.node}`);
  else {
    bad(`node ${process.versions.node} is too old — ${NODE_MIN_MAJOR} or newer is required`);
    return finish();
  }

  const pm = findPackageManager();
  if (!pm) {
    bad("no package manager found — install pnpm: npm install -g pnpm");
    return finish();
  }
  ok(`${pm.name} ${pm.version}`);

  const git = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (git.status === 0) ok((git.stdout || "").trim());
  else note("git not found — needed only if the target directory does not exist yet");

  // --------------------------------------------------------------- 2. fetch
  step(2, `obtaining the source into ${TARGET}`);
  let projectDir = TARGET;
  if (existsSync(join(TARGET, "package.json"))) {
    ok("already present — reusing it (run `git pull` yourself to update)");
  } else if (existsSync(join(HERE, "..", "package.json")) && !has("--force-clone")) {
    // We are being run from inside a checkout; use it rather than cloning.
    projectDir = resolvePath(HERE, "..");
    ok(`running from the existing checkout at ${projectDir}`);
  } else if (DRY_RUN) {
    note(`would clone ${REPO_URL}`);
  } else {
    mkdirSync(dirname(TARGET), { recursive: true });
    if (run("git", ["clone", REPO_URL, TARGET]) !== 0) {
      bad(`could not clone ${REPO_URL}`);
      return finish();
    }
  }

  const preflight = join(projectDir, "scripts", "preflight.mjs");
  if (!existsSync(preflight)) {
    bad(`scripts/preflight.mjs not found in ${projectDir}`);
    return finish();
  }

  // ------------------------------------------------------------- 3. install
  step(3, "installing dependencies");
  const installArgs = pm.name === "pnpm" && existsSync(join(projectDir, "pnpm-lock.yaml"))
    ? ["install", "--frozen-lockfile"]
    : ["install"];
  if (run(pm.name, installArgs, { cwd: projectDir }) !== 0) {
    bad(`${pm.name} install failed`);
    return finish();
  }

  // ----------------------------------------------------------- 4. preflight
  step(4, "preflight — the dependency guard");
  // Validate the installed SDK/Zod pair before building; a clean checkout has
  // neither dependencies nor dist yet.
  if (run(process.execPath, [preflight], { cwd: projectDir }) !== 0) {
    bad("preflight failed — the messages above include the exact fix command");
    return finish();
  }

  // --------------------------------------------------------------- 5. build
  step(5, "building");
  if (run(pm.name, ["run", "build"], { cwd: projectDir }) !== 0) {
    bad("build failed");
    return finish();
  }
  const entry = join(projectDir, "dist", "index.js");
  if (DRY_RUN) note(`would expect ${entry}`);
  else if (existsSync(entry)) ok(entry);
  else bad(`${entry} does not exist after a successful build`);

  // -------------------------------------------------------------- 6. verify
  step(6, "verifying the tool surface");
  // The startup self-test: in-process, no network, and it distinguishes "starts"
  // from "can actually serve a request" — the difference that hid the original
  // broken release.
  const selftest = [
    "--input-type=module",
    "-e",
    `import { runStartupSelftest } from ${JSON.stringify(
      join(projectDir, "dist", "selfcheck.js")
    )};
     const r = await runStartupSelftest();
     process.stdout.write(JSON.stringify(r));
     process.exitCode = r.ok ? 0 : 1;`,
  ];
  if (DRY_RUN) note("would run the in-process tool-surface self-test");
  else {
    const r = spawnSync(process.execPath, selftest, { encoding: "utf8", cwd: projectDir });
    let parsed = {};
    try {
      parsed = JSON.parse((r.stdout || "").trim());
    } catch {
      /* reported below */
    }
    if (r.status === 0 && parsed.ok) ok("the tool surface answers a real tool call");
    else {
      bad(`tool surface is broken: ${parsed.problem ?? (r.stderr || r.stdout || "unknown").slice(0, 300)}`);
      if (parsed.fix) note(`fix: ${parsed.fix}`);
      return finish();
    }
  }

  if (LIVE) {
    step("6a", "checking live mirror health");
    if (run(process.execPath, [entry, "--selfcheck", "--live"], { cwd: projectDir }) !== 0) {
      bad("live mirror check failed");
      return finish();
    }
  } else {
    note(
      SKIP_NETWORK
        ? "skipping the live mirror check (--skip-network)"
        : "skipping the live mirror check (pass --live to run `--selfcheck --live`)"
    );
  }

  // -------------------------------------------------------------- 7. config
  step(7, "MCP client configuration");
  const snippet = {
    mcpServers: {
      biblio: {
        command: process.execPath,
        args: [entry],
      },
    },
  };
  const text = JSON.stringify(snippet, null, 2);

  if (!CONFIG_PATH) {
    ok("add this to your MCP client config (Claude Desktop, Cline, Cursor, …):");
    process.stdout.write(`\n${text}\n\n`);
    note(`or re-run with --write-config <path> to merge it in for you`);
  } else {
    writeConfig(CONFIG_PATH, snippet.mcpServers.biblio, entry);
  }

  return finish();
}

/** Merge one server entry into an existing MCP config file. */
function writeConfig(configPath, entry, entryPath) {
  const abs = isAbsolute(configPath) ? configPath : resolvePath(process.cwd(), configPath);

  // Validate before writing: a path in `args` that does not exist produces a
  // client that fails with no useful message, which is the failure mode this
  // installer is meant to remove.
  if (!DRY_RUN && !existsSync(entryPath)) {
    bad(`refusing to write a config pointing at a missing file: ${entryPath}`);
    return;
  }

  let existing = {};
  if (existsSync(abs)) {
    let raw;
    try {
      raw = readFileSync(abs, "utf8");
    } catch (e) {
      bad(`cannot read ${abs}: ${String(e?.message ?? e)}`);
      return;
    }
    try {
      existing = JSON.parse(raw);
    } catch (e) {
      bad(`${abs} is not valid JSON, so it was left untouched: ${String(e?.message ?? e)}`);
      note("add the snippet above by hand, or fix the file and re-run");
      return;
    }
    if (!DRY_RUN) {
      copyFileSync(abs, `${abs}.bak`);
      note(`backed up the existing config to ${abs}.bak`);
    }
  }

  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    bad(`${abs} does not contain a JSON object, so it was left untouched`);
    return;
  }
  if (!existing.mcpServers || typeof existing.mcpServers !== "object") existing.mcpServers = {};
  if (existing.mcpServers.biblio) note(`replacing the existing "biblio" entry`);
  existing.mcpServers.biblio = entry;

  if (DRY_RUN) {
    note(`would write ${abs}`);
    return;
  }
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(existing, null, 2)}\n`);
  renameSync(tmp, abs);
  ok(`wrote ${abs}`);
  note(`verify the path it points at: ${entryPath}`);
}

function finish() {
  process.stdout.write(
    failures > 0
      ? `\ninstall FAILED — ${failures} problem(s) above. Nothing further was attempted.\n`
      : "\ninstall complete.\n"
  );
  return failures > 0 ? 1 : 0;
}

process.exitCode = await main();
