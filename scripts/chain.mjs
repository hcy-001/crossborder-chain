#!/usr/bin/env node
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import {runDoctor} from "./lib/preflight.mjs";
import {selectImageChannel, selectLlmChannel} from "./lib/channels.mjs";
import {createJournal} from "../core/judge/journal.mjs";
import {judgePoint} from "../core/judge/run.mjs";
import {buildListingInput} from "../core/listing/build.mjs";
import {planModeling} from "../core/modeling/plan.mjs";
import {resolveSupplier} from "../core/sourcing/match.mjs";
import {applyPersonaGate, baseDecisionFromQuality, checkFalsifier, creativeBriefFrom, minDecision} from "../core/persona/gate.mjs";
import {loadReferenceImages, loadTickets, probeSkill, resolveSkillRoots} from "./lib/skills.mjs";
import {
  briefFrom,
  mergeIntakeAttributes,
  persistModelingPlan,
  probeReferences,
  rankCandidates,
  runModeling,
  ticketAttributes,
  ticketProductFacts
} from "./lib/chain-stages.mjs";
import {runPackage} from "./lib/package-runner.mjs";
import {chainDegradations, computePricing, judgeEvidenceLevels} from "./lib/chain-stages.mjs";
import {adaptSizeToPlatform} from "../core/sizing/adapt.mjs";
import {validateIntake} from "../core/intake/checklist.mjs";
import {parseSizeRows} from "../core/sizing/parse.mjs";
import {asciiSlug} from "./lib/slug.mjs";
import * as mockLlmChannel from "../channels/llm/mock.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pretty = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** 读一个「可能不存在」的 JSON：不存在返回 null，坏文件照旧抛错（别把损坏当缺失）。 */
async function readOptionalJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** 决策码给人看的写法：`unpriced` 在决策梯子里是"没有质量分"，跟价格无关，直接译出来免得误读。 */
const DECISION_LABEL = {
  blocked: "阻断",
  reject: "否决",
  unpriced: "未评分",
  observe: "观察",
  test: "可测"
};
function decisionLabel(decision) {
  if (!decision) return "-";
  return `${DECISION_LABEL[decision] ?? decision}（${decision}）`;
}

/**
 * 把内部 reason 码翻成人话：给外面看的东西不能要求读者懂我们的键名。
 */
function humanizeReason(code) {
  const map = {
    shipping_missing: '国际运费',
    commission_missing: '平台佣金率',
    tax_missing: '税率',
    payment_fee_missing: '支付手续费率',
    size_rows: '工单里的尺码表数据行',
    platform_size_fields: '该平台的尺码字段定义',
    international_equivalence: '本码↔国际码对照表',
    cost_missing: '采购价',
    weight_missing: '包装后重量',
    fx_missing: '汇率'
  };
  if (map[code]) return map[code];
  if (String(code).endsWith('_missing')) return String(code).replace('_missing', '');
  return code;
}

const USAGE = `先选一种场景（不知道选哪个就跑第 1 条）：

  1) 第一次跑，先看流程能不能通（零成本，不联网、不出真图）
     node scripts/chain.mjs --category 女装 --region RU --candidates 1 --mock-llm --mock-images

  2) 真要出包（会调模型、会花钱）：先答问卷，再带答案跑
     node scripts/intake.mjs --list
     node scripts/chain.mjs --category 女装 --region RU --candidates 1 --intake answers.json

  3) 只想确认尺码字段名（不跑链路）
     npm run sizing:confirm

  4) 看全部参数
     node scripts/chain.mjs --help

用法：
  node scripts/chain.mjs --category <品类> --region <法域> --candidates <数量> [选项]

必填：
  --category <str>      大品类，例如 女装 / 衬衫 / 外套（用于文案与判别的上下文，不做本地化翻译）
  --region <CC>         目标法域两位码，必须已存在于 regions/
  --candidates <n>      要产出成品包的候选数（1-10）

选项：
  --profile <p>         打分画像 conservative|aggressive|pilot（默认 conservative）
  --tickets <dir>       直接指定选品工单目录（默认读 selection skill 的导出）
  --skills-root <dir>   三个 skill 的安装根目录（默认 ~/.workbuddy/skills）
  --mock-llm            强制使用判别桩，不联网
  --mock-images         强制使用占位图通道，不产生费用
  --dry-modeling        建模只做计划与规则校验，不真渲染（默认）
  --render-modeling     建模真渲染（需要浏览器与建模 skill 依赖）
  --run-id <id>         复用指定 run_id
  --intake <file>       上架前问卷答复（scripts/intake.mjs 产出）；不给他就只能出包、不能出价
  --explore-quota <n>   本次运行允许多少个「人群仍是假设」的候选豁免封顶进 test（默认 2）
  --help                打印本说明

退出码：0 完成（含降级）｜2 输入或前置不成立｜3 有候选失败｜4 机械门未过
`;

/**
 * 长任务必须当场有声响：一条真实链路要跑十来分钟（9 张图 + 建模渲染），
 * 全程零输出等于让人对着黑屏猜进程死没死。进度一律走 stderr，不污染回执。
 */
