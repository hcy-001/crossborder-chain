import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
import sharp from "sharp";
import {projectPlatform} from "../../adapters/platforms/project.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function makeMaster(count = 2) {
  const dir = await mkdtemp(join(tmpdir(), "xplat-"));
  const master = join(dir, "master");
  await mkdir(join(master, "images"), {recursive: true});
  await mkdir(join(master, "copy"), {recursive: true});
  await writeFile(join(master, "copy", "desc.txt"), "描述文本", "utf8");
  await writeFile(join(master, "title.tokens.json"), JSON.stringify({
    brand: "Trendy", product_type: "Платье", key_attrs: ["миди"], spec: "46", material: "хлопок", audience: "women"
  }), "utf8");
  const images = [];
  for (let index = 0; index < count; index += 1) {
    const name = `img-0${index + 1}.png`;
    const buffer = await sharp({create: {width: 900, height: 1200, channels: 3, background: "#eeeeee"}}).png().toBuffer();
    await writeFile(join(master, "images", name), buffer);
    images.push({
      file: `images/${name}`,
      width: 900,
      height: 1200,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      role: "white_background",
      quality: "placeholder",
      crop_safe: true
    });
  }
  await writeFile(join(master, "manifest.json"), JSON.stringify({sku: "xplat-test", region: "SG", category: "女装", images}), "utf8");
  await writeFile(join(master, "attributes.csv"), "canonical_key,value,synonyms,confidence\nbrand,Trendy,,high\n", "utf8");
  return {dir, master};
}

const loadSpec = async (platform) => JSON.parse(await readFile(join(ROOT, "data/specs/platforms", `${platform}.json`), "utf8"));

test("Shopee：3:4 母版补白边到 900×900，画面不被裁", async () => {
  const {dir, master} = await makeMaster(2);
  const result = await projectPlatform({
    masterDir: master,
    platformSpec: await loadSpec("shopee"),
    platformId: "shopee",
    outputDir: join(dir, "shopee")
  });
  const files = await readdir(join(dir, "shopee", "images"));
  assert.equal(files.length, 2);
  const meta = await sharp(join(dir, "shopee", "images", files[0])).metadata();
  assert.equal(meta.width, 900);
  assert.equal(meta.height, 900);
  const crop = JSON.parse(await readFile(join(dir, "shopee", "crop.json"), "utf8"));
  assert.equal(crop.crops.length, 2);
  assert.deepEqual(crop.crops[0].box, [112, 0, 675, 900], "内容区 675×900 居中，左右各补 112/113");
  assert.equal(crop.crops[0].mode, "contain_pad");
  assert.match(crop.crops[0].algo_version, /contain-pad/);
});

test("Shopee：标题上限未核实 → 不产出 title.txt，只记原因", async () => {
  const {dir, master} = await makeMaster(1);
  const result = await projectPlatform({
    masterDir: master,
    platformSpec: await loadSpec("shopee"),
    platformId: "shopee",
    outputDir: join(dir, "shopee")
  });
  assert.equal(result.validate.title.final, false);
  assert.equal(result.validate.title.reason, "template_missing");
  await assert.rejects(readFile(join(dir, "shopee", "title.txt"), "utf8"), {code: "ENOENT"});
});

test("TikTok Shop：图片同样按 1:1 投影", async () => {
  const {dir, master} = await makeMaster(1);
  const result = await projectPlatform({
    masterDir: master,
    platformSpec: await loadSpec("tiktok-shop"),
    platformId: "tiktok-shop",
    outputDir: join(dir, "tts")
  });
  assert.equal(result.validate.passed.includes("ratio_1x1_contain_pad"), true);
});

test("事实不全（缺 ratio）→ 抛 FACTS_INCOMPLETE，不拿猜的比例裁图", async () => {
  // 机制测试：把 ratio 事实摘掉，模拟"这个平台的图片规格还没查到"。
  // 不能靠某个平台当前恰好缺事实来测 —— 事实补齐后测试会自己失效。
  const {dir, master} = await makeMaster(1);
  const spec = await loadSpec("noon");
  const withoutRatio = {
    ...spec,
    facts: spec.facts.filter((fact) => !String(fact.key).endsWith(".image.ratio"))
  };
  await assert.rejects(
    projectPlatform({
      masterDir: master,
      platformSpec: withoutRatio,
      platformId: "noon",
      outputDir: join(dir, "noon-no-ratio")
    }),
    (error) => error.code === "FACTS_INCOMPLETE"
  );
});

test("noon：官方只规定宽高比 ≥0.5，取 3:4；母版本身是 3:4 时不裁切", async () => {
  const {dir, master} = await makeMaster(1);
  const result = await projectPlatform({
    masterDir: master,
    platformSpec: await loadSpec("noon"),
    platformId: "noon",
    outputDir: join(dir, "noon")
  });
  assert.ok(
    result.validate.passed.some((item) => String(item).startsWith("ratio_3x4")),
    `应当以 3:4 通过：${JSON.stringify(result.validate.passed)}`
  );
  // 3:4 母版不需要裁：crop 记录为空才是对的，有裁切反而说明比例搞错了
  assert.equal((result.cropDocument.crops ?? []).length, 0, "3:4 母版对 3:4 平台不该产生裁切");
});

test("平台事实文件必须能被 G1-FACT 的字段要求满足", async () => {
  for (const platform of ["shopee", "lazada", "tiktok-shop", "noon"]) {
    const spec = await loadSpec(platform);
    assert.ok(Array.isArray(spec.facts) && spec.facts.length > 0, platform);
    for (const fact of spec.facts) {
      for (const field of ["source_url", "fetched_at", "ttl_hours", "status"]) {
        assert.ok(field in fact, `${platform} ${fact.key} 缺 ${field}`);
      }
      assert.ok(["final", "candidate", "unverified", "conflicted"].includes(fact.status), `${platform} ${fact.key} status=${fact.status}`);
      if (fact.status === "final") {
        assert.equal(fact.source_type, "official", `${platform} ${fact.key} 标 final 却不是官方来源`);
      }
    }
  }
});
