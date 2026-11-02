/**
 * 最小 CDP 客户端。
 *
 * 只做四件事：列标签页、开标签页、执行表达式、关标签页。
 * 不引第三方库 —— 项目要能干净 clone 后直接跑，Node 22 自带 WebSocket 够用。
 *
 * ── 两条硬约束（都有踩过的伤）──────────────────────
 * 1. `Runtime.evaluate` 一律 `awaitPromise: false`，表达式写成同步。
 *    页面上有长任务时 awaitPromise 会让调用永久挂起，只能等进程被超时杀掉。
 * 2. 每个调用都有超时。CDP 不返回时不能靠「等一等」，要能报错退出。
 */

const DEFAULT_TIMEOUT_MS = 30000;

/** 列标签页。 */
export async function listTabs({ port = 9222, timeout = 10000 } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) throw new Error(`列标签页失败：HTTP ${response.status}`);
  return response.json();
}

/** 按 URL 片段找标签页。找不到返回 null。 */
export async function findTab({ port = 9222, urlIncludes = null, timeout = 10000 } = {}) {
  const tabs = await listTabs({ port, timeout });
  const candidates = tabs.filter((tab) => tab.type === "page" || tab.type === "other");
  if (!urlIncludes) return candidates[0] ?? null;
  return candidates.find((tab) => String(tab.url ?? "").includes(urlIncludes)) ?? null;
}

/** 开新标签页，返回它的完整 info（含 id 与 webSocketDebuggerUrl）。 */
export async function newTab(url, { port = 9222, timeout = 20000 } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
    signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) throw new Error(`新建标签页失败：HTTP ${response.status}`);
  return response.json();
}

/** 关标签页。关不掉不算错（可能是共享的），返回布尔。 */
export async function closeTab(tabId, { port = 9222, timeout = 10000 } = {}) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/close/${tabId}`, {
      signal: AbortSignal.timeout(timeout)
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * 在指定标签页里执行表达式，返回 `Runtime.evaluate` 的 result.value。
 *
 * @param {string} tabId
 * @param {string} expression 同步表达式（不要返回 Promise）
 */
export async function evaluate(tabId, expression, { port = 9222, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const tabs = await listTabs({ port });
  const tab = tabs.find((item) => item.id === tabId);
  if (!tab) throw new Error(`找不到标签页 ${tabId}`);
  const wsUrl = tab.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error(`标签页 ${tabId} 没有 webSocketDebuggerUrl`);

  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const requestId = 1;
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* 关不掉不影响结果 */ }
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      // 超时前先尝试打断页面里的挂起执行，否则这个 tab 会一直占着
      try {
        socket.send(JSON.stringify({ id: 99, method: "Runtime.terminateExecution" }));
      } catch { /* 通道可能已断 */ }
      finish(new Error(`CDP 执行超时（${timeout}ms）`));
    }, timeout);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        id: requestId,
        method: "Runtime.evaluate",
        params: {
          expression,
          returnByValue: true,
          awaitPromise: false, // 关键：页面有长任务时 awaitPromise 会永久挂起
          timeout: Math.max(1000, timeout - 2000)
        }
      }));
    });

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      if (message.id !== requestId) return;
      if (message.error) {
        finish(new Error(`CDP 错误：${message.error.message ?? JSON.stringify(message.error)}`));
        return;
      }
      const result = message.result?.result;
      if (message.result?.exceptionDetails) {
        const detail = message.result.exceptionDetails;
        finish(new Error(`页面内异常：${detail.text ?? ""} ${detail.exception?.description ?? ""}`.trim()));
        return;
      }
      finish(null, result?.value);
    });

    socket.addEventListener("error", () => {
      finish(new Error("CDP WebSocket 连接失败（浏览器可能没开 9222 调试端口）"));
    });

    socket.addEventListener("close", () => {
      // 正常关闭时 finish 已经调用过；这里是兜底
      finish(new Error("CDP 连接在返回结果前关闭"));
    });
  });
}

/** 等页面条件成立（轮询同步表达式，返回真值即停）。 */
export async function waitFor(tabId, expression, { port = 9222, timeout = 30000, interval = 800 } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await evaluate(tabId, expression, { port, timeout: 10000 });
      if (last) return last;
    } catch (error) {
      last = `探测失败：${error.message}`;
    }
    await new Promise((done) => setTimeout(done, interval));
  }
  throw new Error(`等待条件超时（${timeout}ms）：${expression.slice(0, 80)}；最后一次=${JSON.stringify(last)}`);
}

/** 探活：浏览器在不在。只读，不改任何状态。 */
export async function probeBrowser({ port = 9222, timeout = 5000 } = {}) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeout)
    });
    if (!response.ok) return { available: false, reason: `HTTP ${response.status}` };
    const info = await response.json();
    return { available: true, browser: info.Browser ?? null, port };
  } catch (error) {
    return { available: false, reason: error.message, port };
  }
}
