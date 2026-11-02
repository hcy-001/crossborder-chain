import {rm} from "node:fs/promises";
import {join} from "node:path";
import sharp from "sharp";
import {classifyFault} from "./fault.mjs";

const ROLE_PROMPTS = {
  white_background: "full product centered on a pure white seamless background, e-commerce main image, front view with the whole garment visible, no props, no people",
  scene: "product worn or styled in a realistic everyday scene, natural light, shallow depth of field",
  detail: "extreme close-up macro of the fabric, knit stitches, seams and ribbed trims filling the frame, sharp focus, no people",
  // 尺寸图要的是可量测的平铺，不是「模特旁边飘一根卷尺」。
  size: "top-down flat lay of the garment alone on a neutral surface, measuring tape laid flat beside it without crossing the garment, whole garment including both sleeves inside the frame, no people, no readable text"
};

export const meta = {
  name: "http-openai-compat",
  kind: "imagegen",
  requires: "key",
  capabilities: {},
  cost: {currency: "CNY", unit_price: null}
};

function declaredCapabilities(input) {
  if (Array.isArray(input)) {
    return {generate: input.includes("generate"), edit: input.includes("edit")};
  }
  return {generate: input?.generate === true, edit: input?.edit === true};
}

function unavailable(detail, capabilities, extra = {}) {
  return {ok: false, detail, capabilities, ...extra};
}

function defaultRequestSize(width, height) {
  return width / height < 1 ? "1024x1536" : "1536x1024";
}

const COLOR_KEYS = ["color", "colour", "color.name", "colour.name", "color_name", "colour_name"];
const TYPE_KEYS = ["product_type", "product_name"];

function attributeValue(product, keys) {
  const rows = Array.isArray(product?.attributes) ? product.attributes : [];
  const hit = rows.find((row) => keys.includes(String(row?.canonical_key ?? "").toLowerCase()));
  const value = typeof hit?.value === "string" ? hit.value.trim() : "";
  return value.length > 0 ? value : null;
}

function factValue(product, keys) {
  const rows = Array.isArray(product?.facts) ? product.facts : [];
  const hit = rows.find((row) => keys.includes(String(row?.key ?? "").toLowerCase()));
  const value = typeof hit?.value === "string" ? hit.value.trim() : "";
  return value.length > 0 ? value : null;
}

const HAS_CJK = /[\u3400-\u9fff]/;

/**
 * 角色先定「允不允许有人」，brief 只能在这个前提下改光位与取景。
 * 现实缺陷：白底主图要求 no people，brief 里却带着 persona/action，
 * 两条指令互相拆台，模型就画了个穿着打底衫的模特当主图。
 */
/**
 * 角色对 brief 的取用策略：
 *   "all" → 场景图，光位/取景/动作/人物全要
 *   文本  → 只借光位，再加角色自己的硬约束（主图、特写不许有人）
 *   null  → 平铺量尺图，什么人物设定都不要
 * 现实缺陷：先前整份 brief 不分角色地塞进去，白底主图被写成模特摆拍、
 * 面料特写被写成半身人像 —— 两条指令互相拆台，模型只会挑一条执行。
 */
const BRIEF_POLICY = {
  white_background: "The garment is shown alone: no model, no hands, no mannequin face.",
  detail: "Fabric fills the frame; no face, no people, no full-body framing.",
  size: null,
  scene: "all"
};

function proofLine(creativeBrief, role) {
  if (!creativeBrief || role === "white_background") return null;
  const items = (creativeBrief.must_show ?? []).filter((item) => typeof item === "string" && item.trim().length > 0);
  if (items.length === 0) return null;
  return `画面必须能证明（人群假设）：${items.slice(0, 3).join("；")}。`;
}

function briefForRole(brief, role) {
  if (!brief) return null;
  if (typeof brief === "string") return BRIEF_POLICY[role] === null ? null : brief;
  // 注意不能用 `?? "all"`：本该是 null 的 size 会被 ?? 吞成 "all"。
  const policy = Object.hasOwn(BRIEF_POLICY, role) ? BRIEF_POLICY[role] : "all";
  if (policy === null) return null;
  if (policy === "all") return normalizeBrief(brief);
  return [brief.light, policy].filter(Boolean).join(" ");
}

