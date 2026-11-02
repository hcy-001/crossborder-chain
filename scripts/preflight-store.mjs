#!/usr/bin/env node
/**
 * A 档只读预检 CLI：拿店铺凭证对一次真实平台，回答「这个包现在提交，必填项能不能过」。
 *
 * 与 check-attrs-coverage 的分工：
 *   check:attrs   —— 本地算术：包内值在不在（零网络，每次出包后随手跑）。
 *   preflight:store —— 平台实证：值是否在官方字典里、必填集合是否变了（要凭证，只读端点）。
 *
 * 用法：
 *   node scripts/preflight-store.mjs --sku <sku> [--platform ozon] [--region RU]
 *        [--env <path>] [--type-id <id>] [--category-id <id>] [--max-pages 40]
 * 凭证：环境变量 OZON_CLIENT_ID / OZON_API_KEY，或 --env 指向的 KEY=VALUE 文件。
 * 退出码：0 全过（含自由填）｜1 有缺值或字典未命中｜2 配置/凭证不成立。
 */
import {readFile, readdir, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {loadCredentials, preflightStore, readAttributeCsv} from "./lib/preflight-store.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? true) : fallback;
};

const sku = flag("sku");
const platform = String(flag("platform", "ozon"));
const region = String(flag("region", "RU"));
const envPath = flag("env", join(ROOT, ".env"));
const maxDictPages = Number(flag("max-pages", 40));

if (!sku || sku === true) {
  console.error("用法：node scripts/preflight-store.mjs --sku <sku> [--platform ozon] [--region RU] [--env <path>]");
  process.exit(2);
}

const mapping = JSON.parse(await readFile(join(ROOT, "data/mapping", `${platform}-attributes.json`), "utf8"));

// 包目录解析与 check-attrs-coverage 同规则：精确名优先，其次 <sku>__<时间片>。
const packageRoot = join(ROOT, "package");
const dirs = (await readdir(packageRoot).catch(() => []))
  .filter((name) => name === sku || name.startsWith(`${sku}__`))
  .sort();
const packageDir = dirs.length > 0 ? join(packageRoot, dirs[dirs.length - 1]) : null;
if (!packageDir) {
  console.error(`找不到包目录：package/${sku}（也没有 ${sku}__* 形式的历史目录）。先出包再预检。`);
  process.exit(2);
}

let attributeKeys = new Map();
try {
  attributeKeys = readAttributeCsv(await readFile(join(packageDir, "platforms", platform, "attributes.csv"), "utf8"));
} catch {
  attributeKeys = readAttributeCsv(await readFile(join(packageDir, "master", "attributes.csv"), "utf8").catch(() => "canonical_key,value\n"));
}
const sizeMapping = await readFile(join(packageDir, "platforms", platform, "size-mapping.json"), "utf8")
  .then((text) => JSON.parse(text))
  .catch(() => null);

let creds;
try {
  creds = await loadCredentials({
    envPath,
    readFileImpl: (path, encoding) => readFile(path, encoding)
  });
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

let report;
try {
  report = await preflightStore({
    creds,
    fetchImpl: (url, init) => fetch(url, init),
    packageDir,
    packageAttributes: attributeKeys,
    sizeMappingValue: sizeMapping?.payload?.attribute_value ?? null,
    mapping,
    maxDictPages
  });
} catch (error) {
  console.error(`预检失败：${error.message}`);
  process.exit(2);
}

const stamp = report.ran_at.replace(/[:.]/g, "-").slice(0, 19);
const outFile = join(ROOT, "out", "verification", `preflight-store-${sku}-${stamp}.json`);
await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(`SKU ${sku} · ${platform} · 类目 ${report.category.description_category_id}/${report.category.type_id}（live 实测）`);
console.log(`平台必填 ${report.totals.required} 项：通过 ${report.totals.passed} · 缺值 ${report.totals.missing} · 字典未命中 ${report.totals.dictionary_failed}`);
for (const check of report.checks) {
  const mark = {in_dictionary: "✅", free_text: "✅", missing: "❌", not_found: "❌", cap_reached: "⚠️"}[check.status] ?? "❓";
  console.log(`  ${mark} #${check.attribute_id} ${check.name} → ${check.status}${check.value ? `（值：${String(check.value).slice(0, 40)}）` : ""}`);
  console.log(`      ${check.detail}`);
}
console.log(`\n回执：${outFile}`);
const failed = report.totals.missing + report.totals.dictionary_failed;
if (failed > 0) {
  console.log(`\n结论：${failed} 项会在平台侧出问题（缺值或字典未命中）。字典未命中的项必须改用官方字典值，不能硬交。`);
  process.exit(1);
}
console.log("\n结论：预检通过。本报告只证明「属性层可过」，图片规格与文案合规另有人工复核。");
process.exit(0);
