import assert from "node:assert/strict";
import {mkdir, mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import sharp from "sharp";
import * as openai from "../../channels/imagegen/http-openai-compat.mjs";
import * as mock from "../../channels/imagegen/mock.mjs";
import {selectImageChannel} from "../../scripts/lib/channels.mjs";

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function recordingFetch(handler) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({url: String(url), body: options.body ? JSON.parse(options.body) : null});
    return handler(url, options, calls.length);
  };
  impl.calls = calls;
  return impl;
}

const jsonResponse = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
  text: async () => JSON.stringify(payload)
});

test("run refuses to spend without a key and never calls the network", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(200, {data: [{b64_json: ONE_PIXEL_PNG}]}));
  const result = await openai.run({width: 900, height: 1200, count: 9, outputDir: tmpdir(), fetchImpl});
  assert.equal(result.ok, false);
  assert.equal(result.meta.reason, "missing_api_key");
  assert.equal(fetchImpl.calls.length, 0);
});

test("run generates the full master set and normalises every image to 900x1200", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "imagegen-real-"));
  const fetchImpl = recordingFetch(() => jsonResponse(200, {data: [{b64_json: ONE_PIXEL_PNG}]}));
  const result = await openai.run({
    width: 900,
    height: 1200,
    count: 9,
    outputDir,
    apiKey: "test-key",
    baseUrl: "https://images.example.com/v1",
    model: "test-image-model",
    requestSize: "1024x1536",
    unitPriceCny: 0.4,
    product: {category: "女装外套", facts: [{key: "material.composition", value: "полиэстер 100%"}]},
    roles: ["white_background", "scene", "scene", "scene", "detail", "detail", "detail", "size", "size"],
    fetchImpl
  });

  assert.equal(result.ok, true);
  assert.equal(result.quality, "generated");
  assert.equal(result.files.length, 9);
  assert.equal(result.usage.images, 9);
  assert.equal(result.usage.cost_cny, 3.6);

  for (const file of result.files) {
    const metadata = await sharp(file).metadata();
    assert.equal(metadata.width, 900);
    assert.equal(metadata.height, 1200);
    assert.equal(metadata.format, "png");
  }

  assert.equal(fetchImpl.calls.length, 9);
  assert.equal(fetchImpl.calls[0].url, "https://images.example.com/v1/images/generations");
  assert.equal(fetchImpl.calls[0].body.model, "test-image-model");
  assert.equal(fetchImpl.calls[0].body.size, "1024x1536");
  assert.match(fetchImpl.calls[0].body.prompt, /女装外套/);
  assert.match(fetchImpl.calls[0].body.prompt, /white seamless background/);
  assert.match(fetchImpl.calls[1].body.prompt, /everyday scene/);
  assert.match(fetchImpl.calls[4].body.prompt, /close-up macro of the fabric/);
});

test("run retries without response_format when the provider rejects it", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "imagegen-retry-"));
  const fetchImpl = recordingFetch((url, options, call) =>
    call === 1
      ? jsonResponse(400, {error: "unknown parameter: response_format"})
      : jsonResponse(200, {data: [{b64_json: ONE_PIXEL_PNG}]})
  );
  const result = await openai.run({
    width: 900,
    height: 1200,
    count: 1,
    outputDir,
    apiKey: "test-key",
    baseUrl: "https://images.example.com/v1",
    model: "strict-model",
    fetchImpl
  });

  assert.equal(result.ok, true);
  assert.equal(result.files.length, 1);
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[0].body.response_format, "b64_json");
  assert.equal(fetchImpl.calls[1].body.response_format, undefined);
});

test("run surfaces provider failures as a degraded result instead of fake success", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "imagegen-fail-"));
  const fetchImpl = recordingFetch(() => jsonResponse(401, {error: "invalid api key"}));
  const result = await openai.run({
    width: 900,
    height: 1200,
    count: 9,
    outputDir,
    apiKey: "bad-key",
    baseUrl: "https://images.example.com/v1",
    model: "test-image-model",
    fetchImpl
  });

  assert.equal(result.ok, false);
  assert.equal(result.files.length, 0);
  assert.match(result.meta.reason, /401/);
});

test("selectImageChannel falls back to mock when setup has no key", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-nokey-"));
  await mkdir(join(root, "config"), {recursive: true});
  await writeFile(join(root, "config/local.json"), JSON.stringify({
    imagegen: {enabled: true, baseUrl: "https://images.example.com/v1", model: "m"}
  }));
  const selected = await selectImageChannel(root);
  assert.equal(selected.channel.meta.name, "mock");
  assert.equal(selected.degraded, true);
});

test("selectImageChannel binds local config into the real channel", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-key-"));
  await mkdir(join(root, "config"), {recursive: true});
  await writeFile(join(root, "config/local.json"), JSON.stringify({
    imagegen: {enabled: true, baseUrl: "https://images.example.com/v1", model: "m", unitPriceCny: 0.4}
  }));
  await writeFile(join(root, "config/local.secret.json"), JSON.stringify({
    imagegen: {apiKey: "secret-key"}
  }));
  const selected = await selectImageChannel(root);
  assert.equal(selected.degraded, false);
  assert.equal(selected.channel.meta.name, "http-openai-compat:m");
  assert.equal(selected.channel.meta.name === mock.meta.name, false);
});
