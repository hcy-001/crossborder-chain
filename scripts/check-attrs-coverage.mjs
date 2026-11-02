#!/usr/bin/env node
/**
 * 「这包能不能过审」的第一道门：平台必填属性覆盖了多少。
 *
 * 只做算术，不做判断：
 *   平台必填 N 项（来自官方接口实测）→ 我们的包能提供几项 → 缺哪几项。
 * 覆盖 = 内部键在 attributes.csv 里有值，或该键的值来自 size-mapping。
 *
 * 用法：
 *   node scripts/check-attrs-coverage.mjs --sku <sku> [--platform ozon] [--region RU]
 */
import {readFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {checkDictionaryMembership, checkDictionaryValueShape} from "../core/attrs/value-shape.mjs";
import {pickPackageDir} from "./lib/pick-package.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? true) : fallback;
};

const sku = flag("sku");
const region = String(flag("region", "RU"));
const platform = String(flag("platform", "ozon"));

if (!sku || sku === true) {
  console.error("用法：node scripts/check-attrs-coverage.mjs --sku <sku> [--platform ozon] [--region RU]");
  process.exit(2);
}

const readCsvKeys = async (file) => {
  // 两代表头都认：master 是 canonical_key,value,...；平台投影是 platform_key,canonical_key,value,...
  // 覆盖统计一律按 canonical_key 列取值，platform_key 只是给人看的平台字段名。
  const text = await readFile(file, "utf8");
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return new Map();
  const headers = lines[0].split(",").map((header) => header.trim());
  const keyIndex = headers.indexOf("canonical_key") >= 0 ? headers.indexOf("canonical_key") : 0;
  const valueIndex = headers.indexOf("value") >= 0 ? headers.indexOf("value") : 1;
  const keys = new Map();
  for (const row of lines.slice(1)) {
    const cells = row.split(",");
    const key = (cells[keyIndex] ?? "").trim();
    if (key && !keys.has(key)) keys.set(key, (cells[valueIndex] ?? "").trim());
  }
  return keys;
};

// 缺文件要当"不可判定"处理，不能抛栈：非 Ozon 平台本来就没有映射表与必填清单
// （类目属性要 partner 凭证才能拉），新手照着交付说明跑这一条时不该看到堆栈。
const readJsonSafe = async (file) => {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};

const regionSizing = await readJsonSafe(join(ROOT, "regions", region, "sizing.json"));
if (!regionSizing) {
  console.log(`SKU ${sku} · 法域 ${region}：没有 regions/${region}/sizing.json —— 尺码与必填清单都未登记，本项不可判定。`);
  console.log("补法：按该法域的市场尺码体系建 sizing.json（见 regions/RU/sizing.json 作为样例）。");
  process.exit(3);
}
const mapping = await readJsonSafe(join(ROOT, "data/mapping", `${platform}-attributes.json`));
if (!mapping) {
  console.log(`SKU ${sku} · 平台 ${platform}：没有 data/mapping/${platform}-attributes.json —— 没有平台字段映射，必填覆盖无法判定。`);
  console.log("原因：该类目属性需 partner 凭证 + 店铺授权才能拉；未拉之前只能按 canonical_key 原样输出。");
  console.log("这不等于「包有问题」，也不等于「能过审」——是「没依据判断」。");
  process.exit(3);
}
const required = regionSizing?.platform_fields?.[platform]?.required_attributes;
if (!required?.items?.length) {
  console.log(`SKU ${sku} · 平台 ${platform}：regions/${region}/sizing.json 里没有 ${platform}.required_attributes —— 必填清单未登记，本项不可判定。`);
  console.log(`补法：拿到该平台该类目的必填属性后写进 sizing.json，或在后台核一遍。`);
  process.exit(3);
}

// 包目录可能带时间片后缀，也可能压根不存在：两种情况都要说人话，不能抛栈。
const packageRoot = join(ROOT, "package");
const picked = await pickPackageDir(packageRoot, sku);
const packageDir = picked?.dir ?? null;
if (!packageDir) {
  console.error(`找不到包目录：package/${sku}（也没有 ${sku}__* 形式的历史目录）`);
  console.error("先跑一次出包：npm run quickstart，或 npm run chain -- --category 女装 --region RU --candidates 1 --intake answers.json");
  process.exit(2);
}

let attributeKeys;
try {
  attributeKeys = await readCsvKeys(join(packageDir, "platforms", platform, "attributes.csv"));
} catch {
  attributeKeys = await readCsvKeys(join(packageDir, "master", "attributes.csv")).catch(() => new Map());
}

const sizeMapping = await readFile(join(packageDir, "platforms", platform, "size-mapping.json"), "utf8")
  .then((text) => JSON.parse(text))
  .catch(() => null);

