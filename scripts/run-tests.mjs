// Keep the offline suite compatible with every supported Node 18 release.
// --test-concurrency was added in 18.9; use it where available to amortize the
// many short-lived test workers, and retain Node's default on older runtimes.

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [major, minor] = process.versions.node.split(".").map(Number);
const args = ["--test"];
if (major > 18 || (major === 18 && minor >= 9)) args.push("--test-concurrency=4");
args.push(
  ...readdirSync(join(root, "test"))
    .filter((file) => file.endsWith(".test.mjs"))
    .sort()
    .map((file) => join("test", file))
);

const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
if (result.error) {
  console.error(`Failed to start offline tests: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
