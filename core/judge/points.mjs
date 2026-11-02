import {JUDGE_PROTOCOL} from "./contract.mjs";
import {signalShare} from "../persona/gate.mjs";

/**
 * 十个判别点。
 *
 * 共同约定：
 * - `build` 只从 ctx 里取**已存在的事实**，取不到的字段直接不出现（不给模型留想象空间）。
 * - `check` 只做「这件事能不能成立」的机械判定，不做审美判断。
 *   违规分两档：`block`（回退到确定性实现）、`warn`（采用但留痕）。
 * - `fallback` 必须是**能独立跑通的确定性实现**，且结果与 LLM 版在 schema 上同构 ——
 *   否则「降级」就变成了「换个形状糊过去」。
 */

const CONF = {type: "string", enum: ["high", "medium", "low"]};

function roleLine(text) {
  return `${JUDGE_PROTOCOL}\n\n本轮角色：${text}`;
}

const informationAudit = {
  id: "information_audit",
  version: 1,
  binding: false,
  title: "信息自检：哪些事实该刷新、还缺什么",
  summary: "把机械健康检查的结论翻译成「下一步该做什么」，并排优先级",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["stale_keys", "gaps", "actions", "confidence"],
    properties: {
      stale_keys: {type: "array", items: {type: "string"}},
      gaps: {type: "array", items: {type: "string"}},
      actions: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["action", "target", "why"],
          properties: {
            action: {type: "string", enum: ["refresh", "collect", "verify", "proceed"]},
            target: {type: "string", minLength: 1},
            why: {type: "string", minLength: 4}
          }
        }
      },
      confidence: CONF
    }
  },
  system: roleLine(
    "你要读一份系统的机械健康检查结果，判断接下来哪些动作必须做、为什么。\n" +
    "stale_keys 与 gaps 只能从输入里的 stale / missing 列表中选取，不得自行新增键名。\n" +
    "actions 是按优先级排序的动作清单：refresh=重新拉取已有事实，collect=去采集尚不存在的事实，" +
    "verify=需要人工或官方来源复核，proceed=可以带着这个缺口继续。\n" +
    "排序口径：挡住出价的缺口优先（成本、重量、汇率），其次是挡住平台提交的缺口，最后是审美与加分项。"
  ),
  build(ctx) {
    return {
      category: ctx.category,
      region_completion: ctx.region?.completion ?? "unknown",
      stale: ctx.health?.stale ?? [],
      missing: ctx.health?.missing ?? [],
      degraded_channels: ctx.health?.degraded ?? [],
      known_keys: ctx.knownKeys ?? []
    };
  },
  check(decision, ctx) {
    const conflicts = [];
    const known = new Set(ctx.knownKeys ?? []);
    for (const key of decision.stale_keys ?? []) {
      if (known.size > 0 && !known.has(key) && !String(key).includes(".")) {
        conflicts.push({severity: "warn", code: "audit_unknown_key", detail: key});
      }
    }
    const blocking = new Set(ctx.health?.blockingKeys ?? []);
    const covered = new Set((decision.actions ?? []).map((item) => item.target));
    for (const key of blocking) {
      if (!covered.has(key)) {
        conflicts.push({severity: "warn", code: "audit_blocking_key_ignored", detail: key});
      }
    }
    return conflicts;
  },
  fallback(ctx) {
    const stale = ctx.health?.stale ?? [];
    const missing = ctx.health?.missing ?? [];
    const actions = [];
    for (const key of [...missing, ...stale]) {
      actions.push({
        action: missing.includes(key) ? "collect" : "refresh",
        target: key,
        why: missing.includes(key) ? "该事实缺失，挡住依赖它的下游步骤" : "该事实已过期，需重新拉取"
      });
    }
    if (actions.length === 0) {
      actions.push({action: "proceed", target: "all", why: "机械检查无过期与缺失，可继续"});
    }
    return {stale_keys: stale, gaps: missing, actions, confidence: "high"};
  }
};

