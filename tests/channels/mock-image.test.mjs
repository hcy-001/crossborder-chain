import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import sharp from "sharp";
import * as mock from "../../channels/imagegen/mock.mjs";
import {assertNoDuplicateImages} from "../../core/package/assemble.mjs";

test("mock channel exposes the standard contract", async () => {
  assert.equal(mock.meta.name, "mock");
  assert.equal(mock.meta.kind, "imagegen");
  assert.equal(mock.meta.requires, "none");
  assert.equal(typeof mock.run, "function");
  assert.equal(typeof mock.fault, "function");
  assert.deepEqual(await mock.probe(), {ok: true, detail: "ready"});
});

test("mock emits real placeholder PNGs with requested dimensions", async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), "mock-image-"));
  const result = await mock.run({width: 900, height: 1200, count: 2, outputDir});

  assert.equal(result.ok, true);
  assert.equal(result.quality, "placeholder");
  assert.equal(result.meta.quality, "placeholder");
  assert.equal(result.files.length, 2);

  const expectedSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const contents = [];
  for (const file of result.files) {
    const buffer = await readFile(file);
    contents.push(buffer);
    assert.deepEqual(buffer.subarray(0, 8), expectedSignature);
    const metadata = await sharp(buffer).metadata();
    assert.equal(metadata.format, "png");
    assert.equal(metadata.width, 900);
    assert.equal(metadata.height, 1200);
    t.diagnostic(`${file}: PNG ${metadata.width}x${metadata.height}, ${buffer.length} bytes`);
  }
  assert.notDeepEqual(contents[0], contents[1], "numbered placeholders must not be identical");
});

test("mock native nine-image output passes strict aHash duplicate detection", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "mock-image-nine-"));
  const result = await mock.run({width: 900, height: 1200, count: 9, outputDir});

  assert.equal(result.files.length, 9);
  await assertNoDuplicateImages(result.files);
});
