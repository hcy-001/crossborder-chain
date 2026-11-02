import assert from "node:assert/strict";
import {mkdir, mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import sharp from "sharp";
import * as reuse from "../../channels/imagegen/reuse.mjs";

async function writeFixture(directory, name, width, height, colour) {
  await sharp({create: {width, height, channels: 3, background: colour}}).png().toFile(join(directory, name));
}

test("reuse picks distinct historical images and normalises them to the master frame", async () => {
  const source = await mkdtemp(join(tmpdir(), "reuse-src-"));
  const output = await mkdtemp(join(tmpdir(), "reuse-out-"));
  await mkdir(join(source, "nested"), {recursive: true});
  for (let index = 0; index < 9; index += 1) {
    await writeFixture(index < 5 ? source : join(source, "nested"), `img-${index}.png`, 750, 1125, {
      r: 20 * index, g: 80, b: 140
    });
  }

  const result = await reuse.run({width: 900, height: 1200, count: 9, outputDir: output, sourceDir: source});

  assert.equal(result.ok, true);
  assert.equal(result.quality, "reused");
  assert.equal(result.files.length, 9);
  assert.equal(result.usage.cost_cny, 0);
  assert.equal(result.meta.provenance.length, 9);
  for (const file of result.files) {
    const metadata = await sharp(file).metadata();
    assert.equal(metadata.width, 900);
    assert.equal(metadata.height, 1200);
  }
});

test("reuse never fabricates images when history has too few distinct pictures", async () => {
  const source = await mkdtemp(join(tmpdir(), "reuse-thin-"));
  const output = await mkdtemp(join(tmpdir(), "reuse-thin-out-"));
  await writeFixture(source, "only.png", 900, 1200, {r: 10, g: 10, b: 10});

  const result = await reuse.run({width: 900, height: 1200, count: 9, outputDir: output, sourceDir: source});

  assert.equal(result.ok, false);
  assert.equal(result.files.length, 0);
  assert.equal(result.meta.reason, "insufficient_reused_images");
  assert.equal(result.meta.available, 1);
  assert.equal(result.meta.required, 9);
});

test("reuse deduplicates byte-identical files so one picture cannot fill nine slots", async () => {
  const source = await mkdtemp(join(tmpdir(), "reuse-dup-"));
  const output = await mkdtemp(join(tmpdir(), "reuse-dup-out-"));
  await writeFixture(source, "a.png", 900, 1200, {r: 90, g: 40, b: 20});
  await writeFile(join(source, "b.png"), await sharp(join(source, "a.png")).png().toBuffer());

  const result = await reuse.run({width: 900, height: 1200, count: 9, outputDir: output, sourceDir: source});

  assert.equal(result.ok, false);
  assert.equal(result.meta.reason, "insufficient_reused_images");
  assert.equal(result.meta.available, 1);
});

test("reuse reports a missing source directory instead of throwing", async () => {
  const result = await reuse.run({
    width: 900,
    height: 1200,
    count: 9,
    outputDir: await mkdtemp(join(tmpdir(), "reuse-none-")),
    sourceDir: join(tmpdir(), "definitely-not-here-20261029")
  });
  assert.equal(result.ok, false);
  assert.equal(result.meta.reason, "insufficient_reused_images");
  assert.equal(result.meta.available, 0);
});