export function buildPrompt({product, role, index, brief = null, creativeBrief = null}) {
  const subject = attributeValue(product, TYPE_KEYS) ?? product?.category ?? "garment";
  const material = factValue(product, ["material.composition"]) ?? attributeValue(product, ["material"]);
  const colour = factValue(product, COLOR_KEYS) ?? attributeValue(product, COLOR_KEYS);
  // 商品名多半是源语言（中文/俄文），塞进 "a <subject>" 的英文句式里模型容易当无意义词。
  // 所以源语言名字单独成句，且明确要求照它画 —— 这是「同一件商品」的唯一锚点。
  const head = HAS_CJK.test(subject)
    ? `Professional e-commerce product photograph. Garment (supplier original name, keep it identical): ${subject}.`
    : `Professional e-commerce product photograph of a ${subject}.`;
  return [
    head,
    material ? `Material: ${material}.` : null,
    colour ? `Colour: ${colour}.` : null,
    ROLE_PROMPTS[role] ?? ROLE_PROMPTS.scene,
    // 拍摄计划来自判别层：地点派生光位/焦段/动作，这里只负责把它写进画面语言。
    // 没有 brief 时退化为原来的模板 —— 但模板不该是终点，它只是下限。
    briefForRole(brief, role),
    // 人群假设对画面的唯一作用通道：只把「要证明什么」译成可见要求。
    // 白底主图不吃这条 —— 主图的职责是把整件拍全，不是塞进多个卖点。
    proofLine(creativeBrief, role),
    `Image ${index + 1} of one garment set.`,
    "Show the identical garment in every image of the set: same cut, same colour, same details.",
    "Photorealistic, high detail, no text, no watermark, no logos.",
    "Vertical framing suitable for marketplace listing."
  ].filter(Boolean).join(" ");
}

/**
 * 判别层给的是受控字段，生图模型读的是**画面里看得见的东西**。
 * 所以这里必须展开成「光从哪来、哪亮、哪暗」，不能把 3:1、4200K 这类摄影滑杆值直接丢给模型。
 */
function normalizeBrief(brief) {
  if (typeof brief === "string") return brief;
  const lines = [];
  if (brief.light) lines.push(brief.light);
  if (brief.framing) lines.push(brief.framing);
  if (brief.action) lines.push(brief.action);
  if (brief.persona) lines.push(brief.persona);
  if (brief.constraints) lines.push(brief.constraints);
  return lines.filter(Boolean).join(" ");
}

/**
 * 部分供应商对出图有最小像素要求（实测 Seedream 5.0 为 3686400px）。
 * 按错误回执里的阈值等比放大并保持原宽高比，16 的倍数对齐。
 */
export function scaleToMinPixels(size, minPixels) {
  const match = /^(\d+)x(\d+)$/.exec(String(size ?? ""));
  if (!match || !(minPixels > 0)) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width * height >= minPixels) return null;
  const scale = Math.sqrt(minPixels / (width * height));
  const align = (value) => Math.ceil(value / 16) * 16;
  return `${align(width * scale)}x${align(height * scale)}`;
}

async function requestImage({fetchImpl, endpoint, apiKey, model, prompt, size, signal}) {
  const send = (requestSize, extra) => fetchImpl(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({model, prompt, n: 1, size: requestSize, ...extra}),
    signal: signal ?? AbortSignal.timeout(180000)
  });

  const attempt = async (requestSize, extra) => {
    const response = await send(requestSize, extra);
    if (response.ok) {
      const body = await response.json();
      const item = body?.data?.[0];
      if (!item) throw Object.assign(new Error("image response contained no data"), {code: "NO_DATA"});
      return {item, size: requestSize, usage: body?.usage ?? null};
    }
    const detail = await response.text().catch(() => "");
    return {failure: {status: response.status, detail}};
  };

  let result = await attempt(size, {response_format: "b64_json"});
  if (result.failure) {
    const minPixels = /at least (\d+) pixels/.exec(result.failure.detail ?? "");
    const raised = minPixels ? scaleToMinPixels(size, Number(minPixels[1])) : null;
    if (raised) {
      result = await attempt(raised, {response_format: "b64_json"});
      if (result.failure) result = await attempt(raised, {});
    } else {
      result = await attempt(size, {});
    }
  }
  if (result.failure) {
    const {status, detail} = result.failure;
    throw Object.assign(new Error(`HTTP ${status}${detail ? `: ${detail.slice(0, 200)}` : ""}`), {
      http_status: status
    });
  }
  return result;
}

async function decodeImage(item, fetchImpl) {
  if (typeof item.b64_json === "string" && item.b64_json.length > 0) {
    return Buffer.from(item.b64_json, "base64");
  }
  if (typeof item.url === "string" && item.url.startsWith("https://")) {
    const response = await fetchImpl(item.url, {signal: AbortSignal.timeout(120000)});
    if (!response.ok) {
      throw Object.assign(new Error(`image download HTTP ${response.status}`), {http_status: response.status});
    }
    return Buffer.from(await response.arrayBuffer());
  }
  throw Object.assign(new Error("unsupported image payload"), {code: "NO_DATA"});
}

