import assert from "node:assert/strict";
import test from "node:test";
import {renderHandoff} from "../../core/package/assemble.mjs";

const brief = {
  region: "SG",
  summary: "人口 5.92 百万 · 人均 GDP $86,383",
  climate: "年温差约 2.2℃（Singapore）→ 全年温差小，厚外套/羽绒基本卖不动，主力是薄款",
  holidays: "公共假日 11 天（影响物流停摆与上新节奏）",
  sources: "世界银行 / Open-Meteo / Nager.Date"
};

test("有法域底数时，交付说明开头就给市场基本盘", () => {
  const text = renderHandoff({sku: "t", regionBrief: brief});
  assert.match(text, /## 这个市场的基本盘（SG）/);
  assert.match(text, /年温差约 2\.2℃/);
  assert.match(text, /data\/specs\/regions\/SG\.json/);
});

test("没有法域底数时整段不出现，不留空壳标题", () => {
  const text = renderHandoff({sku: "t"});
  assert.doesNotMatch(text, /这个市场的基本盘/);
});

test("尺码指引不再写死单一平台做法", () => {
  const text = renderHandoff({sku: "t"});
  assert.match(text, /别套用别的平台的做法/);
  assert.doesNotMatch(text, /多码用分号串/);
});
