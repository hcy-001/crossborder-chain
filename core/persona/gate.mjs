/**
 * 人群层的确定性部分：证伪核算、决策封顶、创意简报派生。
 *
 * 分工刻意如此 —— **LLM 判断"这条候选属于谁"，代码执行"它能不能进 test"**。
 * 让模型自己决定要不要封顶，等于让它给自己的结论放行。
 */

/** 决策强度序：数越小越保守。封顶就是取 min。 */
const DECISION_RANK = {
  blocked: 0,
  reject: 1,
  unpriced: 2,
  observe: 3,
  test: 4
};

export const DECISIONS = Object.freeze(Object.keys(DECISION_RANK));

/**
 * 基础决策：沿用上架端既有的分流失衡线 —— ≥80 走半自动（test），其余先 observe。
 * 不引入第二个自定阈值：多一个数字就多一处没人能验证的口径。
 */
export function baseDecisionFromQuality(score) {
  if (score === null || score === undefined || score === "") return "unpriced";
  const value = Number(score);
  if (!Number.isFinite(value)) return "unpriced";
  return value >= 80 ? "test" : "observe";
}

/** 取两个决策里更保守的那个；未知决策按最保守处理，不悄悄放行。 */
export function minDecision(left, right) {
  // 未知决策不能靠"序号当 0"混过去：0 是最保守档，会让 "whatever" 变成合法结果。
  if (DECISION_RANK[left] === undefined) return DECISION_RANK[right] === undefined ? "observe" : right;
  if (DECISION_RANK[right] === undefined) return left;
  return DECISION_RANK[left] <= DECISION_RANK[right] ? left : right;
}

/**
 * 信号份额：某一类信号在这张工单全部信号里占多少。
 * 同一张工单内算比例，避免拿"品类级"数字冒充"人群级"（跨层比较是这份方案最容易被自己打脸的地方）。
 */
export function signalShare(signals, key) {
  if (!signals || typeof signals !== "object") return 0;
  const values = Object.values(signals).map((value) => Number(value) || 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return 0;
  const hit = Number(signals[key] ?? 0) || 0;
  // 固定四位小数：模型看到的值与台账里记的值必须是同一个数，否则复算对不上。
  return Number((hit / total).toFixed(4));
}

/** falsifier 判定：份额达到阈值即假设暂时存活；达不到就该被推翻，不许留着凑数。 */
export function checkFalsifier({persona, signals}) {
  const falsifier = persona?.falsifier ?? null;
  if (!falsifier) return {ok: false, reason: "no_falsifier", share: null, threshold: null};
  const share = signalShare(signals, persona.signal_key);
  const threshold = Number(falsifier.threshold ?? 0);
  return {
    ok: share >= threshold,
    reason: share >= threshold ? "share_above_threshold" : "share_below_threshold",
    share,
    threshold
  };
}

/**
 * 决策封顶。
 *
 * 现实风险：0 单店铺里，如果"人群未观测"一律封到 observe，就永远没有 test，
 * 也就永远没有数据来验证人群 —— 系统被自己的纪律锁死。
 * 所以留一个**明码的探索配额**：每次运行最多放 N 个候选豁免，配额消耗写进回执，
 * 用超了就老实封顶，不靠"这次特殊"。
 */
export function applyPersonaGate({decision, persona, quota = {total: 0, used: 0}, falsifier = null}) {
  const base = DECISION_RANK[decision] === undefined ? "observe" : decision;
  const status = persona?.status ?? "unassigned";
  const quotaLeft = Math.max(0, Number(quota.total ?? 0) - Number(quota.used ?? 0));

  // 未指派人群：连"给谁看"都没答案，不给探索配额 —— 配额是给有假设的人用的。
  if (!persona || persona.id === "unassigned" || status === "unassigned") {
    return {
      decision: minDecision(base, "observe"),
      capped: base !== minDecision(base, "observe"),
      reason: "persona_unassigned",
      quota_used: false,
      quota_left: quotaLeft
    };
  }

  // 证伪没过：假设已被自己推翻，封顶且不占配额。
  if (falsifier && falsifier.ok === false) {
    return {
      decision: minDecision(base, "observe"),
      capped: base !== minDecision(base, "observe"),
      reason: `falsifier_failed:${falsifier.reason}`,
      quota_used: false,
      quota_left: quotaLeft
    };
  }

  // 已观测/已验证的人群不封顶（有真实结果回流时才会出现这个状态）。
  if (status === "observed" || status === "validated") {
    return {decision: base, capped: false, reason: "persona_observed", quota_used: false, quota_left: quotaLeft};
  }

  // hypothesis + 需要进 test（或更高）时，只有配额能放行。
  const wouldCap = DECISION_RANK[base] > DECISION_RANK.observe;
  if (!wouldCap) {
    return {decision: base, capped: false, reason: "below_gate_line", quota_used: false, quota_left: quotaLeft};
  }
  if (quotaLeft > 0) {
    return {decision: base, capped: false, reason: "explore_quota", quota_used: true, quota_left: quotaLeft - 1};
  }
  return {decision: "observe", capped: true, reason: "quota_exhausted", quota_used: false, quota_left: 0};
}

/**
 * 创意简报：人群对下游**唯一**的作用通道。
 * 没有这一步，人群层对出图与文案的影响恒等于 0（另一份方案 §6.8 的原话）。
 */
export function creativeBriefFrom(persona) {
  if (!persona || persona.id === "unassigned") {
    return {
      must_show: [],
      must_not: [],
      audience: null,
      note: "未指派人群：不给定向创意约束，避免拿猜测去改画面"
    };
  }
  return {
    must_show: Array.isArray(persona.proof_needed) ? persona.proof_needed.slice(0, 4) : [],
    must_not: Array.isArray(persona.objections) ? persona.objections.map((item) => `避免让人一眼觉得「${item}」`) : [],
    audience: persona.label_ru ?? persona.label_zh ?? null,
    note: `人群 ${persona.id}（${persona.status}）：只把「要证明什么」译成画面约束，不改商品本体`
  };
}
