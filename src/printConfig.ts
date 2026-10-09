// `--print-config`: a ready-to-paste MCP client entry that launches the published
// package through pnpm. Pure builder + PATH lookup; the CLI wiring lives in index.ts.

import { accessSync, constants, statSync } from "node:fs";
import { delimiter as posixDelimiter, dirname as posixDirname, isAbsolute as posixIsAbsolute, join as posixJoin } from "node:path";
import { win32 } from "node:path";

export const PACKAGE_NAME = "@vernikr/biblio-mcp";

export interface LauncherConfigInput {
  /** Absolute path of the node binary running biblio-mcp. */
  execPath: string;
  /** Command to start pnpm: an absolute path when it was found, otherwise "pnpm". */
  pnpmPath: string;
  /** Package version to pin, without the leading "v". */
  version: string;
  platform: NodeJS.Platform;
}

export interface LauncherConfig {
  mcpServers: {
    biblio: {
      command: string;
      args: string[];
      env: { PATH: string };
    };
  };
}

function pathOps(platform: NodeJS.Platform) {
  return platform === "win32"
    ? { dirname: win32.dirname, isAbsolute: win32.isAbsolute, delimiter: ";" }
    : { dirname: posixDirname, isAbsolute: posixIsAbsolute, delimiter: posixDelimiter };
}

/**
 * Build the MCP entry. The PATH it carries lets a GUI-started client find both
 * pnpm and the node that pnpm uses for `dlx`, which a GUI launch does not inherit
 * from the user's shell.
 */
export function buildLauncherConfig(input: LauncherConfigInput): LauncherConfig {
  const ops = pathOps(input.platform);
  const dirs: string[] = [ops.dirname(input.execPath)];
  if (ops.isAbsolute(input.pnpmPath)) dirs.push(ops.dirname(input.pnpmPath));
  if (input.platform !== "win32") dirs.push("/usr/bin", "/bin");
  const unique = [...new Set(dirs)];
  return {
    mcpServers: {
      biblio: {
        command: input.pnpmPath,
        args: ["--silent", "dlx", `${PACKAGE_NAME}@${input.version}`],
        env: { PATH: unique.join(ops.delimiter) },
      },
    },
  };
}

function isExecutableFile(file: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (platform !== "win32") accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find `name` on the given PATH, returning the absolute path, or undefined.
 * On Windows pnpm is usually a `.cmd` shim, so those extensions are tried too.
 */
export function findOnPath(
  name: string,
  pathValue: string | undefined,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (!pathValue) return undefined;
  const ops = pathOps(platform);
  const exts = platform === "win32" ? ["", ".cmd", ".exe"] : [""];
  const join = platform === "win32" ? win32.join : posixJoin;
  for (const dir of pathValue.split(ops.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return undefined;
}
