import assert from "node:assert/strict";
import test from "node:test";
import {checkDictionaryMembership, checkDictionaryValueShape, isCurrencyLikeFact} from "../../core/attrs/value-shape.mjs";

const attr = (overrides) => ({id: 8229, name: "Тип", dictionary_id: 1960, value: "", ...overrides});

test("中文自由文本进字典型字段：判死", () => {
  const issue = checkDictionaryValueShape(attr({value: "白色亚麻圆领防晒衬衫"}));
  assert.equal(issue.severity, "block");
  assert.equal(issue.code, "dictionary_value_cjk");
});

test("俄文取值放行", () => {
  assert.equal(checkDictionaryValueShape(attr({value: "Платье"})), null);
});

test("纯数字放行（尺码类字典型）", () => {
  assert.equal(checkDictionaryValueShape(attr({value: "44;46", dictionary_id: 835})), null);
});

test("ASCII 短串只提示，不判死（可能是品牌标记）", () => {
  const issue = checkDictionaryValueShape(attr({id: 31, name: "Бренд", dictionary_id: 28732849, value: "NO BRAND"}));
  assert.equal(issue.severity, "warn");
  assert.equal(issue.code, "dictionary_value_ascii");
});

test("非字典型属性不参与判定", () => {
  assert.equal(checkDictionaryValueShape(attr({dictionary_id: null, value: "随便写"})), null);
});

test("空值不算问题（缺值由覆盖率去报，别重复计罪）", () => {
  assert.equal(checkDictionaryValueShape(attr({value: "   "})), null);
});

test("币种核对只看本该是结算币的金额项", () => {
  assert.equal(isCurrencyLikeFact({key: "cost", unit: "CNY"}), false, "采购价按约定是 CNY，不参与");
  assert.equal(isCurrencyLikeFact({key: "weight", unit: "g"}), false, "重量不是钱");
  assert.equal(isCurrencyLikeFact({key: "platform_commission_rate", unit: "%"}), false, "费率不是钱");
  assert.equal(isCurrencyLikeFact({key: "shipping", unit: "RUB"}), true);
  assert.equal(isCurrencyLikeFact({key: "shipping", unit: "USD"}), true);
});

// ── 字典成员校验（L2 数据：官方接口实拉）────────────────────────────
test("值不在字典里：判死，并给出字典里的可选值", () => {
  const dictionary = {values: [{id: 1, value: "Платье"}, {id: 2, value: "Сарафан"}]};
  const issue = checkDictionaryMembership({id: 8229, name: "Тип", dictionary_id: 1960, value: "куртка женская"}, dictionary);
  assert.equal(issue.severity, "block");
  assert.equal(issue.code, "dictionary_value_not_found");
  assert.match(issue.detail, /куртка женская/, "要点名是哪个值不对");
  assert.match(issue.detail, /Платье \/ Сарафан/, "要给出字典里的可选值");
});

test("值在字典里：放过", () => {
  const dictionary = {values: [{id: 1, value: "Платье"}, {id: 2, value: "Сарафан"}]};
  assert.equal(checkDictionaryMembership({id: 8229, dictionary_id: 1960, value: "Платье"}, dictionary), null);
});

test("集合型属性逐值校验，不是整串比对", () => {
  const dictionary = {values: [{id: 44, value: "44"}, {id: 46, value: "46"}]};
  assert.equal(checkDictionaryMembership({id: 4295, dictionary_id: 835, value: "44;46"}, dictionary), null);
  assert.equal(checkDictionaryMembership({id: 4295, dictionary_id: 835, value: "44;45"}, dictionary).severity, "block");
});

test("没拉过字典就不做成员判定，退回形态判定（不假装知道）", () => {
  assert.equal(checkDictionaryMembership({id: 8229, dictionary_id: 1960, value: "что угодно"}, null), null);
  assert.equal(checkDictionaryMembership({id: 8229, dictionary_id: 1960, value: "что угодно"}, {values: []}), null);
});
