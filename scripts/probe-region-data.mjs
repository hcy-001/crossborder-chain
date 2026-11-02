#!/usr/bin/env node
/**
 * 地区底数采集：把 9 个法域的宏观数据拉下来，存成可复算的事实。
 *
 * 为什么不能靠"记忆里的市场概况"：跨境选品最贵的错误是按印象判断市场大小。
 * 世界银行是唯一能覆盖全部 9 个法域、口径统一、还免费公开的来源。
 *
 * 用法：
 *   node scripts/probe-region-data.mjs [--year 2023] [--offline]
 *
 * 产出：
 *   data/specs/regions/<CC>.json   每个法域一份事实（带 source_url / fetched_at / status）
 *   docs/市场底数.md               人读表
 *
 * 纪律：
 *   - 缺数据就是缺，写 null 并标 status=unverified，不用别国或往年顶替；
 *   - 只做国别需求侧底数，不声称是平台销量或品类规模。
 */
import {mkdir, readdir, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {INDICATORS, fetchIndicator} from "../channels/source/worldbank.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? true) : fallback;
};
const offline = args.includes("--offline");

// 法域码 → ISO3。分开写是因为两个体系不同名（AE≠ARE、SA≠SAU），猜会错。
const ISO3 = {AE: "ARE", SA: "SAU", SG: "SGP", MY: "MYS", TH: "THA", PH: "PHL", ID: "IDN", VN: "VNM", RU: "RUS"};

const regionDirs = (await readdir(join(ROOT, "regions"), {withFileTypes: true}))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const missingIso = regionDirs.filter((region) => !ISO3[region]);
if (missingIso.length > 0) {
  console.error(`这些法域没有登记 ISO3，无法取数：${missingIso.join(", ")}`);
  process.exit(2);
}

const year = String(flag("year", "2023"));
const fetchedAt = new Date().toISOString();
const collected = new Map(regionDirs.map((region) => [region, []]));
const diagnostics = [];

