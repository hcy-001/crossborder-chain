#!/usr/bin/env node
/**
 * 方向 → 市场验证。链路的第一段，先于一切选品与找货。
 *
 * 为什么需要它：原来的入口要求先有一份选品工单（里面带 1688 链接与采购价），
 * 等于「先有货，再验证市场」。这把因果搞反了 —— 卖家真正拥有的是
 * 「我想做女装开衫，卖俄罗斯」这种方向，不是一个已经选好的 SKU。
 *
 * 这个脚本只回答三个问题：
 *   1. 这个方向在目标市场有多大（进口规模、中国份额、单价）
 *   2. 什么时候卖（气候窗口 + 假日节奏）
 *   3. 值不值得往下走（结论 + 还缺什么证据）
 *
 * 它**不**回答：具体选哪一款、货源在哪、能赚多少。那些要在方向成立之后才做。
 *
 * 用法：
 *   node scripts/market-scan.mjs --direction "女士针织开衫" --region RU
 *   node scripts/market-scan.mjs --direction "连衣裙" --region RU --year 2023
 *   node scripts/market-scan.mjs --help
 */
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {fetchTrade, HS} from "../channels/source/comtrade.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 方向词 → HS 品类码。一个方向可能对应多个码，全部拉取后按规模排序。 */
const DIRECTION_HS = [
  {match: ["开衫", "毛衫", "毛衣", "针织衫", "套头", "cardigan", "свитер", "кардиган"], hs: ["6110"]},
  {match: ["连衣裙", "裙子", "半身裙", "dress", "платье", "юбка"], hs: ["6204", "6104"]},
  {match: ["衬衫", "衬衣", "shirt", "рубашка", "блузка"], hs: ["6206", "6106"]},
  {match: ["T恤", "t恤", "短袖", "tee", "футболка"], hs: ["6109"]},
  {match: ["外套", "大衣", "风衣", "coat", "пальто", "куртка"], hs: ["6202", "6102"]},
  {match: ["裤", "长裤", "trousers", "брюки", "джинсы"], hs: ["6204", "6103"]},
  {match: ["内衣", "文胸", "bra", "бельё"], hs: ["6212", "6108"]},
];

function usage() {
  console.log(`方向 → 市场验证（链路第一段，不需要先有货）

用法:
  node scripts/market-scan.mjs --direction <方向词> --region <法域码> [--year <年>]

参数:
  --direction  选品方向，中文或俄/英均可，如「女士针织开衫」
  --region     目标法域两位码，必须在 regions/ 下存在，如 RU / AE / SG
  --year       进口数据年份，默认 2023；该年无记录时自动回退到 2021 并标注
  --offline    不联网，只用已有的 data/trade/ 缓存

产出:
  data/directions/<法域>-<方向>.json   机器读
  docs/方向简报-<方向>.md              人读

退出码: 0 成功 | 2 参数或前置不成立 | 3 该方向没匹配到品类码`);
}

function parseArgs(argv) {
  const out = {direction: null, region: null, year: "2023", offline: false};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { usage(); process.exit(0); }
    else if (a === "--direction") out.direction = argv[++i];
    else if (a === "--region") out.region = argv[++i];
    else if (a === "--year") out.year = argv[++i];
    else if (a === "--offline") out.offline = true;
    else { console.error(`未知参数：${a}`); process.exit(2); }
  }
  return out;
}

/** 方向词匹配 HS 码。匹配不到就返回空数组，让调用方明确报错，不猜。 */
export function mapDirection(direction) {
  const text = String(direction || "").toLowerCase();
  const hits = new Set();
  const matchedBy = [];
  for (const rule of DIRECTION_HS) {
    if (rule.match.some((word) => text.includes(word.toLowerCase()))) {
      rule.hs.forEach((code) => hits.add(code));
      matchedBy.push(...rule.match.filter((word) => text.includes(word.toLowerCase())));
    }
  }
  return {codes: [...hits], matched_by: [...new Set(matchedBy)]};
}

async function loadRegion(region) {
  const profilePath = join(ROOT, "regions", region, "profile.json");
  try {
    return JSON.parse(await readFile(profilePath, "utf8"));
  } catch {
    return null;
  }
}

