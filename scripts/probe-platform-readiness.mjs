#!/usr/bin/env node
/**
 * 平台就绪矩阵：把「这个平台能不能出合规的包」变成一张可复现的表。
 *
 * 三件事一起做，缺一件结论就不可信：
 *   1. 事实盘点——data/specs/platforms/<p>.json 里有多少条 final / candidate / unverified（读文件，不猜）；
 *   2. 通道探测——官方文档站现在到底通不通（真发请求，记录状态码与跳转去向）；
 *   3. 判定——该平台该法域现在能不能出"可提交"的包，不能的话卡在哪一环。
 *
 * 产出：
 *   data/platform-readiness.json   机器读（链路/CI 可消费）
 *   docs/平台就绪矩阵.md            人读
 *
 * 用法：
 *   node scripts/probe-platform-readiness.mjs [--offline]
 *
 * --offline 只做事实盘点与判定，不发请求（用于无网环境；此时通道状态标 not_probed）。
 */
import {access, readdir, readFile, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const offline = args.includes("--offline");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * 每个平台的取数通道。endpoint 是"官方文档/接口入口"，不是商品页；
 * 只用公开入口做可达性判断，不抓商品数据、不绕登录。
 */
const CHANNELS = {
  ozon: {
    name: "Ozon",
    regions: ["RU"],
    api: {url: "https://api-seller.ozon.ru/v1/description-category/tree", method: "POST", expect: [200, 401, 403], note: "无凭证返回 401/403 属正常；带 Client-Id/Api-Key 即 200"},
    docs: {url: "https://global-help.ozon.com/zh/products/requirements/product-info/naming-requirements?region=CHN", expect: [200], note: "SPA：curl 只得空壳，需无头浏览器渲染"}
  },
  "yandex-market": {
    name: "Яндекс Маркет",
    regions: ["RU"],
    api: {url: "https://api.partner.market.yandex.ru/", method: "GET", expect: [200, 400, 401, 403, 404], note: "Partner API 需 Api-Key；无凭证 4xx 属正常"},
    docs: {url: "https://yandex.ru/support/marketplace/ru/llms.txt", expect: [200], note: "文档站提供 llms.txt 与 .md 纯文本版本，无需渲染"}
  },
  wildberries: {
    name: "Wildberries",
    regions: ["RU"],
    api: {url: "https://common-api.wildberries.ru/ping", method: "GET", expect: [200, 401, 403], note: "公开 ping 返回 401 说明接口在、缺 token；内容接口与类目属性都需 token"},
    docs: {url: "https://dev.wildberries.ru/openapi/", method: "GET", expect: [200], note: "开发者文档有浏览器校验"}
  },
  shopee: {
    name: "Shopee",
    regions: ["SG", "MY", "TH", "PH", "ID", "VN"],
    api: {url: "https://partner.shopeemobile.com/api/v2/shop/auth_partner", method: "GET", expect: [200, 400, 401, 403], note: "需 partner_id/key + 店铺授权才能取类目属性"},
    docs: {url: "https://open.shopee.com/documents", method: "GET", expect: [200], note: "公开 API 文档"}
  },
  lazada: {
    name: "Lazada",
    regions: ["SG", "MY", "TH", "PH", "ID", "VN"],
    api: {url: "https://api.lazada.com/rest", method: "GET", expect: [200, 400, 401, 403], note: "需 appKey/appSecret + 店铺授权"},
    docs: {url: "https://open.lazada.com/apps/doc", method: "GET", expect: [200], note: "公开 API 文档"}
  },
  "tiktok-shop": {
    name: "TikTok Shop",
    regions: ["SG", "MY", "TH", "PH", "ID", "VN"],
    api: {url: "https://open-api.tiktokglobalshop.com", method: "GET", expect: [200, 400, 401, 403, 404], note: "需 app_key/app_secret + 店铺授权"},
    docs: {url: "https://partner.tiktokshop.com/doc", method: "GET", expect: [200], note: "公开 API 文档"}
  },
  amazon: {
    name: "Amazon",
    regions: ["AE", "SA", "SG"],
    api: {url: "https://sellingpartnerapi-na.amazon.com/", method: "GET", expect: [200, 400, 403, 404], note: "SP-API 需 LWA 令牌 + 卖家授权；无凭证返回 4xx 属正常"},
    docs: {url: "https://developer-docs.amazon.com/sp-api/", expect: [200], note: "开发者文档可达；Seller Central 帮助页有登录墙，external 链接会 302 到开店营销页"}
  },
  noon: {
    name: "noon",
    regions: ["AE", "SA"],
    api: {url: "https://api.noon.partners/", method: "GET", expect: [200, 401, 403, 404], note: "Partner API 需 key；公开资料极少"},
    docs: {url: "https://seller.noon.com/", method: "GET", expect: [200], note: "卖家后台需登录"}
  }
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };

async function probe(url, method) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      method,
      redirect: "follow",
      headers: {"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"},
      signal: controller.signal
    });
    const text = await response.text().catch(() => "");
    return {
      status: response.status,
      final_url: response.url,
      body_len: text.length,
      // SPA 空壳的特征：200 但正文极小 —— 200 不等于"能取到内容"
      shell: response.status === 200 && text.length < 2000
    };
  } catch (error) {
    return {status: null, error: String(error?.message ?? error).slice(0, 120)};
  } finally {
    clearTimeout(timer);
  }
}

