import assert from "node:assert/strict";
import {mkdtemp, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import sharp from "sharp";
import {buildSizeCardSvg, normalizeSizeRows, renderSizeCard} from "../../core/sizing/card.mjs";

const size = {
  status: "reported",
  label: "см",
  columns: ["Российский размер", "Международный размер", "Обхват груди, см", "Длина изделия, см"],
  rows: {"48": ["M/L", "96-104", "72"]}
};

test("尺码行规范化：对象与数组两种写法都能读", () => {
  const fromObject = normalizeSizeRows(size);
  assert.equal(fromObject.rows.length, 1);
  assert.deepEqual(fromObject.rows[0].cells, ["48", "M/L", "96-104", "72"]);

  const fromArray = normalizeSizeRows({columns: ["size", "chest"], rows: [["48", "96-104"]]});
  assert.deepEqual(fromArray.rows[0].cells, ["48", "96-104"]);
});

test("只有表头没有行：不出图，明确说原因（不拿空表凑图）", async () => {
  const headerOnly = {status: "reported", label: "см", columns: size.columns};
  assert.equal(buildSizeCardSvg({size: headerOnly}), null);
  const result = await renderSizeCard({size: headerOnly, outFile: "/dev/null"});
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_size_rows");
});

test("有行就画出可上详情页的 900×1200 图，数字来自数据", async () => {
  const dir = await mkdtemp(join(tmpdir(), "size-card-"));
  const outFile = join(dir, "size-card.png");
  const result = await renderSizeCard({size, outFile, title: "Кардиган"});
  assert.equal(result.ok, true);
  assert.equal(result.rows, 1);

  const meta = await sharp(outFile).metadata();
  assert.equal(meta.width, 900);
  assert.equal(meta.height, 1200);
  assert.equal(meta.format, "png");

  const svg = buildSizeCardSvg({size, title: "Кардиган"});
  assert.match(svg, /96-104/);
  assert.match(svg, /Российский размер/);
  assert.match(svg, /Не измерено/);
});

test("标题与数值都做 XML 转义，避免脏字符毁图", () => {
  const svg = buildSizeCardSvg({
    size: {...size, rows: {"48": ["M/L & co", "<96>", "72"]}},
    title: "A & B <test>"
  });
  assert.match(svg, /A &amp; B &lt;test&gt;/);
  assert.match(svg, /M\/L &amp; co/);
});
