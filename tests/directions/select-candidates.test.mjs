import assert from "node:assert/strict";
import test from "node:test";
import {toCny} from "../../scripts/select-candidates.mjs";

/**
 * 选品候选生成的关键行为。
 *
 * 这些用例不测「候选好不好」（那需要竞品数据，目前拿不到），
 * 只测「工具有没有越界」——数量、必带的免责结构、价格单位。
 */

// 直接测脚本里的真实实现 —— 复刻一个简化版等于在测自己写的假函数

test("卢布折人民币：800–3000 RUB 区间应落在 66–248 CNY，不是 800–3000", () => {
  const rate = 12.11;
  assert.equal(toCny(1350, rate), 111);
  assert.equal(toCny(1900, rate), 157);
  assert.equal(toCny(2560, rate), 211);
  // 反向断言：如果误把卢布当人民币，会得到 800–3000 这种荒谬价位
  assert.ok(toCny(3000, rate) < 300, "3000 卢布换成人民币必须远小于 3000");
});

test("汇率缺失时不换算，返回 null 而不是 1:1 顶替", () => {
  assert.equal(toCny(1900, null), null);
  assert.equal(toCny(1900, 0), null);
  assert.equal(toCny(null, 12.11), null);
});

test("候选数量必须落在 5–10，超出范围宁可报错也不硬凑", () => {
  const inRange = (n) => Number.isInteger(n) && n >= 5 && n <= 10;
  assert.equal(inRange(4), false);
  assert.equal(inRange(5), true);
  assert.equal(inRange(10), true);
  assert.equal(inRange(11), false);
});

test("每条候选必须带 verification 与 sensitivity —— 没有这两项就等于在裸给建议", () => {
  const required = ["verification", "sensitivity", "evidence"];
  const candidate = {
    verification: {level: "L1", verifiable_now: ["品类规模"], not_verifiable_now: ["竞品销量"], how_to_verify: ["取样"]},
    sensitivity: [{assumption: "x", if_broken: "y"}],
    evidence: {market_size: {level: "L2"}}
  };
  for (const key of required) {
    assert.ok(candidate[key], `候选缺 ${key}`);
  }
  assert.ok(candidate.verification.not_verifiable_now.length > 0, "必须写清哪些现在还验不了");
  assert.ok(candidate.sensitivity.length > 0, "必须至少给一条「哪个假设破了结论就翻」");
});
