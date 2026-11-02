#!/usr/bin/env node
/**
 * MCP server（stdio）：把这条链路已有的能力暴露给任意 MCP 客户端。
 *
 * 设计上的三条约束：
 * 1. 只封装已经存在的脚本，不在这里重新实现业务 —— 能力漂移会立刻暴露成两套口径；
 * 2. 参数先校验再 spawn：不拼 shell 字符串，不用 exec，避免命令注入；
 * 3. 长任务（出图 10 分钟级）超时可配，超时按"未完成"返回，不谎报成功。
 *
 * 协议：JSON-RPC 2.0，stdio，一行一条消息（NDJSON）。
 * 方法：initialize / notifications/initialized / tools/list / tools/call / ping。
 */
import {spawn} from "node:child_process";
import {readdir} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = {name: "crossborder-delivery-skill", version: "0.2.0"};

const runNode = (scriptPath, argv, {timeoutMs = 120000} = {}) => new Promise((resolvePromise) => {
  const child = spawn(process.execPath, [scriptPath, ...argv], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    child.kill();
    resolvePromise({code: null, stdout, stderr: `${stderr}\n[tool] 超时 ${timeoutMs}ms，已终止`});
  }, timeoutMs);
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolvePromise({code: null, stdout, stderr: `${stderr}\n[tool] 启动失败：${error.message}`});
  });
  child.on("close", (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolvePromise({code, stdout, stderr});
  });
});

const asText = (result) => {
  const body = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n---\n");
  return {
    content: [{type: "text", text: body || `(无输出；退出码 ${result.code})`}],
    isError: result.code !== 0
  };
};

const requireString = (value, name, {max = 200} = {}) => {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`参数 ${name} 必填且必须是非空字符串`);
  if (value.length > max) throw new Error(`参数 ${name} 超过 ${max} 字符`);
  return value.trim();
};

const requireInt = (value, name, {min = 0, max = 10000} = {}) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`参数 ${name} 必须是 ${min}–${max} 的整数`);
  return number;
};