const marketProfile = {
  id: "market_profile",
  version: 2,
  binding: false,
  title: "市场画像：给这个市场配一组「人、色、场景」",
  summary: "同一件衣服投不同市场，视觉口径应当不同；这里决定用哪一档",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["profile_id", "age_band", "hair", "complexion", "palette", "scene_pool", "rationale", "confidence"],
    properties: {
      profile_id: {type: "string", pattern: "^[a-z][a-z0-9_]{2,30}$"},
      age_band: {type: "string", pattern: "^[0-9]{2}-[0-9]{2}$"},
      hair: {type: "string", minLength: 1},
      complexion: {type: "string", minLength: 1},
      // 只收 #RRGGBB：中文色名（"米白"）进不了调色表，会在建模那一步被静默丢掉。
      palette: {type: "array", minItems: 2, maxItems: 6, items: {type: "string", pattern: "^#[0-9a-fA-F]{6}$"}},
      scene_pool: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: {type: "string", enum: ["studio", "home", "street", "cafe", "resort"]}
      },
      rationale: {type: "string", minLength: 8},
      confidence: CONF
    }
  },
  system: roleLine(
    "你要为目标市场选择一档模特画像与配色/场景倾向，供后续拍摄计划使用。\n" +
    "年龄区间必须落在 18-60；palette 写 #RRGGBB 十六进制色值，不写颜色词、不写品牌。\n" +
    "scene_pool 只能从枚举里选，studio 是唯一允许承担平台主图位的场景。\n" +
    "若输入没有给出该市场的人群数据，rationale 必须写明这一档是按品类常识给的，confidence 最高 medium。"
  ),
  build(ctx) {
    return {
      category: ctx.category,
      regime: ctx.region?.regime ?? "unknown",
      currency: ctx.region?.currency ?? "unknown",
      locale_count: (ctx.region?.locales ?? []).length,
      completion: ctx.region?.completion ?? "unknown",
      user_hint: ctx.hints?.market ?? null
    };
  },
  check(decision) {
    const conflicts = [];
    const [low, high] = String(decision.age_band ?? "").split("-").map(Number);
    if (!Number.isFinite(low) || !Number.isFinite(high) || low < 18 || high > 60 || low >= high) {
      conflicts.push({severity: "block", code: "age_band_out_of_range", detail: decision.age_band});
    }
    if (!(decision.scene_pool ?? []).includes("studio")) {
      conflicts.push({severity: "warn", code: "no_studio_scene", detail: "缺 studio 意味着主图位无可用场景"});
    }
    if (decision.confidence === "high") {
      conflicts.push({severity: "warn", code: "overconfident_market", detail: "人群数据未给出时不应给 high"});
    }
    return conflicts;
  },
  fallback(ctx) {
    const category = String(ctx.category ?? "");
    const warm = /外套|大衣|羽绒|棉服/.test(category);
    return {
      profile_id: "baseline_minimal",
      age_band: "25-35",
      hair: "natural dark brown, shoulder length",
      complexion: "medium",
      // 回退也必须过自己的 schema：palette 是 hex，不是颜色词。
      palette: warm ? ["#efe7d8", "#b98f63", "#3a3a3c", "#1c1c1e"] : ["#efe7d8", "#d9c7a7", "#f7f5f1", "#d6d6d3"],
      scene_pool: ["studio", "home", "street"],
      rationale: "确定性兜底：按品类与季节常识给一组低饱和、以棚拍为主的画像，未使用人群数据",
      confidence: "low",
    };
  }
};

const sourcingMatch = {
  id: "sourcing_match",
  version: 1,
  binding: true,
  title: "货源匹配：同款搜索结果里挑哪个当主供",
  summary: "以图搜同款返回一堆结果，这里判定哪几条同款、哪条作主供、哪条必须排除",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["picks", "rejected", "confidence"],
    properties: {
      picks: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["ref", "verdict", "role", "why"],
          properties: {
            ref: {type: "string", minLength: 1},
            verdict: {type: "string", enum: ["same_style", "similar_style"]},
            role: {type: "string", enum: ["hero", "support"]},
            why: {type: "string", minLength: 6}
          }
        }
      },
      rejected: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["ref", "verdict", "why"],
          properties: {
            ref: {type: "string", minLength: 1},
            verdict: {type: "string", enum: ["different_style", "reject"]},
            why: {type: "string", minLength: 6}
          }
        }
      },
      confidence: CONF
    }
  },
  system: roleLine(
    "你要在货源搜索结果里判定同款关系。\n" +
    "ref 只能取输入 refs 里出现过的标识，不得编造。\n" +
    "role=hero 只能有一个：它必须是单主体、结构最完整、最能看清版型的那条。\n" +
    "含自拍、手持物、镜中倒影、多主体、低清的候选一律进 rejected，理由写具体画面特征。\n" +
    "同款判定只看结构：版型、领口、袖长、下摆、闭合方式、图案。颜色差异不构成不同款。"
  ),
  build(ctx) {
    return {
      category: ctx.category,
      candidate_title: ctx.candidate?.title ?? null,
      candidate_attrs: ctx.candidate?.design_elements ?? [],
      refs: (ctx.refs ?? []).map((ref) => ({
        ref: ref.id,
        width: ref.width ?? null,
        height: ref.height ?? null,
        bytes: ref.bytes ?? null,
        probe: ref.probe ?? null
      })),
      known_rules: [
        "selfie or handheld phone means the shooting form will be inherited",
        "two subjects means the batch will drift",
        "low resolution means detail slots cannot be filled"
      ]
    };
  },
  check(decision, ctx) {
    const conflicts = [];
    const known = new Set((ctx.refs ?? []).map((ref) => ref.id));
    const picks = decision.picks ?? [];
    for (const pick of picks) {
      if (!known.has(pick.ref)) conflicts.push({severity: "block", code: "unknown_ref", detail: pick.ref});
    }
    for (const reject of decision.rejected ?? []) {
      if (!known.has(reject.ref)) conflicts.push({severity: "block", code: "unknown_ref", detail: reject.ref});
    }
    const heroes = picks.filter((pick) => pick.role === "hero");
    if (heroes.length !== 1) {
      conflicts.push({severity: "block", code: "hero_cardinality", detail: String(heroes.length)});
    }
    const rejectedRefs = new Set((decision.rejected ?? []).map((item) => item.ref));
    for (const pick of picks) {
      if (rejectedRefs.has(pick.ref)) {
        conflicts.push({severity: "block", code: "pick_and_reject", detail: pick.ref});
      }
    }
    return conflicts;
  },
  fallback(ctx) {
    const refs = [...(ctx.refs ?? [])];
    const clean = refs.filter((ref) => ref.probe?.flags?.length === 0 || ref.probe == null);
    const hero = clean[0] ?? refs[0];
    const support = clean.slice(1);
    const reject = refs.filter((ref) => ref !== hero && !support.includes(ref));
    return {
      picks: [
        {ref: hero?.id ?? "ref-01", verdict: "same_style", role: "hero", why: "确定性兜底：取第一张无风险标记的参考图作主图基准"},
        ...support.map((ref) => ({ref: ref.id, verdict: "same_style", role: "support", why: "无风险标记，作结构核对用"}))
      ],
      rejected: reject.map((ref) => ({
        ref: ref.id,
        verdict: "reject",
        why: `带风险标记：${(ref.probe?.flags ?? []).join("/") || "未通过筛选"}`
      })),
      confidence: "low",
    };
  }
};

