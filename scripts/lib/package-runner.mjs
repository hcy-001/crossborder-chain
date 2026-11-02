import {cp, mkdir, readdir, readFile, rm, writeFile} from "node:fs/promises";
import {basename, join, resolve} from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import {runDoctor, loadLatestPreflight} from "./preflight.mjs";
import {evaluateCompliance} from "../../core/compliance/evaluate.mjs";
import {buildMaster} from "../../core/content/build-master.mjs";
import {projectPlatform} from "../../adapters/platforms/project.mjs";
import {assemblePackage} from "../../core/package/assemble.mjs";
import {writeOnepager} from "../../core/package/onepager.mjs";
import {calculatePrice} from "../../core/pricing/calculate.mjs";
import {isCurrencyLikeFact} from "../../core/attrs/value-shape.mjs";
import * as labChannel from "../../channels/storage/lab.mjs";
import {selectImageChannel} from "./channels.mjs";
import * as rutubeChannel from "../../channels/source/rutube-search.mjs";

const pretty = (value) => `${JSON.stringify(value, null, 2)}\n`;
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

async function loadInput(root, sku) {
  try {
    return await readJson(join(root, "input", `${sku}.json`));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`missing required product input: input/${sku}.json`);
    throw error;
  }
}

async function loadOptionalJson(file, fallback) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function validateInput(input, schemas) {
  const ajv = new Ajv2020();
  ajv.addSchema(schemas.fact);
  ajv.addSchema(schemas.title);
  ajv.addSchema(schemas.profile);
  const validate = ajv.compile(schemas.input);
  if (!validate(input)) throw new TypeError(`invalid product input: ${JSON.stringify(validate.errors)}`);
  return ajv.compile(schemas.profile);
}

async function resolvePreflight({projectRoot, nowIso}) {
  try {
    return {ok: true, exitCode: 0, state: await loadLatestPreflight(projectRoot)};
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error(`stale preflight rejected: ${error.message}`);
  }
  const doctor = await runDoctor({root: projectRoot, nowIso});
  if (!doctor.ok) throw new Error(`doctor hard failure: ${doctor.state.error.message}`);
  return doctor;
}

/**
 * 把法域底数压成交付说明里的一小段。
 * 新手拿到包最该先知道的两件事是「这个市场有多少人、买得起什么价」和「这里到底有没有冬天」，
 * 而不是先看属性表。数据缺就整段不出现，不编。
 */
