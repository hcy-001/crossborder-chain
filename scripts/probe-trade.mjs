#!/usr/bin/env node
/**
 * 品类规模采集：用 UN Comtrade 公开接口，把「这一类货在当地一年进口多少、中国占多少」拉下来。
 *
 * 为什么要这一层：宏观底数（人口/GDP）只回答"这个国家大不大"，
 * 回答不了"我这类货在这里有没有生意"。进口额、进口重量、中国份额、单价这四项才回答得了。
 *
 * 用法：
 *   node scripts/probe-trade.mjs [--year 2023] [--hs 6204,6104] [--offline]
 *
 * 产出：
 *   data/trade/<CC>.json   每国一份（含分伙伴国 Top8，可复核）
 *   docs/品类规模.md       人读表
 *
 * 纪律：
 *   - 这是**进口报关额**，不是零售规模；换算件数属于估算，不许标成实测
 *   - 某年某编码无记录就写 null 并说明原因（俄罗斯 2022 后不报明细），不用邻国顶替
 */
import {mkdir, readdir, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {HS, fetchTrade} from "../channels/source/comtrade.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? true) : fallback;
};
const offline = args.includes("--offline");

const year = String(flag("year", "2023"));
// 报告国可能某年不报明细（俄罗斯 2022 起停报）。这里允许按序回退到更早年份，
// 但**必须把实际年份写进结果**，否则等于把 2021 的数说成 2023 的。
const fallbackYears = String(flag("fallback-years", "2021")).split(",").map((item) => item.trim()).filter(Boolean);
// 默认只拉女装两个主编码：外套裙裤（非针织/针织）。全量 7 个编码会被限流拖到十几分钟，
// 需要更细时用 --hs 指定。
const hsList = String(flag("hs", "6204,6104")).split(",").map((item) => item.trim()).filter(Boolean);
const badHs = hsList.filter((hs) => !HS[hs]);
if (badHs.length > 0) {
  console.error(`未登记的 HS 编码：${badHs.join(", ")}（见 channels/source/comtrade.mjs 的 HS）`);
  process.exit(2);
}

const regionDirs = (await readdir(join(ROOT, "regions"), {withFileTypes: true}))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const fetchedAt = new Date().toISOString();
const byRegion = new Map(regionDirs.map((region) => [region, []]));
const diagnostics = [];

if (!offline) {
  for (const hs of hsList) {
    for (const region of regionDirs) {
      let result = await fetchTrade({country: region, hs, year});
      // 目标年无记录时按 fallback 年份重试；成功的年份会留在 result.year 里，随数据一起交付。
      for (const alt of fallbackYears) {
        if (result.available) break;
        await new Promise((done) => setTimeout(done, 1200));
        const retry = await fetchTrade({country: region, hs, year: alt});
        if (retry.available) {
          result = {...retry, note: `目标年 ${year} 无记录，采用 ${alt} 年数据（同源，年份差异已标注）`, requested_year: Number(year)};
          break;
        }
      }
      byRegion.get(region).push(result);
      if (!result.available) diagnostics.push(`${region} ${hs}：${result.note ?? "无数据"}`);
      console.log(
        `${region} ${hs} ${result.available ? "OK  " : "MISS"} `
        + `${result.import_value_usd === null ? "-" : `${(result.import_value_usd / 1e6).toFixed(1)}M`} `
        + `y=${result.year} CN%=${result.china_share_pct ?? "-"} $/kg=${result.unit_price_usd_per_kg ?? "-"} ${result.note ?? ""}`
      );
      // 公开接口约 1 次/秒，硬等一手，免得触发 429 后靠重试把整轮拖长
      await new Promise((done) => setTimeout(done, 1200));
    }
  }
}

await mkdir(join(ROOT, "data", "trade"), {recursive: true});
for (const region of regionDirs) {
  const rows = byRegion.get(region);
  await writeFile(
    join(ROOT, "data", "trade", `${region}.json`),
    `${JSON.stringify({region, year, as_of: fetchedAt, source: "un-comtrade-preview", rows}, null, 2)}\n`,
    "utf8"
  );
}

// ── 人读表 ────────────────────────────────────────────────
const lines = [];
lines.push(`# 品类规模（UN Comtrade 进口口径，${year} 年）`, "");
lines.push("> 这是**进口报关额**，不是当地零售规模；单位美元与公斤。");
lines.push("> 单价（$/kg）用来判断价格带，不能直接换算成\"每件多少钱\"——那需要单件净重，属估算。");
lines.push("> 数据源：UN Comtrade 公开预览接口，免 key。某国某年无记录会写明原因，不用邻国顶替。", "");
for (const hs of hsList) {
  lines.push(`## HS ${hs} · ${HS[hs]}`, "");
  lines.push("| 法域 | 进口额 | 进口净重 | 中国份额 | 单价 $/kg | 数据年份 | 数据状态 |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const region of regionDirs) {
    const row = byRegion.get(region).find((item) => item.hs === hs);
    if (!row) continue;
    const money = row.import_value_usd === null ? "—" : `$${(row.import_value_usd / 1e6).toFixed(1)}M`;
    const weight = row.net_weight_kg === null ? "—" : `${(row.net_weight_kg / 1e6).toFixed(2)} 万吨`;
    const share = row.china_share_pct === null ? "—" : `${row.china_share_pct}%`;
    const price = row.unit_price_usd_per_kg === null ? "—" : `$${row.unit_price_usd_per_kg}`;
    const yearCell = row.requested_year && row.requested_year !== row.year ? `${row.year}（目标 ${row.requested_year} 无记录）` : String(row.year);
    lines.push(`| ${region} | ${money} | ${weight} | ${share} | ${price} | ${yearCell} | ${row.available ? "L2 实测" : `缺：${row.note ?? "无数据"}`} |`);
  }
  lines.push("");
}
if (diagnostics.length > 0) {
  lines.push("## 缺口与原因", "");
  for (const item of diagnostics) lines.push(`- ${item}`);
  lines.push("");
}
lines.push("## 怎么读这张表", "");
lines.push("- **进口额大 + 中国份额高**：货已经在那里，竞争是价格与款式，不是市场教育。");
lines.push("- **进口额大 + 中国份额低**：要么有本地供给，要么有关税/合规门槛，值得先查门槛。");
lines.push("- **单价高**：能吃中高价位，但要注意当地购买力（见 `docs/市场底数.md`）。");
lines.push("- **单价低**：只能做量，毛利率会被物流吃掉，必须验证运费（见定价明细）。");
lines.push("");

await writeFile(join(ROOT, "docs", "品类规模.md"), `${lines.join("\n")}\n`, "utf8");

console.log(`\n落盘 data/trade/*.json（${regionDirs.length} 国）与 docs/品类规模.md`);
if (diagnostics.length > 0) {
  console.log(`缺口 ${diagnostics.length} 项（已写进文档，未用替代数据填补）`);
}
