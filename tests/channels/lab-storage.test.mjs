import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, join} from "node:path";
import * as lab from "../../channels/storage/lab.mjs";

test("LAB channel exposes local content-addressed storage", async () => {
  assert.equal(lab.meta.name, "lab");
  assert.equal(lab.meta.kind, "storage");
  assert.equal(lab.meta.requires, "none");
  assert.equal(typeof lab.run, "function");
  assert.equal(typeof lab.fault, "function");
  assert.deepEqual(await lab.probe(), {ok: true, detail: "ready"});
});

test("LAB names are idempotent for identical input and change with content", async () => {
  const root = await mkdtemp(join(tmpdir(), "lab-storage-"));
  const input = join(root, "source.png");
  const outputDir = join(root, "stored");
  const original = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  await writeFile(input, original);

  const first = await lab.run({files: [input], outputDir});
  const firstName = basename(first.files[0]);
  assert.match(firstName, /^img-01-[a-f0-9]{8}\.png$/);
  assert.deepEqual(await readFile(first.files[0]), original);

  const second = await lab.run({files: [input], outputDir});
  assert.equal(basename(second.files[0]), firstName);
  assert.deepEqual(await readFile(second.files[0]), original);

  const manifest = JSON.parse(await readFile(join(outputDir, "manifest.json"), "utf8"));
  assert.equal(manifest.files[0].name, firstName);
  assert.equal("url" in manifest.files[0], false);
  assert.equal("publicUrl" in manifest.files[0], false);

  const changed = Buffer.from(original);
  changed[changed.length - 1] ^= 1;
  await writeFile(input, changed);
  const third = await lab.run({files: [input], outputDir});
  assert.notEqual(basename(third.files[0]), firstName);
  assert.match(basename(third.files[0]), /^img-01-[a-f0-9]{8}\.png$/);
  assert.deepEqual(await readFile(third.files[0]), changed);
});