async function buildRegionBrief(projectRoot, region) {
  if (!region) return null;
  let doc;
  try {
    doc = JSON.parse(await readFile(join(projectRoot, "data", "specs", "regions", `${region}.json`), "utf8"));
  } catch {
    return null;
  }
  const facts = new Map((doc.facts ?? []).map((fact) => [fact.key, fact]));
  const value = (key) => facts.get(key)?.value ?? null;
  const parts = [];
  const population = value("region.population");
  const gdp = value("region.gdp_per_capita");
  const internet = value("region.internet_users");
  const urban = value("region.urban_population");
  if (population) parts.push(`人口 ${(population / 1e6).toFixed(2)} 百万`);
  if (gdp) parts.push(`人均 GDP $${Math.round(gdp).toLocaleString("en-US")}`);
  if (internet !== null && internet !== undefined) parts.push(`互联网渗透 ${Number(internet).toFixed(1)}%`);
  if (urban !== null && urban !== undefined) parts.push(`城镇化 ${Number(urban).toFixed(1)}%`);

  const climateFact = value("region.climate");
  let climate = null;
  if (climateFact && Number.isFinite(climateFact.annual_range_c)) {
    const range = climateFact.annual_range_c;
    // 只按温差做"能不能卖厚衣服"的粗判，别把它说成销量预测。
    const hint = range < 8
      ? "全年温差小，厚外套/羽绒基本卖不动，主力是薄款"
      : range < 18
        ? "有温差但不极端，可做春秋外套"
        : "四季分明，需要按季分层备货";
    climate = `年温差约 ${range}℃（${climateFact.city ?? "主要城市"}）→ ${hint}`;
  }

  const holidays = value("region.holidays");
  const holidayLine = Array.isArray(holidays) && holidays.length > 0
    ? `公共假日 ${holidays.length} 天（影响物流停摆与上新节奏）`
    : null;

  // 品类规模：进口额、中国份额、单价。这三项决定"值不值得进"，比宏观人口更贴近生意。
  let trade = null;
  try {
    const tradeDoc = JSON.parse(await readFile(join(projectRoot, "data", "trade", `${region}.json`), "utf8"));
    const row = (tradeDoc.rows ?? []).find((item) => item.available && item.import_value_usd);
    if (row) {
      const money = row.import_value_usd >= 1e9
        ? `$${(row.import_value_usd / 1e9).toFixed(2)}B`
        : `$${(row.import_value_usd / 1e6).toFixed(0)}M`;
      const share = row.china_share_pct === null ? null : `${row.china_share_pct}%`;
      const price = row.unit_price_usd_per_kg === null ? null : `$${row.unit_price_usd_per_kg}/kg`;
      trade = `HS ${row.hs} 进口 ${money}（${row.year} 年）`
        + `${share ? `，中国占 ${share}` : ""}${price ? `，单价 ${price}` : ""}`
        + `${row.requested_year && row.requested_year !== row.year ? "（目标年无记录，已回退到该年）" : ""}`;
    }
  } catch {
    trade = null;
  }

  // 税率参考：只做提示，不参与计算 —— 计算用的是卖家在问卷里填的 vat_rate。
  // 但「当地法定税率到底是多少」卖家常常记成旧值（俄罗斯 2026 已从 20% 到 22%），
  // 把官方值摆在交付说明里，人一眼能看出自己填错了。
  let tax = null;
  try {
    const profile = JSON.parse(await readFile(join(projectRoot, "regions", region, "profile.json"), "utf8"));
    const t = profile.tax_reference;
    if (t?.standard_rate) {
      const pct = `${Math.round(t.standard_rate * 1000) / 10}%`;
      const effective = t.effective_rate ? `（实际有效 ${Math.round(t.effective_rate * 1000) / 10}%）` : "";
      tax = `${t.label} 标准税率 ${pct}${effective} —— ${t.status === "final" ? "官方原文" : "多源参考，需自行确认"}；你填的税率请与之对照`;
    } else if (t && t.standard_rate === null) {
      tax = `${t.label}：${t.note}`;
    }
  } catch (error) {
    // 读不到税率参考不该让整包失败，但也不能静默：留一句到 stderr，便于排查是路径问题还是数据问题。
    if (process.env.DEBUG_REGION_BRIEF) console.error(`[regionBrief] tax 读取失败：${error.message}`);
    tax = null;
  }

  if (parts.length === 0 && !climate) return null;
  const used = [];
  if (facts.get("region.population")?.status === "final") used.push("世界银行");
  if (facts.get("region.climate")?.status === "final") used.push("Open-Meteo");
  if (facts.get("region.holidays")?.status === "final") used.push("Google 公共假日日历");
  if (trade) used.push("UN Comtrade");
  return {
    region,
    summary: parts.join(" · "),
    climate,
    holidays: holidayLine,
    trade,
    tax,
    sources: used.length ? used.join(" / ") : "见明细"
  };
}

function unavailablePricing(reasons) {
  return {status: "unavailable", reasons, result: null};
}

