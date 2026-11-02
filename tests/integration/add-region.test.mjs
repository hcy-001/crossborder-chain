import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, mkdir, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import Ajv2020 from "ajv/dist/2020.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const schema = JSON.parse(await readFile(join(root, "schemas/profile.schema.json"), "utf8"));

test("add-region creates four files without touching core", async () => {
  const temp = await mkdtemp(join(tmpdir(), "add-region-"));
  await mkdir(join(temp, "core"), {recursive: true});
  await writeFile(join(temp, "core/sentinel.mjs"), "export const value = 1;\n");
  const result = spawnSync(process.execPath, [join(root, "scripts/add-region.mjs"), "--id=XX", "--root", temp], {encoding: "utf8"});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const profile = JSON.parse(await readFile(join(temp, "regions/XX/profile.json"), "utf8"));
  assert.equal(new Ajv2020().compile(schema)(profile), true);
  const expected = [
    "regions/XX/profile.json",
    "regions/XX/platforms/unassigned.json",
    "regions/XX/compliance/rules.json",
    "regions/XX/sources.json"
  ];
  assert.deepEqual(result.stdout.trim().split(/\r?\n/).sort(), expected.sort());
  assert.equal(await readFile(join(temp, "core/sentinel.mjs"), "utf8"), "export const value = 1;\n");
});