if (!offline) {
  for (const indicator of INDICATORS) {
    try {
      const result = await fetchIndicator({
        countries: regionDirs.map((region) => ISO3[region]),
        indicator: indicator.code,
        year
      });
      const byIso = new Map(result.rows.map((row) => [row.iso3, row]));
      for (const region of regionDirs) {
        const row = byIso.get(ISO3[region]) ?? null;
        const hasValue = row && Number.isFinite(row.value);
        collected.get(region).push({
          key: indicator.key,
          value: hasValue ? row.value : null,
          unit: indicator.unit,
          year: row?.year ?? Number(year),
          scope: {region, platform: null, category: null},
          source: "worldbank",
          source_url: result.source_url,
          source_type: "official",
          confidence: hasValue ? "official" : "unverified",
          status: hasValue ? "final" : "unverified",
          conflict_id: null,
          fetched_at: fetchedAt,
          ttl_hours: 8760,
          stale: false,
          cross_check: [],
          divergence_pct: null,
          override: null,
          note: hasValue ? `${indicator.label}；世界银行口径，${result.last_updated ? `数据更新于 ${result.last_updated}` : "更新时间未知"}` : `${indicator.label}：该年无数据，未用他年或他国顶替`
        });
      }
      diagnostics.push(`${indicator.code} ok（${result.rows.filter((row) => Number.isFinite(row.value)).length}/${regionDirs.length} 有值）`);
      await new Promise((done) => setTimeout(done, 400));
    } catch (error) {
      diagnostics.push(`${indicator.code} 失败：${error.message}`);
      for (const region of regionDirs) {
        collected.get(region).push({
          key: indicator.key,
          value: null,
          unit: indicator.unit,
          year: Number(year),
          scope: {region, platform: null, category: null},
          source: "worldbank",
          source_url: "https://api.worldbank.org/v2",
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
    }
  }
}

// 补齐：即使某指标全失败，也要给每个法域留下一条可读的"缺什么"。
for (const region of regionDirs) {
  const facts = collected.get(region) ?? [];
  if (facts.length === 0) {
    facts.push({
      key: "region.data_status",
      value: offline ? "not_probed" : "unavailable",
      unit: "state",
      year: Number(year),
      scope: {region, platform: null, category: null},
      source: "worldbank",
      source_url: "https://api.worldbank.org/v2",
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
      note: "本次未取到任何指标"
    });
  }
  const coverage = facts.filter((fact) => fact.status === "final").length;
  await mkdir(join(ROOT, "data/specs/regions"), {recursive: true});
  await writeFile(
    join(ROOT, "data/specs/regions", `${region}.json`),
    `${JSON.stringify({region, as_of: fetchedAt, source: "worldbank", covered: coverage, total: facts.length, facts}, null, 2)}\n`,
    "utf8"
  );
}

// 人读表
const lines = [
  "# 市场底数（脚本生成，勿手改）",
  "",
  `采集时间：${fetchedAt}　数据年：${year}　来源：世界银行开放 API`,
  "",
  "> 这是**国别需求侧底数**，不是平台销量、也不是品类规模。用它做\"该不该进这个市场\"的初筛；",
  "> 拿它当\"这个类目能卖多少\"会错 —— 品类规模必须另外取（平台数据或第三方报告）。",
  "",
  "| 法域 | 人口 | 人均 GDP | 互联网渗透 | 城镇化 | 人均家庭消费 | 女性劳动参与 | 覆盖 |",
  "|---|---|---|---|---|---|---|---|"
];
const fmt = (value, unit) => {
  if (value === null || value === undefined) return "—";
  if (unit === "person") return `${(value / 1e6).toFixed(2)} 百万`;
  if (unit === "%") return `${value.toFixed(1)}%`;
  if (unit === "USD/person") return `$${Math.round(value).toLocaleString("en-US")}`;
  return value.toFixed(1);
};
for (const region of regionDirs) {
  const facts = collected.get(region) ?? [];
  const get = (key) => facts.find((fact) => fact.key === key);
  const cell = (key) => {
    const fact = get(key);
    return fact ? fmt(fact.value, fact.unit) : "—";
  };
  const covered = facts.filter((fact) => fact.status === "final").length;
  lines.push(`| ${region} | ${cell("region.population")} | ${cell("region.gdp_per_capita")} | ${cell("region.internet_users")} | ${cell("region.urban_population")} | ${cell("region.household_consumption_pc")} | ${cell("region.female_labor_participation")} | ${covered}/${facts.length} |`);
}
lines.push(
  "",
  "## 怎么读",
  "",
  "- **人均 GDP / 人均家庭消费**：决定可接受的价格带。跨境女装在新兴市场的成交价通常落在人均月消费的一个小比例区间，",
  "  这个比例必须用真实成交校准，不要用宏观数字直接推售价。",
  "- **互联网渗透 / 城镇化**：决定电商可达人口上限，也决定物流密度（城镇化低 → 末端配送贵、时效长）。",
  "- **女性劳动参与率**：女装品类的需求侧参考之一（通勤/职业场景占比），不是因果结论。",
  "- 缺失值一律写 `—`，来源文件里是 `null` + `status=unverified`，不用他年或他国数据顶替。",
  "",
  "## 复跑",
  "",
  "```bash",
  "npm run region:data            # 拉当年数据",
  "npm run region:data -- --year 2022",
  "```"
);
await writeFile(join(ROOT, "docs/市场底数.md"), `${lines.join("\n")}\n`, "utf8");

console.log(`法域 ${regionDirs.length} 个 · 指标 ${INDICATORS.length} 个`);
for (const item of diagnostics) console.log(`  ${item}`);
for (const region of regionDirs) {
  const facts = collected.get(region) ?? [];
  const covered = facts.filter((fact) => fact.status === "final").length;
  console.log(`  [${region}] ${covered}/${facts.length} 有值`);
}
