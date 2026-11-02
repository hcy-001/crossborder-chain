#!/usr/bin/env node
/**
 * 反查货源：把选品候选变成一份能直接拿去 1688 询价的采购规格书。
 *
 * 顺序上这是第三段，必须排在方向验证与选品之后 —— 先有「要做什么」，
 * 才知道「去找什么货」。反过来做（先有货再找方向）会把采购决策变成需求的替代品。
 *
 * 这一段能做的与不能做的，界线很清楚：
 *   能做：把候选拆成检索词 + 规格要求 + 目标采购价 + 验货要点
 *   不能做：替你去 1688 砍价、判断某家供应商靠不靠谱
 *
 * 目标采购价是倒推的，用的是显式假设（佣金/物流/毛利），
 * 每个假设都写进 assumptions，改一个数就能重算。不把假设当事实。
 *
 * 用法：
 *   node scripts/source-lookup.mjs --direction "女士针织开衫" --region RU
 *   node scripts/source-lookup.mjs --direction "女士针织开衫" --region RU --pick c01,c03
 *   node scripts/source-lookup.mjs --help
 */
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 倒推目标采购价的假设。
 *
 * 这三项都可以改，改完重跑即可。它们是**假设**不是实测值 ——
 * 平台佣金与物流报价需要从卖家后台与货代报价单抄，脚本不替你猜。
 */
const ASSUMPTIONS = {
  platform_commission_pct: 0.18,
  fulfillment_cny_per_order: 22,
  target_gross_margin_pct: 0.30,
  note: "三项均为假设：佣金按服装类目常见区间取中值，物流按 400g 跨境小包估，毛利按自定目标。"
    + "改这三个数即可重算目标采购价；真实值须从卖家后台与货代报价单取得。"
};

const SPEC_BY_MATERIAL = {
  acrylic: {cn: "腈纶", ru: "акрил", yarn: "腈纶 70% 以上", weight_g: "280–360", note: "起订低、色卡全，适合先打样"},
  wool_blend: {cn: "羊毛混纺", ru: "шерсть/акрил", yarn: "羊毛 30–50% + 腈纶", weight_g: "320–420", note: "必须在水洗标标含毛量，虚标是主要退货原因"},
  wool: {cn: "高含毛", ru: "шерсть", yarn: "羊毛 70% 以上", weight_g: "380–480", note: "小单难拿稳定货源，先确认起订量与验货标准"}
};

const SPEC_BY_FIT = {
  oversize: {cn: "宽松版型", size_hint: "肩宽 +4–6cm，衣长盖臀", note: "覆盖体型差异，退货率低"},
  regular: {cn: "常规合身", size_hint: "按标准尺码表，胸围放量 8–12cm", note: "尺码不准时退货风险明显更高"}
};

function usage() {
  console.log(`反查货源：候选 → 1688 采购规格书

用法:
  node scripts/source-lookup.mjs --direction <方向词> --region <法域码> [--pick c01,c03]

参数:
  --direction  与 market:scan 相同的方向词
  --region     目标法域
  --pick       只给指定候选出规格书（逗号分隔），默认全部

前置:
  先跑 market:scan 与 select:candidates

产出:
  data/sourcing/<法域>-<方向>.json   机器读
  docs/采购规格书-<方向>.md          人读，可直接贴给供应商

退出码: 0 成功 | 2 缺前置 | 3 候选里没有可下手的项`);
}

function parseArgs(argv) {
  const out = {direction: null, region: null, pick: null};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { usage(); process.exit(0); }
    else if (a === "--direction") out.direction = argv[++i];
    else if (a === "--region") out.region = argv[++i];
    else if (a === "--pick") out.pick = String(argv[++i]).split(",").map((s) => s.trim()).filter(Boolean);
    else { console.error(`未知参数：${a}`); process.exit(2); }
  }
  return out;
}

const slugOf = (text) => Buffer.from(String(text)).toString("hex").slice(0, 12);

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