/** 某个平台必填项，我们能否给出值。 */
function coverageOf(attribute) {
  const entry = Object.entries(mapping.map).find(([, value]) => value.attribute_id === attribute.id);
  if (!entry) {
    return {covered: false, via: null, reason: "映射表里没有对应项（不知道该用内部哪个键去填）"};
  }
  const [internal, meta] = entry;
  if (meta.source === "size-mapping.json") {
    const value = sizeMapping?.payload?.attribute_value ?? null;
    return value
      ? {covered: true, via: `size-mapping:${internal}`, value}
      : {covered: false, via: null, reason: "尺码映射没有产出值（尺码表缺行）"};
  }
  // 映射条目可以声明别名（如 color/colour、audience/gender）：包内键名随工单源字段，取值时一起试。
  const aliases = [internal, ...(meta.aliases ?? [])];
  const found = aliases
    .map((key) => [key, attributeKeys.get(key)])
    .find(([, candidate]) => candidate && String(candidate).trim() !== "");
  if (found) return {covered: true, via: `attributes.csv:${found[0]}`, value: found[1]};
  return {covered: false, via: null, reason: `内部键 ${aliases.join("/")} 在 attributes.csv 里没有值`};
}

const results = required.items.map((attribute) => ({
  id: attribute.id,
  name: attribute.name,
  dictionary_id: attribute.dictionary_id ?? null,
  ...coverageOf(attribute)
}));

/**
 * 「有值」不等于「能过」：字典型属性只接受字典里的项。
 * 优先做字典成员校验（字典来自官方接口，落盘在 data/dictionaries/），
 * 没拉过字典的属性退回形态判定 —— 不猜，但也不放过明显的错。
 */
const dictDir = join(ROOT, "data", "dictionaries", platform);
const readDictionary = async (attributeId) => {
  try {
    return JSON.parse(await readFile(join(dictDir, `${attributeId}.json`), "utf8"));
  } catch {
    return null;
  }
};
const shapeIssues = [];
for (const item of results) {
  const dictionary = await readDictionary(item.id);
  const issue = checkDictionaryMembership(item, dictionary) ?? checkDictionaryValueShape(item);
  if (issue) shapeIssues.push({...item, value_issue: issue, dictionary_checked: Boolean(dictionary), dictionary_values: dictionary?.values?.map((entry) => entry.value) ?? null});
}
const blockingShape = shapeIssues.filter((item) => item.value_issue.severity === "block");
const categoryLeaf = String(mapping?.category?.path ?? "").split("/").pop().trim();



const covered = results.filter((item) => item.covered);
const missing = results.filter((item) => !item.covered);

console.log(`SKU ${sku} · ${platform} 类目 ${mapping.category.path}`);
console.log(`平台必填 ${results.length} 项，本包覆盖 ${covered.length} 项：`);
for (const item of results) {
  const mark = item.covered ? "✅" : "❌";
  console.log(`  ${mark} #${item.id} ${item.name}${item.covered ? ` = ${String(item.value).slice(0, 40)}（来自 ${item.via}）` : ` —— ${item.reason}`}`);
}
for (const item of shapeIssues) {
  console.log(`  ${item.value_issue.severity === "block" ? "⛔" : "⚠️"} ${item.value_issue.detail}`);
}
if (missing.length > 0) {
  console.log(`\n结论：这份包现在直接提交会被打回，缺 ${missing.length} 项必填。`);
  console.log("补法：在 attributes.csv 里补上对应内部键，或在后台手工填这几项；映射表见 data/mapping/ozon-attributes.json。");
} else if (blockingShape.length > 0) {
  console.log(`\n结论：必填项都填了，但 ${blockingShape.length} 项的值会被字典校验拒掉，等于没填。`);
  console.log("补法：字典型字段只能填平台字典里的取值（后台下拉选），自由文本不行。");
  const typeItem = blockingShape.find((item) => String(item.name).includes("Тип"));
  if (typeItem?.dictionary_values?.length) {
    console.log(`提示：#${typeItem.id} ${typeItem.name} 在这个类目只能填：${typeItem.dictionary_values.slice(0, 8).join(" / ")}。`);
    console.log("若商品本来就不是这个类目（例如把夹克放进连衣裙类目），要换的是类目，不是改这个值。");
  } else if (typeItem && categoryLeaf) {
    console.log(`提示：#${typeItem.id} ${typeItem.name} 的候选值通常就是类目叶子名「${categoryLeaf}」，在后台确认后再填。`);
  }
} else if (shapeIssues.length > 0) {
  console.log(`\n结论：必填项全覆盖；${shapeIssues.length} 项字典型取值是 ASCII 串，需后台确认是不是字典项。`);
} else {
  console.log("\n结论：平台必填项已全覆盖，且字典型取值形态正常（具体选项是否在字典内仍需后台核一眼）。");
}

process.exit(missing.length === 0 && blockingShape.length === 0 ? 0 : 1);