const BASIS_EVIDENCE = ["成交价", "报价", "克重", "区间", "中位", "同款", "同类", "均重", "参考", "listing", "price", "weight"];

const costEstimate = {
  id: "cost_estimate",
  version: 1,
  binding: false,
  title: "成本与克重：能不能估、依据是什么",
  summary: "缺成本/重量时决定是否允许估算，并强制标注 estimated",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["can_estimate", "cost", "weight", "rationale", "confidence"],
    properties: {
      can_estimate: {type: "boolean"},
      cost: {
        type: ["object", "null"],
        additionalProperties: false,
        required: ["value", "unit", "basis"],
        properties: {
          value: {type: "number", exclusiveMinimum: 0},
          unit: {type: "string", enum: ["CNY"]},
          basis: {type: "string", minLength: 8}
        }
      },
      weight: {
        type: ["object", "null"],
        additionalProperties: false,
        required: ["value", "unit", "basis"],
        properties: {
          value: {type: "number", exclusiveMinimum: 0},
          unit: {type: "string", enum: ["g"]},
          basis: {type: "string", minLength: 8}
        }
      },
      rationale: {type: "string", minLength: 8},
      confidence: CONF
    }
  },
  system: roleLine(
    "你要判断成本与克重能否在「没有实测」的情况下给出估算，并写清依据。\n" +
    "can_estimate=false 时 cost 与 weight 必须是 null，rationale 写明缺什么。\n" +
    "can_estimate=true 时两者都必须给出正数，basis 必须写清估算方法与来源类型（同类成交价/克重区间），" +
    "不得写成「市场价」这种无法核对的措辞。\n" +
    "估算出来的数只能标 estimated，confidence 最高 medium。"
  ),
  build(ctx) {
    return {
      category: ctx.category,
      known_cost: ctx.facts?.cost ?? null,
      known_weight: ctx.facts?.weight ?? null,
      supplier_price_hints: ctx.supplier?.priceHints ?? [],
      material: ctx.facts?.material ?? null,
      size_table_present: Boolean(ctx.facts?.sizes)
    };
  },
  check(decision) {
    const conflicts = [];
    if (decision.can_estimate === true) {
      if (!decision.cost || !decision.weight) {
        conflicts.push({severity: "block", code: "estimate_missing_component", detail: "can_estimate=true 但 cost/weight 有空"});
      }
      for (const item of [decision.cost, decision.weight]) {
        if (!item) continue;
        if (!(item.value > 0)) conflicts.push({severity: "block", code: "estimate_non_positive", detail: String(item.value)});
        // 依据要能被核对：必须点明证据类型（成交价/克重/区间…），而不是一句「市场价」
        const basis = String(item.basis ?? "");
        const hasEvidence = BASIS_EVIDENCE.some((word) => basis.toLowerCase().includes(word));
        if (!hasEvidence || basis.length < 8) {
          conflicts.push({severity: "block", code: "estimate_basis_not_verifiable", detail: basis});
        }
      }
      if (decision.confidence === "high") {
        conflicts.push({severity: "block", code: "estimate_overconfident", detail: "估算不得标 high"});
      }
    }
    if (decision.can_estimate === false && (decision.cost || decision.weight)) {
      conflicts.push({severity: "block", code: "estimate_contradiction", detail: "can_estimate=false 却给出数值"});
    }
    return conflicts;
  },
  fallback(ctx) {
    if (ctx.facts?.cost && ctx.facts?.weight) {
      return {
        can_estimate: false,
        cost: null,
        weight: null,
        rationale: "已有实测成本与克重，无需估算",
        confidence: "high",
      };
    }
    return {
      can_estimate: false,
      cost: null,
      weight: null,
      rationale: "缺实测成本/克重且没有可核对的同类成交价，拒绝估算；只出包不出价",
      confidence: "high",
    };
  }
};

