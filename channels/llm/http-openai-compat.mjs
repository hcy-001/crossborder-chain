import {classifyFault, salvageJson} from "./fault.mjs";

export const meta = {
  name: "http-openai-compat",
  kind: "llm",
  requires: "key",
  capabilities: {json_mode: true, structured_output: false},
  cost: {currency: "CNY", unit_price: null, unit_price_reason: "单价按供应商价格页现查，不写死"}
};

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_TOKENS = 2_048;
const RETRYABLE_ATTEMPTS = 3;

function normalizeBase(baseUrl) {
  const trimmed = String(baseUrl ?? "").replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

function joinUrl(baseUrl) {
  const endpoint = normalizeBase(baseUrl);
  if (!endpoint) return "";
  return endpoint;
}

export function probe(config = {}) {
  const missing = ["apiKey", "baseUrl", "model"].filter((key) => !config[key]);
  if (missing.length > 0) {
    return {ok: false, detail: `缺少 ${missing.join(" / ")}`, capabilities: meta.capabilities};
  }
  return {
    ok: true,
    detail: `configured model=${config.model}`,
    capabilities: meta.capabilities,
    note: "probe 只校验配置形状，不发请求；真实连通性用 selftest()"
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 一次真实调用。约定：
 * - 永远把 usage 原样带回来（账单是证据，不是日志）
 * - 截断（finish_reason=length）算「失败但可救」，抬 max_tokens 重来一次
 * - 拿不到 JSON 时走一次「修复轮」，把残片与 schema 一起递回去
 */
export async function complete(input = {}) {
  const {
    apiKey,
    baseUrl,
    model,
    system,
    user,
    schema,
    maxTokens = DEFAULT_MAX_TOKENS,
    temperature = 0.2,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    jsonMode = true,
    repair = true,
    thinking = null,
    fetchImpl = globalThis.fetch
  } = input;

  const endpoint = joinUrl(baseUrl);
  if (!endpoint || !apiKey || !model) {
    return {
      ok: false,
      fault: {kind: "permanent", reason: "not_configured", detail: "apiKey / baseUrl / model 不全"},
      attempts: 0,
      usage: null
    };
  }

  const startedAt = Date.now();
  const ledger = [];
  const userContent = Array.isArray(input.images) && input.images.length > 0
    ? [
      ...input.images.map((url) => ({type: "image_url", image_url: {url}})),
      {type: "text", text: typeof user === "string" ? user : JSON.stringify(user)}
    ]
    : (typeof user === "string" ? user : JSON.stringify(user));
  let messages = [
    ...(system ? [{role: "system", content: system}] : []),
    {role: "user", content: userContent}
  ];
  let budget = maxTokens;
  let lastFault = null;

  for (let attempt = 1; attempt <= RETRYABLE_ATTEMPTS; attempt += 1) {
    const body = {
      model,
      messages,
      max_tokens: budget,
      temperature
    };
    if (jsonMode) body.response_format = {type: "json_object"};
    // 推理开关交给调用方：结构化抽取不需要长思考，开一次思考多烧 1000 token 与 30 秒。
    if (thinking === "enabled" || thinking === "disabled") body.thinking = {type: thinking};

    let response;
    let payload = null;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
      payload = await response.json().catch(() => null);
    } catch (error) {
      const fault = classifyFault(0, error?.message ?? String(error));
      ledger.push({attempt, status: 0, fault: fault.reason, detail: fault.detail});
      lastFault = fault;
      if (fault.kind === "transient" && attempt < RETRYABLE_ATTEMPTS) {
        await delay(400 * attempt * attempt);
        continue;
      }
      return {ok: false, fault, attempts: attempt, usage: null, ledger, latency_ms: Date.now() - startedAt};
    }

    const status = response.status;
    if (!response.ok) {
      const message = payload?.error?.message ?? payload?.message ?? response.statusText;
      const fault = classifyFault(status, message);
      ledger.push({attempt, status, fault: fault.reason, detail: String(message).slice(0, 200)});
      lastFault = fault;
      if (fault.kind === "transient" && attempt < RETRYABLE_ATTEMPTS) {
        await delay(400 * attempt * attempt);
        continue;
      }
      return {ok: false, fault, attempts: attempt, usage: null, ledger, latency_ms: Date.now() - startedAt};
    }

    const choice = payload?.choices?.[0];
    const content = choice?.message?.content ?? "";
    const finish = choice?.finish_reason ?? "unknown";
    const usage = payload?.usage ?? null;

    if (finish === "length" && budget < DEFAULT_MAX_TOKENS * 4) {
      ledger.push({attempt, status, fault: "truncated", detail: `finish=length at ${budget} tokens`});
      budget *= 4;
      lastFault = {kind: "content", reason: "truncated", detail: "输出被 max_tokens 截断"};
      continue;
    }

    const parsed = salvageJson(content);
    if (parsed.ok) {
      return {
        ok: true,
        value: parsed.value,
        parse_layer: parsed.layer,
        raw: content,
        finish_reason: finish,
        usage,
        model,
        attempts: attempt,
        ledger,
        latency_ms: Date.now() - startedAt
      };
    }

    if (repair && attempt === 1) {
      ledger.push({attempt, status, fault: "unparsable", detail: parsed.layer});
      messages = [
        ...messages,
        {role: "assistant", content: content || "(空)"},
        {
          role: "user",
          content: [
            "上一条输出无法被 JSON.parse 解析。只重发一遍纯 JSON，不要解释、不要代码块围栏。",
            schema ? `必须满足的 JSON Schema：${JSON.stringify(schema)}` : "",
            "不要在 JSON 之外写任何字符。"
          ].filter(Boolean).join("\n")
        }
      ];
      lastFault = {kind: "content", reason: "unparsable", detail: parsed.layer};
      continue;
    }

    return {
      ok: false,
      fault: {kind: "content", reason: "unparsable", detail: parsed.layer},
      raw: content,
      usage,
      attempts: attempt,
      ledger,
      latency_ms: Date.now() - startedAt
    };
  }

  return {
    ok: false,
    fault: lastFault ?? {kind: "transient", reason: "exhausted", detail: "重试次数用尽"},
    attempts: RETRYABLE_ATTEMPTS,
    usage: null,
    ledger,
    latency_ms: Date.now() - startedAt
  };
}

/** 真实连通性自测：一次 8 token 的调用，成本可忽略，用来证明 key 与模型名不是想象出来的。 */
export async function selftest(config = {}) {
  const startedAt = Date.now();
  const result = await complete({
    ...config,
    system: "只输出 JSON。",
    user: "输出 {\"ok\":true}",
    schema: {type: "object", required: ["ok"], properties: {ok: {type: "boolean"}}},
    maxTokens: 32,
    jsonMode: true,
    repair: false
  });
  return {
    ok: result.ok === true && result.value?.ok === true,
    model: config.model ?? null,
    endpoint: normalizeBase(config.baseUrl),
    latency_ms: Date.now() - startedAt,
    usage: result.usage ?? null,
    fault: result.fault ?? null,
    attempts: result.attempts ?? 0
  };
}

/** 通道统一入口，形状与 imagegen 通道一致（probe / run / meta）。 */
export async function run(input = {}) {
  return complete(input);
}
