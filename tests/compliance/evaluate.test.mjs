import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import {evaluateCompliance} from "../../core/compliance/evaluate.mjs";

const rules = JSON.parse(await readFile(
  new URL("../../regions/RU/compliance/rules.json", import.meta.url), "utf8"
));
const schema = JSON.parse(await readFile(
  new URL("../../schemas/compliance-report.schema.json", import.meta.url), "utf8"
));
const checkedAt = "2026-10-29T01:00:00.000Z";

function evaluate(product) {
  return evaluateCompliance({
    rules,
    product,
    sku: "SKU-COAT-001",
    destination: "RU",
    checkedAt
  });
}

const coat = {category: "女装外套", close_to_skin: false, is_child: false};

test("女装外套判定为准入 DoC 与追溯 DataMatrix，阻塞时仍返回完整报告", () => {
  const report = evaluate(coat);
  const access = report.items.filter((item) => item.layer === "access");
  const traceability = report.items.filter((item) => item.layer === "traceability");

  assert.equal(report.sku, "SKU-COAT-001");
  assert.equal(report.destination, "RU");
  assert.equal(access.length, 1);
  assert.match(access[0].requirement, /DoC/);
  assert.doesNotMatch(access[0].requirement, /CoC/);
  assert.ok(traceability.some((item) => item.requirement.includes("DataMatrix")));
  assert.ok(report.blockers.length > 0);
  assert.equal(report.items.length, report.blockers.length);
  assert.ok(report.notes.length > 0);
});

test("贴身服装走 CoC 分支而非外套 DoC", () => {
  const report = evaluate({category: "内衣", close_to_skin: true, is_child: false});
  const access = report.items.filter((item) => item.layer === "access");

  assert.equal(access.length, 1);
  assert.match(access[0].requirement, /CoC/);
  assert.doesNotMatch(access[0].requirement, /DoC/);
  assert.match(access[0].applies_because, /贴身/);
});

test("童装使用单独法规并标出额外证书要求", () => {
  const report = evaluate({category: "童装", close_to_skin: false, is_child: true});
  const access = report.items.filter((item) => item.layer === "access");

  assert.equal(access.length, 1);
  assert.match(access[0].requirement, /TR CU 007\/2011/);
  assert.doesNotMatch(access[0].requirement, /TR CU 017\/2011/);
  assert.match(access[0].applies_because, /高危|额外证书/);
});

test("准入先于追溯，责任主体与主体一致性要求明确", () => {
  const report = evaluate(coat);

  assert.deepEqual(report.items.map((item) => item.layer), [
    "access", "traceability", "traceability"
  ]);
  assert.equal(report.items[0].owner, "工厂 / 进口商 / 品牌方");
  assert.ok(report.items.slice(1).every((item) => item.owner === "目的国进口商"));
  assert.match(report.items[1].requirement, /准入完成后/);
  assert.match(report.items[2].requirement, /证书主体.*申请主体.*报关主体.*一致/);
});

test("报告不含税率、费用、时效数字或代办承诺", () => {
  const serialized = JSON.stringify(evaluate(coat));

  assert.doesNotMatch(serialized, /关税|进口\s*VAT|认证费用|清关时效/);
  assert.doesNotMatch(serialized, /\d+(?:\.\d+)?\s*(?:%|％|卢布|美元|元|工作日|小时|天|年)/);
  assert.doesNotMatch(serialized, /可代为办理|包过|代办/);
});

test("各分支严格符合报告 schema，二手结论只给官方核查入口", () => {
  const validate = new Ajv2020().compile(schema);
  const products = [
    coat,
    {category: "内衣", close_to_skin: true, is_child: false},
    {category: "童装", close_to_skin: false, is_child: true}
  ];

  for (const product of products) {
    const report = evaluate(product);
    assert.equal(validate(report), true, JSON.stringify(validate.errors));
    for (const item of report.items) {
      assert.equal(item.checked_at, checkedAt);
      assert.equal(item.confidence, "secondary");
      assert.ok(item.source_url.startsWith("https://"));
      if (item.layer === "access") {
        assert.equal(item.source_url, "https://eec.eaeunion.org");
      } else {
        assert.equal(item.source_url, "https://честныйзнак.рф");
      }
    }
  }
});
