import test, {after, before} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, extname, join, relative} from "node:path";
import {fileURLToPath} from "node:url";
import sharp from "sharp";
import Ajv2020 from "ajv/dist/2020.js";
import * as imageChannel from "../../channels/imagegen/mock.mjs";
import * as storageChannel from "../../channels/storage/lab.mjs";
import {buildMaster} from "../../core/content/build-master.mjs";
import {projectPlatform} from "../../adapters/platforms/project.mjs";
import {
  aHash8x8,
  assemblePackage,
  assertNoDuplicateImages,
  renderHandoff
} from "../../core/package/assemble.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const readSchema = async (name) => readJson(join(repoRoot, "schemas", name));
const [manifestSchema, titleSchema, cropSchema, cropDocumentSchema, validateSchema, receiptSchema] = await Promise.all([
  readSchema("manifest.schema.json"),
  readSchema("title-tokens.schema.json"),
  readSchema("crop.schema.json"),
  readSchema("crop-document.schema.json"),
  readSchema("validate.schema.json"),
  readSchema("receipt.schema.json")
]);
const ajv = new Ajv2020();
ajv.addSchema(cropSchema);
const validateManifest = ajv.compile(manifestSchema);
const validateTitle = ajv.compile(titleSchema);
const validateCropDocument = ajv.compile(cropDocumentSchema);
const validateProjection = ajv.compile(validateSchema);
const validateReceipt = ajv.compile(receiptSchema);

const titleTokens = {
  brand: "FixtureBrand",
  product_type: "Long coat",
  key_attrs: ["belted", "lined"],
  spec: "M",
  material: "polyester",
  audience: "women"
};
const copy = {
  desc: "Master description must remain byte-identical.",
  bullets: ["First exact bullet", "Second exact bullet"],
  keywords: ["coat", "outerwear"]
};
const attributes = [
  {canonical_key: "brand", value: "FixtureBrand", synonyms: "brand_name", confidence: "high"},
  {canonical_key: "product_type", value: "Long coat", synonyms: "product_name|category", confidence: "high"},
  {canonical_key: "material", value: "polyester", synonyms: "composition", confidence: "medium"}
];
const product = {
  sku: "SKU-P5-001",
  region: "RU",
  category: "outerwear",
  facts: [
    {
      key: "material.composition",
      value: "polyester 100%",
      unit: null,
      source_kind: "reported",
      basis: "supplier fixture label",
      confidence: "medium"
    },
    {
      key: "material.weight",
      value: 280,
      unit: "g/m2",
      source_kind: "measured",
      basis: "fixture scale record",
      confidence: "high"
    },
    {
      key: "material.handfeel",
      value: "soft",
      unit: null,
      source_kind: "estimated",
      basis: "reported weave and finish",
      confidence: "low"
    }
  ],
  variants: []
};
const complianceReport = {
  sku: product.sku,
  destination: "RU",
  items: [],
  blockers: ["declaration evidence missing"],
  notes: "fixture compliance result"
};
const platforms = ["ozon", "wildberries"];
let root;
let packageDir;
let masterDir;
let masterManifest;
const projections = new Map();

