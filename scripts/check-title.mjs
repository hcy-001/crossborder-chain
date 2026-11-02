#!/usr/bin/env node
/**
 * 标题上平台前的最后一道检查：会不会被打回、因为哪一条。
 *
 * 用法：
 *   node scripts/check-title.mjs --text "Trendy Платье женское, миди"
 *   node scripts/check-title.mjs --file title.txt [--platform ozon]
 *   node scripts/check-title.mjs --package <sku>        # 打印包内该平台的自动生成说明与参考名
 *
 * 退出码：0 = 无硬性违规；1 = 有硬性违规（照这个版本提交会被拒）；2 = 用法错误。
 */
import {readFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {lintTitle, titleRulesFromFacts} from "../core/listing/title-rules.mjs";
import {pickPackageDir} from "./lib/pick-package.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? true) : fallback;
};

const platform = String(flag("platform", "ozon"));
const specPath = join(ROOT, "data/specs/platforms", `${platform}.json`);
let spec;
try {
  spec = JSON.parse(await readFile(specPath, "utf8"));
} catch {
  console.error(`读不到平台事实：${specPath}`);
  process.exit(2);
}
const rules = titleRulesFromFacts(spec.facts);

const packageSku = flag("package");
if (packageSku) {
  const picked = await pickPackageDir(join(ROOT, "package"), packageSku);
  if (!picked) {
    console.error(`找不到包目录：package/${packageSku}`);
    process.exit(2);
  }
  const file = join(picked.dir, "platforms", platform, "title.auto.json");
  try {
    const auto = JSON.parse(await readFile(file, "utf8"));
    console.log(`包：package/${picked.name} · 平台 ${platform}`);
    console.log(`标题来源：${auto.status}（${auto.platform_format}）`);
    console.log(`依据：${auto.why}`);
    console.log(`该做什么：${auto.what_to_do}`);
    console.log(`参考名：${auto.reference_name_preview}`);
    const lint = auto.reference_lint ?? {};
    console.log(`参考名体检：${lint.ok ? "无硬性违规" : `有 ${lint.violations.length} 条硬性违规`}`);
    for (const item of lint.violations ?? []) console.log(`  ✗ ${item.code} — ${item.detail}`);
    process.exit(0);
  } catch {
    console.error(`该包没有 title.auto.json：说明这个品类的标题不是平台自动生成，或包还没跑到投影段。`);
    console.error(`用 --text / --file 直接检查标题文本。`);
    process.exit(2);
  }
}

let text = flag("text");
const file = flag("file");
if (!text && file) text = await readFile(resolve(process.cwd(), String(file)), "utf8");
if (!text || text === true) {
  console.error('用法：node scripts/check-title.mjs --text "..." | --file <path> | --package <sku>');
  process.exit(2);
}

const result = lintTitle(String(text).trim(), rules);
// 各平台的上限口径不同（字符 / 字节 / 按语种折算），不能只打印一个 /max_chars，
// 否则 Lazada 这种"按字节"的平台会打出 "90/?" 让人以为没上限。
const limits = [];
limits.push(`字符 ${result.stats.chars}`);
if (rules.max_chars) limits.push(`上限 ${rules.max_chars}`);
if (rules.min_chars) limits.push(`下限 ${rules.min_chars}`);
if (rules.max_bytes) limits.push(`${result.stats.bytes}/${rules.max_bytes} 字节`);
if (rules.max_word_chars) limits.push(`最长词 ${result.stats.longest_word}/${rules.max_word_chars}`);
if (rules.max_chars_by_script) {
  const hasCjk = /[\u3400-\u4dbf\u4e00-\u9fff]/u.test(String(text));
  limits.push(`${hasCjk ? "中文" : "英文"}标题上限 ${hasCjk ? rules.max_chars_by_script.cjk : rules.max_chars_by_script.latin}`);
}
console.log(`平台 ${platform} · ${limits.join(" · ")}`);
if (!rules.max_chars && !rules.max_bytes && !rules.max_chars_by_script) {
  console.log("注意：该平台的标题上限尚未取到官方值（事实为 null），本次只检查禁用项与结构性规则。");
}
if (result.ok && (result.warnings ?? []).length === 0) {
  console.log("结论：无硬性违规。");
} else {
  for (const item of result.violations) console.log(`  ✗ ${item.code} — ${item.detail}`);
  for (const item of result.warnings ?? []) console.log(`  · ${item.code} — ${item.detail}`);
  console.log(result.ok ? "结论：可通过，但有需要人看一眼的提示。" : "结论：按这个版本提交会被拒。");
}
process.exit(result.ok ? 0 : 1);
