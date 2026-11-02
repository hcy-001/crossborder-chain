import test from "node:test";
import assert from "node:assert/strict";
import {cp, mkdtemp, readFile, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const nowIso = "2026-10-29T04:00:00.000Z";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "process-negative-"));
  await Promise.all(["data", "regions", "schemas", "input"].map((directory) =>
    cp(join(projectRoot, directory), join(root, directory), {recursive: true})
  ));
  await writeFile(join(root, "data/sources.json"), "[]\n");
  return root;
}

function doctorCli(root) {
  return spawnSync(process.execPath, [join(projectRoot, "scripts/doctor.mjs"), "--root", root, "--now", nowIso], {encoding: "utf8"});
}

function packCli(root, sku = "demo-sku") {
  return spawnSync(process.execPath, [join(projectRoot, "scripts/pack.mjs"), sku, "--root", root, "--now", nowIso], {encoding: "utf8"});
}

function demoCli(root) {
  return spawnSync(process.execPath, [join(projectRoot, "scripts/demo.mjs"), "--root", root, "--now", nowIso], {encoding: "utf8"});
}

test("doctor CLI rejects a schema-invalid source config instead of treating it as empty", async () => {
  const root = await fixture();
  await writeFile(join(root, "data/sources.json"), `${JSON.stringify([{id: "broken-source"}], null, 2)}\n`);
  const result = doctorCli(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /Invalid source config/);
});

test("pack and demo refuse to start when configuration is unreadable", async () => {
  const root = await fixture();
  await writeFile(join(root, "data/sources.json"), "{");
  const packed = packCli(root);
  const demoed = demoCli(root);
  assert.equal(packed.status, 1, packed.stdout + packed.stderr);
  assert.equal(demoed.status, 1, demoed.stdout + demoed.stderr);
  await assert.rejects(stat(join(root, "package/demo-sku")));
});

test("pack reuses the existing doctor run instead of minting a new snapshot", async () => {
  const root = await fixture();
  const doctor = doctorCli(root);
  assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
  const doctorState = JSON.parse(await readFile(join(root, "runs/latest-doctor.json"), "utf8"));
  const packed = packCli(root);
  assert.equal(packed.status, 0, packed.stdout + packed.stderr);
  const receipt = JSON.parse(await readFile(join(root, "package/demo-sku/receipt.json"), "utf8"));
  assert.equal(receipt.run_id, doctorState.run_id);
});

test("pack rejects a tampered variables file after doctor", async () => {
  const root = await fixture();
  assert.equal(doctorCli(root).status, 0);
  await writeFile(join(root, "data/variables/fx.json"), "[]\n\n");
  const packed = packCli(root);
  assert.equal(packed.status, 1, packed.stdout + packed.stderr);
  assert.match(packed.stdout + packed.stderr, /stale preflight rejected/);
});

test("pack rejects a tampered sources file after doctor", async () => {
  const root = await fixture();
  assert.equal(doctorCli(root).status, 0);
  await writeFile(join(root, "data/sources.json"), "[]\n\n");
  const packed = packCli(root);
  assert.equal(packed.status, 1, packed.stdout + packed.stderr);
  assert.match(packed.stdout + packed.stderr, /stale preflight rejected/);
});

test("pack rejects a tampered snapshot file after doctor", async () => {
  const root = await fixture();
  assert.equal(doctorCli(root).status, 0);
  const {run_id: runId} = JSON.parse(await readFile(join(root, "runs/latest-doctor.json"), "utf8"));
  await writeFile(join(root, "runs", runId, "variables.snapshot.json"), "{\"changed\":true}\n");
  const packed = packCli(root);
  assert.equal(packed.status, 1, packed.stdout + packed.stderr);
  assert.match(packed.stdout + packed.stderr, /stale preflight rejected/);
});

test("demo refuses to run on a stale snapshot while doctor still exits 0", async () => {
  const root = await fixture();
  assert.equal(doctorCli(root).status, 0);
  const {run_id: runId} = JSON.parse(await readFile(join(root, "runs/latest-doctor.json"), "utf8"));
  await writeFile(join(root, "runs", runId, "variables.snapshot.json"), "{}\n");
  const demoed = demoCli(root);
  assert.equal(demoed.status, 1, demoed.stdout + demoed.stderr);
  assert.match(demoed.stdout + demoed.stderr, /stale preflight rejected/);
});
