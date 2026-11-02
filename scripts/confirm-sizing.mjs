#!/usr/bin/env node
/**
 * 尺码字段确认器：把「去后台抄 4 个名字」压缩成一次问答。
 *
 * 为什么要有它：字段名只存在于卖家后台，公开接口被 WAF 挡（实测 403）、
 * 开发者文档有反爬。我们不去猜，也不要求人打开 JSON 手改 —— 那两种做法都会出错。
 *
 * 用法：
 *   node scripts/confirm-sizing.mjs                 # 交互式问 4 个问题，回车沿用当前值
 *   node scripts/confirm-sizing.mjs --dry           # 只看会写什么，不落盘
 *   node scripts/confirm-sizing.mjs --set ozon.size_attribute=Размер --set wildberries.tech_size_field=techSize
 *   node scripts/confirm-sizing.mjs --reset         # 撤回确认（回到 pending_seller）
 *
 * 判断标准：填的是「后台字段的显示名」，不是我们自己起的名字。
 */
import {readFile, writeFile} from "node:fs/promises";
import {createInterface} from "node:readline/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const regionFlag = args.indexOf("--region");
const REGION = regionFlag >= 0 ? args[regionFlag + 1] : "RU";
const FILE = join(ROOT, "regions", REGION, "sizing.json");

/** 四个待确认项：键、在哪看、填什么样。写成数据，问话时原样打印。 */
const FIELDS = [
  {
    key: "ozon.size_attribute",
    where: "Ozon 后台 → 商品 → 添加商品 → 选到服装叶子类目 → 「特征」区找尺码那一项",
    example: "Российский размер",
    hint: "抄「属性名」原文（俄文、含大小写），不要抄成“Размер”除非后台就是这么写的"
  },
  {
    key: "ozon.international_attribute",
    where: "同一页，尺码附近通常会有一个“国际尺码”属性",
    example: "Международный размер",
    hint: "没有这一项就直接回车留空——不要编一个"
  },
  {
    key: "wildberries.tech_size_field",
    where: "WB 后台 → 商品卡片 → 「尺码」/ «Размеры» → 变体表里的尺码列",
    example: "techSize",
    hint: "WB 一般叫技术尺码（techSize）；如果页面显示俄文名，就抄俄文名"
  },
  {
    key: "wildberries.wb_size_field",
    where: "同一张尺码表里 WB 自己的尺码码位（可能叫 wbSize / 尺码）",
    example: "wbSize",
    hint: "看不到就回车留空，系统会用本地码表，不拿别的码冒充"
  }
];

function readByPath(doc, path) {
  const [platform, field] = path.split(".");
  return doc.platform_fields?.[platform]?.[field] ?? null;
}

function writeByPath(doc, path, value) {
  const [platform, field] = path.split(".");
  doc.platform_fields[platform] = doc.platform_fields[platform] ?? {};
  if (value === "" || value === null) delete doc.platform_fields[platform][field];
  else doc.platform_fields[platform][field] = value;
}

const raw = JSON.parse(await readFile(FILE, "utf8"));

if (has("help")) {
  console.log("用法见文件头：node scripts/confirm-sizing.mjs [--dry] [--set k=v] [--reset] [--region RU]");
  process.exit(0);
}

if (has("reset")) {
  raw.confirmation = {...raw.confirmation, status: "pending_seller", confirmed_at: null};
  await writeFile(FILE, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  console.log("已撤回确认：sizing.json 的 confirmation.status = pending_seller");
  process.exit(0);
}

const next = structuredClone(raw);
const changes = [];

const setFlags = args.reduce((list, item, index) => {
  if (item === "--set" && args[index + 1]) list.push(args[index + 1]);
  return list;
}, []);

if (setFlags.length > 0) {
  for (const pair of setFlags) {
    const [path, ...rest] = pair.split("=");
    const value = rest.join("=").trim();
    const before = readByPath(next, path);
    writeByPath(next, path, value);
    changes.push({path, before, after: value === "" ? null : value});
  }
} else {
  if (!process.stdin.isTTY) {
    console.error([
      "非交互环境：请用 --set 传值，例如",
      "  node scripts/confirm-sizing.mjs --set ozon.size_attribute=\"Российский размер\" \\",
      "    --set ozon.international_attribute=\"Международный размер\" \\",
      "    --set wildberries.tech_size_field=techSize \\",
      "    --set wildberries.wb_size_field=wbSize"
    ].join("\n"));
    process.exit(2);
  }

  const rl = createInterface({input: process.stdin, output: process.stdout});
  console.log(`\n尺码字段确认（法域 ${REGION}）—— 一共 ${FIELDS.length} 个问题，直接回车＝沿用当前值\n`);
  try {
    for (const [index, field] of FIELDS.entries()) {
      const current = readByPath(next, field.key);
      console.log(`${index + 1}/${FIELDS.length} ${field.key}`);
      console.log(`   在哪看：${field.where}`);
      console.log(`   填什么：${field.hint}`);
      console.log(`   示例：${field.example}`);
      const answer = (await rl.question(`   > 当前「${current ?? "（空）"}」，改成什么？`)).trim();
      if (answer !== "") {
        writeByPath(next, field.key, answer);
        changes.push({path: field.key, before: current, after: answer});
      }
      console.log("");
    }
  } finally {
    rl.close();
  }
}

if (changes.length === 0) {
  console.log("没有任何改动。若后台里显示的名字和当前值一致，用 --set 显式填一次即可完成确认。");
  process.exit(0);
}

next.confirmation = {
  ...next.confirmation,
  status: "confirmed_by_seller",
  confirmed_at: new Date().toISOString().slice(0, 10),
  confirmed_note: "由卖家在后台核对后填入；改动项见 changes"
};
next.platform_fields.ozon = {...next.platform_fields.ozon, status: "confirmed_by_seller"};
next.platform_fields.wildberries = {...next.platform_fields.wildberries, status: "confirmed_by_seller"};

console.log("将要改动：");
for (const change of changes) {
  console.log(`  ${change.path}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`);
}
console.log(`  confirmation.status: pending_seller → confirmed_by_seller`);

if (has("dry")) {
  console.log("\n（--dry：只预览，未写入）");
  process.exit(0);
}

await writeFile(FILE, `${JSON.stringify(next, null, 2)}\n`, "utf8");
console.log(`\n已写入 ${FILE}`);
console.log("效果：size-mapping.json 不再标 needs_field_confirmation，尺码映射可直接按这些字段名填。");