function priceFrom({input, profile, doctor}) {
  if (doctor.state.pricing.status === "unavailable") {
    return unavailablePricing(doctor.state.pricing.reasons);
  }
  const cost = input.facts.find((fact) => fact.key === "cost")?.value;
  const weight = input.facts.find((fact) => fact.key === "weight")?.value;
  const fx = doctor.state.facts.find((fact) => fact.key === `fx.USD_${profile.currency}`);
  if (!fx) return unavailablePricing(["fx_missing"]);
  // 只核对"本该已经是目标币"的金额项：cost 是采购价（按约定用 CNY，后面走汇率换算），
  // 重量是克，费率是百分比 —— 把它们拿去和结算币比，会让每一包都误报单位不匹配。
  const mismatched = input.pricing_facts.filter((fact) => isCurrencyLikeFact(fact) && fact.unit !== profile.currency);
  if (mismatched.length > 0) {
    return unavailablePricing(["pricing_unit_mismatch", ...mismatched.map((fact) => `${fact.key}:${fact.unit}`)]);
  }
  const result = calculatePrice({
    product: {cost, weight},
    snapshot: {
      snapshot_id: doctor.state.run_id,
      currency: profile.currency,
      fx: {value: fx.value, unit: fx.unit},
      components: input.pricing_facts.map((fact) => ({key: fact.key, local_value: fact.value}))
    },
    roundTo: profile.price_rounding
  });
  return result.status === "available"
    ? {status: "available", reasons: [], result}
    : unavailablePricing(result.reasons);
}

/**
 * 内容寻址目录按内容哈希命名，旧文件不会被覆盖：换生图通道后上一轮的占位图会留在原处，
 * 直接交付会把假图混进平台目录。出包末尾按 manifest 引用清理孤儿图并留痕。
 */
export async function pruneUnreferencedImages(packageDir) {
  let referenced;
  try {
    const manifest = JSON.parse(await readFile(join(packageDir, "master", "manifest.json"), "utf8"));
    referenced = new Set((manifest.images ?? []).map((image) => basename(image.file)));
  } catch (error) {
    if (error?.code === "ENOENT") return {removed: [], reason: "manifest_missing"};
    throw error;
  }

  const targets = [join(packageDir, "master", "images")];
  try {
    for (const entry of await readdir(join(packageDir, "platforms"), {withFileTypes: true})) {
      if (entry.isDirectory()) targets.push(join(packageDir, "platforms", entry.name, "images"));
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const removed = [];
  for (const directory of targets) {
    let entries;
    try {
      entries = await readdir(directory, {withFileTypes: true});
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".png")) continue;
      if (referenced.has(entry.name)) continue;
      await rm(join(directory, entry.name), {force: true});
      removed.push(`${basename(packageDir)}/${directory.slice(packageDir.length + 1).replaceAll("\\", "/")}/${entry.name}`);
    }
  }
  return {removed, kept: referenced.size};
}

async function unavailableProjection({masterDir, outputDir, platformId, detail}) {
  await mkdir(join(outputDir, "images"), {recursive: true});
  await Promise.all([
    cp(join(masterDir, "copy"), join(outputDir, "copy"), {recursive: true}),
    cp(join(masterDir, "title.tokens.json"), join(outputDir, "title.tokens.json")),
    cp(join(masterDir, "attributes.csv"), join(outputDir, "attributes.csv"))
  ]);
  const validate = {
    platform: platformId,
    quality: "unverified",
    passed: [],
    violations: [{code: "spec_unavailable", detail}],
    conflicts: [{key: `platform.${platformId}`, status: "unverified"}],
    crop_unsafe: [],
    notes: detail
  };
  await writeFile(join(outputDir, "validate.json"), pretty(validate));
  await writeFile(join(outputDir, "crop.json"), pretty({crops: []}));
  return {platform: platformId, outputDir, validate, cropDocument: {crops: []}};
}

