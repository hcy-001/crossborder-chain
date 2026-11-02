#!/usr/bin/env node
/**
 * 文案：生成「写作任务单」→ AI 写 → 校验产出。
 *
 * 为什么不在这里直接调模型：文案该由执行任务的 AI 自己写，它才知道上下文。
 * Skill 的职责是把「市场/人群/商品事实/长度与禁忌」变成一份没有歧义的任务单，
 * 再对 AI 写完的稿子做机械校验（结构、长度、禁用表达）。这样：
 *   - 换任何模型都能用（不绑供应商）；
 *   - 人也能照着任务单写，校验同样生效；
 *   - 校验规则可被追问到来源（官方 / 未定稿 / 经验）。
 *
 * 用法：
 *   node scripts/copy.mjs --sku <sku> --plan     # 生成 package/<sku>/copy/job.json
 *   node scripts/copy.mjs --sku <sku> --check    # 校验 package/<sku>/copy/draft.json
 *   node scripts/copy.mjs --sku <sku> --dir <包目录>  # 指定目录（重复跑时目录带时间片）
 */
import {readdir, readFile, writeFile, mkdir} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {planCopy, validateCopy} from "../core/copy/writer.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? true) : fallback;
};
const has = (name) => args.includes(`--${name}`);

const sku = flag("sku");
if (!sku || sku === true) {
  console.error("用法：node scripts/copy.mjs --sku <sku> [--plan|--check] [--dir <包目录>]");
  process.exit(2);
}

/** 找包目录：优先 --dir，其次 package/<sku>，最后取最新带时间片的那份。 */
async function resolvePackageDir() {
  const explicit = flag("dir");
  if (explicit && explicit !== true) return resolve(String(explicit));
  const base = join(ROOT, "package", sku);
  try {
    await readdir(base);
    return base;
  } catch { /* 继续找带后缀的 */ }
  const entries = await readdir(join(ROOT, "package")).catch(() => []);
  const candidates = entries.filter((name) => name.startsWith(`${sku}__`)).sort();
  if (candidates.length === 0) {
    console.error(`找不到包目录：package/${sku}（先跑 npm run quickstart 或 chain）`);
    process.exit(2);
  }
  return join(ROOT, "package", candidates[candidates.length - 1]);
}

const packageDir = await resolvePackageDir();

async function readCsv(file) {
  const text = await readFile(file, "utf8").catch(() => "");
  const map = new Map();
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const [key, value] = line.split(",");
    if (key) map.set(key.trim(), (value ?? "").trim());
  }
  return map;
}

const attributes = await readCsv(join(packageDir, "platforms", "ozon", "attributes.csv"));
const region = JSON.parse(await readFile(join(ROOT, "regions", "RU", "profile.json"), "utf8"));
const platformSpec = JSON.parse(await readFile(join(ROOT, "data", "specs", "platforms", "ozon.json"), "utf8"));
const sizeMapping = await readFile(join(packageDir, "platforms", "ozon", "size-mapping.json"), "utf8")
  .then((text) => JSON.parse(text))
  .catch(() => null);

const plan = planCopy({
  region,
  persona: {audience: attributes.get("audience") ?? null},
  product: {
    category: attributes.get("product_type") ?? null,
    subject: attributes.get("product_type") ?? null,
    material: attributes.get("material") ?? null,
    colour: attributes.get("colour") ?? null,
    sizes: sizeMapping?.payload?.attribute_value ?? null
  },
  marketProfile: null,
  platformSpec,
  platformId: "ozon",
  locale: "ru-RU"
});

const copyDir = join(packageDir, "copy");
await mkdir(copyDir, {recursive: true});

if (has("plan") || (!has("check"))) {
  await writeFile(join(copyDir, "job.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  await writeFile(join(copyDir, "README.md"), [
    "# 文案怎么写",
    "",
    "1. 读 `job.json`：市场、人群、商品事实、结构、长度与禁忌都在里面。",
    "2. 用**目标市场母语**写，写完按 `output_schema` 存成 `draft.json`：",
    "",
    "```json",
    JSON.stringify({title: "…", bullets: ["…", "…", "…"], description: "…", keywords: ["…"], notes: "我做了哪些假设"}, null, 2),
    "```",
    "",
    "3. 跑 `node scripts/copy.mjs --sku " + sku + " --check` 做机械校验。",
    "",
    "规则来源：标题上限 " + (plan.limits.title.max_chars ?? "未知") + " 字符（" + plan.limits.title.rule_status + "）；描述无统一上限，按后台提示为准。",
    "校验只管结构与长度，**内容好不好仍要人看**——同一件衣服，莫斯科通勤和家庭主妇的卖点顺序不一样。"
  ].join("\n") + "\n", "utf8");
  console.log(`写作任务单已生成：${join(copyDir, "job.json").replace(ROOT, "").replace(/\\/g, "/")}`);
  console.log(`市场 ${plan.market.region} · 语言 ${plan.market.locale} · 人群 ${plan.audience.segment ?? "未定（标为假设）"} · 标题上限 ${plan.limits.title.max_chars ?? "未知"}（${plan.limits.title.rule_status}）`);
  process.exit(0);
}

const draft = await readFile(join(copyDir, "draft.json"), "utf8")
  .then((text) => JSON.parse(text))
  .catch(() => null);
if (!draft) {
  console.error(`没有找到 ${join(copyDir, "draft.json").replace(ROOT, "")}：先按 job.json 写稿再校验`);
  process.exit(2);
}

const result = validateCopy(draft, plan.limits);
await writeFile(join(copyDir, "copy.receipt.json"), `${JSON.stringify({checked_at: new Date().toISOString(), ...result}, null, 2)}\n`, "utf8");

if (result.ok) {
  console.log(`文案校验通过：标题 ${result.title_len} 字符${result.title_max ? `（上限 ${result.title_max}，规则 ${plan.limits.title.rule_status}）` : ""}`);
  if (result.warn) console.log(`提醒：${result.warn}`);
} else {
  console.log("文案未通过：");
  for (const problem of result.problems) console.log(`  - ${problem}`);
}
process.exit(result.ok ? 0 : 1);