function judgeStatus(result, expect) {
  if (result.status === null) return "unreachable";
  if (expect.includes(result.status)) return "reachable";
  return `http_${result.status}`;
}

const factStatuses = ["final", "candidate", "unverified", "conflicted"];
async function factInventory(platformId) {
  try {
    const spec = JSON.parse(await readFile(join(ROOT, "data/specs/platforms", `${platformId}.json`), "utf8"));
    const facts = Array.isArray(spec) ? spec : spec.facts ?? [];
    const byStatus = Object.fromEntries(factStatuses.map((status) => [status, 0]));
    for (const fact of facts) byStatus[fact.status ?? "unverified"] = (byStatus[fact.status ?? "unverified"] ?? 0) + 1;
    return {exists: true, total: facts.length, by_status: byStatus, keys: facts.map((fact) => fact.key), entries: facts};
  } catch {
    return {exists: false, total: 0, by_status: {}, keys: [], entries: []};
  }
}

const dictionaryDir = join(ROOT, "data/dictionaries");
async function dictionaryInventory(platformId) {
  try {
    const names = (await readdir(join(dictionaryDir, platformId))).filter((name) => name.endsWith(".json"));
    return names.map((name) => name.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

const regions = (await readdir(join(ROOT, "regions"), {withFileTypes: true}))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const platformEntries = [];
for (const [id, channel] of Object.entries(CHANNELS)) {
  const facts = await factInventory(id);
  const dictionaries = await dictionaryInventory(id);
  let api = {status: offline ? "not_probed" : "pending"};
  let docs = {status: offline ? "not_probed" : "pending"};
  if (!offline) {
    const apiResult = await probe(channel.api.url, channel.api.method);
    api = {
      status: judgeStatus(apiResult, channel.api.expect),
      http: apiResult.status,
      final_url: apiResult.final_url ?? null,
      note: channel.api.note
    };
    await sleep(300);
    const docsResult = await probe(channel.docs.url, channel.docs.method);
    docs = {
      status: judgeStatus(docsResult, channel.docs.expect),
      http: docsResult.status,
      body_len: docsResult.body_len ?? null,
      shell: docsResult.shell ?? null,
      final_url: docsResult.final_url ?? null,
      note: channel.docs.note
    };
    await sleep(300);
  }
  // 文档站被限流/反爬时，如果之前已把原文落盘，状态写 cached 而不是 unreachable ——
  // 结论仍然可用，只是不能当场复现，这一点必须写清楚。
  if (docs.status === "unreachable" || (docs.http && docs.http >= 400)) {
    const cached = await exists(join(ROOT, "out/verification/ozon-official")) && id === "ozon";
    if (cached) docs = {...docs, cached_evidence: "out/verification/ozon-official/", status: "cached"};
  }
  // 能出包的前提是"图片比例事实存在"；但"能不能当可提交包"要看**关键事实的等级**，
  // 不是"有任意一条 final"。WB 差点被一条"文档不可达"的 final 说明骗成可提交。
  const ratioFact = (facts.entries ?? []).find((fact) => String(fact.key).endsWith(".image.ratio")) ?? null;
  // 有的平台官方不规定比例（只给最小尺寸），此时投影按「原图直出、不裁」处理。
  // 这同样是可出包的合法状态，不能因为 ratio 是 null 就判成「做不了」。
  const preserveFact = (facts.entries ?? []).find((fact) =>
    String(fact.key).endsWith(".image.ratio_policy") && fact.value === "preserve") ?? null;
  const preserveFinal = Boolean(preserveFact) && preserveFact.status === "final";
  const ratioOk = Boolean(ratioFact) && ratioFact.value !== null && ratioFact.value !== undefined;
  const projectable = ratioOk || preserveFinal;
  const ratioIsFinal = (ratioOk && ratioFact.status === "final") || preserveFinal;
  // 1:1 但比例口径只有二手来源时，风险性质变了：
  // 几何处理是「等比缩放 + 补白边」，不裁掉任何像素。就算真实要求不是 1:1，
  // 方图在白底上也不会被拒；最坏结果是主体显小，不是违规。
  // 而如果是「按 1:1 裁切」，口径错一次就把裙摆领口切没了 —— 那是不可逆的。
  const squareRatioCandidate = ratioOk && ratioFact.value.width === ratioFact.value.height && ratioFact.status !== "final";
  const titleFinals = (facts.entries ?? []).filter((fact) =>
    String(fact.key).includes(".title.") && fact.status === "final" && fact.value !== null
  ).length;
  platformEntries.push({
    id,
    name: channel.name,
    regions: channel.regions,
    spec: {path: `data/specs/platforms/${id}.json`, ...facts},
    dictionaries,
    channels: {api, docs},
    // 判定口径：能出包 = 关键事实齐全（至少要有图片比例，否则连裁图都做不了）。
    // 只看"有没有 final 事实"会被一条说明性事实骗过去 —— noon 就是这种：有 1 条 final，
    // 但那是"怎么去补数据"的说明，不是平台规则。
    projectable,
    ratio_is_final: ratioIsFinal,
    title_final_facts: titleFinals,
    verdict: !projectable
      ? "不能出包（缺图片比例，连裁图都做不了）"
      : ratioIsFinal && titleFinals > 0
        ? (preserveFinal && !ratioOk ? "可出包（平台未规定比例，原图直出；标题规则已核实）" : "可出包（图片比例与标题规则均已核实）")
        : ratioIsFinal
          ? (preserveFinal && !ratioOk ? "可出包（平台未规定比例，原图直出；标题规则待核）" : "可出包（图片比例已核实；标题规则待核）")
          : squareRatioCandidate && titleFinals > 0
            ? "可出包（1:1 为多源口径，已用补边不裁切；尺寸下限仍待后台确认）"
            : "只能出待核包（关键事实仍为 candidate，提交前须人工核）"
  });
}

const regionView = regions.map((region) => {
  const platforms = Object.entries(CHANNELS)
    .filter(([, channel]) => channel.regions.includes(region))
    .map(([id]) => {
      const entry = platformEntries.find((item) => item.id === id);
      return {platform: id, verdict: entry.verdict, api: entry.channels.api.status, docs: entry.channels.docs.status};
    });
  // 三档而不是两档：有 final 事实 = 可提交；只有 candidate = 待核包（仍能干活，只是要人核一遍）；
  // 连关键事实都缺 = 不能出。把"待核包"和"不能出"并成一句，会让人以为这块完全没做。
  const ready = platforms.filter((item) => item.verdict.startsWith("可出包"));
  const drafty = platforms.filter((item) => item.verdict.startsWith("只能出待核包"));
  return {
    region,
    platforms,
    ready: ready.map((item) => item.platform),
    draft_ready: drafty.map((item) => item.platform),
    verdict: ready.length > 0
      ? `可出包：${ready.map((item) => item.platform).join(" / ")}${drafty.length ? `（另有待核包：${drafty.map((item) => item.platform).join(" / ")}）` : ""}`
      : drafty.length > 0
        ? `只能出待核包：${drafty.map((item) => item.platform).join(" / ")}（事实均为 candidate，提交前须人工核一遍）`
        : "无可出包平台（只有汇率与人工取样）"
  };
});

const evidence = {
  generated_at: new Date().toISOString(),
  mode: offline ? "offline" : "online",
  protocol: {
    T1_api: "官方 Seller/Partner API 只读拉取（需凭证）→ 事实为 L2，status=final",
    T2_doc: "官方帮助/开发者文档（公开）→ 事实为 L2 文本，需人工确认是否同样适用于该法域",
    T3_manual: "后台截图/卖家手抄 → 事实为 L1，status=candidate，必须在真机核对后升级",
    rule: "只有 final 事实才能产出\"可提交\"的包；candidate 只能产出待核包；unverified 不参与生成"
  },
  note: "可达性只说明\"能看见入口\"，不等于\"能取到数据\"：Shopee/Lazada/TikTok 的类目属性都必须有 partner 凭证 + 店铺授权。",
  platforms: platformEntries,
  regions: regionView
};

await writeFile(join(ROOT, "data/platform-readiness.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

const lines = [
  "# 平台就绪矩阵（脚本生成，勿手改）",
  "",
  `生成时间：${evidence.generated_at}　模式：${evidence.mode}`,
  "",
  "> 可达 ≠ 可取。文档站能打开只说明入口在；要拿类目属性，必须有该平台的 partner 凭证 + 店铺授权。",
  "",
  "## 一、平台维度",
  "",
  "| 平台 | 法域 | 平台事实 | final / candidate / unverified | 字典 | API 通道 | 文档通道 | 判定 |",
  "|---|---|---|---|---|---|---|---|"
];
for (const item of platformEntries) {
  const stats = `${item.spec.total} 条`;
  const split = `${item.spec.by_status.final ?? 0} / ${item.spec.by_status.candidate ?? 0} / ${item.spec.by_status.unverified ?? 0}`;
  lines.push(`| ${item.name} | ${item.regions.join(",")} | ${stats} | ${split} | ${item.dictionaries.length} 个 | ${item.channels.api.status}${item.channels.api.http ? `（${item.channels.api.http}）` : ""} | ${item.channels.docs.status}${item.channels.docs.http ? `（${item.channels.docs.http}${item.channels.docs.shell ? " · SPA空壳" : ""}）` : ""} | ${item.verdict} |`);
}

lines.push(
  "",
  "> 通道列里的 401 / 403 / 404 都算 `reachable`：说明接口在、只是探测没带凭证（或路径需要授权）；真正的 498 / 空壳 / 登录墙才算不可用。",
  "",
  "## 二、法域维度",
  "",
  "| 法域 | 平台 | 出包判定 |",
  "|---|---|---|"
);
for (const item of regionView) {
  lines.push(`| ${item.region} | ${item.platforms.map((platform) => platform.platform).join(" / ")} | ${item.verdict} |`);
}

lines.push(
  "",
  "## 三、取数协议（新增平台照这个走）",
  "",
  `1. **T1 官方 API**：${evidence.protocol.T1_api}`,
  `2. **T2 官方文档**：${evidence.protocol.T2_doc}`,
  `3. **T3 后台/人工**：${evidence.protocol.T3_manual}`,
  "",
  `判定规则：${evidence.protocol.rule}`,
  "",
  "## 四、这份表能回答什么",
  "",
  "- 某个法域现在能不能出**可提交**的包（不能的话卡在 API 凭证、文档缺失、还是后台字段）；",
  "- 新增一个平台要补多少事实（看 `平台事实` 那列是不是 0）；",
  "- 平台事实里有多少只是二手来源（`candidate` 列非 0 就说明还没到 L2）。",
  "",
  "它**不能**回答：某条规则在具体叶子类目是否成立 —— 那必须用该类目的 type_id 实拉一次。"
);

await writeFile(join(ROOT, "docs/平台就绪矩阵.md"), `${lines.join("\n")}\n`, "utf8");

console.log(`平台 ${platformEntries.length} 个 · 法域 ${regionView.length} 个 → data/platform-readiness.json + docs/平台就绪矩阵.md`);
for (const item of platformEntries) {
  console.log(`  ${item.name.padEnd(12)} final=${item.spec.by_status.final ?? 0} cand=${item.spec.by_status.candidate ?? 0} · api=${item.channels.api.status} docs=${item.channels.docs.status} · ${item.verdict}`);
}
for (const item of regionView) console.log(`  [${item.region}] ${item.verdict}`);