async function loadSeason(region) {
  // 气候与假日由 probe-region-calendar 落盘，这里只读结果，不联网重抓
  const path = join(ROOT, "data", "specs", "regions", `${region}.json`);
  try {
    const doc = JSON.parse(await readFile(path, "utf8"));
    const facts = Array.isArray(doc?.facts) ? doc.facts : [];
    const find = (suffix) => facts.find((f) => String(f.key || "").endsWith(suffix)) ?? null;
    return {
      climate: find(".climate")?.value ?? null,
      holidays: find(".holidays")?.value ?? null
    };
  } catch {
    return {climate: null, holidays: null};
  }
}

function money(usd) {
  if (usd === null || usd === undefined) return "—";
  return usd >= 1e9 ? `$${(usd / 1e9).toFixed(2)}B` : `$${(usd / 1e6).toFixed(0)}M`;
}

/** 季节窗口：从月均气温推「什么月份卖什么厚度」。没有气候数据就明说没有。 */
function seasonWindow(climate) {
  const monthly = climate?.monthly_mean_c?.length ? climate.monthly_mean_c : null;
  if (!monthly) return null;
  const cold = monthly.filter((t) => t <= 5).length;
  const warm = monthly.filter((t) => t >= 20).length;
  return {
    monthly_mean_c: monthly,
    cold_months: cold,
    warm_months: warm,
    hint: cold >= 5
      ? "低温月 ≥5，秋冬是主战场；针织/厚料的上新窗口在 8–10 月"
      : warm >= 6
        ? "高温月 ≥6，轻薄料为主；针织类只做过渡季与空调场景"
        : "四季温和，靠款式而非厚度驱动"
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.direction || !args.region) { usage(); process.exit(2); }

  const profile = await loadRegion(args.region);
  if (!profile) { console.error(`法域不存在：regions/${args.region}/profile.json`); process.exit(2); }

  const {codes, matched_by} = mapDirection(args.direction);
  if (codes.length === 0) {
    console.error(`「${args.direction}」没有匹配到 HS 品类码。\n`
      + `已收录的方向词：${DIRECTION_HS.flatMap((r) => r.match).join(" / ")}\n`
      + `新增方向请在 scripts/market-scan.mjs 的 DIRECTION_HS 里加一条，不要猜码。`);
    process.exit(3);
  }

  const rows = [];
  for (const hs of codes) {
    let r = {available: false};
    if (!args.offline) {
      r = await fetchTrade({country: args.region, hs, year: args.year});
      if (!r?.available && args.year !== "2021") {
        // 该年无记录（俄罗斯 2022 起不报明细）→ 回退 2021，并把实际年份写进结果
        const fallback = await fetchTrade({country: args.region, hs, year: "2021"});
        if (fallback?.available) r = {...fallback, fallback_from: args.year};
      }
      await new Promise((done) => setTimeout(done, 1200));
    }
    rows.push({hs, desc: HS[hs] ?? null, ...r});
  }

  const usable = rows.filter((r) => r.available && r.import_value_usd);
  usable.sort((a, b) => b.import_value_usd - a.import_value_usd);
  const top = usable[0] ?? null;

  const season = await loadSeason(args.region);
  const window = seasonWindow(season.climate);

  // 汇率从已落盘的 fx 数据读，不在脚本里写死数字
  let fxRate = null;
  try {
    const fx = JSON.parse(await readFile(join(ROOT, "data", "variables", "fx.json"), "utf8"));
    // fx.json 是 [{key:"fx.USD_RUB", value:80.55, unit:"RUB/USD"}, ...]
    // 没有直接的 RUB/CNY，用两条 USD 交叉相除
    const rows = Array.isArray(fx) ? fx : [];
    const pick = (key) => Number(rows.find((r) => r.key === key)?.value);
    const rub = pick("fx.USD_RUB");
    const cny = pick("fx.USD_CNY");
    if (Number.isFinite(rub) && Number.isFinite(cny) && cny > 0) {
      fxRate = Math.round((rub / cny) * 100) / 100;
    }
  } catch {
    fxRate = null;
  }

  // 结论分三档，不写「建议做」这种空话：只说证据够不够、缺什么
  let verdict;
  if (!top) {
    verdict = {level: "证据不足", reason: "该方向在目标市场的进口记录没拿到，不能判断规模"};
  } else if (top.import_value_usd >= 5e8 && (top.china_share_pct ?? 0) >= 20) {
    verdict = {
      level: "方向成立",
      reason: `进口 ${money(top.import_value_usd)}、中国占 ${top.china_share_pct}%，说明需求真实存在且中国货已是主力供应`
    };
  } else if (top.import_value_usd >= 1e8) {
    verdict = {level: "方向可试", reason: `进口 ${money(top.import_value_usd)}，规模中等；要更细的品类切分才能判断`};
  } else {
    verdict = {level: "方向偏小", reason: `进口仅 ${money(top.import_value_usd)}，单品难撑起一条线`};
  }

  const doc = {
    direction: args.direction,
    region: args.region,
    generated_at: new Date().toISOString(),
    hs: {codes, matched_by},
    demand: top
      ? {
        hs: top.hs, desc: top.desc,
        imports_usd: top.import_value_usd,
        net_weight_kg: top.net_weight_kg ?? null,
        china_share_pct: top.china_share_pct ?? null,
        unit_price_usd_per_kg: top.unit_price_usd_per_kg ?? null,
        year: top.year ?? null,
        requested_year: top.requested_year ?? args.year,
        source: "un-comtrade",
        source_url: top.source_url ?? null,
        level: "L2"
      }
      : {status: "unavailable", level: "none"},
    alternatives: usable.slice(1).map((r) => ({hs: r.hs, imports_usd: r.import_value_usd})),
    season: window,
    calendar: season.holidays ? {holidays: season.holidays} : null,
    // 价格带：C 端竞品数据拿不到，但平台客单价区间是公开可查的二手数据。
    // 标 candidate，并且给「区间」而不是一个点 —— 区间能承载不确定性，单点会假装精确。
    price_band: {
      status: "candidate",
      low: 800,
      high: 3000,
      currency: "RUB",
      scope: "服饰鞋靴类目整体（非本方向专有）",
      source: "平台客单价区间（二手汇总）",
      level: "candidate",
      reason: "C 端竞品搜索页对本机 IP 拒绝，取不到款级价格；只能用类目级客单价区间做锚点",
      how_to_get: "卖家后台「搜索分析 / 关键词报告」，或从可访问 C 端的网络环境取样同款价格"
    },
    // 候选段要算卢布价，汇率单独给，来源是仓库里已落盘的 fx 数据
    fx_rub_per_cny: fxRate,
    verdict,
    // 这一段是「回国内反查」的输入：方向成立后，拿这些词去 1688 找货
    sourcing: {
      note: "方向成立后才做这一步；此前不需要任何货源",
      keywords_for_1688: [
        args.direction,
        ...(top?.desc ? [top.desc.split("、")[0]] : [])
      ],
      spec_hints: window?.cold_months >= 5 ? ["秋冬厚度", "含毛量", "克重"] : ["轻薄", "透气"]
    }
  };

  const slug = Buffer.from(args.direction).toString("hex").slice(0, 12);
  const outDir = join(ROOT, "data", "directions");
  await mkdir(outDir, {recursive: true});
  const outPath = join(outDir, `${args.region}-${slug}.json`);
  await writeFile(outPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");

  console.log(`方向：${args.direction} ｜ 法域：${args.region}`);
  console.log(`品类码：${codes.join(" / ")}（由「${matched_by.join("、")}」匹配）`);
  if (top) {
    console.log(`需求：进口 ${money(top.import_value_usd)}（${top.year} 年）`
      + `｜中国占 ${top.china_share_pct ?? "—"}%｜单价 $${top.unit_price_usd_per_kg ?? "—"}/kg`);
  } else {
    console.log("需求：未取到");
  }
  console.log(`季节：${window?.hint ?? "无气候数据"}`);
  console.log(`价格带：${doc.price_band.low}–${doc.price_band.high} ${doc.price_band.currency}（${doc.price_band.level}，类目级）`);
  console.log(`结论：${verdict.level} —— ${verdict.reason}`);
  console.log(`\n产出：${outPath.replaceAll("\\", "/")}`);
  console.log(`下一步：${verdict.level === "证据不足" ? "先补需求数据" : "拿 sourcing.keywords_for_1688 去反查货源，而不是反过来"}`);
}

if (process.argv[1] && process.argv[1].endsWith("market-scan.mjs")) {
  main().catch((error) => { console.error(`失败：${error.message}`); process.exit(1); });
}