const SHOOT_RULES = {
  lensByDepth: [
    {maxDepth: 3.5, lenses: ["35mm", "50mm"]},
    {maxDepth: 10, lenses: ["35mm", "50mm", "85mm"]},
    {maxDepth: Infinity, lenses: ["35mm", "50mm", "85mm", "135mm"]}
  ],
  actionsWithoutProps: ["stand", "walk", "turn"]
};

const shootPlan = {
  id: "shoot_plan",
  version: 1,
  binding: true,
  title: "拍摄计划：地点派生光位/焦段/机位/动作",
  summary: "地点是上游真源，光、焦段、机位、动作都必须从地点因果推出，禁止各写各的",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["location", "shots", "rationale", "confidence"],
    properties: {
      location: {
        type: "object",
        additionalProperties: false,
        required: ["family", "light_source", "depth_m", "ceiling_m", "interactives"],
        properties: {
          family: {type: "string", enum: ["studio", "home", "street", "cafe", "resort"]},
          light_source: {type: "string", enum: ["north_window", "east_window", "west_window", "overcast", "artificial"]},
          depth_m: {type: "number", exclusiveMinimum: 0, maximum: 60},
          ceiling_m: {type: "number", exclusiveMinimum: 1.8, maximum: 12},
          interactives: {type: "array", items: {type: "string", enum: ["sofa", "chair", "stair", "rail", "table", "none"]}}
        }
      },
      shots: {
        type: "array",
        minItems: 1,
        maxItems: 12,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["slot", "framing", "lens", "action"],
          properties: {
            slot: {type: "string", enum: ["white_background", "scene", "detail", "fit"]},
            framing: {type: "string", enum: ["full", "three_quarter", "half", "macro"]},
            lens: {type: "string", enum: ["35mm", "50mm", "85mm", "135mm"]},
            action: {type: "string", enum: ["stand", "walk", "turn", "sit", "lean"]}
          }
        }
      },
      rationale: {type: "string", minLength: 8},
      confidence: CONF
    }
  },
  system: roleLine(
    "你要为一个拍摄任务给出地点与机位计划。地点不是背景字符串，它决定什么能拍、什么不能拍。\n" +
    "因果规则（违反即作废）：\n" +
    "1. north_window 终年无直射，不得依赖直射强光；overcast 是漫射峰值。\n" +
    "2. depth_m 小于 3.5 只能用 35mm/50mm；小于 10 不得用 135mm 拍全身。\n" +
    "3. ceiling_m 低于 2.8 不得俯拍。\n" +
    "4. interactives 为空时动作只能是 stand/walk/turn，不得凭空坐下或倚靠。\n" +
    "5. 平台主图位（white_background）只能由 family=studio 承担。\n" +
    "6. 特写（macro）必须排在场景之后，不得作为第一张。\n" +
    "地点与机位必须彼此成立：写出来的每个数字都要能在画面里被证明。"
  ),
  build(ctx) {
    return {
      category: ctx.category,
      market_profile: ctx.judgments?.market_profile?.value ?? null,
      slots_required: ctx.slotsRequired ?? ["white_background", "scene", "detail"],
      allow_location_family: ctx.allowLocationFamily ?? true,
      fixed_location: ctx.hints?.location ?? null
    };
  },
  check(decision, ctx) {
    const conflicts = [];
    const {depth_m: depth, interactives, family, ceiling_m: ceiling} = decision.location ?? {};
    const allowed = SHOOT_RULES.lensByDepth.find((rule) => depth <= rule.maxDepth)?.lenses ?? [];
    for (const shot of decision.shots ?? []) {
      if (!allowed.includes(shot.lens)) {
        conflicts.push({severity: "block", code: "lens_vs_depth", detail: `${shot.lens} at ${depth}m`});
      }
      if (shot.slot === "white_background" && family !== "studio") {
        conflicts.push({severity: "block", code: "main_slot_not_studio", detail: family});
      }
      const props = (interactives ?? []).filter((item) => item !== "none");
      if (["sit", "lean"].includes(shot.action) && props.length === 0) {
        conflicts.push({severity: "block", code: "action_without_prop", detail: shot.action});
      }
      if (shot.framing === "full" && shot.lens === "135mm" && depth < 10) {
        conflicts.push({severity: "block", code: "no_room_to_back_up", detail: `${shot.lens} full at ${depth}m`});
      }
    }
    if (ceiling < 2.8 && (decision.shots ?? []).some((shot) => shot.framing === "macro")) {
      conflicts.push({severity: "warn", code: "low_ceiling_macro", detail: String(ceiling)});
    }
    const firstSlot = decision.shots?.[0]?.slot;
    if (firstSlot === "detail") {
      conflicts.push({severity: "block", code: "detail_first", detail: "特写不能作为第一张"});
    }
    const families = new Set(ctx.allowedFamilies ?? ["studio", "home", "street", "cafe", "resort"]);
    if (!families.has(family)) {
      conflicts.push({severity: "block", code: "family_not_allowed", detail: family});
    }
    return conflicts;
  },
  fallback(ctx) {
    const slots = ctx.slotsRequired ?? ["white_background", "scene", "detail"];
    return {
      location: {family: "studio", light_source: "north_window", depth_m: 6, ceiling_m: 3.2, interactives: []},
      shots: slots.map((slot) => ({
        slot,
        framing: slot === "detail" ? "macro" : slot === "scene" ? "three_quarter" : "full",
        lens: slot === "detail" ? "85mm" : "50mm",
        action: "stand"
      })),
      rationale: "确定性兜底：棚拍 + 北向漫射 + 6 米进深，只用 35/50/85mm 的合法组合",
      confidence: "high",
    };
  }
};

