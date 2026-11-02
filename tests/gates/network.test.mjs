import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {join} from "node:path";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const gatePath = join(repoRoot, "scripts/gates/check-decouple.mjs");
const runGate = (root) => spawnSync(process.execPath, [gatePath, "--root", root], {cwd: repoRoot, encoding: "utf8"});

test("G2-NET turns red when core reaches the network directly", () => {
  const result = runGate("tests/fixtures/gate-network-red");
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /G2-NET FAIL core\/net-call\.mjs: bare fetch call/);
  assert.match(output, /G2-NET FAIL core\/net-module\.mjs: node http\/https\/net\/tls import/);
});

test("G2-NET stays green when only channels reach the network", () => {
  const result = runGate("tests/fixtures/gate-network-green");
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  const match = output.match(/G2-NET PASS scanned_core_files=(\d+) network_allowed_channels=(\d+)/);
  assert.ok(match, `G2-NET must report both counts; output:\n${output}`);
  assert.ok(Number(match[1]) > 0, "G2-NET must scan a non-empty core directory");
  assert.equal(Number(match[2]), 1);
});

test("G2-NET scans the real repository core and reports a non-zero count", () => {
  const result = runGate(repoRoot);
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  const match = output.match(/G2-NET PASS scanned_core_files=(\d+) network_allowed_channels=(\d+)/);
  assert.ok(match, `G2-NET must report both counts; output:\n${output}`);
  assert.ok(Number(match[1]) >= 7, `expected at least 7 core files, got ${match[1]}`);
  assert.ok(Number(match[2]) > 0, "channels must still be counted as network-capable");
});

test("G2-NET skips rather than silently passing when a root has no core files", () => {
  const result = runGate("tests/fixtures/gate-profile");
  const output = result.stdout + result.stderr;
  assert.match(output, /G2-NET SKIP scanned_core_files=0/);
});