const T0 = Date.now();
function step(label, detail) {
  const sec = ((Date.now() - T0) / 1000).toFixed(1).padStart(7, " ");
  process.stderr.write(`[${sec}s] ${label}${detail ? ` · ${detail}` : ""}\n`);
}

function parseArgs(argv) {
  const args = {
    category: null,
    region: null,
    candidates: 3,
    profile: "conservative",
    tickets: null,
    skillsRoot: null,
    mockLlm: false,
    mockImages: false,
    dryModeling: true,
    runId: null,
    exploreQuota: 2,
    intake: null,
    help: false
  };
  const take = (index, name) => {
    const value = argv[index];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} 缺少取值`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index].replace(/^--/, "");
    switch (flag) {
      case "category": args.category = take(++index, flag); break;
      case "region": args.region = take(++index, flag); break;
      case "candidates": args.candidates = Number(take(++index, flag)); break;
      case "profile": args.profile = take(++index, flag); break;
      case "tickets": args.tickets = take(++index, flag); break;
      case "skills-root": args.skillsRoot = take(++index, flag); break;
      case "mock-llm": args.mockLlm = true; break;
      case "mock-images": args.mockImages = true; break;
      case "dry-modeling": args.dryModeling = true; break;
      case "render-modeling": args.dryModeling = false; break;
      case "run-id": args.runId = take(++index, flag); break;
      case "intake": args.intake = take(++index, flag); break;
      case "explore-quota": args.exploreQuota = Number(take(++index, flag)); break;
      case "help": args.help = true; break;
      default: throw new Error(`未知参数 --${flag}`);
    }
  }
  return args;
}

function stampRunId() {
  const iso = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
  const suffix = createHash("sha256").update(String(process.hrtime.bigint())).digest("hex").slice(0, 4);
  return `${iso.slice(0, 8)}-${iso.slice(8, 14)}-${suffix}`;
}

function skuFor(candidate, rank) {
  const readable = asciiSlug(candidate.topic ?? candidate.title ?? `cand-${rank}`, {maxLength: 26});
  const hash = createHash("sha256").update(String(candidate.topic ?? candidate.id ?? rank)).digest("hex").slice(0, 6);
  return readable.length >= 3 ? `${readable}-${hash}` : `cand-${rank}-${hash}`;
}

function summarizeHealth(state) {
  const receipts = state?.receipts ?? [];
  const stale = receipts.filter((item) => item.status === "stale").map((item) => item.key ?? "unknown");
  const missing = receipts.filter((item) => item.status === "missing").map((item) => item.key ?? "unknown");
  return {
    stale,
    missing,
    degraded: [],
    blockingKeys: [...new Set([...missing])]
  };
}

async function validateInputAgainstSchema(root, input) {
  const ajv = new Ajv2020();
  const read = async (name) => JSON.parse(await readFile(join(root, "schemas", name), "utf8"));
  for (const name of ["fact.schema.json", "title-tokens.schema.json", "profile.schema.json"]) {
    ajv.addSchema(await read(name));
  }
  const validate = ajv.compile(await read("product-input.schema.json"));
  if (!validate(input)) {
    throw new TypeError(`组装出的上品输入未通过 schema：${JSON.stringify(validate.errors)}`);
  }
  return true;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (!args.category || !args.region) {
    console.error("缺少 --category 或 --region");
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (!Number.isInteger(args.candidates) || args.candidates < 1 || args.candidates > 10) {
    console.error("--candidates 必须是 1-10 的整数");
    process.exitCode = 2;
    return;
  }
  if (!Number.isInteger(args.exploreQuota) || args.exploreQuota < 0 || args.exploreQuota > 10) {
    console.error("--explore-quota 必须是 0-10 的整数");
    process.exitCode = 2;
    return;
  }

  const runId = args.runId ?? stampRunId();
  const runDir = join(ROOT, "runs", runId);
  await mkdir(runDir, {recursive: true});
  const nowIso = new Date().toISOString();
  const startedAt = Date.now();
  // 钱要花在明处：一个候选 9 张图，跑 10 个候选就是 90 次付费出图。
  if (!args.mockImages) {
    step("预算", `预计真实出图 ${args.candidates * 9} 张（每候选 9 张，--mock-images 可零成本路由）`);
  }

  // ── 段 0｜自检 ─────────────────────────────────────────────────────────────
  const doctor = await runDoctor({root: ROOT, nowIso});
  if (!doctor.ok) {
    console.error(`doctor 硬失败，按约束拒绝启动：${doctor.state?.error?.message ?? "unknown"}`);
    process.exitCode = 2;
    return;
  }
  const health = summarizeHealth(doctor.state);
  step("段0 自检", `doctor ok · 陈旧 ${health.stale.length} / 缺失 ${health.missing.length}`);
  const llmSelection = await selectLlmChannel(ROOT, args.mockLlm ? mockLlmChannel : undefined);
  step("通道", `判别 ${llmSelection.detail}${llmSelection.degraded ? "（降级）" : ""}`);
  const journal = createJournal({dir: join(runDir, "judgments")});

  const regionProfile = JSON.parse(await readFile(join(ROOT, "regions", args.region, "profile.json"), "utf8"));
  // 尺码体系跟法域走：单位与字段名都从 sizing.json 读，不许在代码里写死 "см"。
  const regionSizing = await readOptionalJson(join(ROOT, "regions", args.region, "sizing.json"));
  if (!regionSizing) {
    step("警告", `regions/${args.region}/sizing.json 缺失：尺码只按工单原样搬运，不做平台映射`);
  }
  // 成本口径与汇率：定价缺项必须点名，所以这里把策略与事实一次读齐。
  const costPolicy = await readOptionalJson(join(ROOT, "regions", args.region, "cost-policy.json"));
  const fxFacts = (await readOptionalJson(join(ROOT, "data/variables/fx.json"))) ?? [];
  let intakeAnswers = null;
  if (args.intake) {
    const doc = await readOptionalJson(resolve(String(args.intake)));
    intakeAnswers = doc?.answers ?? doc ?? null;
    if (!intakeAnswers) step("警告", `读不到 --intake 文件：${args.intake}`);
  }

  // 问卷硬门：缺必答项不是先跑起来再说，是直接不出包 —— 尺码/运费/佣金猜错的代价比停一天高得多。
  let intakeCheck = null;
  if (args.intake) {
    intakeCheck = validateIntake(intakeAnswers ?? {});
    if (!intakeCheck.ok) {
      console.error(`上架信息不齐：缺 ${intakeCheck.blocking_missing.length} 项必答，不出包也不出价。`);
      for (const item of intakeCheck.blocking_missing) console.error(`  - 缺 ${item.key}（${item.type}）：${item.question}`);
      for (const item of intakeCheck.invalid) console.error(`  - 错 ${item.key}：${item.reason}`);
      console.error("完整清单：node scripts/intake.mjs --list");
      process.exitCode = 2;
      return;
    }
    step("段0.5 问卷", `必答齐全 · 已填 ${intakeCheck.summary.filled} 项 · 采用默认 ${intakeCheck.summary.defaults_used} 项`);
  } else {
    step("段0.5 问卷", "未提供 --intake：只出包不出价，且不得声称可上架");
  }
  const canonicalKeys = (await readFile(join(ROOT, "data/specs/attributes.csv"), "utf8"))
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.split(",")[0]?.trim())
    .filter(Boolean);

  // 只对卖家真正有账号的平台出投影：没账号的平台即便平台存在，也只会产出无法提交的空壳。
  const activePlatforms = (regionProfile.platforms ?? []).filter((platform) =>
    (regionProfile.platform_accounts?.[platform]?.status ?? "active") !== "no_account"
  );
  const skippedPlatforms = (regionProfile.platforms ?? []).filter((platform) => !activePlatforms.includes(platform));

  const ctxBase = {
    category: args.category,
    region: regionProfile,
    health,
    knownKeys: [...new Set([...canonicalKeys, ...health.stale, ...health.missing])]
  };

  const audit = await judgePoint({
    pointId: "information_audit",
    ctx: ctxBase,
    channel: llmSelection.channel,
    journal,
    scope: "run"
  });

  // ── 段 1｜采集（真实工单） ──────────────────────────────────────────────────
  const skillRoots = await resolveSkillRoots({skillsRoot: args.skillsRoot});
  const selectionProbe = await probeSkill({root: skillRoots.selection});
  const tickets = await loadTickets({
    selectionRoot: args.tickets ? resolve(args.tickets) : skillRoots.selection,
    subdirs: args.tickets ? ["."] : undefined
  });
  if (tickets.total === 0) {
    const detail = tickets.missing_dirs.length > 0
      ? `选品工单目录不存在：${args.tickets ?? tickets.missing_dirs.join(", ")}`
      : "选品工单目录里没有 kind=sourcing_ticket 的文件";
    console.error(`采集为空，停止：${detail}`);
    // 报错要给"下一步"，不能只说缺什么。
    // 信息获取是链路第一段：这里必须说清"这个地区的信息从哪来"，而不是只说没有工单。
    const signalRegistry = await readFile(join(ROOT, "data/signal-sources.json"), "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => null);
    const autoSources = (signalRegistry?.sources ?? [])
      .filter((item) => item.tier === "A_auto" && ((item.regions ?? []).includes("*") || (item.regions ?? []).includes(String(args.region).toUpperCase())))
      .map((item) => item.what);
    console.error([
      "",
      `地区 ${args.region} 的信息获取路径：`,
      `  可自动：${autoSources.length ? autoSources.join("、") : "（无）"}`,
      "  需授权：自有店铺 API（Ozon Seller）、VK token、Wordstat 登录 —— 有凭证才跑得动",
      "  人工取样：多数平台无公开接口，只能人工抄 20 条竞品 → 写成 sourcing_ticket",
      "",
      "怎么解（任选一条）：",
      "  1. 已经有工单：--tickets <目录>",
      "  2. 只想验证链路：--tickets tests/fixtures/chain-tickets（内置样例，非真实商品）",
      "  3. 先看该地区到底能取到什么：npm run signals:probe -- --region " + args.region
    ].join("\n"));
    await writeFile(join(runDir, "chain.receipt.json"), pretty({
      run_id: runId, status: "no_data", detail, probes: {selection: selectionProbe}
    }));
    process.exitCode = 2;
    return;
  }

  // ── 段 2｜排序（确定性） ────────────────────────────────────────────────────
  step("段1 采集", `工单 ${tickets.total} 份 · 已有货源 ${tickets.tickets.filter((item) => item.offer_url).length} 份`);
  const {candidates: ranked, score, profile} = rankCandidates({
    tickets: tickets.tickets,
    profile: args.profile,
    limit: args.candidates
  });
  await writeFile(join(runDir, "candidates.json"), pretty({run_id: runId, profile, count: ranked.length, candidates: ranked}));
  step("段2 排序", `${ranked.length} 个候选 · 画像 ${profile} · 首名 ${ranked[0]?.topic ?? "-"} ${ranked[0]?.score?.total ?? ""}`.trim());

  // ── 段 3｜市场画像（一次，所有候选共用） ────────────────────────────────────
  const marketProfile = await judgePoint({
    pointId: "market_profile",
    ctx: ctxBase,
    channel: llmSelection.channel,
    journal,
    scope: "run"
  });
  step("段3 市场画像", `画像 ${marketProfile.value?.profile_id ?? "-"} · 人群 ${marketProfile.value?.age_band ?? "-"} · 调色 ${(marketProfile.value?.palette ?? []).length} 色 · 来源 ${marketProfile.source}`);

  const personaRegistry = (await readOptionalJson(join(ROOT, "data/personas.json")))?.personas ?? [];
  const gateQuota = {total: args.exploreQuota, used: 0};
  step("段3.5 人群", `注册 ${personaRegistry.length} 个假设 · 探索配额 ${gateQuota.total}`);

  const imageSelection = await selectImageChannel(
    ROOT,
    args.mockImages ? (await import("../channels/imagegen/mock.mjs")) : undefined
  );
  const modelingProbe = await probeSkill({
    root: skillRoots.modeling,
    script: "scripts/booth.mjs",
    args: ["--design", "presets/booth-design.json", "--dry"]
  });
  const basePreset = modelingProbe.ok
    ? JSON.parse(await readFile(join(skillRoots.modeling, "presets/booth-design.json"), "utf8"))
    : null;

  const produced = [];
  for (const candidate of ranked) {
    const sku = skuFor(candidate, candidate.rank);
    step(`候选 ${candidate.rank}/${ranked.length}`, sku);
    const ticket = candidate.ticket ?? {};
    const scope = sku;

    // ── 参考图分级：几何（确定性）+ 视觉（有通道才做） ──
    const aliases = JSON.parse(await readFile(join(ROOT, "data/aliases/ref-aliases.json"), "utf8")).aliases ?? {};
    const refFiles = await loadReferenceImages({
      uploadRoot: skillRoots.upload,
      slug: ticket.slug,
      keyword: ticket.keyword,
      aliases
    });
    const refs = await probeReferences(refFiles.images, {
      vision: llmSelection.degraded ? null : (input) => llmSelection.channel.run({...input, point: "vision_ref"})
    });
    // 没有参考图就不做分级 —— 让判别点对空集合给结论，等于逼它编。
    const refRoles = refs.length === 0
      ? {source: "skipped_no_reference", binding: false, value: null, conflicts: []}
      : await judgePoint({
        pointId: "ref_roles",
        ctx: {...ctxBase, refs, candidate},
        channel: llmSelection.channel,
        journal,
        scope
      });

    // ── 拍摄计划 ──
    const shootPlan = await judgePoint({
      pointId: "shoot_plan",
      ctx: {...ctxBase, candidate, refs, judgments: {market_profile: marketProfile}},
      channel: llmSelection.channel,
      journal,
      scope
    });

    // ── 成本：先看工单有没有，再让判别层决定能不能估 ──
    const productFacts = ticketProductFacts(ticket);
    // 商品身份（品类/颜色/材质/人群/品牌）必须一路带到文案与出图，不能只剩品类词。
    // 颜色与性别工单经常缺、又是平台必填，所以问卷答了就以问卷为准（同成本/尺码口径）。
    const ticketAttrs = mergeIntakeAttributes(ticketAttributes(ticket), intakeAnswers);
    const hasCost = productFacts.some((fact) => fact.key === "cost");
    const hasWeight = productFacts.some((fact) => fact.key === "weight");
    const estimate = hasCost && hasWeight ? null : await judgePoint({
      pointId: "cost_estimate",
      ctx: {...ctxBase, candidate, facts: {material: ticket.composition ?? ticket.material}},
      channel: llmSelection.channel,
      journal,
      scope
    });

    const supplier = resolveSupplier({
      offers: ticket.offer_url ? [{
        ref: "ref-01",
        price_cny: ticket.price_cny,
        weight_g: ticket.weight_g,
        url: ticket.offer_url,
        fetched_at: ticket.signal_date ? `${ticket.signal_date}T00:00:00.000Z` : null,
        title: ticket.cn_title
      }] : [],
      decision: ticket.offer_url ? {
        picks: [{ref: "ref-01", verdict: "same_style", role: "hero", why: "选品工单已锁定该货源链接"}],
        rejected: []
      } : null,
      estimate: estimate?.value ?? null,
      sku
    });

    // ── 平台规格与文案 ──
    const platformMapping = await judgePoint({
      pointId: "platform_mapping",
      ctx: {...ctxBase, canonicalKeys, platform: {id: regionProfile.platforms?.[0] ?? "unknown"}},
      channel: llmSelection.channel,
      journal,
      scope
    });
    const copyPitch = await judgePoint({
      pointId: "copy_pitch",
      ctx: {
        ...ctxBase,
        candidate,
        facts: Object.fromEntries(productFacts.map((fact) => [fact.key.split(".")[0], fact.value])),
        attributes: ticketAttrs,
        copyLimits: {descMax: 600, bulletMax: 6, keywordMax: 10, langScript: "cyrillic", fallbackDesc: null}
      },
      channel: llmSelection.channel,
      journal,
      scope
    });

    // ── 人群归属：模型判断「给谁」，代码决定「能不能进 test」 ──
    const personaDecision = await judgePoint({
      pointId: "persona_assign",
      ctx: {
        ...ctxBase,
        ticket,
        candidate,
        personas: personaRegistry,
        ticketRef: `ticket:${ticket.slug ?? ticket.merge_attribute ?? sku}#signals`
      },
      channel: llmSelection.channel,
      journal,
      scope
    });
    const personaValue = personaDecision.value ?? {};
    const matchedPersona = personaRegistry.find((item) => item.id === personaValue.persona_id) ?? null;
    const falsifier = matchedPersona
      ? checkFalsifier({persona: matchedPersona, signals: ticket.signals ?? {}})
      : null;
    const gate = applyPersonaGate({
      decision: baseDecisionFromQuality(ticket.quality_score),
      persona: matchedPersona ?? {id: "unassigned", status: "unassigned"},
      quota: gateQuota,
      falsifier
    });
    if (gate.quota_used) gateQuota.used += 1;
    const personaForInput = matchedPersona
      ? {
        id: matchedPersona.id,
        label: matchedPersona.label_ru ?? matchedPersona.label_zh ?? matchedPersona.id,
        status: matchedPersona.status,
        evidence_ids: personaValue.evidence_ids ?? [],
        falsifier_ok: falsifier ? falsifier.ok : null
      }
      : null;
    const positioning = matchedPersona
      ? {
        trigger: matchedPersona.jobs?.[0] ?? "日常穿搭",
        objection: matchedPersona.objections?.[0] ?? "不合身",
        proof: matchedPersona.proof_needed?.[0] ?? "面料近景"
      }
      : null;
    const personaBrief = creativeBriefFrom(matchedPersona);

    // 品牌授权门：卖品牌款却没授权，是侵权下架的高频原因，且平台侧处罚重。
    // 这里不猜大概是白牌，只认卖家明确说的：自有/白牌 → 放行；代理/未答 → 封顶 observe + 交接说明标 BLOCKED。
    const brandAnswer = String(intakeAnswers?.brand_authorization ?? "").trim();
    const brandCovered = /自有|白牌|自主|own brand/i.test(brandAnswer);
    const complianceGate = {
      brand_authorization: brandAnswer || null,
      passed: brandCovered,
      reason: brandCovered ? "self_or_white_label" : brandAnswer ? "brand_needs_license" : "brand_unknown"
    };
    if (!brandCovered) gate.decision = minDecision(gate.decision, "observe");
    const extraBlockers = [];
    if (!brandCovered) extraBlockers.push(`品牌授权未证（${complianceGate.reason}）：不得上架品牌款`);
    if (!intakeAnswers) extraBlockers.push("上架信息未收齐（--intake 缺失）：价格未出，不得声称可上架");
    step("  人群", `${personaValue.persona_id ?? "unassigned"} · ${personaDecision.source} · 决策 ${gate.decision}${gate.capped ? `（封顶：${gate.reason}）` : `（${gate.reason}）`}`);

    // ── 上品输入 ──
    const {input, meta} = buildListingInput({
      sku,
      destination: args.region,
      category: args.category,
      closeToSkin: /бель|блуз|топ|плать|юбк/i.test(String(ticket.keyword ?? "")) ? true : false,
      isChild: false,
      productFacts,
      supplierFacts: supplier.facts,
      attributes: ticketAttrs,
      platformMapping: platformMapping.value,
      copyPitch: copyPitch.value,
      marketProfile: marketProfile.value,
      platforms: activePlatforms,
      candidate: {title: ticket.cn_title ?? candidate.title, design_elements: (ticket.design_elements ?? []).map((item) => item.word)},
      // 尺码表必须整表带过去：只带表头会退化成"有表无数据"，下游画不出任何尺寸图。
      // 来源优先级：问卷手填 > 选品工单（用户说的才是最新事实；工单是二手采集）。
      size: (() => {
        const ticketChart = ticket.size_chart ?? null;
        const intakeParsed = parseSizeRows(intakeAnswers?.size_chart_rows, ticketChart?.columns ?? []);
        const mergedRows = {
          ...(ticketChart?.rows ?? {}),
          ...(intakeParsed.rows ?? {})
        };
        if (Object.keys(mergedRows).length === 0) return null;
        return {
          status: "reported",
          label: regionSizing?.label ?? null,
          unit: regionSizing?.unit ?? null,
          system: regionSizing?.system ?? null,
          columns: ticketChart?.columns ?? intakeParsed.columns ?? [],
          rows: mergedRows,
          source: intakeParsed.rows ? "intake+sourcing_ticket" : "sourcing_ticket",
          intake_parse: intakeParsed.rows ? null : intakeParsed.reason
        };
      })(),
      signalQuery: ticket.keyword ?? null,
      pricingFacts: supplier.pricing_facts ?? [],
      persona: personaForInput,
      positioning,
      // 只送契约认的字段：note 是给人看的说明，不进上品输入（schema additionalProperties=false 会挡住）
      creativeBrief: personaBrief.must_show.length > 0 || personaBrief.must_not.length > 0
        ? {must_show: personaBrief.must_show, must_not: personaBrief.must_not, audience: personaBrief.audience}
        : null
    });
    await validateInputAgainstSchema(ROOT, input);
    await mkdir(join(ROOT, "input"), {recursive: true});
    await writeFile(join(ROOT, "input", `${sku}.json`), pretty(input));

    // ── 定价：先算"缺什么"，再决定要不要出价 ──
    // 现实教训：运费/佣金/税费/手续费这四项没人主动提供，缺一项算出来的不是低价而是亏损价。
    // 所以这里不补行业均值，只把缺的项点名写进 reasons。
    const pricing = computePricing({
      ticket,
      region: regionProfile,
      costPolicy,
      intakeAnswers,
      fxFacts
    });

    // ── 尺码 → 平台字段：各平台结构不同，必须逐平台映射 ──
    const sizeMappings = {};
    for (const platform of activePlatforms) {
      sizeMappings[platform] = adaptSizeToPlatform({
        size: input.size ?? null,
        regionSizing,
        platform,
        // 开局问的尺码字段名只对"问的那个平台"有效。
        // 问卷是单答案的，若拿它去确认所有平台，等于用 A 平台的认知替 B 平台背书 ——
        // 各平台变体名叫法不同（Size / Size Name / 尺码），混用会让人以为已核过。
        fieldConfirmation: (() => {
          const askedPlatform = String(intakeAnswers?.platform ?? "").trim();
          if (askedPlatform && askedPlatform !== platform) return null;
          const answer = String(intakeAnswers?.platform_size_field ?? "").trim();
          if (!answer || answer.toLowerCase() === "unknown") return null;
          return "confirmed_by_seller";
        })()
      });
    }

    // 平台必填属性：来自 regions/<CC>/sizing.json（由 scripts/ozon-required-attrs.mjs 只读实测写入）。
    // 这是"能不能过审核"的硬清单，必须随包交付，不能只留在文档里。
    const requiredAttributes = {};
    for (const platform of activePlatforms) {
      requiredAttributes[platform] = regionSizing?.platform_fields?.[platform]?.required_attributes ?? null;
    }

    // ── 建模任务单 ──
    const modelingPlan = planModeling({
      sku,
      category: args.category,
      palette: marketProfile.value?.palette ?? [],
      facts: {material: ticket.composition ?? ticket.material ?? null},
      basePreset,
      wantProductAsset: false,
      slots: ["hero", "detail"]
    });
    const persisted = await persistModelingPlan({root: ROOT, plan: modelingPlan});

    // ── 并行：一条线出图出包，另一条线建模 ──
    const brief = briefFrom({shootPlan, marketProfile, slot: "scene"});
    const imagingChannel = {
      meta: imageSelection.channel.meta,
      probe: imageSelection.channel.probe,
      run: (channelInput = {}) => imageSelection.channel.run({...channelInput, brief})
    };

    const [packaging, modeling] = await Promise.allSettled([
      runPackage({
        root: ROOT,
        sku,
        nowIso: new Date().toISOString(),
        imageChannel: imagingChannel,
        extraBlockers,
        sizeMappings,
        requiredAttributes,
        pricing,
      }),
      persisted
        ? runModeling({
          modelingRoot: skillRoots.modeling,
          designPath: persisted.designPath,
          outDir: join(ROOT, "assets", "3d", sku),
          dry: args.dryModeling
        })
        : Promise.resolve({status: "unavailable", detail: "无建模基准设计", files: []})
    ]);

    const modelingResult = modeling.status === "fulfilled"
      ? modeling.value
      : {status: "unavailable", detail: String(modeling.reason?.message ?? "建模异常"), files: []};
    const packageResult = packaging.status === "fulfilled"
      ? {status: "ok", packageDir: packaging.value.packageDir, receipt: packaging.value.receipt}
      : {status: "failed", detail: String(packaging.reason?.message ?? "出包异常")};
    // 失败必须当场说原因：静默的 failed 等于让人去猜。
    if (packageResult.status === "failed") {
      console.error(`[出包失败] ${sku}：${packageResult.detail}`);
    }
    // 成品在哪、几张图，回执里必须能直接读出来，不能让人去翻目录猜。
    let imageCount = 0;
    if (packageResult.packageDir) {
      const manifest = await readOptionalJson(join(packageResult.packageDir, "master/manifest.json"));
      imageCount = Array.isArray(manifest?.images) ? manifest.images.length : 0;

      // 尺码映射已由 runPackage 在 assemble 之前写入平台目录（handoff 要引用同一份文件），
      // 这里不再重复写，避免"两处写、顺序不同"。
    }

    produced.push({
      sku,
      rank: candidate.rank,
      candidate_id: candidate.id,
      topic: candidate.topic,
      score: candidate.score,
      package: {...packageResult, images: imageCount},
      listing: meta,
      sourcing: {status: supplier.status, reason: supplier.reason, facts: supplier.facts.map((fact) => ({key: fact.key, source_kind: fact.source_kind}))},
      reference_images: refs.map((ref) => ({id: ref.id, flags: ref.probe.flags, vision: ref.probe.vision})),
      modeling: {
        status: modelingResult.status,
        detail: modelingResult.detail,
        exit_code: modelingResult.exit_code ?? null,
        dir: modelingResult.dir ?? null,
        files: modelingResult.files ?? [],
        kind: modelingPlan.kind,
        product_in_scene: modelingPlan.product_in_scene,
        listing_contribution: modelingPlan.listing_contribution ?? "unknown",
        scene_note: modelingPlan.scene_note
      },
      persona: {
        id: personaValue.persona_id ?? "unassigned",        status: personaValue.status ?? "unassigned",
        source: personaDecision.source,
        evidence_ids: personaValue.evidence_ids ?? [],
        falsifier,
        decision: gate.decision,
        gate_capped: gate.capped,
        gate_reason: gate.reason
      },
      pricing,
      compliance_gate: complianceGate,
      size_mappings: sizeMappings,
      judgments: {
        market_profile: marketProfile.source,
        ref_roles: refRoles.source,
        shoot_plan: shootPlan.source,
        cost_estimate: estimate?.source ?? "skipped_have_facts",
        platform_mapping: platformMapping.source,
        copy_pitch: copyPitch.source,
        persona_assign: personaDecision.source
      }
    });
  }

  const journalSummary = journal.summary();
  const personaGateSummary = {
    quota_total: gateQuota.total,
    quota_used: gateQuota.used,
    capped: produced.filter((item) => item.persona?.gate_capped).length,
    assigned: produced.filter((item) => (item.persona?.id ?? "unassigned") !== "unassigned").length
  };
  const modelingAll = produced.map((item) => item.modeling);
  const degradations = chainDegradations({
    doctor,
    llmSelection,
    imageSelection,
    tickets,
    modeling: modelingAll.find((item) => item.status !== "rendered" && item.status !== "planned") ?? null,
    judges: journalSummary
  });

  // 证据等级只认台账，不认「通道已配置」。写死一句话会把 0 次模型调用吹成 L2。
  const imageCount = produced.reduce((sum, item) => sum + (item.package.images ?? 0), 0);
  const levels = judgeEvidenceLevels({
    judges: journalSummary,
    stubbed: args.mockLlm,
    channelDegraded: llmSelection.degraded,
    imageCount,
    imageStubbed: imageSelection.degraded
  });
  const llmLevel = levels.llm;
  const imageLevel = levels.images;

  const receipt = {
    run_id: runId,
    stage: "chain",
    status: produced.every((item) => item.package.status === "ok") ? "complete" : "partial",
    started_at: nowIso,
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    inputs: {
      category: args.category,
      region: args.region,
      candidates: args.candidates,
      profile,
      platforms_active: activePlatforms,
      platforms_skipped: skippedPlatforms.map((platform) => ({
        platform,
        reason: regionProfile.platform_accounts?.[platform]?.note ?? "无账号"
      }))
    },
    stages: {
      preflight: {status: doctor.ok ? "pass" : "fail", stale: health.stale.length, missing: health.missing.length},
      audit: {source: audit.source, actions: audit.value?.actions?.length ?? 0},
      collect: {
        selection_skill: selectionProbe,
        tickets_total: tickets.total,
        tickets_ready: tickets.ready_count,
        missing_dirs: tickets.missing_dirs
      },
      rank: {profile, deterministic: true, input_sha256: score?.input_sha256 ?? null},
      produce: produced.map((item) => ({
        sku: item.sku,
        rank: item.rank,
        package: item.package.status,
        package_dir: item.package.packageDir ?? null,
        package_run_id: item.package.receipt?.run_id ?? null,
        images: item.package.images ?? 0,
        modeling: item.modeling.status,
        modeling_kind: item.modeling.kind ?? null,
        product_in_scene: item.modeling.product_in_scene ?? null,
        modeling_listing_contribution: item.modeling.listing_contribution ?? "unknown",
        modeling_dir: item.modeling.dir ?? null,
        modeling_files: item.modeling.files?.length ?? 0,
        modeling_note: item.modeling.scene_note ?? null,
        persona: item.persona,
        pricing: item.pricing,
        compliance_gate: item.compliance_gate,
        size_mappings: item.size_mappings,
        judgments: item.judgments
      }))
    },
    degradations,
    persona_gate: personaGateSummary,
    judges: journalSummary,
    evidence_levels: {
      market_signals: "L1（选品工单为历史快照，source_type=secondary）",
      llm_judgments: llmLevel,
      images: imageLevel,
      modeling: args.dryModeling
        ? "L0（只做规则校验与计划）"
        : produced.some((item) => item.modeling.product_in_scene)
          ? "L1（本地渲染，未上平台）"
          : "L1（本地展陈空间渲染；商品本体不在场景内，招牌与道具来自基准展位）",
      platform_submission: "未做"
    },
    cost: {
      unit_price_cny: null,
      unit_price_reason: "供应商价格页未取到机器可读单价，只记 token 用量，不折算金额",
      tokens: journalSummary.usage
    }
  };

  await writeFile(join(runDir, "chain.receipt.json"), pretty(receipt));
  const lines = [
    `# 链路回执 ${runId}`,
    "",
    `- 输入：品类 ${args.category} / 法域 ${args.region} / 候选 ${args.candidates}`,
    `- 工单：${tickets.total} 份，其中已有货源 ${tickets.ready_count} 份`,
    `- 判别：${journalSummary.total} 次（LLM ${journalSummary.by_source.llm ?? 0} / 回退 ${journalSummary.by_source.fallback ?? 0}）`,
    `- 降级：${degradations.length === 0 ? "无" : degradations.map((item) => `${item.kind}: ${item.detail}`).join("；")}`,
    "",
    "| 排名 | SKU | 人群 | 决策 | 出包 | 展陈渲染 | 货源 | 判别来源 |",
    "|---|---|---|---|---|---|---|---|"
  ];
  for (const item of produced) {
    const personaCell = item.persona ? `${item.persona.id}${item.persona.gate_capped ? "（封顶）" : ""}` : "unassigned";
    lines.push(`| ${item.rank} | ${item.sku} | ${personaCell} | ${decisionLabel(item.persona?.decision)} | ${item.package.status} | ${item.modeling.status} | ${item.sourcing.status} | ${Object.entries(item.judgments).map(([key, value]) => `${key}=${value}`).join(" ")} |`);
  }
  const sceneNotes = [...new Set(produced.map((item) => item.modeling.scene_note).filter(Boolean))];
  if (sceneNotes.length > 0) lines.push("", `> 展陈渲染说明：${sceneNotes.join("；")}`);
  lines.push("", `> 平台：产出 ${activePlatforms.join("、") || "（无）"}${skippedPlatforms.length > 0 ? `；跳过 ${skippedPlatforms.map((p) => `${p}（无账号）`).join("、")}` : ""}`);

  // 跑完最该知道的是"接下来做什么、还缺什么"，而不是只给一张表。
  const nextSteps = [];
  const gaps = [];
  for (const item of produced) {
    if (item.package.status === "ok" && item.package.packageDir) {
      nextSteps.push(`打开 \`${item.package.packageDir}/handoff.md\`，按「开工三步」往下做`);
    }
    if (item.pricing?.status === "unavailable") {
      nextSteps.push(`价格没出：补齐 ${(item.pricing.reasons ?? []).map(humanizeReason).join("、")} 后带 --intake 重跑`);
    }
    for (const [platform, mapping] of Object.entries(item.size_mappings ?? {})) {
      if (mapping?.needs_field_confirmation) {
        nextSteps.push(`${platform} 尺码字段未核实：跑 \`npm run sizing:confirm\``);
      } else if (mapping?.status === "blocked") {
        gaps.push(`${item.sku}｜${platform} 尺码填不了：缺 ${(mapping.missing ?? []).map(humanizeReason).join("、")}`);
      }
    }
    if (item.compliance_gate && item.compliance_gate.passed === false) {
      gaps.push(`${item.sku}｜品牌授权没说明（自有/白牌/代理）：decision 已封顶 observe，别当可上架`);
    }
  }
  if (!args.intake) nextSteps.push("这次没带 --intake：价格与授权都没有结论，别拿去上架");
  const firstSku = produced.find((item) => item.package?.status === "ok")?.sku;
  if (firstSku) nextSteps.push(`提交前先查平台必填覆盖：node scripts/check-attrs-coverage.mjs --sku ${firstSku}`);
  if (nextSteps.length === 0) nextSteps.push("没有产出成品包，先看上面的失败原因");
  lines.push("", "## 下一步", ...[...new Set(nextSteps)].map((step, index) => `${index + 1}. ${step}`));
  if (gaps.length > 0) lines.push("", "## 还缺什么", ...gaps.map((gap) => `- ${gap}`));

  await writeFile(join(runDir, "chain.md"), `${lines.join("\n")}\n`, "utf8");

  console.log(lines.join("\n"));
  const failed = produced.filter((item) => item.package.status !== "ok").length;
  process.exitCode = failed > 0 ? 3 : 0;
}

await main();