const refRoles = {
  id: "ref_roles",
  version: 1,
  binding: true,
  title: "参考图分级：谁是准绳、谁只能核对结构、谁必须排除",
  summary: "参考图整批继承拍摄形式，所以必须先筛再拍",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["hero", "support", "reject", "confidence"],
    properties: {
      hero: {type: "string", minLength: 1},
      support: {type: "array", items: {type: "string"}},
      reject: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["ref", "reason"],
          properties: {ref: {type: "string"}, reason: {type: "string", minLength: 4}}
        }
      },
      confidence: CONF
    }
  },
  system: roleLine(
    "你要给参考图分角色。hero 是唯一准绳（结构、颜色、版型都以它为准），" +
    "support 只用于核对结构，背景光线构图一律不采用，reject 必须写明画面里的具体特征。\n" +
    "hero 只能一个，不得同时出现在 support 或 reject 里。"
  ),
  build(ctx) {
    return {
      category: ctx.category,
      refs: (ctx.refs ?? []).map((ref) => ({ref: ref.id, probe: ref.probe ?? null, width: ref.width, height: ref.height}))
    };
  },
  check(decision, ctx) {
    const conflicts = [];
    const known = new Set((ctx.refs ?? []).map((ref) => ref.id));
    if (!known.has(decision.hero)) {
      conflicts.push({severity: "block", code: "hero_unknown_ref", detail: decision.hero});
    }
    for (const ref of decision.support ?? []) {
      if (!known.has(ref)) conflicts.push({severity: "block", code: "support_unknown_ref", detail: ref});
      if (ref === decision.hero) conflicts.push({severity: "block", code: "hero_in_support", detail: ref});
    }
    for (const item of decision.reject ?? []) {
      if (!known.has(item.ref)) conflicts.push({severity: "block", code: "reject_unknown_ref", detail: item.ref});
      if (item.ref === decision.hero) conflicts.push({severity: "block", code: "hero_in_reject", detail: item.ref});
      if ((decision.support ?? []).includes(item.ref)) {
        conflicts.push({severity: "block", code: "support_in_reject", detail: item.ref});
      }
    }
    if ((decision.support ?? []).length === 0) {
      conflicts.push({severity: "warn", code: "no_support_ref", detail: "只有一张参考图时结构核对能力有限"});
    }
    return conflicts;
  },
  fallback(ctx) {
    const refs = ctx.refs ?? [];
    const clean = refs.filter((ref) => (ref.probe?.flags ?? []).length === 0);
    const hero = clean[0] ?? refs[0];
    return {
      hero: hero?.id ?? "ref-01",
      support: clean.filter((ref) => ref !== hero).map((ref) => ref.id),
      reject: refs.filter((ref) => !clean.includes(ref)).map((ref) => ({
        ref: ref.id,
        reason: `筛选器标记：${(ref.probe?.flags ?? []).join("/")}`
      })),
      confidence: "low",
    };
  }
};

