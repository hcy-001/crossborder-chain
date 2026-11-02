import test from "node:test";
import assert from "node:assert/strict";
import {buildPrompt, scaleToMinPixels} from "../../channels/imagegen/http-openai-compat.mjs";

const product = {
  category: "女装外套",
  facts: [{key: "material.composition", value: "полиэстер 100%"}],
  attributes: [
    {canonical_key: "product_type", value: "Женская куртка"},
    {canonical_key: "color", value: "голубой"}
  ]
};

test("prompt uses product_type over the loose category", () => {
  const prompt = buildPrompt({product, role: "white_background", index: 0});
  assert.match(prompt, /Женская куртка/);
  assert.doesNotMatch(prompt, /photograph of a 女装外套/);
});

test("prompt carries material, colour and the same-garment constraint", () => {
  const prompt = buildPrompt({product, role: "scene", index: 2});
  assert.match(prompt, /Material: полиэстер 100%/);
  assert.match(prompt, /Colour: голубой/);
  assert.match(prompt, /identical garment in every image/);
});

test("prompt omits colour when the input has no colour fact or attribute", () => {
  const prompt = buildPrompt({
    product: {category: "女装外套", facts: [{key: "material.composition", value: "полиэстер 100%"}]},
    role: "detail",
    index: 4
  });
  assert.doesNotMatch(prompt, /Colour:/);
  assert.match(prompt, /identical garment in every image/);
});

test("prompt falls back to category when product_type is absent", () => {
  const prompt = buildPrompt({product: {category: "女装外套"}, role: "size", index: 7});
  assert.match(prompt, /女装外套/);
  assert.match(prompt, /product photograph/);
});

test("源语言商品名单独成句，不塞进英文句式", () => {
  const prompt = buildPrompt({
    product: {category: "女装", attributes: [{canonical_key: "product_type", value: "韩版中长款针织毛衣外套女"}]},
    role: "scene",
    index: 0
  });
  assert.match(prompt, /Garment \(supplier original name, keep it identical\): 韩版中长款针织毛衣外套女/);
  assert.doesNotMatch(prompt, /photograph of a 韩版/);
});

test("白底主图不许出现人模 —— 角色先于 brief 说了算", () => {
  const prompt = buildPrompt({
    product,
    role: "white_background",
    index: 0,
    brief: {
      light: "Daylight from a tall window on the left, soft shadow to the right.",
      framing: "Three-quarter framing, 50mm.",
      action: "standing and looking away",
      persona: "a 25-35 year old model"
    }
  });
  assert.match(prompt, /no model, no hands, no mannequin face/i);
  assert.match(prompt, /Daylight from a tall window/);
  assert.doesNotMatch(prompt, /looking away/);
  assert.doesNotMatch(prompt, /25-35 year old model/);
});

test("场景图才带人物与动作", () => {
  const prompt = buildPrompt({
    product,
    role: "scene",
    index: 1,
    brief: {light: "Soft window light.", action: "walking mid-step", persona: "a model in her thirties"}
  });
  assert.match(prompt, /walking mid-step/);
  assert.match(prompt, /model in her thirties/);
});

test("尺寸图不吃 brief 的人像设定", () => {
  const prompt = buildPrompt({
    product,
    role: "size",
    index: 8,
    brief: {light: "x", action: "sitting", persona: "a model"}
  });
  assert.doesNotMatch(prompt, /sitting/);
  assert.match(prompt, /flat lay/);
});

test("scaleToMinPixels raises a too-small size and keeps the aspect ratio", () => {
  assert.equal(scaleToMinPixels("1024x1536", 3686400), "1568x2352");
  assert.equal(scaleToMinPixels("1728x2304", 3686400), null);
});

test("scaleToMinPixels returns null for malformed sizes or non-positive thresholds", () => {
  assert.equal(scaleToMinPixels("2K", 3686400), null);
  assert.equal(scaleToMinPixels("1024x1536", 0), null);
});

test("面料特写不许出现人像", () => {
  const prompt = buildPrompt({
    product,
    role: "detail",
    index: 4,
    brief: {light: "Soft side light.", framing: "Three-quarter framing, 50mm.", action: "standing", persona: "a model"}
  });
  assert.match(prompt, /no face, no people/i);
  assert.match(prompt, /Soft side light/);
  assert.doesNotMatch(prompt, /standing/);
  assert.doesNotMatch(prompt, /Three-quarter framing/);
});

test("人群创意简报进画面：场景/特写要能看出「要证明什么」", () => {
  const brief = {must_show: ["面料近景（织纹与厚薄）", "平铺量尺实拍"], must_not: ["太隆重"], audience: "Офисный базовый"};
  const scene = buildPrompt({product, role: "scene", index: 1, creativeBrief: brief});
  assert.match(scene, /画面必须能证明/);
  assert.match(scene, /面料近景/);
  const detail = buildPrompt({product, role: "detail", index: 4, creativeBrief: brief});
  assert.match(detail, /平铺量尺实拍/);
});

test("白底主图不吃创意简报：主图的职责是把整件拍全", () => {
  const brief = {must_show: ["面料近景"], must_not: [], audience: null};
  const prompt = buildPrompt({product, role: "white_background", index: 0, creativeBrief: brief});
  assert.doesNotMatch(prompt, /画面必须能证明/);
});

test("没有创意简报就不出现空行", () => {
  const prompt = buildPrompt({product, role: "scene", index: 1, creativeBrief: null});
  assert.doesNotMatch(prompt, /画面必须能证明/);
});
