import {execFile} from "node:child_process";
import {mkdir, readdir, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {promisify} from "node:util";
import sharp from "sharp";
import {buildCandidates} from "../../core/selection/collect.mjs";
import {scoreCategories} from "../../core/signals/score.mjs";

const exec = promisify(execFile);

/**
 * 六段流程里「可以脱离命令行独立测试」的部分都放这里。
 * 好处很实际：测试不用起浏览器、不用花钱、不用联网，判据仍然是真判据。
 */

/** 工单 → 打分输入。信号只搬运，不重新解释；解释权在 core/signals。 */
export function ticketSignals(tickets = []) {
  const signals = [];
  const supply = [];
  for (const ticket of tickets) {
    const topic = String(ticket.merge_attribute ?? ticket.slug ?? ticket.keyword ?? "").trim();
    if (!topic) continue;
    const buckets = ticket.signals ?? {};
    const mentions = Number(ticket.trend_score ?? Object.values(buckets).reduce((sum, value) => sum + (Number(value) || 0), 0));
    signals.push({
      topic,
      title: String(ticket.cn_title ?? ticket.keyword ?? topic),
      mentions,
      engagement: Number(buckets["S7-互动量"] ?? 0),
      fetched_at: ticket.signal_date ? `${ticket.signal_date}T00:00:00.000Z` : null,
      source_url: null,
      source_type: "secondary"
    });
    supply.push({
      topic,
      sellers: Number.isFinite(Number(ticket.listed_hits)) ? Number(ticket.listed_hits) : null,
      price_cny: Number.isFinite(Number(ticket.price_cny)) ? Number(ticket.price_cny) : null
    });
  }
  return {signals, supply};
}

/**
 * 排序：先用 core/selection 归一，再用 core/signals 确定性打分。
 * 这里刻意**不**让模型参与 —— G8 要求同一输入两次逐字节一致，混入模型输出就做不到。
 */
export function rankCandidates({tickets = [], profile = "conservative", limit = 5} = {}) {
  const {signals, supply} = ticketSignals(tickets);
  const candidates = buildCandidates({signals, supply, now: Date.parse("2026-10-29T00:00:00.000Z"), limit: 200});
  if (candidates.length === 0) return {candidates: [], score: null};
  const score = scoreCategories({candidates});
  const ranking = score.rankings[profile] ?? score.rankings.conservative;
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const ticketByTopic = new Map(tickets.map((ticket) => [String(ticket.merge_attribute ?? ticket.slug ?? ticket.keyword ?? "").trim(), ticket]));
  const ranked = ranking.slice(0, limit).map((entry) => {
    const candidate = byId.get(entry.candidate_id);
    const ticket = ticketByTopic.get(candidate.topic) ?? null;
    return {
      ...candidate,
      ticket,
      score: entry.score,
      rank: entry.rank,
      vector: entry.vector
    };
  });
  return {candidates: ranked, score, profile};
}

/**
 * 工单里能直接进上品属性的字段，只取规范化字典里有的七个键。
 *
 * 现实缺陷：先前这里传空数组，出图提示词只能拿到品类词「女装」，
 * 于是模型画出一件看着像打底衫的开衫 —— 商品身份根本没进过提示词。
 * 值一律保持源语言原样（不翻译、不美化），这是「同一件商品」的唯一锚点。
 * merge_card 是唯一的派生键：官方 #8292 说明「不需要合并就填唯一值（如唯一货号）」，
 * 单 SKU 包不与其他商品合并，取工单唯一货号（slug），确定性、可复现。
 */
export function ticketAttributes(ticket = {}) {
  const rows = [];
  const push = (canonicalKey, value, confidence = "high") => {
    if (value === null || value === undefined) return;
    const text = typeof value === "string" ? value.trim() : value;
    if (text === "" || text === 0) return;
    rows.push({canonical_key: canonicalKey, value: text, synonyms: "", confidence});
  };
  const spec = Array.isArray(ticket.specs) ? ticket.specs[0] ?? {} : {};
  const brand = String(ticket.brand ?? "").trim();
  push("brand", /^无品牌$|^no\s*brand$/i.test(brand) ? "NO BRAND" : brand);
  push("product_type", ticket.cn_title ?? ticket.category);
  push("color", spec.color ?? spec.color_name);
  push("material", ticket.composition ?? ticket.material);
  push("audience", ticket.gender);
  push("merge_card", ticket.slug ?? ticket.name);
  return rows;
}

/**
 * 问卷优先级：颜色与性别是平台必填属性，而工单里经常没有。
 * 口径与成本、尺码一致 —— 问卷手填 > 工单，答 unknown 视为没答。
 */
export function mergeIntakeAttributes(rows = [], answers = null) {
  if (!answers) return rows;
  const pairs = [["color", "color"], ["gender", "audience"]];
  const merged = rows.map((row) => ({...row}));
  for (const [answerKey, canonicalKey] of pairs) {
    const raw = answers[answerKey];
    if (raw === null || raw === undefined) continue;
    const text = String(raw).trim();
    if (text === "" || /^unknown$/i.test(text)) continue;
    const existing = merged.find((row) => row.canonical_key === canonicalKey);
    if (existing) {
      existing.value = text;
      existing.confidence = "high";
      existing.source = "intake";
    } else {
      merged.push({canonical_key: canonicalKey, value: text, synonyms: "", confidence: "high", source: "intake"});
    }
  }
  return merged;
}

/** 工单里已有的商品事实。reported 就是 reported，不升级成 measured。 */
export function ticketProductFacts(ticket = {}) {
  const facts = [];
  if (ticket.composition || ticket.material) {
    facts.push({
      key: "material.composition",
      value: String(ticket.composition ?? ticket.material),
      unit: null,
      source_kind: "reported",
      basis: "选品工单字段，源自货源页商品描述，未送检",
      confidence: "medium"
    });
  }
  if (ticket.price_cny) {
    facts.push({
      key: "cost",
      value: Number(ticket.price_cny),
      unit: "CNY",
      source_kind: "reported",
      basis: `货源页标价（${ticket.offer_url ? "含来源链接" : "无来源链接"}），未下单验证`,
      confidence: ticket.offer_url ? "medium" : "low"
    });
  }
  if (ticket.weight_g) {
    facts.push({
      key: "weight",
      value: Number(ticket.weight_g),
      unit: "g",
      source_kind: "reported",
      basis: "货源页克重，未实测",
      confidence: "medium"
    });
  }
  return facts;
}

const DATA_URL_MIME = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"};

function mimeFor(path) {
  const dot = path.lastIndexOf(".");
  return DATA_URL_MIME[path.slice(dot).toLowerCase()] ?? "image/jpeg";
}

/**
 * 参考图分级的第一层：几何与体积（确定性，零成本）。
 * 第二层交给视觉判别（有 key 才做）—— 没 key 就只留几何层，
 * 并把 `vision=false` 写进证据，别让下游以为做过视觉筛查。
 */
export async function probeReferences(paths = [], {vision = null, maxImages = 6} = {}) {
  const refs = [];
  for (const [index, path] of paths.slice(0, maxImages).entries()) {
    const meta = await sharp(path).metadata();
    const ref = {
      id: `ref-${String(index + 1).padStart(2, "0")}`,
      path,
      width: meta.width ?? null,
      height: meta.height ?? null,
      bytes: null,
      probe: {flags: [], vision: false, notes: []}
    };
    const stats = await sharp(path).stats().catch(() => null);
    ref.probe.mean_channel = stats ? stats.channels.map((channel) => Math.round(channel.mean)) : null;
    if ((meta.width ?? 0) < 800) ref.probe.flags.push("low_resolution");
    if (meta.width && meta.height && meta.height > meta.width * 1.6) ref.probe.flags.push("unusual_aspect");
    refs.push(ref);
  }

  if (vision && refs.length > 0) {
    for (const ref of refs) {
      const base64 = await readFile(ref.path, {encoding: "base64"});
      const dataUrl = `data:${mimeFor(ref.path)};base64,${base64}`;
      const result = await vision({
        images: [dataUrl],
        user: "看图后只输出 JSON：subjects(画面里的人数，整数)、selfie(是否对镜自拍)、handheld(是否手持手机或相机)、second_person(是否有第二个人或镜中倒影)、plain_background(背景是否纯色无杂物)、garment(品类与主色，一句话)",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["subjects", "selfie", "handheld", "second_person", "plain_background", "garment"],
          properties: {
            subjects: {type: "integer", minimum: 0, maximum: 9},
            selfie: {type: "boolean"},
            handheld: {type: "boolean"},
            second_person: {type: "boolean"},
            plain_background: {type: "boolean"},
            garment: {type: "string"}
          }
        },
        maxTokens: 256
      });
      if (result?.ok) {
        ref.probe.vision = true;
        ref.probe.visual = result.value;
        if (result.value.selfie) ref.probe.flags.push("selfie");
        if (result.value.handheld) ref.probe.flags.push("handheld");
        if (result.value.second_person || result.value.subjects > 1) ref.probe.flags.push("multi_subject");
        if (!result.value.plain_background) ref.probe.flags.push("busy_background");
      } else {
        ref.probe.notes.push(`vision_failed:${result?.fault?.reason ?? "unknown"}`);
      }
    }
  }
  return refs;
}