async function walk(directory) {
  const entries = await readdir(directory, {withFileTypes: true});
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

async function directoryDiff(left, right) {
  const [leftFiles, rightFiles] = await Promise.all([walk(left), walk(right)]);
  const leftRelative = leftFiles.map((file) => relative(left, file).replaceAll("\\", "/"));
  const rightRelative = rightFiles.map((file) => relative(right, file).replaceAll("\\", "/"));
  const differences = [];
  const names = new Set([...leftRelative, ...rightRelative]);
  for (const name of [...names].sort()) {
    if (!leftRelative.includes(name) || !rightRelative.includes(name)) {
      differences.push(`missing:${name}`);
      continue;
    }
    const [a, b] = await Promise.all([readFile(join(left, name)), readFile(join(right, name))]);
    if (!a.equals(b)) differences.push(`content:${name}`);
  }
  return differences;
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "content-pipeline-"));
  packageDir = join(root, "package", product.sku);
  masterDir = join(packageDir, "master");
  await buildMaster({
    outputDir: masterDir,
    product,
    titleTokens,
    copy,
    attributes,
    complianceReport,
    snapshotId: "snapshot-p5-fixture",
    imageChannel,
    storageChannel
  });
  masterManifest = await readJson(join(masterDir, "manifest.json"));

  for (const platform of platforms) {
    const platformSpec = await readJson(join(repoRoot, "data", "specs", "platforms", `${platform}.json`));
    const outputDir = join(packageDir, "platforms", platform);
    const result = await projectPlatform({masterDir, platformSpec, platformId: platform, outputDir});
    projections.set(platform, result);
  }

  await assemblePackage({
    packageDir,
    complianceReport,
    receipt: {
      run_id: "20261029-010000-p5fx",
      sku: product.sku,
      snapshot_sha256: "b".repeat(64),
      started_at: "2026-10-29T01:00:00.000Z",
      finished_at: "2026-10-29T01:00:01.000Z",
      duration_ms: 1000,
      gates: [
        {id: "G12", status: "pass", level: "L1", evidence: "two projections preserve copy"},
        {id: "G13", status: "pass", level: "L1", evidence: "LAB content-addressed names"}
      ],
      degradations: [
        {kind: "imagegen", detail: "mock placeholder"},
        {kind: "video", detail: "unavailable; optional"}
      ],
      divergences: [{kind: "spec", detail: "candidate title facts remain visible"}],
      stale: [{key: "platform.title.template", expired_days: null}],
      providers: [
        {kind: "imagegen", detail: "mock"},
        {kind: "storage", detail: "lab"}
      ]
    }
  });
});

after(async () => {
  if (root) await rm(root, {recursive: true, force: true});
});

test("完整母版、标题、投影、裁切文档与回执均严格符合 schema", () => {
  assert.equal(validateManifest(masterManifest), true, JSON.stringify(validateManifest.errors));
  assert.equal(validateTitle(titleTokens), true, JSON.stringify(validateTitle.errors));
  for (const platform of platforms) {
    const {validate, cropDocument} = projections.get(platform);
    assert.equal(validateProjection(validate), true, JSON.stringify(validateProjection.errors));
    assert.equal(validateCropDocument(cropDocument), true, JSON.stringify(validateCropDocument.errors));
  }
});

test("母版固定九张 900x1200 PNG，内容寻址与 SHA-256 一致且不补满三十张", async (t) => {
  assert.equal(masterManifest.images.length, 9);
  const files = await readdir(join(masterDir, "images"));
  const imageFiles = files.filter((file) => /\.(?:png|jpg)$/.test(file));
  assert.equal(imageFiles.length, 9);
  let totalBytes = 0;
  let minBytes = Number.POSITIVE_INFINITY;
  let maxBytes = 0;
  for (const image of masterManifest.images) {
    const buffer = await readFile(join(masterDir, image.file));
    totalBytes += buffer.length;
    minBytes = Math.min(minBytes, buffer.length);
    maxBytes = Math.max(maxBytes, buffer.length);
    const metadata = await sharp(buffer).metadata();
    assert.equal(metadata.format, "png");
    assert.equal(metadata.width, 900);
    assert.equal(metadata.height, 1200);
    assert.ok(buffer.length <= 10485760);
    assert.match(image.file, /^images\/img-\d{2}-[a-f0-9]{8}\.png$/);
    assert.equal(basename(image.file), `img-${String(masterManifest.images.indexOf(image) + 1).padStart(2, "0")}-${image.sha256.slice(0, 8)}.png`);
    assert.equal(image.quality, "placeholder");
  }
  t.diagnostic(`master images=${masterManifest.images.length}; all 900x1200 PNG; sha8 names verified; bytes total=${totalBytes}, min=${minBytes}, max=${maxBytes}`);
});

test("材质事实保留 measured/reported/estimated、basis 与 high/medium/low", async () => {
  assert.deepEqual(masterManifest.product_facts.map((fact) => fact.source_kind), ["reported", "measured", "estimated"]);
  assert.deepEqual(masterManifest.product_facts.map((fact) => fact.confidence), ["medium", "high", "low"]);
  assert.ok(masterManifest.product_facts.every((fact) => fact.basis.length > 0));
  const material = await readJson(join(masterDir, "material", "facts.json"));
  assert.equal(material.facts.length, 3);
});

