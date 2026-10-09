// --print-config emits a ready-to-paste MCP client entry that launches the
// published package through pnpm, with PATH set so a GUI-started client can
// still find node. It must never start the stdio server or print anything but JSON.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const PKG_SPEC = "@vernikr/biblio-mcp@latest";
// pnpm 12 skips releases younger than its minimum release age, so `latest` would
// resolve to an older copy for about a day after publishing. The exclude exempts
// this package only. The cache flag stops reuse of a previously fetched `latest`.
const LAUNCH_ARGS = [
  "--silent",
  "--config.minimum-release-age-exclude=@vernikr/biblio-mcp",
  "--config.dlx-cache-max-age=0",
  "dlx",
  PKG_SPEC,
];

function fakeExecutable(dir, name) {
  const file = join(dir, name);
  writeFileSync(file, "#!/bin/sh\necho 12.10.1\n");
  chmodSync(file, 0o755);
  return file;
}

function runPrintConfig(pathValue) {
  return spawnSync(process.execPath, [entry, "--print-config"], {
    encoding: "utf8",
    input: "",
    timeout: 10_000,
    env: { PATH: pathValue, HOME: tmpdir() },
  });
}

test("buildLauncherConfig launches the latest release with a cache-free dlx and carries node's dir on PATH", async () => {
  const { buildLauncherConfig } = await import("../dist/printConfig.js");
  const cfg = buildLauncherConfig({
    execPath: "/opt/node/bin/node",
    pnpmPath: "/opt/local/bin/pnpm",
    platform: "darwin",
  });
  assert.deepEqual(cfg, {
    mcpServers: {
      biblio: {
        command: "/opt/local/bin/pnpm",
        args: LAUNCH_ARGS,
        env: { PATH: `/opt/node/bin:/opt/local/bin:/usr/bin:/bin` },
      },
    },
  });
});

test("buildLauncherConfig never embeds secrets or a server-start flag", async () => {
  const { buildLauncherConfig } = await import("../dist/printConfig.js");
  const text = JSON.stringify(buildLauncherConfig({
    execPath: "/opt/node/bin/node", pnpmPath: "pnpm", platform: "linux",
  }));
  assert.doesNotMatch(text, /BIBLIO_|API_KEY|--selfcheck|--print-config/);
});

test("buildLauncherConfig keeps the Windows shim name and joins PATH with ';'", async () => {
  const { buildLauncherConfig } = await import("../dist/printConfig.js");
  const cfg = buildLauncherConfig({
    execPath: "C:\\Program Files\\nodejs\\node.exe",
    pnpmPath: "C:\\pnpm\\pnpm.cmd",
    platform: "win32",
  });
  const server = cfg.mcpServers.biblio;
  assert.equal(server.command, "C:\\pnpm\\pnpm.cmd");
  assert.equal(server.env.PATH, "C:\\Program Files\\nodejs;C:\\pnpm");
});

test("--print-config prints one JSON object on stdout, latest and absolute, and exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "biblio-pc-"));
  const pnpm = fakeExecutable(dir, "pnpm");
  const r = runPrintConfig(`${dir}${delimiter}/usr/bin${delimiter}/bin`);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /ready on stdio/, "must not start the stdio server");
  const parsed = JSON.parse(r.stdout);
  const server = parsed.mcpServers.biblio;
  assert.equal(server.command, pnpm);
  assert.deepEqual(server.args, LAUNCH_ARGS);
  assert.equal(server.env.PATH.split(delimiter)[0], dirname(process.execPath));
  assert.ok(server.env.PATH.split(delimiter).includes(dir));
});

test("--print-config warns and still prints when pnpm is not on PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "biblio-pc-empty-"));
  mkdirSync(join(dir, "empty"));
  const r = runPrintConfig(join(dir, "empty"));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).mcpServers.biblio.command, "pnpm");
  assert.match(r.stderr, /pnpm not found on PATH/);
});

test("stableExecDir resolves a symlinked node (fnm multishell) to its real install directory", async () => {
  const { stableExecDir } = await import("../dist/printConfig.js");
  const real = "/home/u/.local/share/fnm/node-versions/v22.23.2/installation/bin/node";
  const dir = stableExecDir(
    "/home/u/.local/state/fnm_multishells/15352_1791579648621/bin/node",
    "darwin",
    () => real,
  );
  assert.equal(dir, "/home/u/.local/share/fnm/node-versions/v22.23.2/installation/bin");
});

test("stableExecDir falls back to the given path when realpath fails", async () => {
  const { stableExecDir } = await import("../dist/printConfig.js");
  const dir = stableExecDir("/opt/node/bin/node", "linux", () => { throw new Error("ENOENT"); });
  assert.equal(dir, "/opt/node/bin");
});

test("ephemeralPathWarning flags per-shell and temp locations, not stable installs", async () => {
  const { ephemeralPathWarning } = await import("../dist/printConfig.js");
  assert.match(ephemeralPathWarning("/h/.local/state/fnm_multishells/1/bin/node") ?? "", /per-shell/);
  assert.match(ephemeralPathWarning("/tmp/abc/pnpm") ?? "", /temporary/);
  assert.equal(ephemeralPathWarning("/opt/local/bin/pnpm"), undefined);
});
