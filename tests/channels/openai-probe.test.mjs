import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import * as openai from "../../channels/imagegen/http-openai-compat.mjs";
import * as mock from "../../channels/imagegen/mock.mjs";
import * as lab from "../../channels/storage/lab.mjs";

async function withFixture(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return `http://127.0.0.1:${address.port}/v1`;
}

test("all channel requires metadata uses the contract enum", () => {
  for (const channel of [mock, openai, lab]) {
    assert.ok(
      ["none", "key", "account"].includes(channel.meta.requires),
      `${channel.meta.name} has invalid requires: ${channel.meta.requires}`
    );
  }
});

test("OpenAI-compatible probe verifies key and model against a local fixture", async (t) => {
  let requests = 0;
  const baseUrl = await withFixture(t, (request, response) => {
    requests += 1;
    if (request.headers.authorization !== "Bearer fixture-key") {
      response.writeHead(401).end(JSON.stringify({error: {message: "bad key"}}));
      return;
    }
    if (request.url !== "/v1/models/fixture-image") {
      response.writeHead(404).end(JSON.stringify({error: {message: "unknown model"}}));
      return;
    }
    response.writeHead(200, {"content-type": "application/json"});
    response.end(JSON.stringify({id: "fixture-image", capabilities: {generate: true, edit: true}}));
  });

  const result = await openai.probe({
    baseUrl,
    apiKey: "fixture-key",
    model: "fixture-image",
    capabilities: {generate: true}
  });
  assert.equal(result.ok, true);
  assert.equal(result.model, "fixture-image");
  assert.deepEqual(result.capabilities, {generate: true, edit: false});
  assert.equal(requests, 1);

  const badKey = await openai.probe({
    baseUrl,
    apiKey: "wrong",
    model: "fixture-image",
    capabilities: {generate: true}
  });
  assert.equal(badKey.ok, false);
  assert.equal(badKey.status, 401);
});

test("undeclared capabilities stay unsupported and run never generates", async (t) => {
  const baseUrl = await withFixture(t, (request, response) => {
    response.writeHead(200, {"content-type": "application/json"});
    response.end(JSON.stringify({id: "fixture-image", capabilities: {generate: true}}));
  });
  const result = await openai.probe({baseUrl, apiKey: "fixture-key", model: "fixture-image"});
  assert.equal(result.ok, true);
  assert.deepEqual(result.capabilities, {generate: false, edit: false});

  let called = false;
  const generated = await openai.run({
    baseUrl,
    apiKey: "fixture-key",
    model: "fixture-image",
    capabilities: {generate: false},
    fetchImpl: async () => {
      called = true;
      throw new Error("must not generate");
    }
  });
  assert.equal(generated.ok, false);
  assert.equal(generated.meta.reason, "capability_not_declared");
  assert.deepEqual(generated.files, []);
  assert.equal(called, false);
});

test("declared generation reaches the provider instead of returning a read-only stub", async () => {
  const calls = [];
  const onePixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const outputDir = await mkdtemp(join(tmpdir(), "openai-generate-"));
  const result = await openai.run({
    capabilities: {generate: true},
    width: 900,
    height: 1200,
    count: 1,
    outputDir,
    apiKey: "fixture-key",
    baseUrl: "https://images.example.com/v1",
    model: "fixture-image",
    fetchImpl: async (url, options = {}) => {
      calls.push({url: String(url), body: options.body ? JSON.parse(options.body) : null});
      return {
        ok: true,
        status: 200,
        json: async () => ({data: [{b64_json: onePixel}]}),
        text: async () => ""
      };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.quality, "generated");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://images.example.com/v1/images/generations");
  assert.equal(calls[0].body.model, "fixture-image");
});

test("fault classification uses only the five channel categories", () => {
  const cases = [
    [Object.assign(new Error("quota exhausted"), {code: "insufficient_quota"}), "billing"],
    [Object.assign(new Error("content policy blocked"), {status: 400}), "moderation"],
    [Object.assign(new Error("slow down"), {status: 429}), "rate"],
    [Object.assign(new Error("timeout"), {code: "ETIMEDOUT"}), "transient"],
    [Object.assign(new Error("upstream"), {status: 503}), "transient"],
    [new Error("other"), "unknown"]
  ];
  for (const channel of [mock, openai, lab]) {
    for (const [error, expected] of cases) {
      assert.equal(channel.fault(error), expected);
    }
    assert.ok(["billing", "moderation", "rate", "transient", "unknown"].includes(channel.fault(null)));
  }
});