test("母版文本没有平台字段，视频为空目录且 unavailable 不阻塞", async () => {
  const textFiles = (await walk(masterDir)).filter((file) => [".json", ".csv", ".txt", ".md"].includes(extname(file)));
  for (const file of textFiles) {
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, /ozon|wildberries|"platform"/i, file);
  }
  assert.deepEqual(masterManifest.video, {status: "unavailable", file: null, reason: "optional video not provided"});
  assert.deepEqual(await readdir(join(masterDir, "video")), []);
});

test("两个真实平台投影的 copy 与 title tokens 零字节差异，3:4 图片仅复制", async (t) => {
  for (const platform of platforms) {
    const outputDir = join(packageDir, "platforms", platform);
    const copyDiff = await directoryDiff(join(masterDir, "copy"), join(outputDir, "copy"));
    assert.deepEqual(copyDiff, []);
    assert.ok((await readFile(join(masterDir, "title.tokens.json"))).equals(await readFile(join(outputDir, "title.tokens.json"))));
    const outputImages = (await readdir(join(outputDir, "images"))).filter((file) => /\.(?:png|jpg)$/.test(file));
    assert.equal(outputImages.length, 9);
    for (const image of masterManifest.images) {
      assert.ok((await readFile(join(masterDir, image.file))).equals(await readFile(join(outputDir, image.file))));
    }
    t.diagnostic(`${platform}: copy diff=${JSON.stringify(copyDiff)}; image hash diff=[]; images=${outputImages.length}`);
  }
});

test("secondary/candidate 与 unverified 模板全部进入 conflicts/notes，不冒充 official/final", async () => {
  const ozon = projections.get("ozon").validate;
  // 标题长度已由官方页面核实（2026-11-01），不再以 candidate 出现在 conflicts 里 ——
  // 反过来，如果它还出现在这里，说明事实被改回了二手来源，那才是问题。
  assert.equal(ozon.conflicts.some((item) => item.key.endsWith("title.max_chars")), false);
  assert.ok(ozon.conflicts.some((item) => item.key.endsWith("title.template") && item.status === "unverified"));
  assert.ok(ozon.conflicts.some((item) => item.key.endsWith("image.max_count") && item.status === "conflicted"));
  assert.match(ozon.notes, /secondary|candidate|unverified|platform/i);
  assert.equal(ozon.quality, "placeholder");
  assert.equal(ozon.passed.includes("official"), false);

  const wb = projections.get("wildberries").validate;
  // 用当前确实还是 candidate 的事实来验证「非 final 必须进 conflicts」这条机制，
  // 不绑定某一条具体事实 —— 事实升级成 final 后，测试不该跟着失效。
  assert.ok(wb.conflicts.some((item) => item.key.endsWith("image.max_bytes") && item.status === "candidate"));
  assert.ok(wb.conflicts.some((item) => item.key.endsWith("title.template") && item.status === "unverified"));
  assert.match(wb.notes, /secondary|candidate|unverified/);
  for (const platform of platforms) {
    await assert.rejects(readFile(join(packageDir, "platforms", platform, "title.txt"), "utf8"), {code: "ENOENT"});
  }
});

