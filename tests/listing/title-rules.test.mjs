import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {lintTitle, titleRulesFromFacts} from "../../core/listing/title-rules.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const spec = JSON.parse(await readFile(join(ROOT, "data/specs/platforms/ozon.json"), "utf8"));
const rules = titleRulesFromFacts(spec.facts);

test("规则必须从事实里取到，且全部标 official/final", () => {
  assert.equal(rules.max_chars, 200);
  assert.equal(rules.max_word_chars, 27);
  assert.ok(rules.charset, "字符集规则缺失");
  assert.equal(rules.auto_generated?.enabled, true);
  assert.ok(rules.sources.length >= 4);
  for (const source of rules.sources) {
    assert.equal(source.source_type, "official", `${source.key} 不是官方来源`);
    assert.equal(source.status, "final", `${source.key} 不是 final`);
    assert.match(source.source_url, /^https:\/\/global-help\.ozon\.com\//);
  }
});

test("合规俄文标题通过：品牌 + 类型 + 特征", () => {
  const result = lintTitle("Trendy Платье женское, миди, черное", rules);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
  assert.equal(result.stats.words, 5);
});

test("超过 200 字符被拒", () => {
  const result = lintTitle(`Платье ${"оченьдлинное".repeat(20)}`, rules);
  const codes = result.violations.map((item) => item.code);
  assert.ok(codes.includes("title_too_long"));
});

test("单个词超过 27 字符被拒（这是独立拒因，不是长度总和）", () => {
  const result = lintTitle(`Платье ${"а".repeat(28)}`, rules);
  const codes = result.violations.map((item) => item.code);
  assert.ok(codes.includes("word_too_long"), JSON.stringify(result));
});

test("恰好 27 字符的词不算超限（边界不多拒）", () => {
  const result = lintTitle(`Платье ${"а".repeat(27)}`, rules);
  assert.equal(result.violations.some((item) => item.code === "word_too_long"), false);
});

test("纯中文标题被拒：官方错误示例明确列了汉字", () => {
  const result = lintTitle("爆款连衣裙", rules);
  const codes = result.violations.map((item) => item.code);
  assert.ok(codes.includes("no_cyrillic"));
  assert.ok(codes.includes("cjk_char"));
});

test("纯拉丁文标题被拒：官方列为「名称为拉丁语」", () => {
  const result = lintTitle("Trendy dress midi black", rules);
  const codes = result.violations.map((item) => item.code);
  assert.ok(codes.includes("no_cyrillic"));
  assert.equal(codes.includes("cjk_char"), false);
});

test("禁用符号逐个点名：™ © « » 等", () => {
  const result = lintTitle("Платье «Trendy»™, миди", rules);
  const details = result.violations.filter((item) => item.code === "forbidden_char").map((item) => item.detail);
  assert.equal(details.length, 3, JSON.stringify(details));
});

test("首字母小写被拒", () => {
  const result = lintTitle("платье женское, миди", rules);
  assert.ok(result.violations.some((item) => item.code === "not_capitalized"));
});

test("表情符号被拒", () => {
  const result = lintTitle("Платье женское 🌸 миди", rules);
  assert.ok(result.violations.some((item) => item.code === "emoji"));
});

test("不间断空格与 HTML 标记被拒", () => {
  assert.ok(lintTitle("Платье\u00a0женское", rules).violations.some((item) => item.code === "nbsp"));
  assert.ok(lintTitle("Платье <b>женское</b>", rules).violations.some((item) => item.code === "html_tag"));
});

test("外部链接被拒", () => {
  assert.ok(lintTitle("Платье женское https://example.com", rules).violations.some((item) => item.code === "external_ref"));
});

test("白名单外的符号只给提示，不判死", () => {
  const result = lintTitle("Платье женское ~ миди", rules);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((item) => item.code === "symbol_outside_list"));
});

test("空标题被拒，不返回 ok", () => {
  const result = lintTitle("   ", rules);
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].code, "title_empty");
});
