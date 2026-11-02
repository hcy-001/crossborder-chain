import test from "node:test";
import assert from "node:assert/strict";
import {cp, mkdtemp, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import sharp from "sharp";
import {runPackage} from "../../scripts/lib/package-runner.mjs";
import {assertPreflightCurrent} from "../../scripts/lib/preflight.mjs";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const nowIso = "2026-10-29T03:00:00.000Z";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "package-runner-"));
  await Promise.all(["data", "regions", "schemas", "input"].map((directory) =>
    cp(join(projectRoot, directory), join(root, directory), {recursive: true})
  ));
  await writeFile(join(root, "data/sources.json"), "[]\n");
  return root;
}

test("runPackage produces a complete degraded package without inventing price or signals", async () => {
  const root = await fixture();
  const signalChannel = {run: async () => ({ok: false, signals: [], receipt: {status: "unavailable", detail: "fixture"}})};
  const result = await runPackage({root, sku: "demo-sku", nowIso, signalChannel});
  assert.equal(result.packageDir, join(root, "package", "demo-sku"));
  const manifest = JSON.parse(await readFile(join(root, "package/demo-sku/master/manifest.json"), "utf8"));
  assert.equal(manifest.images.length, 9);
  const handoff = await readFile(join(root, "package/demo-sku/handoff.md"), "utf8");
  assert.match(handoff.split(/\r?\n/)[0], /^BLOCKED:/);
  assert.match(handoff, /占位图/, "占位图提示必须在 handoff 里（位置可变，信息不能丢）");
  const receipt = JSON.parse(await readFile(join(root, "package/demo-sku/receipt.json"), "utf8"));
  assert.equal(receipt.pricing.status, "unavailable");
  assert.equal(await assertPreflightCurrent(root, result.preflight), true);
});

test("pack rejects a missing real input instead of using demo data", async () => {
  const root = await fixture();
  const result = spawnSync(process.execPath, [join(projectRoot, "scripts/pack.mjs"), "absent-sku", "--root", root], {encoding: "utf8"});
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /input\/absent-sku\.json/);
});

test("出图通道拿到的是带商品身份的商品对象，不是一个品类词", async () => {
  const root = await fixture();
  const seen = [];
  const imageChannel = {
    meta: {name: "capture"},
    run: async (input) => {
      seen.push(input.product);
      const files = [];
      for (let index = 0; index < input.count; index += 1) {
        const file = join(input.outputDir, `g-${index}.png`);
        // 9 张必须互相可区分：出包有重复图门禁（aHash 距离为 0 直接拒），
        // 纯色图会被它判成重复 —— 这正好证明门禁在干活。
        const svg = `<svg width="900" height="1200"><rect width="900" height="1200" fill="#e8e6e1"/>`
          + `<rect x="${40 + index * 80}" y="120" width="300" height="700" fill="#c9c2b6"/></svg>`;
        await sharp(Buffer.from(svg)).png({compressionLevel: 0}).toFile(file);
        files.push(file);
      }
      return {ok: true, files, quality: "generated"};
    }
  };
  const signalChannel = {run: async () => ({ok: false, signals: [], receipt: {status: "unavailable", detail: "fixture"}})};
  await runPackage({root, sku: "demo-sku", nowIso, imageChannel, signalChannel});
  assert.equal(seen.length, 1);
  const input = JSON.parse(await readFile(join(root, "input/demo-sku.json"), "utf8"));
  const passed = Object.fromEntries((seen[0].attributes ?? []).map((row) => [row.canonical_key, row.value]));
  const expected = Object.fromEntries(input.attributes.map((row) => [row.canonical_key, row.value]));
  assert.deepEqual(passed, expected);
  assert.equal(passed.product_type, "Женская куртка");
});
