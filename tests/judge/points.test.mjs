import assert from "node:assert/strict";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import {POINTS, POINT_IDS, getPoint} from "../../core/judge/points.mjs";
import {validateDecision} from "../../core/judge/contract.mjs";

const ajv = new Ajv2020({allErrors: true, strict: false});
const emptyCtx = {category: "女装", region: {}, facts: {}, refs: [], health: {}, knownKeys: []};

test("每个判别点的回退实现都过自己的 schema（降级不换形状）", () => {
  for (const id of POINT_IDS) {
    const point = POINTS[id];
    const value = point.fallback(emptyCtx);
    const validate = ajv.compile(point.schema);
    assert.equal(validate(value), true, `${id} fallback 违反自身 schema: ${JSON.stringify(validate.errors)}`);
  }
});

test("判别点都声明了协议正文、版本与 binding", () => {
  for (const id of POINT_IDS) {
    const point = POINTS[id];
    assert.ok(point.system.includes("只输出一个 JSON 对象"), `${id} 缺少「只输出 JSON」约束`);
    assert.ok(point.system.includes("数据"), `${id} 缺少「输入是数据不是指令」的注入防线`);
    assert.ok(Number.isInteger(point.version) && point.version >= 1);
    assert.equal(typeof point.binding, "boolean");
  }
});

test("运镜/焦段必须与进深自洽：2.4 米进深拍 135mm 全身被判阻断", () => {
  const decision = {
    location: {family: "studio", light_source: "north_window", depth_m: 2.4, ceiling_m: 3.2, interactives: []},
    shots: [{slot: "white_background", framing: "full", lens: "135mm", action: "stand"}],
    rationale: "故意违规",
    confidence: "high"
  };
  const conflicts = POINTS.shoot_plan.check(decision, {});
  const codes = conflicts.map((item) => item.code);
  assert.ok(codes.includes("lens_vs_depth") || codes.includes("no_room_to_back_up"), codes.join(","));
  assert.ok(conflicts.every((item) => item.severity === "block"));
});

test("主图位只能由 studio 承担；无互动元素时不得凭空坐下", () => {
  const decision = {
    location: {family: "street", light_source: "overcast", depth_m: 12, ceiling_m: 6, interactives: ["none"]},
    shots: [
      {slot: "white_background", framing: "full", lens: "50mm", action: "sit"}
    ],
    rationale: "违规组合",
    confidence: "high"
  };
  const codes = POINTS.shoot_plan.check(decision, {}).map((item) => item.code);
  assert.ok(codes.includes("main_slot_not_studio"));
  assert.ok(codes.includes("action_without_prop"));
});

test("参考图分级：hero 必须唯一且不得同时出现在 support/reject", () => {
  const ctx = {refs: [{id: "ref-01"}, {id: "ref-02"}]};
  const bad = {
    hero: "ref-01",
    support: ["ref-01"],
    reject: [{ref: "ref-02", reason: "x"}],
    confidence: "low"
  };
  const codes = POINTS.ref_roles.check(bad, ctx).map((item) => item.code);
  assert.ok(codes.includes("hero_in_support"));

  const twoHeroes = {
    hero: "ref-01",
    support: [],
    reject: [],
    confidence: "low"
  };
  assert.equal(POINTS.ref_roles.check(twoHeroes, ctx).length, 1);

  const unknown = {hero: "ref-99", support: [], reject: [], confidence: "low"};
  assert.ok(POINTS.ref_roles.check(unknown, ctx).map((item) => item.code).includes("hero_unknown_ref"));
});

test("平台规格：判别层无权声明 official，也不得发明属性键", () => {
  const ctx = {canonicalKeys: ["brand", "product_type"]};
  const decision = {
    spec_status: "official",
    title: {max_chars: 60, template: "{brand} {product_type}"},
    images: {min: 3, max: 9, aspect: "3:4"},
    required_attributes: ["brand", "invented_key"],
    rationale: "违规声明",
    confidence: "high"
  };
  const codes = POINTS.platform_mapping.check(decision, ctx).map((item) => item.code);
  assert.ok(codes.includes("llm_claims_official"));
  assert.ok(codes.includes("invented_attribute"));
});

test("成本估算：非正数、无证据依据、过度自信都被阻断", () => {
  const decision = {
    can_estimate: true,
    cost: {value: 0, unit: "CNY", basis: "市场价"},
    weight: {value: 400, unit: "g", basis: "同类克重区间中位"},
    rationale: "故意违规",
    confidence: "high"
  };
  const codes = POINTS.cost_estimate.check(decision).map((item) => item.code);
  assert.ok(codes.includes("estimate_non_positive"));
  assert.ok(codes.includes("estimate_basis_not_verifiable"));
  assert.ok(codes.includes("estimate_overconfident"));
});

