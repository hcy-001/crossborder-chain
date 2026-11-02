#!/usr/bin/env node
/**
 * 地区时间维度采集：公共假日 + 月均气温/降水，合并进 data/specs/regions/<CC>.json。
 *
 * 用法：
 *   node scripts/probe-region-calendar.mjs [--year 2026] [--climate-year 2025]
 *
 * 为什么气温用"去年实测"而不是常年平均：ERA5 日值可得，自己聚合能算出年温差，
 * 而年温差直接决定"这个市场能不能卖厚外套"，这是选款的第一步。
 */
import {readFile, mkdir, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {fetchClimate, fetchHolidays as fetchHolidaysNager} from "../channels/source/region-calendar.mjs";
import {fetchHolidays as fetchHolidaysGoogle} from "../channels/source/google-holidays.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};

const holidayYear = Number(flag("year", new Date().getFullYear() + 1));
const climateYear = Number(flag("climate-year", new Date().getFullYear() - 1));

/** 首都/主要城市坐标：决定气候取数点位。这里选的是人口与物流最集中的城市。 */
/** 假日库没收录的国家，写清去哪个官方机构取，别只留一句"无数据"。 */
const HOLIDAY_SOURCE_HINT = {
  MY: "马来西亚政府 MyGov / 内阁（kabinet.gov.my）年度公共假期表",
  TH: "泰国央行（Bank of Thailand）金融机构假日公告",
  AE: "阿联酋内阁（u.ae）官方公共假日公告",
  SA: "沙特人力资源与社会发展部（hrsd.gov.sa）官方假日公告"
};

const PLACES = {
  SG: {lat: 1.3521, lon: 103.8198, tz: "Asia/Singapore", city: "Singapore"},
  MY: {lat: 3.1390, lon: 101.6869, tz: "Asia/Kuala_Lumpur", city: "Kuala Lumpur"},
  TH: {lat: 13.7563, lon: 100.5018, tz: "Asia/Bangkok", city: "Bangkok"},
  PH: {lat: 14.5995, lon: 120.9842, tz: "Asia/Manila", city: "Manila"},
  ID: {lat: -6.2088, lon: 106.8456, tz: "Asia/Jakarta", city: "Jakarta"},
  VN: {lat: 21.0278, lon: 105.8342, tz: "Asia/Ho_Chi_Minh", city: "Hanoi"},
  AE: {lat: 24.4539, lon: 54.3773, tz: "Asia/Dubai", city: "Abu Dhabi"},
  SA: {lat: 24.7136, lon: 46.6753, tz: "Asia/Riyadh", city: "Riyadh"},
  RU: {lat: 55.7558, lon: 37.6173, tz: "Europe/Moscow", city: "Moscow"}
};

const fetchedAt = new Date().toISOString();
const rows = [];

for (const [region, place] of Object.entries(PLACES)) {
  const facts = [];
  // 主源用 Google 官方假日日历（覆盖 9/9），Nager 作为交叉核对：
  // Nager 只收 5 国，单靠它会把 MY/TH/AE/SA 的缺失说成"没有假日"。
  let holidays = {available: false, note: "未采集"};
  let holidaySource = null;
  try {
    holidays = await fetchHolidaysGoogle({country: region, year: holidayYear});
    holidaySource = "google-calendar-official";
  } catch (error) {
    holidays = {available: false, note: `取数失败：${error.message}`};
  }
  let crossCheck = null;
  if (holidays.available) {
    try {
      const nager = await fetchHolidaysNager({country: region, year: holidayYear});
      if (nager.available) {
        crossCheck = {
          source: "nager.date",
          value: nager.days.length,
          agree: Math.abs(nager.days.length - holidays.days.length) <= 3,
          note: `Nager 记 ${nager.days.length} 天，Google 记 ${holidays.days.length} 天`
        };
      }
    } catch {
      crossCheck = null;
    }
  }
  if (!holidays.available) {
    try {
      const fallback = await fetchHolidaysNager({country: region, year: holidayYear});
      if (fallback.available) {
        holidays = fallback;
        holidaySource = "nager.date";
      }
    } catch {
      // 两个源都不行：保持 unavailable，note 里已有原因
    }
  }
  facts.push({
    key: "region.holidays",
    value: holidays.available
      ? holidays.days.map((day) => ({date: day.date, name: day.name, local_name: day.local_name}))
      : null,
    unit: "calendar",
    year: holidayYear,
    scope: {region, platform: null, category: null},
    source: holidaySource ?? "google-calendar-official",
    source_url: holidays.source_url ?? null,
    source_type: holidays.available ? "official" : "secondary",
    confidence: holidays.available ? "official-aggregator" : "unverified",
    status: holidays.available ? "final" : "unverified",
    conflict_id: null,
    fetched_at: fetchedAt,
    ttl_hours: 8760,
    stale: false,
    cross_check: crossCheck ? [crossCheck] : [],
    divergence_pct: null,
    override: null,
    note: holidays.available
      ? `公共假日 ${holidays.days.length} 天（全国 ${holidays.national_count ?? "?"} / 州级 ${holidays.regional_count ?? "?"}）；用于排产与上新节奏。`
        + `${crossCheck ? `已与 Nager 交叉核对：${crossCheck.note}` : "无第二源核对"}`
      : `${holidays.note ?? "无数据"}${HOLIDAY_SOURCE_HINT[region] ? `；官方去处：${HOLIDAY_SOURCE_HINT[region]}` : ""}；不得用邻国假日顶替`
  });

  let climate = null;
  try {
    climate = await fetchClimate({
      latitude: place.lat,
      longitude: place.lon,
      year: climateYear,
      timezone: place.tz
    });
  } catch (error) {
    climate = null;
    facts.push({
      key: "region.climate",
      value: null,
      unit: "monthly-mean-c",
      year: climateYear,
      scope: {region, platform: null, category: null},
      source: "open-meteo",
      source_url: "https://archive-api.open-meteo.com/v1/archive",
      source_type: "official",
      confidence: "unverified",
      status: "unverified",
      conflict_id: null,
      fetched_at: fetchedAt,
      ttl_hours: 1,
      stale: true,
      cross_check: [],
      divergence_pct: null,
      override: null,
      note: `取数失败：${error.message}`
    });
  }
  if (climate) {
    const hasClimate = climate.monthly_mean_c.some((value) => value !== null);
    facts.push({
      key: "region.climate",
      value: hasClimate
        ? {city: place.city, monthly_mean_c: climate.monthly_mean_c, monthly_precip_mm: climate.monthly_precip_mm, annual_range_c: climate.annual_range_c}
        : null,
      unit: "monthly-mean-c",
      year: climateYear,
      scope: {region, platform: null, category: null},
      source: "open-meteo-era5",
      source_url: climate.source_url,
      source_type: "official",
      confidence: hasClimate ? "official" : "unverified",
      status: hasClimate ? "final" : "unverified",
      conflict_id: null,
      fetched_at: fetchedAt,
      ttl_hours: 8760,
      stale: false,
      cross_check: [],
      divergence_pct: null,
      override: null,
      note: hasClimate
        ? `${place.city} ${climateYear} 年日值聚合成月均；年温差 ${climate.annual_range_c}℃ 决定厚外套是否可卖`
        : "该点位无有效日值"
    });
  }

  // 合并进既有法域文件：只替换同名 key，其余事实（世界银行指标）原样保留。
  const file = join(ROOT, "data/specs/regions", `${region}.json`);
  let existing = {region, facts: []};
  try {
    existing = JSON.parse(await readFile(file, "utf8"));
  } catch {
    existing = {region, as_of: fetchedAt, source: "mixed", covered: 0, total: 0, facts: []};
  }
  const byKey = new Map((existing.facts ?? []).map((fact) => [fact.key, fact]));
  for (const fact of facts) byKey.set(fact.key, fact);
  const merged = [...byKey.values()].sort((left, right) => String(left.key).localeCompare(String(right.key)));
  await mkdir(join(ROOT, "data/specs/regions"), {recursive: true});
  await writeFile(file, `${JSON.stringify({
    ...existing,
    as_of: fetchedAt,
    covered: merged.filter((fact) => fact.status === "final").length,
    total: merged.length,
    facts: merged
  }, null, 2)}\n`, "utf8");

  rows.push({
    region,
    city: place.city,
    holidays: holidays.available ? holidays.days.length : 0,
    holidayNote: holidays.available ? "" : (holidays.note ?? ""),
    range: climate?.annual_range_c ?? null,
    monthly: climate?.monthly_mean_c ?? []
  });
  await new Promise((done) => setTimeout(done, 350));
}

const lines = [
  "# 地区日历与气候（脚本生成，勿手改）",
  "",
  `采集时间：${fetchedAt}　假日年：${holidayYear}　气候年：${climateYear}`,
  "",
  "> 服装是跟着天气和节日卖的品类：年温差决定能卖多厚，假日决定什么时候上新、什么时候物流会停。",
  "",
  "| 法域 | 取数城市 | 公共假日 | 年温差℃ | 1月 | 4月 | 7月 | 10月 |",
  "|---|---|---|---|---|---|---|---|"
];
const cell = (value) => (value === null || value === undefined ? "—" : `${value}`);
for (const row of rows) {
  const m = row.monthly;
  lines.push(`| ${row.region} | ${row.city} | ${row.holidays || (row.holidayNote ? "无数据" : "0")} | ${cell(row.range)} | ${cell(m[0])} | ${cell(m[3])} | ${cell(m[6])} | ${cell(m[9])} |`);
}
lines.push(
  "",
  "## 怎么用这两列",
  "",
  "- **年温差**：< 8℃ 的市场卖不了羽绒/厚呢；> 20℃ 的市场必须做四季分层，同一件货不能全年挂。",
  "- **月均气温**：决定上新月份。热带市场没有换季窗口，靠节日和大促造节奏。",
  "- **公共假日**：既是销售节点也是物流停摆日；跨境的备货截止日通常比假日早 2–4 周。",
  "- 假日库未收录的国家写「无数据」，不拿邻国替代 —— 去官方公报补，或标 unverified。",
  "",
  "## 复跑",
  "",
  "```bash",
  "npm run region:calendar",
  "npm run region:calendar -- --year 2027 --climate-year 2025",
  "```"
);
await writeFile(join(ROOT, "docs/地区日历与气候.md"), `${lines.join("\n")}\n`, "utf8");

console.log(`法域 ${rows.length} 个`);
for (const row of rows) {
  console.log(`  [${row.region}] 假日 ${row.holidays || row.holidayNote || 0} · 年温差 ${row.range ?? "—"}℃ · ${row.city}`);
}
