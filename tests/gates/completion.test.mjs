import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {join} from "node:path";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const gatePath = join(repoRoot, "scripts/gates/check-decouple.mjs");
const runGate = (root) => spawnSync(process.execPath, [gatePath, "--root", root], {cwd: repoRoot, encoding: "utf8"});

test("a region claiming completion=full without rules or platform specs turns the profile gate red", () => {
  const result = runGate("tests/fixtures/gate-completion");
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /G1-PROFILE FAIL regions\/SA\/profile\.json: completion=full but regions\/SA\/compliance\/rules\.json is missing/);
  assert.match(output, /G1-PROFILE FAIL regions\/SA\/profile\.json: completion=full but data\/specs\/platforms\/noon\.json is missing/);
});

test("the real repository no longer claims full support for regions without rules and specs", () => {
  const result = runGate(repoRoot);
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.doesNotMatch(output, /completion=full but/);
});
