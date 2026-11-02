import assert from "node:assert/strict";
import test from "node:test";
import {copyRulesFor, planCopy, validateCopy} from "../../core/copy/writer.mjs";

const spec = {facts: [{key: "platform.ozon.title.max_chars", value: 120, status: "candidate"}]};

test("写作任务单必须带上市场、人群、结构与长度规则", () => {
  const plan = planCopy({
    region: {id: "RU", currency: "RUB"},
    persona: {audience: "20-28 通勤"},
    product: {category: "dress", material: "80% 聚酯纤维"},
    platformSpec: spec,
    platformId: "ozon",
    locale: "ru-RU"
  });
  assert.equal(plan.market.region, "RU");
  assert.equal(plan.market.locale, "ru-RU");
  assert.equal(plan.audience.segment, "20-28 通勤");
  assert.ok(plan.structure.title.includes("关键词"));
  assert.equal(plan.limits.title.max_chars, 120);
  assert.equal(plan.limits.title.rule_status, "candidate", "未定稿的规则必须如实标注");
});

test("人群未定时标为假设，不假装知道", () => {
  const plan = planCopy({region: {id: "RU"}, platformSpec: spec});
  assert.equal(plan.audience.segment, null);
  assert.match(plan.audience.note, /假设/);
});

test("校验会拦住结构不全、超长与禁用表达", () => {
  const rules = copyRulesFor({platformSpec: spec, platformId: "ozon"});
  const bad = validateCopy({
    title: "最好的连衣裙 100% 显瘦 治疗驼背 " + "x".repeat(200),
    bullets: ["一条"],
    description: "太短",
    keywords: ["a", "b"]
  }, rules);
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((item) => item.includes("标题")));
  assert.ok(bad.problems.some((item) => item.includes("卖点")));
  assert.ok(bad.problems.some((item) => item.includes("关键词")));
  assert.ok(bad.problems.some((item) => item.includes("禁用表达")));
});

test("合格的稿子能过，且长度规则未定稿时给提醒而不是判死", () => {
  const rules = copyRulesFor({platformSpec: spec, platformId: "ozon"});
  const good = validateCopy({
    title: "Платье женское из полиэстера, свободный крой",
    bullets: ["Мягкая ткань", "Свободный силуэт", "Легко стирать"],
    description: "Платье для повседневной носки: мягкая ткань, свободный силуэт, не требует глажки. ".repeat(2),
    keywords: ["платье", "женское платье", "платье свободного кроя", "повседневное платье", "полиэстер", "летнее платье", "платье оверсайз", "недорогое платье"]
  }, rules);
  assert.equal(good.ok, true, JSON.stringify(good.problems));
  assert.equal(good.title_max, 120);
});
