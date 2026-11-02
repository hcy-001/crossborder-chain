#!/usr/bin/env node
// 包结构核对：把「9 张 900x1200、copy 零差异、handoff 两行声明、降级记录」变成可复核的机器断言。
// 用法：node scripts/verify-package.mjs [sku] [--root <dir>]
import {createHash} from "node:crypto";
import {readFile, readdir, stat} from "node:fs/promises";
import {join, resolve} from "node:path";
import sharp from "sharp";

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

async function listFiles(directory, filter = () => true) {
  try {
    const entries = await readdir(directory, {withFileTypes: true});
    return entries.filter((entry) => entry.isFile() && filter(entry.name)).map((entry) => entry.name).sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function imageInfo(file) {
  const buffer = await readFile(file);
  const metadata = await sharp(buffer).metadata();
  return {width: metadata.width, height: metadata.height, format: metadata.format, sha256: sha256(buffer)};
}

async function copyDigests(directory) {
  const files = await listFiles(directory);
  const digests = {};
  for (const file of files) {
    digests[file] = sha256(await readFile(join(directory, file)));
  }
  return digests;
}

const args = process.argv.slice(2);
let sku = "demo-sku";
let root = process.cwd();
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--root" && args[index + 1]) root = args[++index];
  else sku = args[index];
}
root = resolve(root);
const packageDir = join(root, "package", sku);
const checks = [];
const record = (id, ok, detail) => checks.push({id, ok, detail});

let manifest;
try {
  manifest = JSON.parse(await readFile(join(packageDir, "master/manifest.json"), "utf8"));
} catch (error) {
  console.log(JSON.stringify({ok: false, sku, error: `manifest unreadable: ${error.message}`}, null, 2));
  process.exitCode = 1;
  process.exit();
}

const masterImages = await listFiles(join(packageDir, "master/images"), (name) => name.endsWith(".png"));
record("master_image_count", manifest.images.length === 9 && masterImages.length === 9,
  `manifest=${manifest.images.length} files=${masterImages.length} expected=9`);

const dimensionFailures = [];
const digestFailures = [];
for (const image of manifest.images) {
  const file = join(packageDir, "master", image.file);
  const info = await imageInfo(file);
  if (info.width !== 900 || info.height !== 1200 || info.format !== "png") {
    dimensionFailures.push(`${image.file}:${info.width}x${info.height}/${info.format}`);
  }
  if (info.sha256 !== image.sha256) digestFailures.push(image.file);
  if (image.width !== 900 || image.height !== 1200) dimensionFailures.push(`${image.file}:manifest_claims_${image.width}x${image.height}`);
}
record("master_images_900x1200_png", dimensionFailures.length === 0, dimensionFailures);
record("master_sha256_matches_manifest", digestFailures.length === 0, digestFailures);

const receipt = await readFile(join(packageDir, "receipt.json"), "utf8").then((raw) => JSON.parse(raw)).catch(() => null);
const imageProvider = (receipt?.providers ?? []).find((item) => item.kind === "imagegen")?.detail ?? null;
const qualities = [...new Set(manifest.images.map((image) => image.quality))];
const imageQuality = qualities.length === 1 ? qualities[0] : null;
record("images_quality_declared",
  ["placeholder", "generated", "reused"].includes(imageQuality) && Boolean(imageProvider),
  {quality: imageQuality, distinct: qualities.length, provider: imageProvider});

const masterCopy = await copyDigests(join(packageDir, "master/copy"));
let platformDirs = [];
try {
  platformDirs = (await readdir(join(packageDir, "platforms"), {withFileTypes: true}))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
} catch {
  platformDirs = [];
}
record("platform_count_at_least_two", platformDirs.length >= 2, platformDirs);

const platformDetail = [];
for (const platform of platformDirs) {
  const dir = join(packageDir, "platforms", platform);
  const spec = await readFile(join(root, "data/specs/platforms", `${platform}.json`), "utf8")
    .then((raw) => JSON.parse(raw)).catch(() => null);
  const expectedRatio = spec?.image?.aspect_ratio ?? spec?.images?.aspect_ratio ?? null;
  const images = await listFiles(join(dir, "images"), (name) => name.endsWith(".png"));
  const copies = await copyDigests(join(dir, "copy"));
  const copyIdentical = JSON.stringify(copies) === JSON.stringify(masterCopy);
  const dims = [];
  for (const file of images) {
    const info = await imageInfo(join(dir, "images", file));
    dims.push(`${info.width}x${info.height}`);
  }
  const uniqueDims = [...new Set(dims)];
  const validate = await readFile(join(dir, "validate.json"), "utf8").then((raw) => JSON.parse(raw)).catch(() => null);
  platformDetail.push({
    platform,
    images: images.length,
    unique_dims: uniqueDims,
    expected_ratio: expectedRatio,
    copy_byte_identical: copyIdentical,
    copy_files: Object.keys(copies).length,
    validate_passed: validate?.passed ?? null,
    violations: validate?.violations ?? null,
    conflicts: validate?.conflicts ?? null,
    crop_unsafe: validate?.crop_unsafe ?? null,
    has_title_txt: (await stat(join(dir, "title.txt")).then(() => true).catch(() => false))
  });
}
record("platform_images_match_master", platformDetail.every((item) => item.images === 9),
  platformDetail.map((item) => `${item.platform}:${item.images}`));
record("platform_copy_byte_identical", platformDetail.every((item) => item.copy_byte_identical),
  platformDetail.map((item) => `${item.platform}:${item.copy_byte_identical}`));
record("platform_ratio_consistent", platformDetail.every((item) => item.unique_dims.length === 1),
  platformDetail.map((item) => `${item.platform}:${item.unique_dims.join("|")}`));
record("title_txt_absent_while_template_unverified", platformDetail.every((item) => !item.has_title_txt),
  platformDetail.map((item) => `${item.platform}:${item.has_title_txt ? "PRESENT" : "absent"}`));

const handoff = await readFile(join(packageDir, "handoff.md"), "utf8").catch(() => "");
const handoffLines = handoff.split(/\r?\n/);
record("handoff_line1_blocked", /^BLOCKED:/.test(handoffLines[0] ?? ""), (handoffLines[0] ?? "").slice(0, 60));
record("handoff_line2_image_state",
  imageQuality === "placeholder"
    ? /占位图/.test(handoffLines[1] ?? "")
    : (handoffLines[1] ?? "").trim().length > 0,
  (handoffLines[1] ?? "").slice(0, 60));
record("handoff_video_optional_wording", /本平台可选/.test(handoff) && !/视频：待补/.test(handoff), null);

record("receipt_present", Boolean(receipt), receipt ? receipt.run_id : null);
const degradationKinds = (receipt?.degradations ?? []).map((item) => item.kind);
record("degradation_imagegen_consistent",
  imageQuality === "placeholder" ? degradationKinds.includes("imagegen") : !degradationKinds.includes("imagegen"),
  {quality: imageQuality, degradations: degradationKinds});
record("degradation_video_optional", degradationKinds.includes("video"), degradationKinds);
record("receipt_pricing_has_no_invented_price", !receipt?.pricing || receipt.pricing.status === "unavailable" || Boolean(receipt.pricing.result),
  receipt?.pricing?.status ?? null);

const signalsReceipt = await readFile(join(packageDir, "signals.receipt.json"), "utf8").then((raw) => JSON.parse(raw)).catch(() => null);
record("signals_receipt_recorded", Boolean(signalsReceipt), signalsReceipt ? (signalsReceipt.error?.fault ?? "ok") : null);

const videoFiles = await listFiles(join(packageDir, "master/video"));
record("video_absent_when_unavailable", videoFiles.length === 0, videoFiles.length);

const failed = checks.filter((check) => !check.ok);
console.log(JSON.stringify({
  ok: failed.length === 0,
  sku,
  package: packageDir,
  checks_total: checks.length,
  checks_failed: failed.length,
  failed: failed.map((check) => check.id),
  checks,
  platforms: platformDetail
}, null, 2));
if (failed.length > 0) process.exitCode = 1;
