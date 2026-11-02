#!/usr/bin/env node
import {writeFile} from "node:fs/promises";
import {join, resolve, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {mkdir} from "node:fs/promises";
import {loadLocalConfig} from "./lib/channels.mjs";
import * as llmChannel from "../channels/llm/http-openai-compat.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 判别通道的连通性自测。
 *
 * 只做一件事：花最少量的 token 证明「这把 key + 这个模型名 + 这个端点」是真的能出 JSON，
 * 并把用量原样记下来。**不**承诺单价 —— 单价要另查供应商价格页，查不到就写 null。
 */
async function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const config = await loadLocalConfig(ROOT);
  const llm = config.llm ?? {};
  const report = {
    at: new Date().toISOString(),
    configured: {
      baseUrl: llm.baseUrl ?? null,
      model: llm.model ?? null,
      hasKey: Boolean(llm.apiKey),
      maxTokens: llm.maxTokens ?? null
    },
    text: null,
    vision: null,
    unit_price_cny: null,
    unit_price_reason: "供应商价格页未提供机器可读的对话模型单价，此处不折算金额"
  };

  if (!llm.apiKey || !llm.baseUrl || !llm.model) {
    report.text = {ok: false, detail: "缺少 apiKey/baseUrl/model，未发起请求"};
  } else {
    report.text = await llmChannel.selftest({
      apiKey: llm.apiKey,
      baseUrl: llm.baseUrl,
      model: llm.model
    });
  }

  const visionModel = llm.visionModel ?? llm.model;
  if (llm.apiKey && llm.baseUrl && visionModel) {
    const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHElEQVQ4jWP8//8/AwMDAwMjAwMDIwMDAwMAAB6bBBAJ3lWuAAAAAElFTkSuQmCC";
    const result = await llmChannel.complete({
      apiKey: llm.apiKey,
      baseUrl: llm.baseUrl,
      model: visionModel,
      images: [pixel],
      system: "只输出 JSON。",
      user: "这张图是一个纯色方块。输出 {\"is_solid\":true,\"width\":16}",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["is_solid", "width"],
        properties: {is_solid: {type: "boolean"}, width: {type: "integer"}}
      },
      maxTokens: 128,
      repair: false
    });
    report.vision = {
      ok: result.ok === true,
      model: visionModel,
      value: result.value ?? null,
      usage: result.usage ?? null,
      fault: result.fault ?? null,
      latency_ms: result.latency_ms ?? null
    };
  } else {
    report.vision = {ok: false, detail: "未配置视觉模型"};
  }

  const text = JSON.stringify(report, null, 2);
  if (outIndex >= 0 && args[outIndex + 1]) {
    const target = resolve(ROOT, args[outIndex + 1]);
    await mkdir(dirname(target), {recursive: true});
    await writeFile(target, `${text}\n`);
    console.log(`已写入 ${join("", args[outIndex + 1])}`);
  }
  console.log(text);
  process.exitCode = report.text?.ok && report.vision?.ok ? 0 : 1;
}

await main();
