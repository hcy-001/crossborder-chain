#!/usr/bin/env node
/**
 * 选品决策：把「方向」变成 5–10 个可比较的候选。
 *
 * 这一段的前提是方向已经过 market-scan 验证。它不预测爆款 —— 竞品价格带拿不到时，
 * 谁都不知道哪个款好卖。它能做的是：
 *   1. 用已知约束（品类规模、季节窗口、平台必填属性、价格带区间）枚举合理选项
 *   2. 给每个候选标清「哪条依据是硬的、哪条是二手的、哪条完全没有」
 *   3. 附敏感性：哪个假设一破，这个候选就不成立
 *   4. 附自我查证：哪些能被验证、怎么验、现在还差什么
 *
 * 输出一律带等级，`candidate` 不许当结论用。
 *
 * 用法：
 *   node scripts/select-candidates.mjs --direction "女士针织开衫" --region RU
 *   node scripts/select-candidates.mjs --direction "女士针织开衫" --region RU --count 8
 *   node scripts/select-candidates.mjs --help
 */
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 价格档位：相对「平台客单价区间」切三段，不凭空定绝对数。 */
const PRICE_TIERS = [
  {id: "entry", label: "入门档", position: 0.25, note: "区间下四分位，靠量"},
  {id: "core", label: "主力档", position: 0.5, note: "区间中位，款式与价格都要能打"},
  {id: "premium", label: "上探档", position: 0.8, note: "区间上五分位，靠材质与版型差异化"}
];

/** 材质档：直接决定成本与卖点，也决定供货端好不好找。 */
const MATERIALS = [
  {id: "acrylic", label: "腈纶为主", cost_index: 1.0, note: "1688 供货最充足，起订低"},
  {id: "wool_blend", label: "羊毛混纺", cost_index: 1.6, note: "保暖卖点成立，需标注含毛量"},
  {id: "wool", label: "高含毛", cost_index: 2.4, note: "客单价上探，但起订与验货要求高"}
];

/** 版型档：与季节窗口和体型偏好相关，属于可描述、可打样的维度。 */
const FITS = [
  {id: "oversize", label: "Oversize 宽松", note: "覆盖体型差异，退货率相对低"},
  {id: "regular", label: "常规合身", note: "尺码不准时退货风险高"}
];

function usage() {
  console.log(`选品决策：方向 → 5–10 个候选（每个带依据、敏感性、自我查证）

用法:
  node scripts/select-candidates.mjs --direction <方向词> --region <法域码> [--count <5-10>]

参数:
  --direction  与 market-scan 相同的方向词
  --region     目标法域
  --count      候选数量，默认 6，允许 5–10

前置:
  先跑 npm run market:scan 生成方向简报（data/directions/<法域>-*.json）

产出:
  data/candidates/<法域>-<方向>.json

退出码: 0 成功 | 2 参数错或缺方向简报 | 3 方向未通过验证`);
}

function parseArgs(argv) {
  const out = {direction: null, region: null, count: 6};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { usage(); process.exit(0); }
    else if (a === "--direction") out.direction = argv[++i];
    else if (a === "--region") out.region = argv[++i];
    else if (a === "--count") out.count = Number(argv[++i]);
    else { console.error(`未知参数：${a}`); process.exit(2); }
  }
  return out;
}

function slugOf(text) {
  return Buffer.from(String(text)).toString("hex").slice(0, 12);
}

