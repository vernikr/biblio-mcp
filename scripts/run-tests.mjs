// Probe the flag: the Node 18.17 runtime floor predates --test-concurrency.

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [major, minor] = process.versions.node.split(".").map(Number);
if (major === 18 && minor < 19) {
  console.error("Full suite requires Node 18.19+; the server runtime floor is 18.17 (checked separately in CI).");
  process.exit(1);
}
const args = ["--test"];
if (spawnSync(process.execPath, ["--test-concurrency=4", "--eval", ""], { stdio: "ignore" }).status === 0) {
  args.push("--test-concurrency=4");
}
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
