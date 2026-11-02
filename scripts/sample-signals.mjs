#!/usr/bin/env node
/**
 * 人工取样 → 选品工单。
 *
 * 为什么需要这个：非俄法域（AE/SA/SG/MY/TH/PH/ID/VN）没有合规的公开趋势接口，
 * 实测过的源要么 403 要么要登录。与其写一个跑不起来的采集器，不如把"人工抄 20 条"
 * 这件事做成一条命令 —— 抄完就是可消费的工单，链路其余部分照跑。
 *
 * 用法：
 *   node scripts/sample-signals.mjs --region AE --platform noon --file samples.csv \
 *     [--out data/export/sourcing/AE] [--rate 0.52] [--dry]
 *
 * 输入 CSV 表头（中英都认，大小写与空格不敏感）：
 *   名称/标题/title       必填
 *   链接/url            选填（没有就留空，工单会标 unverified）
 *   价格/price          选填
 *   币种/currency       选填（给了价格就必须给币种，否则不换算）
 *   评价数/reviews      选填
 *   销量/sales          选填（平台页面看到的线索，不要求精确）
 *
 * 纪律：
 *   - 不补数字。缺列就是 null，不写 0；
 *   - 每条都带 source 三件套：manual_sample / 采样时间 / 原链接；
 *   - 汇率只做乘除，不在本地查（查汇率要联网，属于另一条通道）。
 */
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? true) : fallback;
};

const region = flag("region");
const platform = flag("platform");
const file = flag("file");
const rate = flag("rate");
const dry = args.includes("--dry");

if (!region || region === true || !platform || platform === true || !file || file === true) {
  console.error("用法：node scripts/sample-signals.mjs --region <CC> --platform <name> --file <csv> [--out <dir>] [--rate <target per CNY>] [--dry]");
  process.exit(2);
}

const HEADER_ALIASES = {
  name: ["名称", "标题", "title", "name", "商品名称"],
  url: ["链接", "url", "offer_url", "链接地址"],
  price: ["价格", "price", "售价"],
  currency: ["币种", "currency", "货币"],
  reviews: ["评价数", "评价", "reviews", "评论数"],
  sales: ["销量", "sales", "已售"]
};

function splitCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else cell += char;
  }
  cells.push(cell);
  return cells.map((item) => item.trim());
}

const text = (await readFile(resolve(process.cwd(), String(file)), "utf8")).replace(/^\uFEFF/, "");
const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
if (lines.length < 2) {
  console.error("CSV 里没有数据行（只有表头或空文件）");
  process.exit(2);
}

const header = splitCsvLine(lines[0]).map((cell) => cell.toLowerCase());
const columnOf = (key) => {
  for (const alias of HEADER_ALIASES[key]) {
    const index = header.indexOf(alias.toLowerCase());
    if (index >= 0) return index;
  }
  return -1;
};
const columns = Object.fromEntries(Object.keys(HEADER_ALIASES).map((key) => [key, columnOf(key)]));
if (columns.name < 0) {
  console.error(`表头里找不到名称列（可用：${HEADER_ALIASES.name.join(" / ")}）`);
  process.exit(2);
}

const slugify = (value) => String(value)
  .toLowerCase()
  .replace(/[^a-z0-9\u0400-\u04ff]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 48) || "item";

const rateValue = rate === null || rate === true ? null : Number(rate);
const sampledAt = new Date().toISOString();
const tickets = [];
const problems = [];

lines.slice(1).forEach((line, rowIndex) => {
  const cells = splitCsvLine(line);
  const pick = (key) => (columns[key] >= 0 ? String(cells[columns[key]] ?? "").trim() : "");
  const name = pick("name");
  if (!name) {
    problems.push(`第 ${rowIndex + 2} 行没有名称，已跳过`);
    return;
  }
  const currency = pick("currency") || null;
  const rawPrice = pick("price").replace(/[^0-9.\-]/g, "");
  const priceLocal = rawPrice === "" ? null : Number(rawPrice);
  let priceCny = null;
  let priceNote = null;
  if (priceLocal === null) {
    priceNote = "采样时没抄价格";
  } else if (!currency) {
    priceNote = "有价格但没写币种，不换算";
  } else if (currency === "CNY") {
    priceCny = priceLocal;
  } else if (Number.isFinite(rateValue) && rateValue > 0) {
    priceCny = Math.round((priceLocal / rateValue) * 100) / 100;
  } else {
    priceNote = `缺汇率（1 CNY = ? ${currency}），价格保留原币但未折算`;
  }

  const url = pick("url") || null;
  const reviews = pick("reviews").replace(/[^0-9]/g, "");
  const sales = pick("sales").replace(/[^0-9]/g, "");
  const slug = `${slugify(name)}-${rowIndex + 1}`;

  tickets.push({
    kind: "sourcing_ticket",
    schema_version: 1,
    slug,
    name,
    offer_url: url,
    price_cny: priceCny,
    price_local: priceLocal,
    currency,
    price_note: priceNote,
    weight_g: null,
    reviews: reviews === "" ? null : Number(reviews),
    sales_clue: sales === "" ? null : Number(sales),
    trend_score: null,
    source: {
      type: "manual_sample",
      region,
      platform,
      sampled_at: sampledAt,
      url,
      how: "人工在平台搜索结果页抄录，未使用爬虫"
    },
    confidence: url ? "secondary" : "unverified",
    note: url
      ? "来源为平台前台页面人工抄录；销量/评价数为页面可见值，未经后台核对"
      : "没有原始链接：无法回溯，只可作为方向参考，不得当作事实引用"
  });
});

if (tickets.length === 0) {
  console.error("一条有效工单都没解析出来。问题：");
  for (const item of problems) console.error(`  - ${item}`);
  process.exit(1);
}

const outDir = resolve(ROOT, String(flag("out", join("data", "export", "sourcing", region))));

if (!dry) {
  await mkdir(outDir, {recursive: true});
  for (const ticket of tickets) {
    await writeFile(join(outDir, `${ticket.slug}.json`), `${JSON.stringify(ticket, null, 2)}\n`, "utf8");
  }
  await writeFile(join(outDir, "_sample.json"), `${JSON.stringify({
    region,
    platform,
    sampled_at: sampledAt,
    count: tickets.length,
    with_url: tickets.filter((ticket) => ticket.offer_url).length,
    with_price: tickets.filter((ticket) => ticket.price_cny !== null).length,
    skipped: problems,
    caveat: "全部为人工取样：可追溯性取决于是否抄了链接；无链接的条目标 unverified，不得当作事实结论引用"
  }, null, 2)}\n`, "utf8");
}

console.log(`${dry ? "[dry-run] " : ""}${tickets.length} 条工单 → ${dry ? "(未写盘)" : outDir}`);
console.log(`  有链接 ${tickets.filter((ticket) => ticket.offer_url).length} 条 · 有人民币价 ${tickets.filter((ticket) => ticket.price_cny !== null).length} 条`);
for (const item of problems) console.log(`  跳过：${item}`);
const unpriced = tickets.filter((ticket) => ticket.price_cny === null).length;
if (unpriced > 0) {
  console.log(`  注意：${unpriced} 条没有人民币价 —— 定价段会对这些候选直接报缺项，不会用均值代填`);
}
console.log(`下一步：node scripts/chain.mjs --category <品类> --region ${region} --tickets ${outDir}`);
