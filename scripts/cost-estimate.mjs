#!/usr/bin/env node
/**
 * 单包出图成本估算：按官方价目表算，不按"感觉"算。
 *
 * 用法：
 *   node scripts/cost-estimate.mjs --sku <sku> [--model <id>] [--json]
 *
 * 口径（写死在输出里，别让它变成口头知识）：
 *   成本 = 成功出图张数 × 该模型在该像素档位的单价
 *   单价来自 data/specs/providers/ark-image.json（官方价目表，带 source_url）
 *   张数来自包内 manifest（只算真实落盘的图，不算计划张数）
 *   型号与价目行的对应关系若靠前缀匹配，会在输出里标出来（这是唯一的推断点）
 */
import {readFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {pickPackageDir} from "./lib/pick-package.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? true) : fallback;
};

const sku = flag("sku");
const asJson = args.includes("--json");
if (!sku || sku === true) {
  console.error("用法：node scripts/cost-estimate.mjs --sku <sku> [--model <id>] [--json]");
  process.exit(2);
}

const picked = await pickPackageDir(join(ROOT, "package"), sku);
if (!picked) {
  console.error(`找不到包目录：package/${sku}`);
  process.exit(2);
}
const packageDir = picked.dir;

const manifest = JSON.parse(await readFile(join(packageDir, "master", "manifest.json"), "utf8"));
const images = (manifest.images ?? []).filter((image) => image?.file);
const table = JSON.parse(await readFile(join(ROOT, "data/specs/providers/ark-image.json"), "utf8"));
const priceFact = table.facts.find((fact) => fact.key === "image.price.table");
const aliasFact = table.facts.find((fact) => fact.key === "image.price.model_alias_risk");
const price = priceFact.value;

let model = flag("model");
if (!model || model === true) {
  try {
    const local = JSON.parse(await readFile(join(ROOT, "config/local.json"), "utf8"));
    model = local?.imagegen?.model ?? null;
  } catch {
    model = null;
  }
}

if (!model) {
  console.error("拿不到模型名：config/local.json 里没有 imagegen.model，也没传 --model");
  process.exit(2);
}

const row = price.models.find((item) => item.id === model);
const aliasRow = row ?? price.models.find((item) => (item.aliases ?? []).some((alias) => model.startsWith(alias)));
if (!aliasRow) {
  const result = {
    status: "unresolved",
    reason: `价目表里没有与「${model}」对应的行`,
    known_models: price.models.map((item) => item.id),
    source_url: priceFact.source_url
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(1);
}

const maxPixels = images.reduce((best, image) => Math.max(best, (image.width ?? 0) * (image.height ?? 0)), 0);
const tier = price.pixel_tiers.find((item) => item.max_pixels !== null && maxPixels <= item.max_pixels)
  ?? price.pixel_tiers.find((item) => item.max_pixels === null);
const unitPrice = aliasRow.price[tier.id];
const total = Math.round(images.length * unitPrice * 100) / 100;

const result = {
  status: "estimated",
  sku: manifest.sku,
  package: `package/${picked.name}`,
  model,
  matched_row: aliasRow.id,
  match_basis: row ? "型号逐字匹配" : `前缀匹配（配置型号带日期后缀，价目表只列 ${aliasRow.id}）`,
  images: images.length,
  max_pixels: maxPixels,
  pixel_tier: tier.label,
  unit_price_cny: unitPrice,
  total_cny: total,
  currency: price.currency,
  level: "L1",
  confidence: row ? "high（价目表 + 型号逐字对应）" : "medium（价目表为官方，型号对应是前缀推断）",
  assumptions: [
    "只算已落盘的图；计划张数不算钱",
    "未计失败重试（官方：审核未通过的图不计费）",
    priceFact.note
  ],
  source: {key: priceFact.key, source_url: priceFact.source_url, fetched_at: priceFact.fetched_at},
  alias_risk: row ? null : aliasFact?.value?.risk ?? null
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`SKU ${result.sku} · 模型 ${model}`);
  console.log(`张数 ${result.images} · 最大像素 ${maxPixels}（${tier.label}）· 单价 ${unitPrice} 元/张`);
  console.log(`单包出图成本 ≈ ${total} CNY`);
  console.log(`对应价目行：${aliasRow.id}（${result.match_basis}）`);
  console.log(`置信：${result.confidence}`);
  for (const item of result.assumptions) console.log(`  · ${item}`);
  if (result.alias_risk) console.log(`  风险：${result.alias_risk}`);
  console.log(`来源：${priceFact.source_url}（${priceFact.fetched_at.slice(0, 10)}）`);
}
process.exit(0);