test("通用 square fixture：等比缩放补白边到 900×900，逐图哈希与输出可追溯", async () => {
  const fixtureRoot = join(root, "square-safe");
  const fixtureMaster = join(fixtureRoot, "master");
  await cp(masterDir, fixtureMaster, {recursive: true});
  const outputDir = join(fixtureRoot, "platforms", "square-fixture");
  const ratioFact = {
    key: "platform.square-fixture.image.ratio",
    value: {width: 1, height: 1},
    source_type: "official",
    status: "final"
  };
  const result = await projectPlatform({
    masterDir: fixtureMaster,
    platformSpec: {facts: [ratioFact]},
    platformId: "square-fixture",
    outputDir
  });
  assert.equal(result.cropDocument.crops.length, 9);
  assert.equal(validateCropDocument(result.cropDocument), true, JSON.stringify(validateCropDocument.errors));
  for (const crop of result.cropDocument.crops) {
    // 3:4 母版进 1:1 画布：内容区 675×900 居中，左右各补 112/113 白边。
    // box 记录的是「内容区在画布里的位置」，不是被切掉的部分。
    assert.deepEqual(crop.box, [112, 0, 675, 900]);
    assert.equal(crop.mode, "contain_pad");
    assert.deepEqual(crop.canvas, [900, 900]);
    assert.equal(crop.algo_version, "contain-pad-white-v1");
    assert.match(crop.src_sha256, /^[a-f0-9]{64}$/);
    assert.match(crop.output, /-1x1\.png$/);
    const source = await readFile(join(fixtureRoot, crop.src));
    const output = await readFile(join(fixtureRoot, crop.output));
    const metadata = await sharp(output).metadata();
    assert.equal(metadata.width, 900);
    assert.equal(metadata.height, 900);

    // 关键断言：内容区必须逐字节等于「原图等比缩放到内容区尺寸」的结果。
    // 中心裁切做不到这一点（它扔掉了上下各 12.5%），补边必须做到。
    const {data: outRaw, info: outInfo} = await sharp(output).raw().toBuffer({resolveWithObject:true});
    const [left, top, innerW, innerH] = crop.box;
    const contentRegion = await sharp(outRaw, {raw: {width: outInfo.width, height: outInfo.height, channels: outInfo.channels}})
      .extract({left, top, width: innerW, height: innerH})
      .raw().toBuffer();
    const expectedContent = await sharp(source).resize(innerW, innerH, {fit: "fill"}).raw().toBuffer();
    assert.ok(contentRegion.equals(expectedContent), "内容区与「等比缩放后的原图」不一致：画面被裁切或变形了");

    // 边角必须是纯白：平台要求白底，补边色不能是灰的
    const {data, info} = await sharp(output).raw().toBuffer({resolveWithObject:true});
    const at = (x, y) => {
      const i = (y * info.width + x) * info.channels;
      return [data[i], data[i + 1], data[i + 2]];
    };
    assert.deepEqual(at(0, 0), [255, 255, 255]);
  }
});

test("crop_safe=false 的图同样得到完整 1:1 派生（补边不裁，不存在「不能裁所以跳过」）", async () => {
  const fixtureRoot = join(root, "square-unsafe");
  const fixtureMaster = join(fixtureRoot, "master");
  await cp(masterDir, fixtureMaster, {recursive: true});
  const manifestPath = join(fixtureMaster, "manifest.json");
  const manifest = await readJson(manifestPath);
  manifest.images[0].crop_safe = false;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const result = await projectPlatform({
    masterDir: fixtureMaster,
    platformSpec: {facts: [{key: "platform.square.image.ratio", value: {width: 1, height: 1}, source_type: "official", status: "final"}]},
    platformId: "square",
    outputDir: join(fixtureRoot, "platforms", "square")
  });
  // 补边方案下没有任何像素被裁掉，所以 crop_unsafe 恒为空、9 张全部出图。
  assert.deepEqual(result.validate.crop_unsafe, []);
  assert.equal(result.cropDocument.crops.length, 9);
  // 补边不裁，所以这张「不适合裁」的图同样要出：跳过它反而是丢内容
  assert.equal(result.cropDocument.crops.some((crop) => crop.src.endsWith(basename(manifest.images[0].file))), true);
  const outputImages = (await readdir(join(fixtureRoot, "platforms", "square", "images"))).filter((file) => /\.png$/.test(file));
  assert.equal(outputImages.length, 9);
});

test("aHash 8x8 在打包前拦截复制凑数，同时接受九张不同占位图", async () => {
  const firstFile = join(masterDir, masterManifest.images[0].file);
  const duplicate = join(root, "duplicate.png");
  await writeFile(duplicate, await readFile(firstFile));
  assert.match(await aHash8x8(firstFile), /^[a-f0-9]{16}$/);
  await assert.rejects(
    assertNoDuplicateImages([firstFile, duplicate]),
    (error) => error.code === "DUPLICATE_IMAGE" && /hamming/i.test(error.message)
  );
  await assertNoDuplicateImages(masterManifest.images.map((image) => join(masterDir, image.file)));
});