/** 读方向简报。找不到就让调用方先跑 market:scan，不临时编一份。 */
async function loadBrief(direction, region) {
  const path = join(ROOT, "data", "directions", `${region}-${slugOf(direction)}.json`);
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 从客单价区间取一个绝对价位，**返回卢布**。
 *
 * 区间本身是卢布（平台客单价以卢布计价），所以这一步只做分位插值，
 * 换算成人民币是下一步的事 —— 两者混在一起就会出现「1900 CNY 的开衫」这种荒谬数字。
 */
export function pickPrice(band, position) {
  if (!band || band.low === undefined || band.high === undefined) return null;
  const value = band.low + (band.high - band.low) * position;
  return Math.round(value / 10) * 10;
}

/** 卢布 → 人民币。汇率缺失就返回 null，不拿 1:1 顶上。 */
export function toCny(rub, rate) {
  if (!Number.isFinite(rub) || !Number.isFinite(rate) || rate <= 0) return null;
  return Math.round(rub / rate);
}

/**
 * 生成候选。
 *
 * 组合逻辑：价格档 × 材质档 × 版型，按 count 取前 N 个。
 * 排序不是「哪个好卖」（那需要竞品数据），而是「依据强度 + 差异化程度」：
 * 主力档 + 腈纶 + Oversize 排最前，因为它的三条依据都最硬（区间中位、供货最足、退货最低）。
 */
function buildCandidates({brief, count}) {
  // market-scan 落的是 price_band: {low, high, currency}；别再另起一个字段名
  const band = brief.price_band && Number.isFinite(brief.price_band.low) && Number.isFinite(brief.price_band.high)
    ? {low: brief.price_band.low, high: brief.price_band.high, currency: brief.price_band.currency, level: brief.price_band.level}
    : null;
  const season = brief.season ?? null;
  const cold = season?.cold_months ?? 0;

  const pool = [];
  for (const tier of PRICE_TIERS) {
    for (const material of MATERIALS) {
      for (const fit of FITS) {
        pool.push({tier, material, fit});
      }
    }
  }

  // 依据强度打分：档位越靠中、材质越好找、版型越宽容，分越高。
  const scoreOf = ({tier, material, fit}) => {
    let s = 0;
    s += tier.id === "core" ? 3 : tier.id === "entry" ? 2 : 1;
    s += material.id === "acrylic" ? 3 : material.id === "wool_blend" ? 2 : 1;
    s += fit.id === "oversize" ? 2 : 1;
    // 冬季长的市场，保暖材质加权
    if (cold >= 5 && material.id !== "acrylic") s += 1;
    return s;
  };

  pool.sort((a, b) => scoreOf(b) - scoreOf(a));

  // 去重：同一组「档位 + 材质」只出一个版型，但版型要轮换 ——
  // 否则排在前面的 oversize 会把其余版型全部挤掉，八个候选长得一模一样。
  const seen = new Set();
  const picked = [];
  for (const item of pool) {
    const key = `${item.tier.id}|${item.material.id}`;
    if (seen.has(key)) continue;
    // 该组合下按 cursor 选一个还没用过的版型
    const fitChoice = FITS[picked.length % FITS.length];
    const chosen = {tier: item.tier, material: item.material, fit: fitChoice};
    seen.add(key);
    picked.push(chosen);
    if (picked.length >= count) break;
  }

  return picked.map(({tier, material, fit}, index) => {
    // 价格带的币种是会变的：款级数据给 CNY，类目级回退给 CNY，
    // 但历史/别处可能给 RUB。所以按 band.currency 判断换算方向，
    // 不能默认「band 一定是卢布」—— 那一版把 140–210 CNY 又除了一次汇率，报出 15 元的开衫。
    const anchor = pickPrice(band, tier.position);
    const bandCurrency = band.currency ?? "CNY";
    const priceCny = bandCurrency === "CNY" ? anchor : toCny(anchor, brief.fx_rub_per_cny);
    const priceRub = bandCurrency === "CNY"
      ? (Number.isFinite(brief.fx_rub_per_cny) ? Math.round(anchor * brief.fx_rub_per_cny) : null)
      : anchor;

    // 合理性闸门：一件针织开衫不可能 15 元，也不可能 5000 元。
    // 单位错了要当场炸，不能把荒谬价格写进候选。
    if (priceCny !== null && (priceCny < 30 || priceCny > 5000)) {
      throw new Error(`价格不合理：${priceCny} CNY（档位 ${tier.id}，锚点 ${anchor} ${bandCurrency}）。多半是币种换算方向错了。`);
    }

    const evidence = {
      market_size: {
        value: brief.demand?.imports_usd ?? null,
        level: "L2",
        source: "UN Comtrade",
        note: "方向级数据，不是款级数据；它证明品类有需求，不证明这个款好卖"
      },
      price_band: band
        ? {value: band, level: "candidate", source: "二手区间（平台客单价）", note: "区间来自二手，具体价位按分位推算"}
        : {value: null, level: "none", source: null, note: "价格带未取得，本候选的价格只能标\"待定\""},
      season: season
        ? {value: {cold_months: cold, hint: season.hint}, level: "L2", source: "Open-Meteo 月均气温", note: "决定上新窗口与厚度，不决定款式"}
        : {value: null, level: "none", source: null, note: "无气候数据"}
    };

    // 自我查证：把「能验」与「不能验」分开写，并给提升路径
    const verification = {
      level: priceCny ? "L1" : "L0",
      verifiable_now: [
        "品类规模（Comtrade，可复算）",
        "季节窗口（月均气温，可复算）",
        "平台必填属性与字典值（Seller API 实拉）"
      ],
      not_verifiable_now: [
        "这个款在目标市场是否好卖（缺竞品销量与评价）",
        "目标定价能否成交（缺竞品价格带）",
        "采购成本与毛利（缺 1688 实盘报价）"
      ],
      how_to_verify: [
        "竞品：从可访问 C 端的环境取样，或在卖家后台看「搜索分析」的同款价格与转化",
        "成本：按 sourcing 关键词去 1688 询价，至少 3 家取中位",
        "成交：先小批量上架 2–3 个候选，用 2 周曝光/点击/加购数据淘汰"
      ]
    };

    // 敏感性：哪个假设一破，这条候选就废
    const sensitivity = [];
    if (!band) {
      sensitivity.push({assumption: "价格带存在且可取得", if_broken: "本候选的价格与档位全部作废，只能给款式不给价"});
    } else {
      const lowEdge = band.low;
      sensitivity.push({
        assumption: `客单价区间下沿约 ${lowEdge}`,
        if_broken: `若实际主流成交价低于 ${lowEdge}，本档位（${tier.label}）没有价格空间，应退到入门档或换材质`
      });
    }
    if (cold < 5) {
      sensitivity.push({assumption: "目标市场有明确秋冬窗口", if_broken: "低温月不足 5 个月，厚针织的销售窗口过短，应改轻薄款"});
    }
    sensitivity.push({
      assumption: "供货端能按规格找到对应材质",
      if_broken: material.id === "wool"
        ? "高含毛在小单量下难拿到稳定货源，可能要退到羊毛混纺"
        : "供货正常，风险低"
    });

    return {
      id: `c${String(index + 1).padStart(2, "0")}`,
      // 档位必须进标题：不同档位可能有相同的材质与版型，不写档位就分不清两条候选
      title_cn: `${brief.direction} · ${tier.label} · ${material.label} · ${fit.label}`,
      title_ru_template: "{{brand}} {{product_type}} женский, {{material}}, {{fit}}, {{color}}",
      tier: tier.id,
      material: material.id,
      fit: fit.id,
      target_price_cny: priceCny,
      target_price_rub: priceRub,
      price_note: priceRub
        ? `${tier.label}：${priceCny} CNY / ${priceRub} RUB（锚点 ${band.anchor ?? anchor} ${bandCurrency}，汇率 ${brief.fx_rub_per_cny}）`
          + `（区间 ${band.low}–${band.high} RUB 的 ${Math.round(tier.position * 100)}% 位；区间为二手，汇率为当日）`
        : "价格待定：价格带未取得",
      season_fit: cold >= 5 ? "秋冬主推" : "过渡季",
      evidence,
      verification,
      sensitivity,
      rank_reason: `依据强度 ${scoreOf({tier, material, fit})}/9：${tier.note}；${material.note}；${fit.note}`
    };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.direction || !args.region) { usage(); process.exit(2); }
  if (!Number.isInteger(args.count) || args.count < 5 || args.count > 10) {
    console.error("--count 必须在 5–10 之间");
    process.exit(2);
  }

  const brief = await loadBrief(args.direction, args.region);
  if (!brief) {
    console.error(`没有找到方向简报。先跑：\n  npm run market:scan -- --direction "${args.direction}" --region ${args.region}`);
    process.exit(2);
  }
  if (brief.verdict?.level === "证据不足") {
    console.error(`方向「${args.direction}」在 ${args.region} 的验证结论是「证据不足」，不出候选。\n先补需求数据，不要用候选掩盖方向没验证这件事。`);
    process.exit(3);
  }

  const candidates = buildCandidates({brief, count: args.count});

  const doc = {
    direction: args.direction,
    region: args.region,
    generated_at: new Date().toISOString(),
    upstream: {
      brief_generated_at: brief.generated_at,
      verdict: brief.verdict,
      demand: brief.demand,
      season: brief.season,
      price_band_status: brief.price_band?.status ?? "unknown"
    },
    // 这一段最容易被误读成「工具知道什么好卖」，所以把边界写在最前面
    scope_note: "候选是「按已知约束枚举出的合理选项」，不是「市场验证过的爆款」。"
      + "排序依据是依据强度与差异化，不是销量预测。任何候选在拿到竞品数据前都不该单独下注。",
    count: candidates.length,
    candidates
  };

  const outDir = join(ROOT, "data", "candidates");
  await mkdir(outDir, {recursive: true});
  const outPath = join(outDir, `${args.region}-${slugOf(args.direction)}.json`);
  await writeFile(outPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");

  console.log(`方向：${args.direction} ｜ ${args.region} ｜ 候选 ${candidates.length} 个`);
  console.log(`上游结论：${brief.verdict.level} —— ${brief.verdict.reason}`);
  if (!brief.price_band || !Number.isFinite(brief.price_band.low)) console.log("⚠ 价格带未取得：候选只有款式与档位，价格标「待定」");
  console.log("");
  console.log("候选（按依据强度排序）：");
  for (const c of candidates) {
    const price = c.target_price_cny ? `${c.target_price_cny} CNY（${c.target_price_rub} RUB）` : "待定";
    console.log(`  ${c.id}  ${c.title_cn}`);
    console.log(`       ${price} ｜ ${c.season_fit} ｜ 证据等级 ${c.verification.level} ｜ ${c.rank_reason.slice(0, 40)}…`);
  }
  console.log(`\n产出：${outPath.replaceAll("\\", "/")}`);
  console.log("下一步：选 1–3 个候选往下做，其余留档；不要把 8 个全上架。");
}

if (process.argv[1] && process.argv[1].endsWith("select-candidates.mjs")) {
  main().catch((error) => { console.error(`失败：${error.message}`); process.exit(1); });
}
