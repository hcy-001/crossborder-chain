import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {dirname, join, resolve} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** 起一个 MCP server 进程，按行发请求，按行收响应。 */
function session() {
  const child = spawn(process.execPath, [join(ROOT, "mcp", "server.mjs")], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let buffer = "";
  const waiters = [];
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      } else {
        waiters.push(message);
      }
    }
  });
  const nextId = {value: 1};
  const request = (method, params) => new Promise((resolvePromise, reject) => {
    const id = nextId.value++;
    const timer = setTimeout(() => reject(new Error(`超时：${method}`)), 20000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolvePromise(message);
    });
    child.stdin.write(`${JSON.stringify({jsonrpc: "2.0", id, method, params})}\n`);
  });
  return {
    request,
    notify: (method, params) => child.stdin.write(`${JSON.stringify({jsonrpc: "2.0", method, params})}\n`),
    close: () => new Promise((resolvePromise) => {
      child.on("close", resolvePromise);
      child.kill();
    })
  };
}

test("MCP 握手：返回协议版本与服务标识", async () => {
  const client = session();
  try {
    const response = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {name: "test", version: "0"}
    });
    assert.equal(response.result.protocolVersion, "2024-11-05");
    assert.equal(response.result.serverInfo.name, "crossborder-delivery-skill");
    assert.ok(response.result.capabilities.tools);
  } finally {
    await client.close();
  }
});

test("tools/list 暴露 6 个工具，且每个都有入参 schema", async () => {
  const client = session();
  try {
    await client.request("initialize", {protocolVersion: "2024-11-05", capabilities: {}});
    const response = await client.request("tools/list", {});
    const names = response.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["attrs_coverage", "chain_run", "cost_estimate", "list_packages", "sample_signals", "title_check"]);
    for (const tool of response.result.tools) {
      assert.equal(tool.inputSchema.type, "object", tool.name);
      assert.ok(tool.description.length > 10, tool.name);
    }
  } finally {
    await client.close();
  }
});

test("tools/call 真跑一次标题检查：违规时 isError=true", async () => {
  const client = session();
  try {
    await client.request("initialize", {protocolVersion: "2024-11-05", capabilities: {}});
    const bad = await client.request("tools/call", {name: "title_check", arguments: {text: "爆款连衣裙"}});
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /no_cyrillic|cjk_char/);

    const good = await client.request("tools/call", {
      name: "title_check",
      arguments: {text: "Trendy Платье женское, миди"}
    });
    assert.equal(good.result.isError, false);
    assert.match(good.result.content[0].text, /无硬性违规/);
  } finally {
    await client.close();
  }
});

test("参数校验：缺必填 → isError 且不改用默认值硬跑", async () => {
  const client = session();
  try {
    await client.request("initialize", {protocolVersion: "2024-11-05", capabilities: {}});
    const response = await client.request("tools/call", {name: "attrs_coverage", arguments: {}});
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /sku/);
  } finally {
    await client.close();
  }
});

test("未知工具返回 -32602，而不是静默成功", async () => {
  const client = session();
  try {
    await client.request("initialize", {protocolVersion: "2024-11-05", capabilities: {}});
    const response = await client.request("tools/call", {name: "no_such_tool", arguments: {}});
    assert.equal(response.error.code, -32602);
  } finally {
    await client.close();
  }
});

test("list_packages 不跑子进程也能返回", async () => {
  const client = session();
  try {
    await client.request("initialize", {protocolVersion: "2024-11-05", capabilities: {}});
    const response = await client.request("tools/call", {name: "list_packages", arguments: {}});
    assert.equal(response.result.isError, false);
    assert.ok(response.result.content[0].text.length > 0);
  } finally {
    await client.close();
  }
});