const platformMapping = {
  id: "platform_mapping",
  version: 1,
  binding: false,
  title: "平台规格：没有机器可读规格时，现场推一份候选",
  summary: "新平台不写代码也能接；但候选值永远不得自称官方",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["spec_status", "title", "images", "required_attributes", "rationale", "confidence"],
    properties: {
      spec_status: {type: "string", enum: ["candidate", "unverified"]},
      title: {
        type: "object",
        additionalProperties: false,
        required: ["max_chars", "template"],
        properties: {
          max_chars: {type: "integer", minimum: 20, maximum: 300},
          template: {type: "string", minLength: 5}
        }
      },
      images: {
        type: "object",
        additionalProperties: false,
        required: ["min", "max", "aspect"],
        properties: {
          min: {type: "integer", minimum: 1, maximum: 30},
          max: {type: "integer", minimum: 1, maximum: 60},
          aspect: {type: "string", enum: ["3:4", "1:1", "4:5", "16:9"]}
        }
      },
      required_attributes: {type: "array", minItems: 1, items: {type: "string"}},
      rationale: {type: "string", minLength: 8},
      confidence: CONF
    }
  },
  system: roleLine(
    "目标平台没有机器可读规格时，你要给出一份候选规格，供临时投影使用。\n" +
    "铁律：spec_status 只能是 candidate 或 unverified —— 你无权把候选值声明为官方值，" +
    "声明 official 会被机械校验直接驳回。\n" +
    "required_attributes 只能从输入给出的 canonical 键集合里选，不得发明新键。\n" +
    "rationale 必须写清依据类型（公开帮助页/同类平台口径/行业惯例）以及尚需人工复核的点。"
  ),
  build(ctx) {
    return {
      platform_id: ctx.platform?.id ?? "unknown",
      category: ctx.category,
      canonical_keys: ctx.canonicalKeys ?? [],
      existing_spec: ctx.platform?.spec ?? null,
      known_limits: ctx.platform?.limits ?? null
    };
  },
  check(decision, ctx) {
    const conflicts = [];
    if (decision.spec_status === "official") {
      conflicts.push({severity: "block", code: "llm_claims_official", detail: "判别层无权声明官方规格"});
    }
    const canonical = new Set(ctx.canonicalKeys ?? []);
    for (const key of decision.required_attributes ?? []) {
      if (canonical.size > 0 && !canonical.has(key)) {
        conflicts.push({severity: "block", code: "invented_attribute", detail: key});
      }
    }
    const images = decision.images ?? {};
    if (images.max < images.min) {
      conflicts.push({severity: "block", code: "image_range_inverted", detail: `${images.min}>${images.max}`});
    }
    if (decision.title?.max_chars && decision.title.max_chars < 20) {
      conflicts.push({severity: "block", code: "title_limit_implausible", detail: String(decision.title.max_chars)});
    }
    return conflicts;
  },
  fallback(ctx) {
    const limits = ctx.platform?.limits ?? {};
    return {
      spec_status: "unverified",
      title: {max_chars: limits.titleMaxChars ?? 60, template: "{brand} {product_type} {key_attrs}"},
      images: {min: limits.imagesMin ?? 3, max: limits.imagesMax ?? 9, aspect: limits.aspect ?? "3:4"},
      required_attributes: (ctx.canonicalKeys ?? ["brand", "product_type"]).slice(0, 6),
      rationale: "确定性兜底：按该类目最保守的公开口径取值，全部标 unverified，提交前须人工复核",
      confidence: "low",
    };
  }
};

const ABSOLUTE_WORDS = ["最好", "最佳", "第一", "唯一", "100%", "绝对", "永久", "国家级", "顶级"];

const copyPitch = {
  id: "copy_pitch",
  version: 1,
  binding: false,
  title: "文案：按目标语言写，但每个数都必须有出处",
  summary: "文案可以创作，数字不行；绝对化用语一律不允许",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["desc", "bullets", "keywords", "confidence"],
    properties: {
      // 允许空描述：没有目标语言的兜底模板时，「写不出」本身就是一个合法结论。
      // 把它强行写长，只会逼出一段没人敢用的机器翻译。
      desc: {type: "string"},
      bullets: {type: "array", maxItems: 6, items: {type: "string", minLength: 4}},
      keywords: {type: "array", minItems: 1, maxItems: 12, items: {type: "string", minLength: 2}},
      confidence: CONF
    }
  },
  system: roleLine(
    "你要为目标市场写商品文案。\n" +
    "铁律：文案里出现的每一个数字（成分比例、克重、尺寸、年份）都必须来自输入 facts，" +
    "输入没有的数字一律不写，包括「多年」「千家」这类模糊量。\n" +
    "禁止绝对化与排名用语（最好、第一、唯一、100%、顶级、国家级）。\n" +
    "desc 只用目标语言书写，不夹带其他语言；bullet 每条一句，不超过 60 字。"
  ),
  build(ctx) {
    return {
      locale: (ctx.region?.locales ?? [])[0] ?? "unknown",
      category: ctx.category,
      facts: ctx.facts ?? {},
      attributes: ctx.attributes ?? [],
      limits: ctx.copyLimits ?? {descMax: 600, bulletMax: 6, keywordMax: 10}
    };
  },
  check(decision, ctx) {
    const conflicts = [];
    const text = [decision.desc, ...(decision.bullets ?? [])].join(" ");
    if (String(decision.desc ?? "").trim().length === 0) {
      conflicts.push({severity: "warn", code: "copy_empty", detail: "描述为空：缺目标语言模板或模型未给出"});
    }
    for (const word of ABSOLUTE_WORDS) {
      if (text.includes(word)) conflicts.push({severity: "block", code: "absolute_claim", detail: word});
    }
    const numbers = text.match(/[0-9]+(?:[.,][0-9]+)?/g) ?? [];
    const allowed = JSON.stringify(ctx.facts ?? {}).match(/[0-9]+(?:[.,][0-9]+)?/g) ?? [];
    const allowedSet = new Set(allowed);
    for (const number of numbers) {
      if (!allowedSet.has(number)) {
        conflicts.push({severity: "block", code: "unsourced_number", detail: number});
      }
    }
    const limit = ctx.copyLimits?.descMax ?? 600;
    if (decision.desc.length > limit) {
      conflicts.push({severity: "block", code: "desc_too_long", detail: `${decision.desc.length}>${limit}`});
    }
    if (String(decision.desc).match(/[a-z]{4,}/i) && !/latin/i.test(ctx.copyLimits?.langScript ?? "")) {
      // 目标语言不是拉丁文字时，正文里长串拉丁词几乎一定是模板残留
      if (!/latin/i.test(ctx.copyLimits?.langScript ?? "")) {
        conflicts.push({severity: "warn", code: "latin_residue", detail: "正文疑似残留拉丁词"});
      }
    }
    return conflicts;
  },
  fallback(ctx) {
    const facts = ctx.facts ?? {};
    const template = ctx.copyLimits?.fallbackDesc ?? null;
    if (template) {
      return {
        desc: String(template).replaceAll("{material}", String(facts.material ?? "")),
        bullets: [],
        keywords: [String(ctx.category ?? "item")],
        confidence: "low",
      };
    }
    // 没有目标语言的兜底模板就不编：空描述会被下游标成 copy unavailable，
    // 这比塞一段其他语言的文字更容易被发现，也更难被误当成成品。
    return {
      desc: "",
      bullets: [],
      keywords: [String(ctx.category ?? "item")],
      confidence: "low",
    };
  }
};