const LIGHT_TEXT = {
  north_window: "light comes from a large window on the north wall: soft, directional, never direct sun",
  east_window: "light comes from a window on the east wall: crisp morning light, short shadows",
  west_window: "light comes from a window on the west wall: warm late light, long shadows",
  overcast: "flat overcast daylight: evenly diffused, no visible sun disc, minimal shadow edges",
  artificial: "controlled studio strobes: soft key from one side, deep falloff on the other"
};

const FRAMING_TEXT = {
  full: "full body framed head to toe with margin above the head and below the feet",
  three_quarter: "three-quarter framing from mid-thigh up",
  half: "half-body framing from the waist up",
  macro: "tight macro framing on fabric texture and stitching"
};

const ACTION_TEXT = {
  stand: "standing still, relaxed shoulders",
  walk: "mid-stride walking, fabric caught in motion",
  turn: "turning slightly away from camera, back structure partially visible",
  sit: "seated on the available prop",
  lean: "leaning against the available structure"
};

/**
 * 判别结果 → 生图 brief。
 * 全部写成「画面里看得见的东西」：不写 3:1、不写 4200K。
 * 这是 v7.3 那条结论的直接移植：模型读的是画面，不是摄影师的滑杆。
 */
export function briefFrom({shootPlan, marketProfile, slot}) {
  if (!shootPlan?.value?.location || !Array.isArray(shootPlan.value.shots)) return null;
  const shot = shootPlan.value.shots.find((item) => item.slot === slot) ?? shootPlan.value.shots[0];
  const location = shootPlan.value.location;
  const persona = marketProfile?.value
    ? `Model look: ${marketProfile.value.age_band} years old, ${marketProfile.value.hair}, ${marketProfile.value.complexion} complexion, palette leaning ${marketProfile.value.palette.join("/")}.`
    : null;
  return {
    light: `${LIGHT_TEXT[location.light_source] ?? LIGHT_TEXT.overcast}; room depth ${location.depth_m}m so the background stays close and the falloff is visible.`,
    framing: `${FRAMING_TEXT[shot?.framing] ?? FRAMING_TEXT.three_quarter}, shot on ${shot?.lens ?? "50mm"}.`,
    action: ACTION_TEXT[shot?.action] ?? ACTION_TEXT.stand,
    persona,
    constraints: location.family === "studio"
      ? "Seamless studio wall, single subject, no props except the garment itself, no reflections of a phone or a second person."
      : "Real interior, single subject, no handheld device, no second person, background clutter kept out of frame."
  };
}

