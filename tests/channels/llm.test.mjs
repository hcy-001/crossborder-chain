import assert from "node:assert/strict";
import test from "node:test";
import {complete, probe, selftest} from "../../channels/llm/http-openai-compat.mjs";
import {classifyFault} from "../../channels/llm/fault.mjs";

const config = {apiKey: "k", baseUrl: "https://example.invalid/api/v3", model: "m"};

function fakeFetch(sequence) {
  let index = 0;
  return async () => {
    const step = sequence[Math.min(index, sequence.length - 1)];
    index += 1;
    if (step instanceof Error) throw step;
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      statusText: step.statusText ?? "",
      json: async () => step.body
    };
  };
}

const okBody = (content) => ({
  status: 200,
  body: {
    choices: [{message: {content}, finish_reason: "stop"}],
    usage: {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15}
  }
});

test("probe 只校验配置形状，不发请求", () => {
  const missing = probe({apiKey: "k"});
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /baseUrl|model/);
  const ready = probe(config);
  assert.equal(ready.ok, true);
});

test("正常返回时带回 usage 与解析层级", async () => {
  const result = await complete({
    ...config,
    system: "s",
    user: "u",
    fetchImpl: fakeFetch([okBody('{"a":1}')])
  });
  assert.equal(result.ok, true);
  assert.equal(result.parse_layer, "strict");
  assert.equal(result.usage.total_tokens, 15);
  assert.equal(result.attempts, 1);
});

test("5xx 会重试；401 不重试（重试只是烧钱）", async () => {
  const retried = await complete({
    ...config,
    user: "u",
    fetchImpl: fakeFetch([{status: 500, body: {}}, okBody('{"a":1}')])
  });
  assert.equal(retried.ok, true);
  assert.equal(retried.attempts, 2);

  const denied = await complete({
    ...config,
    user: "u",
    fetchImpl: fakeFetch([{status: 401, body: {error: {message: "bad key"}}}])
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.fault.kind, "permanent");
  assert.equal(denied.attempts, 1);
});

test("输出被 max_tokens 截断时抬预算重来，而不是把半截当答案", async () => {
  const truncated = {status: 200, body: {choices: [{message: {content: '{"a":'}, finish_reason: "length"}], usage: {total_tokens: 9}}};
  const result = await complete({
    ...config,
    user: "u",
    fetchImpl: fakeFetch([truncated, okBody('{"a":1}')])
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.ok(result.ledger.some((entry) => entry.fault === "truncated"));
});

test("拿不到 JSON 时先走修复轮，修复轮仍失败才认输", async () => {
  const result = await complete({
    ...config,
    user: "u",
    fetchImpl: fakeFetch([okBody("我就随便说两句"), okBody('{"a":2}')])
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.a, 2);
  assert.equal(result.attempts, 2);

  const hopeless = await complete({
    ...config,
    user: "u",
    fetchImpl: fakeFetch([okBody("不是 JSON"), okBody("还不是 JSON")])
  });
  assert.equal(hopeless.ok, false);
  assert.equal(hopeless.fault.reason, "unparsable");
});

test("未配置时不发请求，直接返回永久性故障", async () => {
  let called = 0;
  const result = await complete({
    apiKey: null,
    baseUrl: "",
    model: "",
    user: "u",
    fetchImpl: async () => {
      called += 1;
      return {ok: true, status: 200, json: async () => ({})};
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.fault.reason, "not_configured");
  assert.equal(called, 0);
});

test("selftest 只有在返回约定 JSON 时才算通过", async () => {
  const passed = await selftest({...config, fetchImpl: fakeFetch([okBody('{"ok":true}')])});
  assert.equal(passed.ok, true);
  const failed = await selftest({...config, fetchImpl: fakeFetch([okBody('{"ok":false}')])});
  assert.equal(failed.ok, false);
});

test("故障分类：网络/限流可重试，鉴权/模型不存在不可重试", () => {
  assert.equal(classifyFault(429, "").kind, "transient");
  assert.equal(classifyFault(502, "").kind, "transient");
  assert.equal(classifyFault(0, "fetch failed").kind, "transient");
  assert.equal(classifyFault(403, "").kind, "permanent");
  assert.equal(classifyFault(404, "InvalidEndpointOrModel.NotFound").reason, "model_unavailable");
  assert.equal(classifyFault(400, "invalid_request_error").kind, "permanent");
});