export async function probe(input = {}) {
  const capabilities = declaredCapabilities(input.capabilities);
  const apiKey = input.apiKey ?? process.env.OPENAI_API_KEY;
  const baseUrl = input.baseUrl ?? input.baseURL ?? process.env.OPENAI_BASE_URL;
  const model = input.model ?? process.env.OPENAI_IMAGE_MODEL;
  if (!apiKey) return unavailable("missing_api_key", capabilities);
  if (!baseUrl) return unavailable("missing_base_url", capabilities);
  if (!model) return unavailable("missing_model", capabilities);

  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return unavailable("fetch_unavailable", capabilities);

  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/models/${encodeURIComponent(model)}`, {
      method: "GET",
      headers: {accept: "application/json", authorization: `Bearer ${apiKey}`},
      signal: input.signal
    });
    if (!response.ok) {
      return unavailable(`HTTP ${response.status}`, capabilities, {status: response.status});
    }
    const body = await response.json();
    if (body?.id !== model) {
      return unavailable("model_mismatch", capabilities, {status: response.status});
    }
    return {ok: true, detail: "ready", model, capabilities};
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : "probe_failed", capabilities, {
      fault: classifyFault(error)
    });
  }
}

export async function run(input = {}) {
  const capabilities = declaredCapabilities(input.capabilities);
  const apiKey = input.apiKey ?? process.env.OPENAI_API_KEY;
  const baseUrl = input.baseUrl ?? input.baseURL ?? process.env.OPENAI_BASE_URL;
  const model = input.model ?? process.env.OPENAI_IMAGE_MODEL;
  const missing = !apiKey ? "missing_api_key" : !baseUrl ? "missing_base_url" : !model ? "missing_model" : null;
  if (missing) return {ok: false, files: [], meta: {reason: missing, capabilities}, usage: {}};
  if (input.capabilities !== undefined && !capabilities.generate) {
    return {ok: false, files: [], meta: {reason: "capability_not_declared", capabilities}, usage: {}};
  }

  const {width, height, count, outputDir, product, roles} = input;
  if (!Number.isInteger(width) || width <= 0) throw new TypeError("width must be a positive integer");
  if (!Number.isInteger(height) || height <= 0) throw new TypeError("height must be a positive integer");
  if (!Number.isInteger(count) || count <= 0) throw new TypeError("count must be a positive integer");
  if (typeof outputDir !== "string" || outputDir.length === 0) throw new TypeError("outputDir is required");

  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return {ok: false, files: [], meta: {reason: "fetch_unavailable", capabilities}, usage: {}};
  }

  const endpoint = `${baseUrl.replace(/\/+$/, "")}/images/generations`;
  const requestedSize = input.requestSize ?? defaultRequestSize(width, height);
  const files = [];
  const actualSizes = [];
  const usageTotals = {images: 0, output_tokens: 0};
  const brief = input.brief ?? null;
  const creativeBrief = input.creativeBrief ?? product?.creative_brief ?? null;
  const promptSample = buildPrompt({product, role: Array.isArray(roles) ? roles[0] ?? "scene" : "scene", index: 0, brief, creativeBrief});
  let costPerImage = Number.isFinite(input.unitPriceCny) ? input.unitPriceCny : null;

  try {
    for (let index = 0; index < count; index += 1) {
      const role = Array.isArray(roles) ? roles[index] ?? "scene" : "scene";
      const prompt = buildPrompt({product, role, index, brief, creativeBrief});
      const payload = await requestImage({
        fetchImpl,
        endpoint,
        apiKey,
        model,
        prompt,
        size: requestedSize,
        signal: input.signal
      });
      actualSizes.push(payload.size);
      usageTotals.images += 1;
      if (Number.isFinite(payload.usage?.output_tokens)) usageTotals.output_tokens += payload.usage.output_tokens;
      const raw = await decodeImage(payload.item, fetchImpl);
      const file = join(outputDir, `generated-${String(index + 1).padStart(2, "0")}.png`);
      await sharp(raw)
        .resize(width, height, {fit: "cover", position: "centre"})
        .png()
        .toFile(file);
      files.push(file);
    }
    return {
      ok: true,
      files,
      quality: "generated",
      meta: {
        quality: "generated",
        width,
        height,
        count,
        model,
        requestSize: requestedSize,
        actualSizes,
        promptSample,
        roles: files.length
      },
      usage: {
        images: count,
        unit_price: costPerImage,
        output_tokens: usageTotals.output_tokens,
        cost_cny: costPerImage === null ? null : Number((costPerImage * count).toFixed(4))
      }
    };
  } catch (error) {
    await Promise.allSettled(files.map((file) => rm(file, {force: true})));
    return {
      ok: false,
      files: [],
      meta: {reason: error instanceof Error ? error.message : "generation_failed", capabilities},
      usage: {},
      fault: classifyFault(error)
    };
  }
}

export function fault(error) {
  return classifyFault(error);
}
