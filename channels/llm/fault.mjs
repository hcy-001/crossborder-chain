/**
 * 文本通道的失效分类。判据只有一条：这次失败**再试一次会不会不同**。
 *
 * - transient：网络抖动、限流、5xx、超时 —— 重试有意义
 * - permanent：鉴权、模型不存在、请求体非法 —— 重试只是烧钱
 * - content：HTTP 成功但返回不是可用 JSON —— 需要「修复轮」而不是原样重试
 */
export function classifyFault(status, message = "") {
  const text = String(message ?? "");
  if (status === 401 || status === 403) return {kind: "permanent", reason: "auth", detail: text};
  if (status === 404 || /InvalidEndpointOrModel|model .*not (?:exist|found)/i.test(text)) {
    return {kind: "permanent", reason: "model_unavailable", detail: text};
  }
  if (status === 400 || /invalid_request|invalid_request_error/i.test(text)) {
    return {kind: "permanent", reason: "bad_request", detail: text};
  }
  if (status === 429 || /rate.?limit|too many requests/i.test(text)) {
    return {kind: "transient", reason: "rate_limit", detail: text};
  }
  if (status >= 500) return {kind: "transient", reason: "server", detail: text};
  if (status === 0 || /timeout|aborted|ECONN|EAI_AGAIN|fetch failed|socket/i.test(text)) {
    return {kind: "transient", reason: "network", detail: text};
  }
  return {kind: "transient", reason: "unknown", detail: text};
}

/**
 * 从「模型返回的一段文本」里抢救 JSON。
 *
 * 三层，逐层放宽，每层都记下用的是哪一层 —— 因为「靠第 3 层救回来的」
 * 与「本来就是干净 JSON」是不同的证据等级，不能混着报。
 */
export function salvageJson(text) {
  const source = String(text ?? "").trim();
  if (source.length === 0) return {ok: false, layer: "empty", value: null};

  try {
    return {ok: true, layer: "strict", value: JSON.parse(source)};
  } catch {
    // 继续放宽
  }

  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return {ok: true, layer: "fenced", value: JSON.parse(fenced[1].trim())};
    } catch {
      // 继续放宽
    }
  }

  const start = source.search(/[[{]/);
  if (start >= 0) {
    const candidate = source.slice(start);
    try {
      return {ok: true, layer: "substring", value: JSON.parse(candidate)};
    } catch {
      // 括号配平再试一次：模型常在 JSON 后面跟一句「以上」，直接 parse 会废掉整段
      const balanced = extractBalanced(candidate);
      if (balanced !== null) {
        try {
          return {ok: true, layer: "substring", value: JSON.parse(balanced)};
        } catch {
          // 继续放宽
        }
      }
      const repaired = repairTruncated(candidate);
      if (repaired !== null) return {ok: true, layer: "salvaged", value: repaired};
    }
  }

  return {ok: false, layer: "unparsable", value: null};
}

/** 取出第一段括号配平的 JSON 片段（跳过字符串内的括号）。 */
function extractBalanced(text) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(0, index + 1);
    }
  }
  return null;
}

/**
 * 被 max_tokens 截断的 JSON：砍到最后一个完整元素，补齐括号。
 * 这是「返回半截」最常见的真实形态（对象末尾丢一个花括号），不是把残片当答案。
 */
function repairTruncated(text) {
  const stack = [];
  let inString = false;
  let escaped = false;
  let lastSafe = -1;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
    else if (char === "}" || char === "]") stack.pop();
    else if (char === "," && stack.length > 0) lastSafe = index;
  }

  const closers = stack.slice().reverse().join("");
  const attempts = [];
  if (!inString) attempts.push(text + closers);
  if (lastSafe > 0) {
    const head = text.slice(0, lastSafe);
    const headStack = [];
    let headInString = false;
    let headEscaped = false;
    for (const char of head) {
      if (headInString) {
        if (headEscaped) headEscaped = false;
        else if (char === "\\") headEscaped = true;
        else if (char === '"') headInString = false;
        continue;
      }
      if (char === '"') headInString = true;
      else if (char === "{" || char === "[") headStack.push(char === "{" ? "}" : "]");
      else if (char === "}" || char === "]") headStack.pop();
    }
    attempts.push(head + headStack.slice().reverse().join(""));
  }

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      continue;
    }
  }
  return null;
}
