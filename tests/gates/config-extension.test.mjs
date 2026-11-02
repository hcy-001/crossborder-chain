import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createSourceChannel} from "../../channels/source/http-json.mjs";
import {probe as openaiProbe, run as openaiRun} from "../../channels/imagegen/http-openai-compat.mjs";

// G4：同形 JSON 源只改 data/sources.json；不同协议必须新增 adapter，不能宣称零代码接入。
test("G4 a third same-shape JSON source is config-only", async () => {
  const thirdSource = {
    id: "third-same-shape-source",
    adapter: "http-json",
    url: "https://example.com/latest.json",
    source_type: "secondary",
    ttl_hours: 12,
    capabilities: {key: "fx.EUR_CNY", timeout_ms: 5000},
    mapping: {key: "fx.EUR_CNY", value_path: "/rates/CNY", as_of_path: "/date", unit: "CNY/EUR", scale: 1}
  };
  const channel = createSourceChannel(thirdSource, {
    fetchImpl: async () => ({ok: true, status: 200, json: async () => ({date: "2026-10-29", rates: {CNY: 7.8123}})})
  });
  const result = await channel.run({nowIso: "2026-10-29T04:00:00.000Z"});
  assert.equal(result.ok, true);
  assert.equal(result.value, 7.8123);
  assert.equal(result.unit, "CNY/EUR");
  assert.equal(result.source_type, "secondary");
  assert.equal(result.ttl_hours, 12);
  assert.equal(channel.meta.name, "third-same-shape-source");
});

test("G4 a different response protocol is rejected as ADAPTER_UNAVAILABLE instead of being silently mapped", async () => {
  const channel = createSourceChannel({
    id: "protobuf-source",
    adapter: "protobuf-binary",
    url: "https://example.com/latest.pb",
    source_type: "secondary",
    ttl_hours: 12,
    capabilities: {key: "fx.USD_CNY"}
  }, {fetchImpl: async () => ({ok: true, status: 200, json: async () => ({})})});
  await assert.rejects(channel.run({}), (error) => error.code === "ADAPTER_UNAVAILABLE");
});

// G7：同一 OpenAI 兼容协议内换 base URL/model/key 只改配置；真实生图未验证。
test("G7 the same OpenAI-compatible protocol is config-only across base URL, model and key", async () => {
  const calls = [];
  const makeFetch = (model) => async (url, options) => {
    calls.push({url, authorization: options.headers.authorization});
    return {ok: true, status: 200, json: async () => ({id: model})};
  };
  const first = await openaiProbe({
    apiKey: "key-alpha",
    baseUrl: "https://vendor-alpha.example.com/v1",
    model: "image-model-alpha",
    fetchImpl: makeFetch("image-model-alpha")
  });
  const second = await openaiProbe({
    apiKey: "key-beta",
    baseUrl: "https://vendor-beta.example.com/v1/",
    model: "image-model-beta",
    fetchImpl: makeFetch("image-model-beta")
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(calls[0].url, "https://vendor-alpha.example.com/v1/models/image-model-alpha");
  assert.equal(calls[1].url, "https://vendor-beta.example.com/v1/models/image-model-beta");
  assert.equal(calls[0].authorization, "Bearer key-alpha");
  assert.equal(calls[1].authorization, "Bearer key-beta");
});

test("G7 same-protocol provider swap is configuration-only and never spends without a key", async () => {
  let networkCalls = 0;
  const outputDir = await mkdtemp(join(tmpdir(), "g7-nokey-"));
  const result = await openaiRun({
    capabilities: {generate: true},
    width: 900,
    height: 1200,
    count: 9,
    outputDir,
    baseUrl: "https://vendor.example.com/v1",
    model: "model",
    fetchImpl: async () => {
      networkCalls += 1;
      return {ok: true, status: 200, json: async () => ({})};
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.files.length, 0);
  assert.equal(result.meta.reason, "missing_api_key");
  assert.equal(networkCalls, 0, "run must not spend money without a configured key");
});
