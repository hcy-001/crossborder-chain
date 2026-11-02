import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPersonaGate,
  baseDecisionFromQuality,
  checkFalsifier,
  creativeBriefFrom,
  minDecision,
  signalShare
} from "../../core/persona/gate.mjs";

const personaA = {
  id: "A",
  label_ru: "Офисный базовый",
  status: "hypothesis",
  signal_key: "S2-场景需求",
  jobs: ["上班能穿"],
  objections: ["怕皱"],
  proof_needed: ["面料近景"],
  falsifier: {metric: "signal_share", source: "ticket_signals", threshold: 0.1}
};

test("信号份额在同一张工单内算，不跨层比较", () => {
  const signals = {"S1-抱怨/否定": 0, "S2-场景需求": 26, "S3-求购": 0, "S6-尺寸/空间": 19, "S7-互动量": 10};
  assert.equal(signalShare(signals, "S2-场景需求"), Number((26 / 55).toFixed(4)));
  assert.equal(signalShare({}, "S2-场景需求"), 0);
  assert.equal(signalShare({"S2-场景需求": 0}, "S2-场景需求"), 0);
});

test("falsifier 用同源阈值判定：达不到就该被推翻", () => {
  const ok = checkFalsifier({persona: personaA, signals: {"S2-场景需求": 30, "S6-尺寸/空间": 20}});
  assert.equal(ok.ok, true);
  const bad = checkFalsifier({persona: personaA, signals: {"S2-场景需求": 1, "S6-尺寸/空间": 99}});
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "share_below_threshold");
  assert.equal(checkFalsifier({persona: {id: "X"}, signals: {}}).reason, "no_falsifier");
});

test("未指派人群：一律封顶到 observe，不占配额", () => {
  const result = applyPersonaGate({decision: "test", persona: null, quota: {total: 5, used: 0}});
  assert.equal(result.decision, "observe");
  assert.equal(result.capped, true);
  assert.equal(result.reason, "persona_unassigned");
  assert.equal(result.quota_used, false);
});

test("假设人群 + 有配额：允许进 test 并消耗配额", () => {
  const result = applyPersonaGate({
    decision: "test",
    persona: personaA,
    quota: {total: 2, used: 0},
    falsifier: {ok: true}
  });
  assert.equal(result.decision, "test");
  assert.equal(result.capped, false);
  assert.equal(result.reason, "explore_quota");
  assert.equal(result.quota_used, true);
  assert.equal(result.quota_left, 1);
});

test("配额用尽：老实回到 observe，不搞「这次特殊」", () => {
  const result = applyPersonaGate({
    decision: "test",
    persona: personaA,
    quota: {total: 2, used: 2},
    falsifier: {ok: true}
  });
  assert.equal(result.decision, "observe");
  assert.equal(result.capped, true);
  assert.equal(result.reason, "quota_exhausted");
});

test("证伪没过：封顶且不消耗配额（假设已被自己推翻）", () => {
  const result = applyPersonaGate({
    decision: "test",
    persona: personaA,
    quota: {total: 2, used: 0},
    falsifier: {ok: false, reason: "share_below_threshold"}
  });
  assert.equal(result.decision, "observe");
  assert.equal(result.reason, "falsifier_failed:share_below_threshold");
  assert.equal(result.quota_used, false);
});

test("已观测人群不封顶；更保守的决策不会被抬高", () => {
  const observed = applyPersonaGate({decision: "test", persona: {...personaA, status: "observed"}, quota: {total: 0, used: 0}});
  assert.equal(observed.decision, "test");
  assert.equal(observed.capped, false);
  const rejected = applyPersonaGate({decision: "reject", persona: personaA, quota: {total: 2, used: 0}});
  assert.equal(rejected.decision, "reject");
  assert.equal(rejected.capped, false);
});

test("决策序：封顶取更保守的那个，未知决策按最保守处理", () => {
  assert.equal(minDecision("test", "observe"), "observe");
  assert.equal(minDecision("blocked", "test"), "blocked");
  assert.equal(minDecision("whatever", "observe"), "observe");
});

test("基础决策沿用上架端 80 分线，不引入第二个自定阈值", () => {
  assert.equal(baseDecisionFromQuality(90), "test");
  assert.equal(baseDecisionFromQuality(80), "test");
  assert.equal(baseDecisionFromQuality(79), "observe");
  assert.equal(baseDecisionFromQuality(null), "unpriced");
});

test("创意简报：人群对下游的唯一通道，未指派时不给空壳约束", () => {
  const brief = creativeBriefFrom(personaA);
  assert.deepEqual(brief.must_show, ["面料近景"]);
  assert.match(brief.must_not[0], /怕皱/);
  const none = creativeBriefFrom(null);
  assert.deepEqual(none.must_show, []);
  assert.equal(none.audience, null);
});