test("aHash distance 0 时即使 PNG 字节与 SHA-256 不同也拦截同像素图片", async () => {
  const width = 16;
  const height = 16;
  const channels = 4;
  const pixels = Buffer.alloc(width * height * channels);
  for (let index = 0; index < pixels.length; index += channels) {
    pixels[index] = (index / channels) % 256;
    pixels[index + 1] = 255 - ((index / channels) % 256);
    pixels[index + 2] = 128;
    pixels[index + 3] = 255;
  }
  const source = sharp(pixels, {raw: {width, height, channels}});
  const lowCompression = join(root, "same-pixels-low-compression.png");
  const highCompression = join(root, "same-pixels-high-compression.png");
  await source.clone().png({compressionLevel: 0}).toFile(lowCompression);
  await source.clone().png({compressionLevel: 9}).toFile(highCompression);

  const [lowBytes, highBytes] = await Promise.all([readFile(lowCompression), readFile(highCompression)]);
  const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
  assert.equal(lowBytes.equals(highBytes), false);
  assert.notEqual(sha256(lowBytes), sha256(highBytes));
  const [lowPixels, highPixels] = await Promise.all([
    sharp(lowCompression).raw().toBuffer(),
    sharp(highCompression).raw().toBuffer()
  ]);
  assert.ok(lowPixels.equals(highPixels));
  assert.equal(await aHash8x8(lowCompression), await aHash8x8(highCompression));
  await assert.rejects(
    assertNoDuplicateImages([lowCompression, highCompression]),
    (error) => error.code === "DUPLICATE_IMAGE" && /Hamming distance 0/i.test(error.message)
  );
});

test("handoff 先 BLOCKED 后 placeholder；无阻塞时 placeholder 第一行，视频写可选", async () => {
  const handoff = await readFile(join(packageDir, "handoff.md"), "utf8");
  const lines = handoff.split(/\r?\n/);
  assert.match(lines[0], /^BLOCKED: 本包暂不可直接上架（[0-9]+ 项待解）/);
  assert.match(handoff, /declaration evidence missing/);
  assert.ok(handoff.includes("本包图片为占位图，仅用于验证流程，不可直接投放"), "占位图提示必须保留");
  assert.doesNotMatch(handoff, /待补/);
  assert.match(handoff, /视频：本平台可选/);

  const noBlockers = renderHandoff({sku: product.sku, blockers: [], placeholder: true, projections: [...projections.values()]});
  assert.equal(noBlockers.split(/\r?\n/)[0], "本包图片为占位图，仅用于验证流程，不可直接投放");
  assert.doesNotMatch(noBlockers, /待补/);
});

test("receipt 符合 schema 并保留 gates/degradations/providers/stale/divergences", async () => {
  const receipt = await readJson(join(packageDir, "receipt.json"));
  assert.equal(validateReceipt(receipt), true, JSON.stringify(validateReceipt.errors));
  assert.ok(receipt.gates.some((gate) => gate.id === "P5-aHash-8x8" && gate.status === "pass"));
  assert.equal(receipt.degradations.length, 2);
  assert.equal(receipt.providers.length, 2);
  assert.deepEqual(receipt.stale, [{key: "platform.title.template", expired_days: null}]);
  assert.equal(receipt.divergences.length, 1);
});

test("模板未验证：不出 title.txt，但给出标 candidate 的稿子供人工复核", async () => {
  for (const platform of platforms) {
    const outputDir = join(packageDir, "platforms", platform);
    const validate = JSON.parse(await readFile(join(outputDir, "validate.json"), "utf8"));
    const hasFinal = await readFile(join(outputDir, "title.txt"), "utf8").then(() => true).catch(() => false);

    if (validate.title.final) {
      assert.equal(hasFinal, true, `${platform}: 模板已定稿就该有 title.txt`);
      continue;
    }

    assert.equal(hasFinal, false, `${platform}: 模板未定稿时不得生成 title.txt`);
    if (validate.title.candidate) {
      const candidate = await readFile(join(outputDir, "title.candidate.txt"), "utf8");
      assert.ok(candidate.trim().length > 0);
      const meta = JSON.parse(await readFile(join(outputDir, "title.candidate.json"), "utf8"));
      assert.equal(meta.status, "candidate");
      assert.equal(meta.rendered, candidate.trim());
      assert.match(meta.note, /不得直接提交/);
      assert.ok(validate.passed.includes("title_tokens_preserved"));
    }
  }
});
