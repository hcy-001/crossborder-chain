export const meta = {
  name: "mock-llm",
  kind: "llm",
  requires: "none",
  capabilities: {json_mode: true, structured_output: false},
  cost: {currency: "CNY", unit_price: 0, unit_price_reason: "本地桩，无网络无费用"}
};

/**
 * 确定性桩。存在的理由不是「省事」，而是两件事必须能离线证明：
 * 1. 判别层的**接受路径**（LLM 给了合法且不冲突的决定）；
 * 2. 判别层的**拒绝路径**（schema 不符 / 与事实冲突 / 不可解析 → 必须回退）。
 *
 * 所以桩按 `scenario` 分三档，且答案与 fallback 故意不同 ——
 * 同一条用例里能靠 `source` 字段区分「LLM 决定的」和「回退决定的」。
 */
const ANSWERS = {
  information_audit: {
    stale_keys: ["fx.USD_CNY"],
    gaps: ["platform_spec_unverified", "supplier_cost_missing"],
    actions: [
      {action: "refresh", target: "fx.USD_CNY", why: "汇率是出价前置，过期即不可出价"},
      {action: "collect", target: "supplier_cost", why: "缺成本只能出包不能出价"}
    ],
    confidence: "medium"
  },
  market_profile: {
    profile_id: "young_minimal",
    age_band: "20-28",
    hair: "light brown, shoulder length",
    complexion: "fair",
    palette: ["#efe7d8", "#d9c7a7", "#f7f5f1", "#d6d6d3"],
    scene_pool: ["studio", "home", "street"],
    rationale: "目标市场的女装内容以低饱和、日常场景为主，饱和色只在冬季外套出现",
    confidence: "medium"
  },
  persona_assign: {
    persona_id: "A",
    status: "hypothesis",
    evidence_ids: ["ticket:mock-slug#signals"],
    falsifier_checked: true,
    fit: "工单搜索词含 офис 类场景词，S2 场景需求信号占比高于其余信号",
    rationale: "只在已注册的 A/B/C 里比对，A 的判别变量同时满足搜索词与信号结构两条，故指派 A 且保持 hypothesis",
    confidence: "medium"
  },
  sourcing_match: {
    picks: [
      {ref: "ref-01", verdict: "same_style", role: "hero", why: "单主体、白底、结构与候选描述一致"},
      {ref: "ref-02", verdict: "same_style", role: "support", why: "同款不同角度，可用于核对背面结构"}
    ],
    rejected: [{ref: "ref-03", verdict: "reject", why: "对镜自拍且手持手机，拍摄形式会被继承"}],
    confidence: "medium"
  },
  cost_estimate: {
    can_estimate: true,
    cost: {value: 68, unit: "CNY", basis: "同款 1688 成交价区间中位，按主供起订量折算"},
    weight: {value: 420, unit: "g", basis: "同品类同材质克重中位"},
    rationale: "可估：这两个字段有同款成交价与克重区间可参照，但只能算估算",
    confidence: "low"
  },
  shoot_plan: {
    location: {family: "studio", light_source: "north_window", depth_m: 6, ceiling_m: 3.2, interactives: []},
    shots: [
      {slot: "white_background", framing: "full", lens: "50mm", action: "stand"},
      {slot: "scene", framing: "three_quarter", lens: "50mm", action: "walk"},
      {slot: "detail", framing: "macro", lens: "85mm", action: "stand"}
    ],
    rationale: "北向窗终年无直射，故只用漫射光；进深 6 米只允许 35/50mm 全身",
    confidence: "medium"
  },
  ref_roles: {
    hero: "ref-01",
    support: ["ref-02"],
    reject: [{ref: "ref-03", reason: "自拍且含手持物"}],
    confidence: "medium"
  },
  platform_mapping: {
    spec_status: "candidate",
    title: {max_chars: 200, template: "{brand} {product_type} {key_attrs} {spec}"},
    images: {min: 3, max: 15, aspect: "3:4"},
    required_attributes: ["brand", "product_type", "material", "size"],
    rationale: "该平台公开帮助页未给出机器可读规格，按同类平台口径给出候选值，使用前须人工复核",
    confidence: "low"
  },
  copy_pitch: {
    desc: "Демонстрационное описание, построенное по подтверждённым фактам карточки.",
    bullets: ["Факты взяты из карточки товара", "Изображения сгенерированы по референсу"],
    keywords: ["демонстрация"],
    confidence: "medium"
  },
  exception_triage: {
    action: "retry_with_larger_size",
    target_size_px: 3686400,
    why: "供应商最小像素阈值为 3.69MP，默认尺寸不足时按等比放大重试即可，不需要换参考图",
    confidence: "medium"
  }
};

