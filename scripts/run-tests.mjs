// Every supported Node (22+) has the bounded test runner.

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = ["--test", "--test-concurrency=4"];
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
