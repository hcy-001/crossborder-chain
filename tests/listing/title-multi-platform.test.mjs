import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {lintTitle, titleRulesFromFacts} from "../../core/listing/title-rules.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const loadFacts = async (platform) =>
  JSON.parse(await readFile(join(ROOT, "data", "specs", "platforms", `${platform}.json`), "utf8")).facts;

const lazada = titleRulesFromFacts(await loadFacts("lazada"));
const shopee = titleRulesFromFacts(await loadFacts("shopee"));
const amazon = titleRulesFromFacts(await loadFacts("amazon"));

// ── Lazada：按字节，不按字符 ─────────────────────────────
test("Lazada：中文 90 字（270 字节）超 255 字节上限，必须拦住", () => {
  const title = `女式连衣裙${"雪纺".repeat(43)}`;
  assert.ok(Buffer.byteLength(title, "utf8") > 255);
  const result = lintTitle(title, lazada);
  const codes = result.violations.map((item) => item.code);
  assert.ok(codes.includes("title_too_many_bytes"), JSON.stringify(result.violations));
});

test("Lazada：中文 80 字（240 字节）在限内，不因字符数少就放过也没误杀", () => {
  const title = `连衣裙${"雪纺".repeat(38)}`;
  const bytes = Buffer.byteLength(title, "utf8");
  assert.ok(bytes <= 255, `样例应当合法：${bytes} 字节`);
  const result = lintTitle(title, lazada);
  assert.equal(result.violations.some((item) => item.code === "title_too_many_bytes"), false);
  assert.equal(result.stats.bytes, bytes);
});

test("Lazada：禁用符号 ^~<>| 被判死", () => {
  const result = lintTitle("Dress <summer> ^new", lazada);
  const codes = result.violations.map((item) => item.code);
  assert.ok(codes.includes("forbidden_char"), JSON.stringify(result.violations));
});

// ── Shopee：按语种折算 + 禁止中英混填 ─────────────────────
test("Shopee：中英混填判死（官方说会导致部分词不翻译、商品被禁）", () => {
  const result = lintTitle("Summer Dress 雪纺连衣裙", shopee);
  const codes = result.violations.map((item) => item.code);
  assert.ok(codes.includes("mixed_language"), JSON.stringify(result.violations));
});

test("Shopee：纯中文 250 字超过 204 上限", () => {
  const title = "连衣裙".repeat(84);
  assert.ok(title.length > 204);
  const result = lintTitle(title, shopee);
  assert.ok(result.violations.some((item) => item.code === "title_too_long_for_script"), JSON.stringify(result.violations));
});

test("Shopee：纯英文 300 字符在 500 限内，不该报超长", () => {
  const title = "Summer floral midi dress with short sleeves for women casual daily wear";
  const result = lintTitle(title, shopee);
  assert.equal(result.violations.some((item) => item.code.startsWith("title_too_long")), false);
});

test("Shopee：下限 10 字符仍然生效", () => {
  const result = lintTitle("Dress", shopee);
  assert.ok(result.violations.some((item) => item.code === "title_too_short"));
});

// ── Amazon：全大写与促销语 ───────────────────────────────
test("Amazon：整条全大写 → 提示（品牌名常全大写，不判死）", () => {
  const result = lintTitle("WOMENS SUMMER MIDI DRESS", amazon);
  assert.ok(result.warnings.some((item) => item.code === "all_caps"));
  assert.equal(result.violations.some((item) => item.code === "all_caps"), false);
});

test("Amazon：含「优惠 20%」这类促销语 → 判死", () => {
  const result = lintTitle("Women Dress 优惠20% free shipping", amazon);
  assert.ok(result.violations.some((item) => item.code === "forbidden_phrase"), JSON.stringify(result.violations));
});

test("Amazon：模块化标题是两段式（75 + 125 = 200），不是单一数字", () => {
  // 官方 SP-API 文档 (submit-modular-titles) 明确：item_name ≤75，title_differentiation ≤125，合计 200。
  // 早前两个站点页面写 200 与 75，看着像冲突，其实一个写合计、一个写分段。
  assert.equal(amazon.max_chars, 200);
  assert.equal(amazon.item_name_max, 75);
  assert.equal(amazon.differentiation_max, 125);
  assert.equal(amazon.item_name_max + amazon.differentiation_max, amazon.max_chars);
});

test("Amazon：主标题超 75 时给「拆到 Item Highlights」的提示，而不是判违规", () => {
  const long = "Women Summer Floral Midi Dress with Puff Sleeves and Smocked Bodice Casual Daily Wear";
  assert.ok(long.length > 75 && long.length <= 200);
  const result = lintTitle(long, amazon);
  const codes = result.warnings.map((item) => item.code);
  assert.ok(codes.includes("exceeds_item_name"), JSON.stringify(result.warnings));
  assert.equal(result.violations.some((item) => item.code.startsWith("title_too_long")), false);
});

// ── 禁用字符的解析口径（踩过的真 bug）───────────────────
const noon = titleRulesFromFacts(await loadFacts("noon"));

test("noon：禁用字符写成「@ ^ * # &」（空格分隔）时，空格本身不是禁用符", () => {
  assert.deepEqual(noon.charset.forbidden.sort(), ["#", "&", "*", "@", "^"].sort());
  assert.equal(noon.charset.forbidden.includes(" "), false, "分隔用的空格不能被当成禁用字符");
  const result = lintTitle("Embroidered Abaya Maxi Dress Long Sleeve", noon);
  assert.equal(result.violations.some((item) => item.code === "forbidden_char"), false, JSON.stringify(result.violations));
});

test("noon：真含 @ 才判死", () => {
  const result = lintTitle("Abaya @ 1 pc ^ Modest", noon);
  assert.equal(result.violations.filter((item) => item.code === "forbidden_char").length, 2);
});

test("noon：标题上下限取严值（20–160），不是标准页写的 5–200", () => {
  assert.equal(noon.max_chars, 160);
  assert.equal(noon.min_chars, 20);
  assert.ok(lintTitle("Too short", noon).violations.some((item) => item.code === "title_too_short"));
});

test("Lazada：连续串「^~<>|」仍按单字符展开", () => {
  assert.deepEqual(lazada.charset.forbidden.sort(), ["<", ">", "^", "|", "~"].sort());
});
