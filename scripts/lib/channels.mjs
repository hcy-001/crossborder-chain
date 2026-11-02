import {readFile} from "node:fs/promises";
import {basename, join} from "node:path";
import * as mockChannel from "../../channels/imagegen/mock.mjs";
import * as openaiChannel from "../../channels/imagegen/http-openai-compat.mjs";
import * as reuseChannel from "../../channels/imagegen/reuse.mjs";
import * as mockLlm from "../../channels/llm/mock.mjs";
import * as openaiLlm from "../../channels/llm/http-openai-compat.mjs";

async function readOptionalJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function loadLocalConfig(root) {
  const config = (await readOptionalJson(join(root, "config/local.json"))) ?? {};
  const secrets = (await readOptionalJson(join(root, "config/local.secret.json"))) ?? {};
  const merged = structuredClone(config);
  for (const [section, values] of Object.entries(secrets)) {
    if (!values || typeof values !== "object" || Array.isArray(values)) continue;
    merged[section] = {...(merged[section] ?? {}), ...values};
  }
  return {
    ...merged,
    secretSource: Object.keys(secrets).length > 0 ? "config/local.secret.json" : null
  };
}

/**
 * 绑定 = 把配置注进去，且**不得丢掉模块的对外接口**。
 * 判别层按 complete() 判通道是否可用，先前这里只透传 run，导致真实通道被判成
 * 「未配置」而全量静默回退 —— 接口在绑定时被吃掉，是最难被发现的一类缺陷。
 */
function bound(module, settings, label) {
  const channel = {
    meta: {...module.meta, name: label},
    probe: (input = {}) => module.probe({...settings, ...input}),
    run: (input = {}) => module.run({...settings, ...input}),
    fault: module.fault
  };
  for (const name of ["complete", "selftest"]) {
    if (typeof module[name] === "function") {
      channel[name] = (input = {}) => module[name]({...settings, ...input});
    }
  }
  return channel;
}

/**
 * 注入通道也要如实标降级：桩就是桩，不能因为「是调用方传进来的」就升格成真实通道。
 * 这条挡的是把占位图写进回执的「真实出图」—— 等级夸大比失败更危险。
 */
function injectedLabel(module) {
  const name = module?.meta?.name ?? "injected";
  const isMock = /mock/i.test(name);
  return {detail: name, degraded: isMock};
}

export async function selectImageChannel(root, injected) {
  if (injected) {
    const {detail, degraded} = injectedLabel(injected);
    return {channel: injected, detail, config: null, degraded};
  }

  const config = (await loadLocalConfig(root)) ?? {};
  const imagegen = config.imagegen ?? {};

  if (typeof imagegen.reuseDir === "string" && imagegen.reuseDir.length > 0) {
    const ready = await reuseChannel.probe({sourceDir: imagegen.reuseDir});
    if (ready.ok) {
      const label = `reuse:${basename(imagegen.reuseDir)}`;
      return {
        channel: bound(reuseChannel, {sourceDir: imagegen.reuseDir}, label),
        detail: `${label} (${ready.detail}, 零成本)`,
        config,
        degraded: false
      };
    }
    config.reuseNote = `reuse 不可用：${ready.detail}`;
  }

  if (imagegen.enabled !== true) {
    return {
      channel: mockChannel,
      detail: config.reuseNote ?? "mock (config/local.json 未启用真实生图)",
      config,
      degraded: true
    };
  }
  if (!imagegen.apiKey) {
    return {
      channel: mockChannel,
      detail: "mock (缺少生图 api key)",
      config,
      degraded: true
    };
  }
  if (!imagegen.baseUrl || !imagegen.model) {
    return {
      channel: mockChannel,
      detail: "mock (缺少 baseUrl 或 model)",
      config,
      degraded: true
    };
  }

  const settings = {
    apiKey: imagegen.apiKey,
    baseUrl: imagegen.baseUrl,
    model: imagegen.model,
    requestSize: imagegen.requestSize,
    unitPriceCny: imagegen.unitPriceCny
  };
  const label = `http-openai-compat:${imagegen.model}`;
  return {channel: bound(openaiChannel, settings, label), detail: label, config, degraded: false};
}

/**
 * 判别通道的选择规则与生图通道同构：能配就真跑，配不了就退到桩，绝不静默假装。
 *
 * 与生图不同的是**没有 key 不算降级失败**：判别层每个点都有确定性回退，
 * 桩返回的答案只用于离线测试，运行时走 fallback 而不是走桩。
 */
export async function selectLlmChannel(root, injected) {
  if (injected) {
    const {detail, degraded} = injectedLabel(injected);
    return {channel: injected, detail, config: null, degraded};
  }

  const config = (await loadLocalConfig(root)) ?? {};
  const llm = config.llm ?? {};

  if (llm.enabled === false) {
    return {channel: mockLlm, detail: "mock (config/local.json 显式关闭判别通道)", config, degraded: true};
  }
  if (!llm.apiKey) {
    return {channel: mockLlm, detail: "mock (缺少判别 api key，链路走确定性回退)", config, degraded: true};
  }
  if (!llm.baseUrl || !llm.model) {
    return {channel: mockLlm, detail: "mock (缺少 baseUrl 或 model)", config, degraded: true};
  }
  if (llm.offlineProbe === true) {
    return {channel: mockLlm, detail: "mock (offlineProbe=true，离线用例专用)", config, degraded: true};
  }

  const settings = {
    apiKey: llm.apiKey,
    baseUrl: llm.baseUrl,
    model: llm.model,
    maxTokens: llm.maxTokens,
    thinking: llm.thinking ?? null
  };
  const label = `http-openai-compat:${llm.model}`;
  return {channel: bound(openaiLlm, settings, label), detail: label, config, degraded: false};
}
