import assert from "node:assert/strict";
import test from "node:test";
import {INTAKE_ITEMS, renderQuestionnaire, validateIntake} from "../../core/intake/checklist.mjs";

const blockingKeys = INTAKE_ITEMS.filter((item) => item.severity === "blocking").map((item) => item.key);

/** 一份"全答对"的基准答案：数值合法，费率是 0–1 小数。 */
function goodAnswers(overrides = {}) {
  return {
    platform: "ozon",
    seller_account_status: "已开店",
    platform_size_field: "confirmed",
    size_system: "本地码 42-52",
    size_chart_rows: "48: M/L, 96-104, 72",
    weight_g: 280,
    package_dimensions_cm: [30, 24, 6],
    cost: 67,
    international_shipping_fee_cny: 33,
    platform_commission_rate: 0.18,
    vat_rate: 0.06,
    payment_fee_rate: 0.02,
    return_policy: "14 天无理由，本地退货地址已有",
    certs: "EAC 待补",
    brand_authorization: "自有品牌",
    material_composition: "80% 聚酯纤维 / 20% 氨纶",
    ...overrides
  };
}

test("问卷覆盖电商真实会踩的坑，且每条都有 why/consequence/type", () => {
  const keys = INTAKE_ITEMS.map((item) => item.key);
  for (const must of [
    "platform", "seller_account_status", "platform_size_field", "size_system", "size_chart_rows", "weight_g", "package_dimensions_cm", "cost",
    "international_shipping_fee_cny", "platform_commission_rate", "vat_rate", "payment_fee_rate",
    "return_policy", "certs", "brand_authorization", "material_composition"
  ]) {
    assert.ok(keys.includes(must), `清单缺少 ${must}`);
  }
  for (const item of INTAKE_ITEMS) {
    assert.ok(item.why && item.why.length > 10, `${item.key} 缺 why`);
    assert.ok(item.consequence && item.consequence.length > 8, `${item.key} 缺 consequence`);
    assert.ok(["string", "number", "number[]"].includes(item.type), `${item.key} 缺 type`);
  }
});

test("键名与下游一致：定价读的就是问卷问的那几个键", () => {
  const keys = INTAKE_ITEMS.map((item) => item.key);
  for (const key of ["international_shipping_fee_cny", "platform_commission_rate", "vat_rate", "payment_fee_rate", "package_dimensions_cm"]) {
    assert.ok(keys.includes(key), `定价要用 ${key}，问卷必须问同名键`);
  }
  for (const legacy of ["international_shipping", "platform_commission", "vat_duty", "platform_size_field_confirmed"]) {
    assert.ok(!keys.includes(legacy), `旧键 ${legacy} 不应再生效`);
  }
});

test("必答项缺失：不通过，点名缺哪几条", () => {
  const result = validateIntake({platform: "ozon"});
  assert.equal(result.ok, false);
  assert.equal(result.blocking_missing.length, blockingKeys.length - 1);
  assert.ok(result.blocking_missing.every((item) => item.question && item.consequence && item.type));
});

test("必答项齐全：通过；confirm 项落默认并留痕", () => {
  const result = validateIntake(goodAnswers());
  assert.equal(result.ok, true);
  assert.deepEqual(result.blocking_missing, []);
  assert.deepEqual(result.invalid, []);
  assert.ok(result.defaults_used.some((item) => item.source === "default"));
});

test("费率写 18 与 0.18 都接受（人就是会这么写），180 才拒", () => {
  assert.equal(validateIntake(goodAnswers({platform_commission_rate: 18})).ok, true);
  assert.equal(validateIntake(goodAnswers({platform_commission_rate: "18%"})).ok, true);
  const tooBig = validateIntake(goodAnswers({platform_commission_rate: 180}));
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.invalid[0].reason, /超出范围/);
});

test("不确定就写 unknown：这是表态，不是缺答", () => {
  const result = validateIntake(goodAnswers({vat_rate: "unknown", certs: "unknown"}));
  assert.equal(result.ok, true);
  assert.ok(result.unknown.includes("vat_rate"));
  assert.ok(result.unknown.includes("certs"));
});

test("体积重尺寸必须是三个正数", () => {
  assert.equal(validateIntake(goodAnswers({package_dimensions_cm: [30, 24]})).ok, false);
  assert.equal(validateIntake(goodAnswers({package_dimensions_cm: [30, 0, 6]})).ok, false);
  assert.equal(validateIntake(goodAnswers({package_dimensions_cm: [30, 24, 6]})).ok, true);
});

test("空字符串不算回答（防止「填了个空」被当成已确认）", () => {
  const answers = Object.fromEntries(blockingKeys.map((key) => [key, "  "]));
  const result = validateIntake(answers);
  assert.equal(result.ok, false);
  assert.equal(result.blocking_missing.length, blockingKeys.length);
});

test("问卷可打印：分组、必答标记、键名类型、理由都在", () => {
  const text = renderQuestionnaire();
  assert.match(text, /【尺码】/);
  assert.match(text, /\[必答\]/);
  assert.match(text, /键名：platform_commission_rate（数字）/);
  assert.match(text, /为什么问：/);
  assert.match(text, /不答会怎样：/);
  assert.match(text, /怎么写：/);
});

test("账号状态与尺码字段：开局必答，不能靠默认混过去", () => {
  const answers = goodAnswers();
  delete answers.seller_account_status;
  delete answers.platform_size_field;
  const result = validateIntake(answers);
  assert.equal(result.ok, false);
  const missingKeys = result.blocking_missing.map((item) => item.key);
  assert.ok(missingKeys.includes("seller_account_status"), "没问账号状态就不知道他有没有店");
  assert.ok(missingKeys.includes("platform_size_field"), "字段名必须开局问");
});

test("没有账号也能过：答 unknown 是明确表态，不是缺答", () => {
  const noAccount = goodAnswers({seller_account_status: "还没有账号", platform_size_field: "unknown"});
  const result = validateIntake(noAccount);
  assert.equal(result.ok, true, "允许没店，但必须被问过并明确写下来");
  assert.equal(result.blocking_missing.length, 0);
});