export async function runPackage({
  root,
  sku,
  nowIso = new Date().toISOString(),
  imageChannel,
  storageChannel = labChannel,
  signalChannel = rutubeChannel,
  extraBlockers = [],
  sizeMappings = {},
  requiredAttributes = {},
  // 定价真源由调用方传入（chain 用分母法算完后交过来）。
  // 不传时才退回本文件里的成本累加（demo / pack 的旧路径）。
  pricing = null
} = {}) {
  const started = Date.now();
  const projectRoot = resolve(root ?? process.cwd());
  const imageSelection = await selectImageChannel(projectRoot, imageChannel);
  imageChannel = imageSelection.channel;
  const input = await loadInput(projectRoot, sku);
  const schemas = {
    input: await readJson(join(projectRoot, "schemas/product-input.schema.json")),
    fact: await readJson(join(projectRoot, "schemas/fact.schema.json")),
    title: await readJson(join(projectRoot, "schemas/title-tokens.schema.json")),
    profile: await readJson(join(projectRoot, "schemas/profile.schema.json"))
  };
  const validateProfile = validateInput(input, schemas);
  const profile = await readJson(join(projectRoot, "regions", input.destination, "profile.json"));
  if (!validateProfile(profile)) throw new TypeError(`invalid region profile: ${JSON.stringify(validateProfile.errors)}`);
  if (input.platforms.some((platform) => !profile.platforms.includes(platform))) {
    throw new TypeError("product platform is not declared by the region profile");
  }

  const doctor = await resolvePreflight({projectRoot, nowIso});
  const rules = await loadOptionalJson(join(projectRoot, "regions", input.destination, "compliance/rules.json"), null);
  const product = {
    sku: input.sku,
    region: input.destination,
    category: input.category,
    facts: input.facts,
    variants: input.variants,
    size: input.size,
    // 商品身份（品名/颜色/材质/人群/品牌）必须跟着走进出图提示词，
    // 否则模型只拿到一个品类词，画出来的东西跟货源不是同一件。
    attributes: input.attributes,
    // 人群创意简报同理：不进这一层，人群假设对画面就没有任何影响。
    creative_brief: input.creative_brief ?? null
  };
  const complianceReport = rules ? evaluateCompliance({
    rules,
    product: input,
    sku: input.sku,
    destination: input.destination,
    checkedAt: nowIso
  }) : {
    sku: input.sku,
    destination: input.destination,
    items: [],
    blockers: ["compliance rules unavailable"],
    notes: "unverified: no region compliance rules"
  };

  // 产物目录策略：首次跑用 package/<sku>；已存在则换 package/<sku>__<时间片>。
  // 为什么不覆盖：覆盖写 + 清目录在部分安全策略下被计成删除（本机实测会撞 50 次/轮阈值），
  // 换个新目录不删任何东西，重复跑永远安全；交接时以回执里的 package_dir 为准。
  const baseDir = join(projectRoot, "package", input.sku);
  const baseExists = await readdir(baseDir).then(() => true).catch(() => false);
  const runSuffix = String(nowIso).replace(/\D/g, "").slice(-6) || String(Date.now()).slice(-6);
  const packageDir = baseExists ? join(projectRoot, "package", `${input.sku}__${runSuffix}`) : baseDir;
  const masterDir = join(packageDir, "master");
  const master = await buildMaster({
    outputDir: masterDir,
    product,
    titleTokens: input.title_tokens,
    copy: input.copy,
    attributes: input.attributes,
    complianceReport,
    snapshotId: doctor.state.run_id,
    imageChannel,
    storageChannel
  });
  const projections = [];
  for (const platformId of input.platforms) {
    const outputDir = join(packageDir, "platforms", platformId);
    try {
      const platformSpec = await readJson(join(projectRoot, "data/specs/platforms", `${platformId}.json`));
      projections.push(await projectPlatform({masterDir, platformSpec, platformId, outputDir}));
    } catch (error) {
      // 两种"还没准备好"都降级而不是崩：没有平台事实文件；有文件但关键事实缺失。
      if (!["ENOENT", "FACTS_INCOMPLETE"].includes(error?.code)) throw error;
      const detail = error?.code === "ENOENT"
        ? "platform spec unavailable"
        : `platform facts incomplete: ${error.message}`;
      projections.push(await unavailableProjection({masterDir, outputDir, platformId, detail}));
    }
    // 尺码映射落在平台目录里，且必须在 assemble 之前写完：
    // handoff.md 要引用同一份文件，不能出现"说明写了、文件还没有"。
    const mapping = sizeMappings[platformId];
    if (mapping) await writeFile(join(outputDir, "size-mapping.json"), `${JSON.stringify(mapping, null, 2)}\n`, "utf8");
    // 平台必填属性清单：过审的第一道门，随包交付才有意义
    const requiredAttrs = requiredAttributes[platformId];
    if (requiredAttrs) await writeFile(join(outputDir, "required-attributes.json"), `${JSON.stringify(requiredAttrs, null, 2)}\n`, "utf8");
  }

  let signalResult = {ok: false, signals: [], receipt: {detail: "signal channel not requested"}};
  if (signalChannel && input.signal_query) {
    signalResult = await signalChannel.run({
      query: input.signal_query,
      page: 1,
      signal: AbortSignal.timeout(8000)
    });
  }
  const runDir = join(projectRoot, "runs", doctor.state.run_id);
  await mkdir(runDir, {recursive: true});
  await writeFile(join(runDir, "signals.json"), pretty(signalResult));

  const pricingReceipt = pricing
    ? (pricing.status === "available"
      ? {status: "available", reasons: [], result: pricing}
      : {
        // infeasible（费率+毛利 ≥100%）也是"给不出价"，回执只认 available/unavailable
        status: "unavailable",
        reasons: pricing.reasons ?? [String(pricing.status ?? "pricing_unavailable")],
        result: null
      })
    : priceFrom({input, profile, doctor});
  const degradations = [...master.degradations];
  if (imageSelection.degraded) degradations.push({kind: "imagegen", detail: imageSelection.detail});
  if (!signalResult.ok) degradations.push({kind: "source", detail: "public signals unavailable"});
  if (pricingReceipt.status === "unavailable") degradations.push({kind: "pricing", detail: "pricing unavailable"});
  const receipt = {
    run_id: doctor.state.run_id,
    sku: input.sku,
    snapshot_sha256: doctor.state.snapshot_sha256,
    started_at: nowIso,
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    gates: [{id: "G6", status: "pass", level: "L1", evidence: "package runner reached assembly"}],
    degradations,
    divergences: doctor.state.conflicts.map((conflict) => ({kind: "fx", detail: `${conflict.key}: ${conflict.divergence_pct}%`})),
    stale: doctor.state.receipts.filter((item) => item.status === "stale").map((item) => ({
      key: item.key ?? "unknown",
      expired_days: item.expired_days ?? null
    })),
    providers: [...master.providers, {kind: "source", detail: signalChannel?.meta?.name ?? "injected"}],
    pricing: pricingReceipt
  };
  const regionBrief = await buildRegionBrief(projectRoot, input.destination);
  const assembled = await assemblePackage({packageDir, complianceReport, receipt, extraBlockers, regionBrief});
  // 一页商品卡：给人看的那一页。数据全部来自包内文件，不新增判断。
  let onepager = null;
  try {
    onepager = await writeOnepager({packageDir, platform: input.platforms?.[0] ?? null});
  } catch (error) {
    onepager = {file: null, error: error.message};
  }
  const pruned = await pruneUnreferencedImages(packageDir);
  await writeFile(join(runDir, "images-prune.json"), pretty(pruned));
  await writeFile(join(packageDir, "signals.receipt.json"), pretty(signalResult.receipt));
  await writeFile(join(runDir, "receipt.json"), pretty(assembled.receipt));
  await writeFile(join(runDir, "state.json"), pretty({
    status: "complete",
    run_id: doctor.state.run_id,
    package: `package/${input.sku}`,
    snapshot_id: doctor.state.run_id
  }));
  return {packageDir, preflight: doctor.state, receipt: assembled.receipt, projections, signals: signalResult.signals};
}