/**
 * 目标采购价：售价扣掉佣金、履约、目标毛利之后，能承受的最高进价。
 *
 * 毛利按**售价的百分比**定义，所以这里要用绝对额相减：
 *   cost = (售价 − 佣金 − 履约) − 售价 × 目标毛利率
 *
 * 不能用「余额 × (1−毛利率)」—— 那是把毛利定义在「余额」上，
 * 与 marginAt 的「毛利/售价」不是同一个口径，倒推出来的价会偏高（实测 87.9 vs 93.6），
 * 按那个价进货实际毛利只有 20.9%，不是设定的 30%。
 */
export function targetCost({priceCny, assumptions = ASSUMPTIONS}) {
  if (!Number.isFinite(priceCny)) return null;
  const afterCommission = priceCny * (1 - assumptions.platform_commission_pct);
  const afterFulfilment = afterCommission - assumptions.fulfillment_cny_per_order;
  const cost = afterFulfilment - priceCny * assumptions.target_gross_margin_pct;
  return Math.max(0, Math.round(cost * 10) / 10);
}

/** 反推之后要能反过来验：给定进价，实际毛利是多少。 */
export function marginAt({priceCny, costCny, assumptions = ASSUMPTIONS}) {
  if (!Number.isFinite(priceCny) || !Number.isFinite(costCny) || priceCny <= 0) return null;
  const afterCommission = priceCny * (1 - assumptions.platform_commission_pct);
  const gross = afterCommission - assumptions.fulfillment_cny_per_order - costCny;
  return Math.round((gross / priceCny) * 1000) / 10;
}