const CONFLICT_ANSWERS = {
  shoot_plan: {
    location: {family: "studio", light_source: "north_window", depth_m: 2.4, ceiling_m: 3.2, interactives: []},
    shots: [{slot: "white_background", framing: "full", lens: "135mm", action: "stand"}],
    rationale: "故意违反进深-焦段规则：2.4 米进深拍不到 135mm 全身",
    confidence: "high"
  },
  cost_estimate: {
    can_estimate: true,
    cost: {value: 0, unit: "CNY", basis: "无依据", confidence: "high"},
    weight: {value: 0, unit: "g", basis: "无依据", confidence: "high"},
    confidence: "high"
  }
};

const INVALID_ANSWERS = {
  market_profile: {profile_id: "x", age_band: 42, palette: "cream", confidence: "certain"},
  // 最危险的错法：指派了人群、却没给证据、还自称已验证。三条都要能被 check 挡下。
  persona_assign: {persona_id: "A", status: "validated", evidence_ids: [], falsifier_checked: true, fit: "看起来很符合", rationale: "凭印象判断", confidence: "high"},
  shoot_plan: {location: "studio", shots: [], confidence: "high"},
  platform_mapping: {spec_status: "official", title: {max_chars: "many"}, images: {}, required_attributes: [], confidence: "high"}
};

export function availableAnswers() {
  return Object.keys(ANSWERS);
}

export async function complete(input = {}) {
  const point = input.point ?? "unknown";
  const scenario = input.scenario ?? "ok";
  const base = ANSWERS[point];
  if (!base) {
    return {
      ok: false,
      fault: {kind: "permanent", reason: "no_mock_answer", detail: `mock 未覆盖判别点 ${point}`},
      attempts: 1,
      usage: null
    };
  }

  const usage = {
    prompt_tokens: 512 + JSON.stringify(input.input ?? {}).length,
    completion_tokens: JSON.stringify(base).length,
    total_tokens: 512 + JSON.stringify(input.input ?? {}).length + JSON.stringify(base).length
  };

  if (scenario === "unparsable") {
    return {ok: false, fault: {kind: "content", reason: "unparsable", detail: "mock:unparsable"}, raw: "not json at all", usage, attempts: 1};
  }
  if (scenario === "invalid") {
    return {ok: true, value: INVALID_ANSWERS[point] ?? {nope: true}, parse_layer: "strict", raw: JSON.stringify(INVALID_ANSWERS[point] ?? {nope: true}), usage, model: "mock", attempts: 1};
  }
  if (scenario === "conflict") {
    const value = CONFLICT_ANSWERS[point] ?? base;
    return {ok: true, value, parse_layer: "strict", raw: JSON.stringify(value), usage, model: "mock", attempts: 1};
  }
  return {ok: true, value: structuredClone(base), parse_layer: "strict", raw: JSON.stringify(base), usage, model: "mock", attempts: 1};
}

export async function run(input = {}) {
  return complete(input);
}

export async function selftest() {
  return {ok: true, model: "mock", latency_ms: 0, usage: {total_tokens: 0}, fault: null, attempts: 1};
}