const TOOLS = [
  {
    name: "chain_run",
    description: "跑完整链路：工单 → 排序 → 判别 → 母版图 → 平台投影 → 出包。默认用桩图（零成本）；realImages=true 才真实出图（单包约 2.7 元、10 分钟级）。",
    inputSchema: {
      type: "object",
      properties: {
        category: {type: "string", description: "品类，如 女装"},
        region: {type: "string", description: "法域两位码，如 RU"},
        candidates: {type: "integer", minimum: 1, maximum: 10, description: "候选数，默认 1"},
        intake: {type: "string", description: "问卷答案 JSON 的绝对路径；不给则只出包不出价"},
        tickets: {type: "string", description: "选品工单目录绝对路径；不给则读默认导出目录"},
        realImages: {type: "boolean", description: "是否真实调用图像模型（默认 false）"}
      },
      required: ["category", "region"],
      additionalProperties: false
    },
    handler: async (args) => {
      const argv = [
        "--category", requireString(args.category, "category", {max: 40}),
        "--region", requireString(args.region, "region", {max: 8}),
        "--candidates", String(requireInt(args.candidates ?? 1, "candidates", {min: 1, max: 10}))
      ];
      if (args.intake) argv.push("--intake", requireString(args.intake, "intake", {max: 500}));
      if (args.tickets) argv.push("--tickets", requireString(args.tickets, "tickets", {max: 500}));
      if (args.realImages !== true) argv.push("--mock-images");
      return asText(await runNode(join(ROOT, "scripts", "chain.mjs"), argv, {timeoutMs: 900000}));
    }
  },
  {
    name: "attrs_coverage",
    description: "查这个包对平台必填属性的覆盖情况，并检查字典型取值会不会被拒。退出码非 0 表示现状提交会被打回。",
    inputSchema: {
      type: "object",
      properties: {
        sku: {type: "string"},
        platform: {type: "string", description: "默认 ozon"}
      },
      required: ["sku"],
      additionalProperties: false
    },
    handler: async (args) => {
      const argv = ["--sku", requireString(args.sku, "sku", {max: 120})];
      if (args.platform) argv.push("--platform", requireString(args.platform, "platform", {max: 40}));
      return asText(await runNode(join(ROOT, "scripts", "check-attrs-coverage.mjs"), argv));
    }
  },
  {
    name: "title_check",
    description: "检查一条标题会不会被平台拒（字符数、单词长度、字符集、语言、禁用符号）。",
    inputSchema: {
      type: "object",
      properties: {
        text: {type: "string"},
        platform: {type: "string", description: "默认 ozon"}
      },
      required: ["text"],
      additionalProperties: false
    },
    handler: async (args) => {
      const text = requireString(args.text, "text", {max: 2000});
      const argv = ["--text", text];
      if (args.platform) argv.push("--platform", requireString(args.platform, "platform", {max: 40}));
      return asText(await runNode(join(ROOT, "scripts", "check-title.mjs"), argv));
    }
  },
  {
    name: "cost_estimate",
    description: "按官方价目表估算某个包的出图成本（元）。",
    inputSchema: {
      type: "object",
      properties: {
        sku: {type: "string"},
        model: {type: "string", description: "可选；默认取 config/local.json 的 imagegen.model"}
      },
      required: ["sku"],
      additionalProperties: false
    },
    handler: async (args) => {
      const argv = ["--sku", requireString(args.sku, "sku", {max: 120})];
      if (args.model) argv.push("--model", requireString(args.model, "model", {max: 80}));
      return asText(await runNode(join(ROOT, "scripts", "cost-estimate.mjs"), argv));
    }
  },
  {
    name: "sample_signals",
    description: "把人工抄的平台搜索结果 CSV 转成选品工单（非俄法域没有合规公开接口时的唯一路径）。dryRun=true 只预览不写盘。",
    inputSchema: {
      type: "object",
      properties: {
        region: {type: "string"},
        platform: {type: "string"},
        file: {type: "string", description: "CSV 绝对路径"},
        rate: {type: "number", description: "1 CNY 兑目标币，用于折算"},
        dryRun: {type: "boolean"}
      },
      required: ["region", "platform", "file"],
      additionalProperties: false
    },
    handler: async (args) => {
      const argv = [
        "--region", requireString(args.region, "region", {max: 8}),
        "--platform", requireString(args.platform, "platform", {max: 40}),
        "--file", requireString(args.file, "file", {max: 500})
      ];
      if (args.rate !== undefined) argv.push("--rate", String(Number(args.rate)));
      if (args.dryRun === true) argv.push("--dry");
      return asText(await runNode(join(ROOT, "scripts", "sample-signals.mjs"), argv));
    }
  },
  {
    name: "list_packages",
    description: "列出已经出过的包目录（按时间倒序）。",
    inputSchema: {type: "object", properties: {}, additionalProperties: false},
    handler: async () => {
      const names = await readdir(join(ROOT, "package")).catch(() => []);
      const text = names.length ? names.slice(-40).reverse().join("\n") : "还没有出过包";
      return {content: [{type: "text", text}], isError: false};
    }
  }
];

const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));

async function handle(request) {
  const {method, params, id} = request ?? {};
  if (method === "initialize") {
    return {jsonrpc: "2.0", id, result: {protocolVersion: PROTOCOL_VERSION, capabilities: {tools: {}}, serverInfo: SERVER_INFO}};
  }
  if (method === "ping") return {jsonrpc: "2.0", id, result: {}};
  if (method === "notifications/initialized") return null;
  if (method === "tools/list") {
    return {jsonrpc: "2.0", id, result: {tools: TOOLS.map(({name, description, inputSchema}) => ({name, description, inputSchema}))}};
  }
  if (method === "tools/call") {
    const name = params?.name;
    const tool = byName.get(name);
    if (!tool) {
      return {jsonrpc: "2.0", id, error: {code: -32602, message: `未知工具：${name}`}};
    }
    try {
      const result = await tool.handler(params?.arguments ?? {});
      return {jsonrpc: "2.0", id, result};
    } catch (error) {
      return {jsonrpc: "2.0", id, result: {content: [{type: "text", text: `参数/执行错误：${error.message}`}], isError: true}};
    }
  }
  if (typeof method === "string" && method.startsWith("notifications/")) return null;
  return {jsonrpc: "2.0", id, error: {code: -32601, message: `不支持的方法：${method}`}};
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (!line) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      send({jsonrpc: "2.0", id: null, error: {code: -32700, message: "JSON 解析失败"}});
      continue;
    }
    handle(request).then((response) => {
      if (response) send(response);
    }).catch((error) => {
      send({jsonrpc: "2.0", id: request?.id ?? null, error: {code: -32603, message: String(error?.message ?? error)}});
    });
  }
});