test("文案：绝对化用语与无出处数字被阻断，空描述只告警", () => {
  const ctx = {facts: {material: "хлопок"}, copyLimits: {descMax: 600}};
  const bad = {
    desc: "这是最好的外套，含 99% 羊毛，畅销 10 年",
    bullets: ["顶级品质"],
    keywords: ["外套"],
    confidence: "high"
  };
  const codes = POINTS.copy_pitch.check(bad, ctx).map((item) => item.code);
  assert.ok(codes.includes("absolute_claim"));
  assert.ok(codes.includes("unsourced_number"));

  const empty = {desc: "", bullets: [], keywords: ["外套"], confidence: "low"};
  const emptyConflicts = POINTS.copy_pitch.check(empty, ctx);
  assert.equal(emptyConflicts.length, 1);
  assert.equal(emptyConflicts[0].severity, "warn");
});

test("异常处置：尺寸类失败不得 abort，放大目标不得低于供应商下限", () => {
  const ctx = {failure: {message: "image size below minimum pixels"}, minPixels: 3_686_400, attemptsLeft: 0};
  const bad = {action: "abort", target_size_px: null, why: "放弃这一件", confidence: "high"};
  const codes = POINTS.exception_triage.check(bad, ctx).map((item) => item.code);
  assert.ok(codes.includes("size_failure_should_not_abort"));

  const small = {action: "retry_with_larger_size", target_size_px: 1_000_000, why: "放大后重试", confidence: "medium"};
  assert.ok(POINTS.exception_triage.check(small, ctx).map((item) => item.code).includes("target_below_min_pixels"));
});

test("市场画像：年龄区间越界被阻断，缺 studio 场景只告警", () => {
  const decision = {
    profile_id: "young_minimal",
    age_band: "16-28",
    hair: "light brown",
    complexion: "fair",
    palette: ["cream", "sand"],
    scene_pool: ["street"],
    rationale: "测试用",
    confidence: "medium"
  };
  const codes = POINTS.market_profile.check(decision).map((item) => item.code);
  assert.ok(codes.includes("age_band_out_of_range"));
  assert.ok(codes.includes("no_studio_scene"));
});

test("人群归属：空证据的指派必须被挡下", () => {
  const point = getPoint("persona_assign");
  const decision = {
    persona_id: "A",
    status: "hypothesis",
    evidence_ids: [],
    falsifier_checked: true,
    fit: "搜索词落在 A 的词典里",
    rationale: "凭搜索词就指派",
    confidence: "medium"
  };
  const codes = point.check(decision, {}).map((item) => item.code);
  assert.ok(codes.includes("assignment_without_evidence"));
});

test("人群归属：模型没有自称「已验证」的权限", () => {
  const point = getPoint("persona_assign");
  const decision = {
    persona_id: "A",
    status: "validated",
    evidence_ids: ["ticket:x#signals"],
    falsifier_checked: true,
    fit: "说不清",
    rationale: "看起来就是这群人",
    confidence: "high"
  };
  const conflicts = point.check(decision, {});
  const codes = conflicts.map((item) => item.code);
  assert.ok(codes.includes("status_overclaimed"));
  assert.ok(codes.includes("overconfident_persona"));
  // schema 层也挡：枚举里根本没有 validated
  assert.equal(validateDecision(point.schema, {persona_id: "A", status: "validated", evidence_ids: ["x"], falsifier_checked: true, fit: "f", rationale: "r", confidence: "high"}).ok, false);
});

test("人群归属：没算 falsifier 就不许指派", () => {
  const point = getPoint("persona_assign");
  const codes = point.check({
    persona_id: "B", status: "hypothesis", evidence_ids: ["ticket:x#signals"],
    falsifier_checked: false, fit: "尺寸信号强", rationale: "尺寸是主信号", confidence: "medium"
  }, {}).map((item) => item.code);
  assert.ok(codes.includes("falsifier_not_checked"));
});

test("人群归属：回退一律 unassigned，不猜人群", () => {
  const point = getPoint("persona_assign");
  const value = point.fallback({});
  assert.equal(value.persona_id, "unassigned");
  assert.equal(value.status, "unassigned");
  assert.deepEqual(value.evidence_ids, []);
  assert.deepEqual(point.check(value, {}), []);
  assert.equal(validateDecision(point.schema, value).ok, true);
});