/** 渲染物清单：只列图片与设计/清单文件，用来让「已渲染」可核验。 */
async function listRenders(dir) {
  try {
    const entries = await readdir(dir, {withFileTypes: true});
    return entries
      .filter((entry) => entry.isFile() && /\.(png|jpg|jpeg|webp|json)$/i.test(entry.name))
      .map((entry) => join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/** 建模：真实调用建模 skill 的渲染入口；没有环境就明确降级，不假装出图。 */
export async function runModeling({modelingRoot, designPath, outDir, dry = true, timeoutMs = 300_000, runner = exec}) {
  if (!modelingRoot) return {status: "unavailable", detail: "未配置建模 skill 根目录", files: []};
  await mkdir(outDir, {recursive: true});
  const args = ["scripts/booth.mjs", "--design", designPath, "--out", outDir];
  if (dry) args.push("--dry");
  try {
    const {stdout, stderr} = await runner(process.execPath, args, {
      cwd: modelingRoot,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    });
    return {
      status: dry ? "planned" : "rendered",
      detail: "建模 skill 执行成功",
      exit_code: 0,
      dir: outDir,
      // 说 rendered 就得给出渲染物，否则回执里的「已渲染」无法核验。
      files: dry ? [] : await listRenders(outDir),
      stdout: String(stdout).slice(-4_000),
      stderr: String(stderr).slice(-1_000)
    };
  } catch (error) {
    const code = typeof error.code === "number" ? error.code : null;
    return {
      status: code === 3 ? "qa_failed" : "unavailable",
      detail: `建模 exit=${code ?? "unknown"}：${String(error.message ?? "").slice(0, 300)}`,
      exit_code: code,
      stdout: String(error.stdout ?? "").slice(-2_000),
      stderr: String(error.stderr ?? "").slice(-1_000),
      files: []
    };
  }
}

/** 把建模计划落到磁盘，保证「任务单」本身是可复现的产物。 */
export async function persistModelingPlan({root, plan}) {
  if (!plan?.design) return null;
  const dir = join(root, "assets", "3d", plan.sku);
  await mkdir(dir, {recursive: true});
  const designPath = join(dir, "design.json");
  await writeFile(designPath, `${JSON.stringify(plan.design, null, 2)}\n`);
  await writeFile(join(dir, "plan.json"), `${JSON.stringify({...plan, design: undefined}, null, 2)}\n`);
  return {designPath, dir};
}

export function chainDegradations({doctor, llmSelection, imageSelection, tickets, modeling, judges}) {
  const list = [];
  if (!doctor.ok) list.push({kind: "doctor", detail: doctor.state?.error?.message ?? "doctor failed"});
  if (llmSelection.degraded) list.push({kind: "llm", detail: llmSelection.detail});
  if (imageSelection.degraded) list.push({kind: "imagegen", detail: imageSelection.detail});
  // 通道配好了不等于判别跑通：真实缺陷是通道对象丢了 complete()，
  // 于是每一次判别都静默回退，而「降级：无」照样写进回执 —— 降级必须从台账读，不从配置猜。
  const fellBack = judges?.by_source?.fallback ?? 0;
  if (fellBack > 0) {
    const reasons = [...new Set((judges.rejected ?? []).map((item) => item.reason).filter(Boolean))];
    list.push({
      kind: "llm",
      detail: `${fellBack}/${judges.total} 个判别点回退${reasons.length > 0 ? `（${reasons.join("；")}）` : ""}`
    });
  }
  if (tickets.missing_dirs.length > 0) list.push({kind: "selection", detail: `缺少工单目录：${tickets.missing_dirs.join(", ")}`});
  if (modeling && modeling.status !== "rendered" && modeling.status !== "planned") {
    list.push({kind: "modeling", detail: modeling.detail});
  }
  return list;
}

/**
 * 证据等级只认台账，不认「通道已配置」。
 * 现实缺陷：把这句话写死在回执里，会在 0 次模型调用的情况下吹成 L2 ——
 * 等级夸大比失败更危险，所以这里算的是「实际发生了几次真实调用」。
 */
export function judgeEvidenceLevels({
  judges,
  stubbed = false,
  channelDegraded = false,
  imageCount = 0,
  imageStubbed = false
}) {
  const total = judges?.total ?? 0;
  const llmCount = judges?.by_source?.llm ?? 0;
  const llm = stubbed || channelDegraded
    ? "L1（判别桩/通道降级，非模型判断）"
    : total > 0 && llmCount === total
      ? "L2（全部判别点由真实模型返回，台账可回放）"
      : llmCount > 0
        ? `L2 部分（${llmCount}/${total} 点真实模型，其余确定性回退）`
        : "L1（全部回退，未取到任何模型返回）";
  const images = imageStubbed
    ? "L1（占位图）"
    : imageCount > 0
      ? `L2（${imageCount} 张真实模型出图）`
      : "L0（未产出图片）";
  return {llm, images};
}

/**
 * 定价：把"缺什么"算清楚，而不是先算出一个数再解释。
 *
 * 公式（写死，便于复核）：
 *   到岸成本 = 采购价 + 国际运费 + 包装费（均为 CNY）
 *   平台费   = 到岸成本 × 佣金率
 *   税费     = 到岸成本 × 税率
 *   手续费   = 到岸成本 × 支付费率
 *   售价成本项合计（CNY）= 到岸成本 + 平台费 + 税费 + 手续费
 *   折算到目标币种 = ×(USD/RUB ÷ USD/CNY)
 *
 * 纪律：四项费率任一缺失 → status=unavailable + reasons 指名缺哪项，**不用行业均值补**。
 * 这是链路里最容易"看起来正常、实际上亏钱"的地方。
 */
/** 费率归一：人写 18 或 "18%" 都是 18%，代码统一按 0.18 算。 */
function toRate(value) {
  if (value === undefined || value === null || value === "") return NaN;
  const raw = String(value).replace(/[%％\s]/g, "");
  const num = Number(raw);
  if (!Number.isFinite(num)) return NaN;
  return num > 1 ? num / 100 : num;
}

export function computePricing({ticket, region, costPolicy, intakeAnswers = null, fxFacts = []}) {
  const required = costPolicy?.required_components ?? [];
  const reasons = [];
  const rateFacts = new Map((fxFacts ?? []).map((fact) => [fact.key, fact]));

  // 成本与重量：问卷里问过就以问卷为准，工单兜底 —— 问了却不用等于没问。
  const answersForCost = intakeAnswers ?? {};
  const costFromIntake = Number(answersForCost.cost);
  const cost = Number.isFinite(costFromIntake) ? costFromIntake : Number(ticket?.price_cny);
  const costSource = Number.isFinite(costFromIntake) ? "intake" : Number.isFinite(Number(ticket?.price_cny)) ? "ticket" : "missing";
  if (!Number.isFinite(cost) || cost <= 0) reasons.push("cost_missing");

  const weightFromIntake = Number(answersForCost.weight_g);
  const weight = Number.isFinite(weightFromIntake) ? weightFromIntake : Number(ticket?.weight_g);
  const weightSource = Number.isFinite(weightFromIntake) ? "intake" : Number.isFinite(Number(ticket?.weight_g)) ? "ticket" : "missing";
  if (!Number.isFinite(weight) || weight <= 0) reasons.push("weight_missing");

  const usdCny = Number(rateFacts.get("fx.USD_CNY")?.value);
  const usdTarget = Number(rateFacts.get(`fx.USD_${region?.currency ?? ""}`)?.value);
  let targetPerCny = null;
  if (Number.isFinite(usdCny) && usdCny > 0 && Number.isFinite(usdTarget) && usdTarget > 0) {
    targetPerCny = usdTarget / usdCny;
  } else if ((region?.currency ?? "") === "CNY") {
    targetPerCny = 1;
  } else {
    reasons.push("fx_missing");
  }

  const answers = intakeAnswers ?? {};
  const rawShipping = answers.international_shipping_fee_cny;
  const shipping = rawShipping === undefined || rawShipping === null || String(rawShipping).trim() === ""
    ? NaN
    : Number(String(rawShipping).replace(/[^0-9.\-]/g, ""));
  const commissionRate = toRate(answers.platform_commission_rate);
  const taxRate = toRate(answers.vat_rate);
  const paymentRate = toRate(answers.payment_fee_rate);

  const shipped = Number.isFinite(shipping) && shipping >= 0 ? shipping : null;
  const rateOf = {commission: commissionRate, tax: taxRate, payment_fee: paymentRate};
  for (const key of required) {
    if (key === "shipping" && shipped === null) reasons.push("shipping_missing");
    if (key !== "shipping" && !Number.isFinite(rateOf[key] ?? NaN)) reasons.push(`${key}_missing`);
  }

  const missing = [...new Set(reasons)];
  if (missing.length > 0) {
    return {
      status: "unavailable",
      reasons: missing,
      required_components: required,
      note: "缺必填成本项：不猜费率、不填 0，先向卖家要这几个数（见 scripts/intake.mjs --list）",
      weight_g: Number.isFinite(weight) ? weight : null
    };
  }

  // 计费重：跨境按「实重与体积重取大」。体积重除数 6000 是货代惯用口径，
  // 不是平台官方规定（官方口径随渠道变化），所以这里是**可替换的参数**，不是硬编码事实。
  const dims = Array.isArray(answers.package_dimensions_cm) ? answers.package_dimensions_cm.map(Number) : null;
  const divisor = Number(answers.volumetric_divisor ?? 6000);
  let volumetric = null;
  if (dims && dims.length === 3 && dims.every((value) => Number.isFinite(value) && value > 0) && divisor > 0) {
    volumetric = (dims[0] * dims[1] * dims[2]) / divisor * 1000; // cm³ → g
  }
  const billableG = volumetric !== null && Number.isFinite(weight)
    ? Math.max(weight, volumetric)
    : Number.isFinite(weight) ? weight : null;

  // ── 定价口径（2026-10-29 修正）────────────────────────────────────────────
  // 佣金、支付手续费、VAT 都是**按售价**抽的，不是按到岸成本抽的。
  // 所以正确做法是"分母法"：
  //     保本价 P0 = 固定成本 / (1 − 佣金率 − 税率 − 支付费率)
  //     目标价 P  = 固定成本 / (1 − 佣金率 − 税率 − 支付费率 − 目标毛利率)
  // 旧实现按"成本×(1+费率)"再加成，会把售价低估一个数量级（实测低估 26%，
  // 意味着按旧价卖每件亏 ~570 RUB），已废弃。
  //
  // 毛利率 / 加成的定义取自公开计算器与教材口径：
  //   毛利率 = (售价 − 成本) / 售价；加成 = (售价 − 成本) / 成本；
  //   margin = markup / (1 + markup)，markup = margin / (1 − margin)
  const fixedCny = cost + shipped;
  const rateSum = commissionRate + taxRate + paymentRate;
  const optionalSum = Object.values({
    insurance: Number(answers.insurance_fee_cny),
    storage: Number(answers.storage_fee_cny),
    return_reserve: Number.isFinite(toRate(answers.return_reserve_rate))
      ? fixedCny * toRate(answers.return_reserve_rate)
      : null
  }).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  const fixedWithOptional = fixedCny + optionalSum;

  const unknownItems = ["insurance", "storage", "return_reserve"].filter((key) => {
    const raw = answers[`${key}_fee_cny`] ?? answers[`${key}_rate`];
    return raw === undefined || raw === null || String(raw).trim() === "";
  });

  const denominatorForBreakEven = 1 - rateSum;
  const targetMode = answers.target_price_mode === "markup" ? "markup" : "margin";
  const targetRate = targetMode === "markup" ? toRate(answers.target_markup_rate) : toRate(answers.target_margin_rate);

  if (!(denominatorForBreakEven > 0)) {
    return {
      status: "infeasible",
      reasons: ["rates_exceed_price"],
      detail: `佣金+税+手续费合计 ${(rateSum * 100).toFixed(1)}% ≥ 100%，任何售价都亏`,
      rates: {commission: commissionRate, tax: taxRate, payment_fee: paymentRate},
      sources: {cost: costSource, weight: weightSource}
    };
  }

  const breakEvenCny = fixedWithOptional / denominatorForBreakEven;
  let targetCny = null;
  let targetReason = null;
  if (Number.isFinite(targetRate) && targetRate > 0) {
    if (targetMode === "margin") {
      const denominator = 1 - rateSum - targetRate;
      if (denominator <= 0) targetReason = "margin_unreachable";
      else targetCny = fixedWithOptional / denominator;
    } else {
      // 加成口径：以保本价为基数加成（严格定义，避免与佣金按售价冲突）
      targetCny = breakEvenCny * (1 + targetRate);
    }
  }

  const toTarget = (cny) => Math.round(cny * targetPerCny * 100) / 100;
  const breakdownAt = (priceCny) => ({
    price_cny: Math.round(priceCny * 100) / 100,
    fixed_cny: Math.round(fixedWithOptional * 100) / 100,
    commission_cny: Math.round(priceCny * commissionRate * 100) / 100,
    tax_cny: Math.round(priceCny * taxRate * 100) / 100,
    payment_fee_cny: Math.round(priceCny * paymentRate * 100) / 100,
    profit_cny: Math.round((priceCny - fixedWithOptional - priceCny * rateSum) * 100) / 100,
    // || 0 把 -0 归一成 0：毛利率为 0 时不能显示成负数零
    profit_rate: (Math.round(((priceCny - fixedWithOptional - priceCny * rateSum) / priceCny) * 10000) / 10000) || 0
  });

  return {
    status: "available",
    currency: region?.currency ?? null,
    // 兼容旧口径：total = 保本价（不是建议售价，字段名保留以免回执结构断裂）
    total: toTarget(breakEvenCny),
    total_cny: Math.round(breakEvenCny * 100) / 100,
    pricing_model: "price_from_rates",
    formula: "P = 固定成本 / (1 − 佣金率 − 税率 − 支付费率 − 目标毛利率)",
    sources: {cost: costSource, weight: weightSource},
    fixed_cost_cny: Math.round(fixedWithOptional * 100) / 100,
    rate_sum: Math.round(rateSum * 10000) / 10000,
    break_even: toTarget(breakEvenCny),
    target: targetCny
      ? {
        mode: targetMode,
        rate: Number(targetRate.toFixed(4)),
        price: toTarget(targetCny),
        breakdown: breakdownAt(targetCny)
      }
      : {mode: targetMode, rate: Number.isFinite(targetRate) ? targetRate : null, price: null, reason: targetReason ?? "no_target_rate"},
    margin: targetCny
      ? {
        target_rate: Number(targetRate.toFixed(4)),
        mode: targetMode,
        break_even: toTarget(breakEvenCny),
        suggested_price: toTarget(targetCny),
        gross_profit: Math.round((targetCny - fixedWithOptional - targetCny * rateSum) * targetPerCny * 100) / 100
      }
      : {target_rate: null, break_even: toTarget(breakEvenCny), suggested_price: null, gross_profit: null, note: "没给目标毛利：只给保本价"},

    weight: {
      actual_g: Number.isFinite(weight) ? weight : null,
      volumetric_g: volumetric === null ? null : Math.round(volumetric),
      billable_g: billableG === null ? null : Math.round(billableG),
      divisor_used: divisor,
      note: "体积重除数 6000 为货代惯用值，非平台官方规定；实际按所选渠道口径重算"
    },
    unknown_items: unknownItems,
    fx: {target_per_cny: Number(targetPerCny.toFixed(6)), usd_cny: usdCny, usd_target: usdTarget},
    breakdown_cny: breakdownAt(targetCny ?? breakEvenCny),
    rates: {commission: commissionRate, tax: taxRate, payment_fee: paymentRate},
    note: "费率与税率须以叶子类目/官方口径核对；口径：平台费按售价抽成，用分母法反推售价"
  };
}
