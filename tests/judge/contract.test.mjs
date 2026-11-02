import assert from "node:assert/strict";
import test from "node:test";
import {asData, decisionEnvelope, describeSchema, validateDecision} from "../../core/judge/contract.mjs";
import {salvageJson} from "../../channels/llm/fault.mjs";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "confidence"],
  properties: {
    ok: {type: "boolean"},
    confidence: {type: "string", enum: ["high", "low"]}
  }
};

test("schema 校验拒绝多余字段，放行合法对象", () => {
  assert.equal(validateDecision(schema, {ok: true, confidence: "high"}).ok, true);
  const extra = validateDecision(schema, {ok: true, confidence: "high", notes: "x"});
  assert.equal(extra.ok, false);
  assert.match(extra.errors.map((item) => item.message).join(" "), /additional properties/);
});

test("JSON 抢救分三层，且明确报出用的是哪一层", () => {
  assert.equal(salvageJson('{"a":1}').layer, "strict");
  assert.equal(salvageJson('```json\n{"a":1}\n```').layer, "fenced");
  assert.equal(salvageJson('好的，结果是 {"a":1} 以上').layer, "substring");
  const truncated = salvageJson('{"a":1,"b":[1,2,3');
  assert.equal(truncated.ok, true);
  assert.equal(truncated.layer, "salvaged");
  assert.deepEqual(truncated.value, {a: 1, b: [1, 2, 3]});
  assert.equal(salvageJson("完全不是 JSON").ok, false);
});

test("asData 截断长文本并处理循环引用，保证提示词不会因数据爆炸", () => {
  const circular = {title: "x".repeat(5_000)};
  circular.self = circular;
  const data = asData(circular, {maxText: 20});
  assert.equal(data.title.length, 21);
  assert.equal(data.self, "[circular]");
});

test("decisionEnvelope 只在「来自 LLM 且无阻断冲突」时 accepted 为真", () => {
  const base = {pointId: "p", version: 1, value: {ok: true}, binding: true, confidence: "low", schemaOk: true};
  assert.equal(decisionEnvelope({...base, source: "llm", conflicts: []}).accepted, true);
  assert.equal(decisionEnvelope({...base, source: "fallback", conflicts: []}).accepted, false);
  assert.equal(
    decisionEnvelope({...base, source: "llm", conflicts: [{severity: "block", code: "x"}]}).accepted,
    false
  );
  assert.equal(
    decisionEnvelope({...base, source: "llm", conflicts: [{severity: "warn", code: "x"}]}).accepted,
    true
  );
});

test("输出契约从 schema 现算：必填键、枚举、长度上限都要出现在提示词里", () => {
  const text = describeSchema({
    type: "object",
    additionalProperties: false,
    required: ["actions", "confidence"],
    properties: {
      actions: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: {
          type: "object",
          required: ["target", "why"],
          properties: {
            target: {type: "string"},
            why: {type: "string", maxLength: 120},
            priority: {type: "string", enum: ["high", "low"]}
          }
        }
      },
      confidence: {type: "string", enum: ["high", "medium", "low"]}
    }
  });
  assert.match(text, /actions（必填，array，至少 1 项，最多 4 项）/);
  assert.match(text, /target（必填，string）/);
  assert.match(text, /why（必填，string，≤120 字）/);
  assert.match(text, /priority（string，取值只能是 "high" \/ "low"）/);
  assert.match(text, /confidence（必填，string，取值只能是 "high" \/ "medium" \/ "low"）/);
});

test("输出契约对空 schema 不编造内容", () => {
  assert.equal(describeSchema(null), "");
  assert.equal(describeSchema({type: "object"}), "");
});

test("输出契约把 pattern 也讲出来（否则模型不知道有格式要求）", () => {
  const text = describeSchema({
    type: "object",
    required: ["profile_id", "palette"],
    properties: {
      profile_id: {type: "string", pattern: "^[a-z][a-z0-9_]{2,30}$"},
      palette: {type: "array", items: {type: "string", pattern: "^#[0-9a-fA-F]{6}$"}}
    }
  });
  assert.match(text, /profile_id（必填，string，须匹配 \^\[a-z\]/);
  assert.match(text, /须匹配 \^#\[0-9a-fA-F\]\{6\}\$/);
});
