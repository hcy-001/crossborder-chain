import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, mkdir, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {selectImageChannel, selectLlmChannel} from "../../scripts/lib/channels.mjs";
import * as mockLlm from "../../channels/llm/mock.mjs";

/**
 * 这一组守的是「绑定时接口不能丢」。
 * 现实缺陷：bound() 只透传 run，判别层按 complete() 判可用性，于是真实通道被判成
 * 「未配置」→ 全量静默回退，而单测因为直接吃模块本身，一点红都不报。
 */
async function rootWith(llm, secretKey) {
  const root = await mkdtemp(join(tmpdir(), "chain-select-"));
  await mkdir(join(root, "config"), {recursive: true});
  await writeFile(join(root, "config/local.json"), JSON.stringify({llm}, null, 2), "utf8");
  if (secretKey) {
    await writeFile(
      join(root, "config/local.secret.json"),
      JSON.stringify({llm: {apiKey: secretKey}}, null, 2),
      "utf8"
    );
  }
  return root;
}

test("真实判别通道必须带 complete —— 否则判别层会判成未配置", async () => {
  const root = await rootWith(
    {enabled: true, baseUrl: "https://example.invalid/api/v3", model: "m", maxTokens: 512},
    "k"
  );
  try {
    const selection = await selectLlmChannel(root);
    assert.equal(selection.degraded, false);
    assert.equal(typeof selection.channel.complete, "function");
    assert.equal(typeof selection.channel.run, "function");
    assert.match(selection.detail, /^http-openai-compat:/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("绑定后的 complete 把配置注进去，调用方只需要给本次输入", async () => {
  const root = await rootWith(
    {enabled: true, baseUrl: "https://example.invalid/api/v3", model: "m", maxTokens: 512},
    "k"
  );
  try {
    const {channel} = await selectLlmChannel(root);
    let seen = null;
    const fakeFetch = async (url, init) => {
      seen = {url, body: JSON.parse(init.body), auth: init.headers.authorization};
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          choices: [{message: {content: '{"a":1}'}, finish_reason: "stop"}],
          usage: {total_tokens: 7}
        })
      };
    };
    const result = await channel.complete({
      point: "information_audit",
      system: "s",
      user: "u",
      maxTokens: 64,
      fetchImpl: fakeFetch
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, {a: 1});
    assert.equal(seen.body.model, "m");
    assert.equal(seen.auth, "Bearer k");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("缺 key 退回桩，且桩也带 complete（否则等于两个通道都不能用）", async () => {
  const root = await rootWith({enabled: true, baseUrl: "https://example.invalid/api/v3", model: "m"}, null);
  try {
    const selection = await selectLlmChannel(root);
    assert.equal(selection.degraded, true);
    assert.equal(typeof selection.channel.complete, "function");
    assert.match(selection.detail, /缺少判别 api key/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("显式注入的桩按其真实身份标降级", async () => {
  const root = await mkdtemp(join(tmpdir(), "chain-select-"));
  try {
    const selection = await selectLlmChannel(root, mockLlm);
    assert.equal(selection.degraded, true);
    assert.equal(typeof selection.channel.complete, "function");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("图像通道绑定后仍带 run（回归：别把透传改丢）", async () => {
  const root = await rootWith({}, null);
  await mkdir(join(root, "config"), {recursive: true});
  await writeFile(
    join(root, "config/local.json"),
    JSON.stringify({imagegen: {enabled: true, baseUrl: "https://example.invalid", model: "img"}}, null, 2),
    "utf8"
  );
  try {
    const selection = await selectImageChannel(root);
    assert.equal(typeof selection.channel.run, "function");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