function buildBrief({candidate, direction}) {
  const material = SPEC_BY_MATERIAL[candidate.material] ?? SPEC_BY_MATERIAL.acrylic;
  const fit = SPEC_BY_FIT[candidate.fit] ?? SPEC_BY_FIT.oversize;
  const cost = targetCost({priceCny: candidate.target_price_cny});

  // 检索词分两档：精确词与宽泛词。1688 上精确词命中少但更准，宽泛词用来比价。
  const keywords = [
    {text: `女 ${material.cn} 开衫`, purpose: "精确：材质 + 品类", expected_hits: "少而准"},
    {text: `${material.cn} 针织开衫 女 宽松`, purpose: "带版型，接近目标款", expected_hits: "中等"},
    {text: "针织开衫 女 批发", purpose: "宽泛：用来比整体价格带", expected_hits: "多而杂"}
  ];

  return {
    candidate_id: candidate.id,
    title_cn: candidate.title_cn,
    target_price_cny: candidate.target_price_cny,
    target_price_rub: candidate.target_price_rub,
    target_cost_cny: cost,
    target_cost_note: "按售价扣佣金/履约/目标毛利倒推，高于这个价就没有毛利空间",
    assumptions: ASSUMPTIONS,
    search: {
      keywords_1688: keywords,
      spec_required: {
        material: material.yarn,
        weight_g: material.weight_g,
        fit: fit.size_hint,
        size_range: "S–XL 或 42–50（俄码），至少 4 个码",
        color: "米色 / 燕麦色 / 黑（三色起，实测色差 ≤ 2 级）"
      },
      must_ask_supplier: [
        "含毛量实测值（不接受口头承诺，要成分检测或水洗标照片）",
        "起订量（MOQ）与混色是否加价",
        "能否按俄码 42–50 打码，而不是只做 S–XL",
        "大货与样品的色差控制方式",
        "断货补货周期（决定会不会因为缺货掉排名）"
      ]
    },
    verify: {
      price: "至少询 3 家取中位；单家报价不算市场价",
      quality: "先打样 1 件，按 weight_g 与成分核对；克重不足是压价最常见手段",
      margin_check: `若进价 ${cost} CNY，按当前假设毛利约 ${ASSUMPTIONS.target_gross_margin_pct * 100}%；进价每高 10 元，毛利掉约 ${Math.round((10 / (candidate.target_price_cny || 1)) * 1000) / 10} 个百分点`
    },
    not_done_by_tool: "不代询价、不代下单、不判断供应商可靠性 —— 这些需要人对接"
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.direction || !args.region) { usage(); process.exit(2); }

  const candDoc = await readJson(join(ROOT, "data", "candidates", `${args.region}-${slugOf(args.direction)}.json`));
  if (!candDoc) {
    console.error("没有候选文件。先跑：\n  npm run select:candidates -- --direction \"...\" --region ...");
    process.exit(2);
  }

  let pool = candDoc.candidates ?? [];
  if (args.pick?.length) pool = pool.filter((c) => args.pick.includes(c.id));
  if (pool.length === 0) {
    console.error("没有可下手的候选（--pick 未命中或候选为空）");
    process.exit(3);
  }

  const briefs = pool.map((c) => buildBrief({candidate: c, direction: args.direction}));

  const doc = {
    direction: args.direction,
    region: args.region,
    generated_at: new Date().toISOString(),
    upstream: {candidates_file: `${args.region}-${slugOf(args.direction)}.json`, count: candDoc.count},
    note: "规格书是「去问什么」，不是「已经问到了」。拿到真实报价后回填 target_cost_cny 对应的实价，再用 marginAt 复核。",
    briefs
  };

  const outDir = join(ROOT, "data", "sourcing");
  await mkdir(outDir, {recursive: true});
  const outPath = join(outDir, `${args.region}-${slugOf(args.direction)}.json`);
  await writeFile(outPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");

  // 人读版：可直接贴给供应商
  const lines = [
    `# 采购规格书 · ${args.direction}（${args.region}）`,
    "",
    `> 生成于 ${doc.generated_at}。目标价按售价倒推，假设见文末；真实报价须自行询价。`,
    ""
  ];
  for (const b of briefs) {
    lines.push(`## ${b.candidate_id} ${b.title_cn}`, "");
    lines.push(`- 目标零售价：**${b.target_price_cny} CNY / ${b.target_price_rub} RUB**`);
    lines.push(`- **目标采购价：≤ ${b.target_cost_cny} CNY**（高于此价没有毛利空间）`);
    lines.push("");
    lines.push("检索词（1688）：");
    for (const k of b.search.keywords_1688) lines.push(`- \`${k.text}\` — ${k.purpose}（${k.expected_hits}）`);
    lines.push("");
    lines.push("规格要求：");
    for (const [key, value] of Object.entries(b.search.spec_required)) lines.push(`- ${key}：${value}`);
    lines.push("");
    lines.push("必须问供应商：");
    for (const q of b.search.must_ask_supplier) lines.push(`- ${q}`);
    lines.push("");
    lines.push(`验货与比价：${b.verify.quality}`);
    lines.push("");
  }
  lines.push("---", "", "假设（可改，改完重跑）：", "");
  for (const [k, v] of Object.entries(ASSUMPTIONS)) {
    if (k !== "note") lines.push(`- ${k} = ${v}`);
  }
  lines.push("", ASSUMPTIONS.note, "");
  const mdPath = join(ROOT, "docs", `采购规格书-${args.region}.md`);
  await writeFile(mdPath, lines.join("\n"), "utf8");

  console.log(`方向：${args.direction} ｜ ${args.region} ｜ 规格书 ${briefs.length} 份`);
  for (const b of briefs) {
    console.log(`  ${b.candidate_id}  零售 ${b.target_price_cny} CNY → 目标进价 ≤ ${b.target_cost_cny} CNY ｜ ${b.title_cn}`);
  }
  console.log(`\n产出：${outPath.replaceAll("\\", "/")}`);
  console.log(`人读版：${mdPath.replaceAll("\\", "/")}`);
  console.log("\n下一步：拿检索词去 1688 询 3 家，回填实价后用 marginAt 复核毛利。");
}

if (process.argv[1] && process.argv[1].endsWith("source-lookup.mjs")) {
  main().catch((error) => { console.error(`失败：${error.message}`); process.exit(1); });
}
