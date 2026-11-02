import test from "node:test";
import assert from "node:assert/strict";
import {cp, mkdtemp, mkdir, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {runDoctor, assertPreflightCurrent} from "../../scripts/lib/preflight.mjs";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const nowIso = "2026-10-29T02:00:00.000Z";

async function fixture(sources = [], facts = []) {
  const root = await mkdtemp(join(tmpdir(), "doctor-fixture-"));
  await mkdir(join(root, "data/variables"), {recursive: true});
  await cp(join(projectRoot, "schemas"), join(root, "schemas"), {recursive: true});
  await writeFile(join(root, "data/sources.json"), `${JSON.stringify(sources, null, 2)}\n`);
  await writeFile(join(root, "data/variables/fx.json"), `${JSON.stringify(facts, null, 2)}\n`);
  return root;
}

test("missing FX is runnable but pricing is unavailable", async () => {
  const root = await fixture();
  const result = await runDoctor({root, nowIso});
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.state.pricing.status, "unavailable");
  const snapshot = JSON.parse(await readFile(join(root, "runs", result.state.run_id, "variables.snapshot.json"), "utf8"));
  assert.deepEqual(snapshot.facts, []);
});

test("unreadable configuration is a hard failure without a snapshot", async () => {
  const root = await fixture();
  await writeFile(join(root, "data/sources.json"), "{");
  const result = await runDoctor({root, nowIso});
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.state.run_id, null);
});

test("doctor CLI exposes both exit states", async () => {
  const valid = await fixture();
  const ok = spawnSync(process.execPath, [join(projectRoot, "scripts/doctor.mjs"), "--root", valid, "--now", nowIso], {encoding: "utf8"});
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /pricing_unavailable/);
  const invalid = await fixture();
  await writeFile(join(invalid, "data/variables/fx.json"), "not-json");
  const bad = spawnSync(process.execPath, [join(projectRoot, "scripts/doctor.mjs"), "--root", invalid, "--now", nowIso], {encoding: "utf8"});
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout + bad.stderr, /hard_failure/);
});

test("preflight rejects source or snapshot changes after doctor", async () => {
  const root = await fixture();
  const {state} = await runDoctor({root, nowIso});
  assert.equal(await assertPreflightCurrent(root, state), true);
  await writeFile(join(root, "data/sources.json"), "[]\n\n");
  assert.equal(await assertPreflightCurrent(root, state), false);
  await writeFile(join(root, "data/sources.json"), "[]\n");
  const snapshotPath = join(root, "runs", state.run_id, "variables.snapshot.json");
  await writeFile(snapshotPath, "{\"changed\":true}\n");
  assert.equal(await assertPreflightCurrent(root, state), false);
});