const personaAssign = {
  id: "persona_assign",
  version: 1,
  binding: true,
  title: "人群归属：这条候选是给谁的，凭什么这么认为",
  summary: "只能指派到注册表里已有的人群；证据为空不许指派，人群状态不许自称已验证",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["persona_id", "status", "evidence_ids", "falsifier_checked", "fit", "rationale", "confidence"],
    properties: {
      // 枚举写死：模型没有"发明新人群"和"自称已验证"的权限，这两件事都靠代码堵，不靠提示词劝。
      persona_id: {type: "string", enum: ["A", "B", "C", "unassigned"]},
      status: {type: "string", enum: ["hypothesis", "unassigned"]},
      evidence_ids: {type: "array", maxItems: 8, items: {type: "string", minLength: 3}},
      falsifier_checked: {type: "boolean"},
      fit: {type: "string", minLength: 6},
      rationale: {type: "string", minLength: 8},
      confidence: CONF
    }
  },
  system: roleLine(
    "你要判断一条候选属于哪个已知人群，或明确说不知道。\n" +
    "硬约束（违反即作废）：\n" +
    "1. 只能选给定 id 之一，或写 unassigned；不许发明新人群、不许改人群定义。\n" +
    "2. 指派到某人群时，evidence_ids 必须至少给一条真实证据编号（通常是工单本身）；空证据的指派一律作废。\n" +
    "3. status 只能写 hypothesis 或 unassigned —— observed / validated 只能由真实成交回流产生，你没有这个权限。\n" +
    "4. 必须先按 falsifier 算一遍该人群的信号份额，算完才填 falsifier_checked=true；算下来不达阈值就该写 unassigned。\n" +
    "5. 拿不准就写 unassigned：错认人群比不认人群更贵，因为它会把错误一路带到文案与画面。"
  ),
  build(ctx) {
    const signals = ctx.ticket?.signals ?? {};
    const personas = (ctx.personas ?? []).map((persona) => ({
      id: persona.id,
      label_ru: persona.label_ru,
      label_zh: persona.label_zh,
      query_tokens: persona.query_tokens ?? [],
      signal_key: persona.signal_key,
      cost_band_cny: persona.cost_band_cny ?? null,
      falsifier: persona.falsifier ?? null
    }));
    return {
      ticket_ref: ctx.ticketRef ?? null,
      candidate: {
        title: ctx.ticket?.cn_title ?? ctx.candidate?.title ?? null,
        keyword: ctx.ticket?.signal_source_keyword ?? ctx.ticket?.keyword ?? null,
        cost_cny: ctx.ticket?.price_cny ?? null,
        weight_g: ctx.ticket?.weight_g ?? null
      },
      signals,
      // 份额先算给模型看，但它仍要自己判断取舍；代码在 check 里会独立复算一遍。
      signal_share: Object.fromEntries(
        personas.map((persona) => [persona.id, Number(signalShare(signals, persona.signal_key).toFixed(4))])
      ),
      personas
    };
  },
  check(decision) {
    const conflicts = [];
    const assigned = decision.persona_id && decision.persona_id !== "unassigned";
    if (assigned && (decision.evidence_ids ?? []).length === 0) {
      conflicts.push({severity: "block", code: "assignment_without_evidence", detail: decision.persona_id});
    }
    if (assigned && decision.falsifier_checked !== true) {
      conflicts.push({severity: "block", code: "falsifier_not_checked", detail: decision.persona_id});
    }
    if (assigned && decision.status !== "hypothesis") {
      conflicts.push({severity: "block", code: "status_overclaimed", detail: decision.status});
    }
    if (assigned && decision.confidence === "high") {
      conflicts.push({severity: "warn", code: "overconfident_persona", detail: "零成交样本下最多 medium"});
    }
    if (!assigned && decision.confidence === "high") {
      conflicts.push({severity: "warn", code: "unassigned_high_confidence", detail: "说不准就该给低置信"});
    }
    return conflicts;
  },
  fallback() {
    return {
      persona_id: "unassigned",
      status: "unassigned",
      evidence_ids: [],
      falsifier_checked: false,
      fit: "未指派：本批证据不足以把候选归到任一已注册人群",
      rationale: "确定性回退：不猜人群，交给下游按通用档出包；decision 由 gate 统一封顶到 observe",
      confidence: "low"
    };
  }
};

