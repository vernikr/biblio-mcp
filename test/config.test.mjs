// The settings registry: every numeric budget is listed in --help, and the
// parser falls back on anything that is not a positive number.

import test from "node:test";
import assert from "node:assert/strict";

const { NUMBER_SETTINGS, ENV_SETTINGS, readNumber, environmentHelp } = await import(
  "../dist/config.js"
);

test("every numeric setting is listed in --help with its real default", () => {
  const names = new Set(ENV_SETTINGS.map((s) => s.name));
  const help = environmentHelp();
  for (const setting of Object.values(NUMBER_SETTINGS)) {
    assert.ok(names.has(setting.name), `${setting.name} missing from ENV_SETTINGS`);
    assert.match(help, new RegExp(`${setting.name} .*\\(default ${setting.fallback}\\)`));
  }
});

test("readNumber takes a positive number from the environment and falls back otherwise", () => {
  const setting = { name: "BIBLIO_TEST_NUMBER_SETTING", fallback: 42 };
  const saved = process.env[setting.name];
  try {
    delete process.env[setting.name];
    assert.equal(readNumber(setting), 42, "unset");
    process.env[setting.name] = "1500";
    assert.equal(readNumber(setting), 1500, "valid");
    for (const bad of ["", "abc", "0", "-5", "Infinity"]) {
      process.env[setting.name] = bad;
      assert.equal(readNumber(setting), 42, `"${bad}" must fall back`);
    }
  } finally {
    if (saved === undefined) delete process.env[setting.name];
    else process.env[setting.name] = saved;
  }
});
