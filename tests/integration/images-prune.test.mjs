import test from "node:test";
import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile, readdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pruneUnreferencedImages} from "../../scripts/lib/package-runner.mjs";

async function layout({referenced, orphans, platformOrphans}) {
  const root = await mkdtemp(join(tmpdir(), "images-prune-"));
  const masterImages = join(root, "master", "images");
  const platformImages = join(root, "platforms", "ozon", "images");
  await Promise.all([mkdir(masterImages, {recursive: true}), mkdir(platformImages, {recursive: true})]);

  const images = [];
  for (const [index, name] of referenced.entries()) {
    await writeFile(join(masterImages, name), `kept-${index}`);
    await writeFile(join(platformImages, name), `kept-${index}`);
    images.push({file: `images/${name}`, width: 900, height: 1200});
  }
  for (const name of orphans) await writeFile(join(masterImages, name), "orphan");
  for (const name of platformOrphans) await writeFile(join(platformImages, name), "orphan");

  await writeFile(join(root, "master", "manifest.json"), JSON.stringify({images}, null, 2));
  return {root, masterImages, platformImages};
}

test("prune keeps every manifest-referenced image and removes orphans in master and platforms", async () => {
  const {root, masterImages, platformImages} = await layout({
    referenced: ["img-01-aaaa.png", "img-02-bbbb.png"],
    orphans: ["img-01-cccc.png"],
    platformOrphans: ["img-01-dddd.png", "img-02-eeee.png"]
  });

  const result = await pruneUnreferencedImages(root);

  assert.equal(result.kept, 2);
  assert.equal(result.removed.length, 3);
  assert.deepEqual((await readdir(masterImages)).sort(), ["img-01-aaaa.png", "img-02-bbbb.png"]);
  assert.deepEqual((await readdir(platformImages)).sort(), ["img-01-aaaa.png", "img-02-bbbb.png"]);
});

test("prune is a no-op when every file is referenced", async () => {
  const {root, masterImages} = await layout({
    referenced: ["img-01-aaaa.png"],
    orphans: [],
    platformOrphans: []
  });

  const result = await pruneUnreferencedImages(root);

  assert.deepEqual(result.removed, []);
  assert.deepEqual(await readdir(masterImages), ["img-01-aaaa.png"]);
});

test("prune ignores non-png files so manifests and receipts survive", async () => {
  const {root, masterImages} = await layout({
    referenced: ["img-01-aaaa.png"],
    orphans: [],
    platformOrphans: []
  });
  await writeFile(join(masterImages, "notes.json"), "{}");

  await pruneUnreferencedImages(root);

  assert.deepEqual((await readdir(masterImages)).sort(), ["img-01-aaaa.png", "notes.json"]);
});

test("prune reports manifest_missing instead of deleting a directory without a manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "images-prune-empty-"));
  const masterImages = join(root, "master", "images");
  await mkdir(masterImages, {recursive: true});
  await writeFile(join(masterImages, "img-01-aaaa.png"), "unknown");

  const result = await pruneUnreferencedImages(root);

  assert.equal(result.reason, "manifest_missing");
  assert.deepEqual(result.removed, []);
  assert.deepEqual(await readdir(masterImages), ["img-01-aaaa.png"]);
});

test("prune output records the package-relative path of every removed file", async () => {
  const {root} = await layout({
    referenced: ["img-01-aaaa.png"],
    orphans: ["img-09-orphan.png"],
    platformOrphans: []
  });

  const result = await pruneUnreferencedImages(root);

  assert.equal(result.removed.length, 1);
  assert.match(result.removed[0], /^[^/]+\/master\/images\/img-09-orphan\.png$/);
  assert.equal(await readFile(join(root, "master", "images", "img-01-aaaa.png"), "utf8"), "kept-0");
});