const exceptionTriage = {
  id: "exception_triage",
  version: 1,
  binding: true,
  title: "异常处置：失败之后该重试、放大、换图还是降级",
  summary: "同一类报错在不同上下文里的正确动作不同，这里做现场判断",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["action", "target_size_px", "why", "confidence"],
    properties: {
      action: {
        type: "string",
        enum: ["retry", "retry_with_larger_size", "swap_reference", "degrade_placeholder", "abort"]
      },
      target_size_px: {type: ["integer", "null"], minimum: 0},
      why: {type: "string", minLength: 8},
      confidence: CONF
    }
  },
  system: roleLine(
    "你要为一次生成/校验失败选择处置动作。\n" +
    "retry=原样重试；retry_with_larger_size=尺寸低于供应商下限，等比放大后重试，必须给出 target_size_px；" +
    "swap_reference=参考图本身不合格；degrade_placeholder=保留占位并声明；abort=停止该件。\n" +
    "尺寸类失败不得选 abort；参考图问题不得选 retry_with_larger_size。"
  ),
  build(ctx) {
    return {
      failure: ctx.failure ?? {},
      min_pixels: ctx.minPixels ?? null,
      attempts_left: ctx.attemptsLeft ?? 0,
      reference_flags: ctx.refs?.[0]?.probe?.flags ?? [],
      slot: ctx.slot ?? "unknown"
    };
  },
  check(decision, ctx) {
    const conflicts = [];
    if (decision.action === "retry_with_larger_size") {
      const min = Number(ctx.minPixels ?? 0);
      if (!decision.target_size_px || (min > 0 && decision.target_size_px < min)) {
        conflicts.push({severity: "block", code: "target_below_min_pixels", detail: String(decision.target_size_px)});
      }
    }
    if (decision.action === "abort" && (ctx.attemptsLeft ?? 0) > 0) {
      conflicts.push({severity: "warn", code: "abort_with_attempts_left", detail: String(ctx.attemptsLeft)});
    }
    const failureText = JSON.stringify(ctx.failure ?? "");
    if (/size|pixel|resolution/i.test(failureText) && decision.action === "abort") {
      conflicts.push({severity: "block", code: "size_failure_should_not_abort", detail: decision.action});
    }
    return conflicts;
  },
  fallback(ctx) {
    const failureText = JSON.stringify(ctx.failure ?? "");
    const min = Number(ctx.minPixels ?? 0);
    if (/size|pixel|resolution/i.test(failureText)) {
      return {
        action: "retry_with_larger_size",
        target_size_px: min > 0 ? min : 3_686_400,
        why: "失败原因指向像素不足，按供应商下限等比放大后重试",
        confidence: "medium",
      };
    }
    if ((ctx.attemptsLeft ?? 0) > 0) {
      return {action: "retry", target_size_px: null, why: "仍有重试次数，先原样重试", confidence: "medium"};
    }
    return {
      action: "degrade_placeholder",
      target_size_px: null,
      why: "重试次数用尽且不属于尺寸问题，保留占位并在交接里声明",
      confidence: "medium",
    };
  }
};

export const POINTS = Object.freeze({
  information_audit: informationAudit,
  market_profile: marketProfile,
  sourcing_match: sourcingMatch,
  cost_estimate: costEstimate,
  shoot_plan: shootPlan,
  ref_roles: refRoles,
  platform_mapping: platformMapping,
  copy_pitch: copyPitch,
  persona_assign: personaAssign,
  exception_triage: exceptionTriage
});

export const POINT_IDS = Object.freeze(Object.keys(POINTS));

export function getPoint(id) {
  const point = POINTS[id];
  if (!point) throw new Error(`unknown judge point: ${id}`);
  return point;
}
