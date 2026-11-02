import {mkdir, readFile, writeFile, access} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {createInterface} from "node:readline/promises";
import {stdin, stdout} from "node:process";

const QUESTIONS = [
  {
    key: "imagegen.enabled",
    label: "启用真实生图",
    hint: "true = 调用图像模型出图；false = 用占位图走完整流程",
    type: "boolean",
    default: false
  },
  {
    key: "imagegen.baseUrl",
    label: "生图 API base URL",
    hint: "OpenAI 兼容地址，含版本段，如 https://api.openai.com/v1",
    type: "string",
    default: "https://api.openai.com/v1",
    when: (answers) => answers.imagegen?.enabled === true
  },
  {
    key: "imagegen.model",
    label: "生图模型名",
    hint: "供应方文档里的模型标识，如 gpt-image-1 / flux-pro-1.1",
    type: "string",
    default: "",
    required: true,
    when: (answers) => answers.imagegen?.enabled === true
  },
  {
    key: "imagegen.apiKey",
    label: "生图 API key（私密，单独存 local.secret.json）",
    hint: "不会写进仓库配置，也不会出现在日志与回执里",
    type: "string",
    default: "",
    required: true,
    secret: true,
    when: (answers) => answers.imagegen?.enabled === true
  },
  {
    key: "imagegen.unitPriceCny",
    label: "单张图成本（CNY）",
    hint: "用于成本核算；不确定就填 null 表示未知，不计入估算",
    type: "number",
    default: null,
    when: (answers) => answers.imagegen?.enabled === true
  },
  {
    key: "imagegen.requestSize",
    label: "请求尺寸",
    hint: "供应方实际支持的尺寸，出图后统一裁到 900x1200",
    type: "string",
    default: "1024x1536",
    when: (answers) => answers.imagegen?.enabled === true
  },
  {
    key: "imagegen.maxImagesPerSku",
    label: "每个 SKU 最多生成张数",
    hint: "主流程固定需要 9 张；调低会导致出包失败，仅用于成本兜底",
    type: "number",
    default: 9,
    when: (answers) => answers.imagegen?.enabled === true
  },
  {
    key: "sku.mode",
    label: "SKU 数据来源",
    hint: "new = 手写 input/<sku>.json；import = 从历史目录导入",
    type: "string",
    default: "new",
    choices: ["new", "import"]
  },
  {
    key: "sku.historyDir",
    label: "历史数据目录",
    hint: "含 SKU json 或已生成图片的旧目录，导入后复用不重生成",
    type: "string",
    default: "",
    when: (answers) => answers.sku?.mode === "import"
  },
  {
    key: "defaultRegion",
    label: "默认法域",
    hint: "现有 RU / SA / AE / SG / KZ 等目录名",
    type: "string",
    default: "RU"
  },
  {
    key: "fx.forceRefresh",
    label: "每次运行强制刷新汇率",
    hint: "false = TTL 内复用缓存，避免无谓请求",
    type: "boolean",
    default: false
  }
];

const CONFIG_PATH = "config/local.json";
const SECRET_PATH = "config/local.secret.json";

function readAt(object, path) {
  return path.split(".").reduce((current, part) => current?.[part], object);
}

function writeAt(object, path, value) {
  const parts = path.split(".");
  const last = parts.pop();
  let cursor = object;
  for (const part of parts) {
    cursor[part] ??= {};
    cursor = cursor[part];
  }
  cursor[last] = value;
}

function deleteAt(object, path) {
  const parts = path.split(".");
  const last = parts.pop();
  const parent = parts.reduce((current, part) => current?.[part], object);
  if (parent) delete parent[last];
}

function coerce(raw, question) {
  const text = raw.trim();
  if (question.type === "boolean") {
    if (text === "") return question.default;
    const lowered = text.toLowerCase();
    if (["y", "yes", "true", "1", "是"].includes(lowered)) return true;
    if (["n", "no", "false", "0", "否"].includes(lowered)) return false;
    throw new Error(`${question.label} 需要 true/false`);
  }
  if (question.type === "number") {
    if (text === "" || text.toLowerCase() === "null") return question.default;
    const value = Number(text);
    if (!Number.isFinite(value)) throw new Error(`${question.label} 需要数字`);
    return value;
  }
  if (text === "") return question.default;
  if (question.choices && !question.choices.includes(text)) {
    throw new Error(`${question.label} 只能是 ${question.choices.join(" / ")}`);
  }
  return text;
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function fromAnswersFile(root, file) {
  const answers = JSON.parse(await readFile(resolve(root, file), "utf8"));
  const config = {imagegen: {}, sku: {}, fx: {}, defaultRegion: undefined};
  const secrets = {};
  for (const question of QUESTIONS) {
    const value = readAt(answers, question.key);
    if (value === undefined) {
      if (question.secret) continue;
      if (question.required && readAt(answers, "imagegen.enabled") === true) {
        throw new Error(`answers file is missing required field: ${question.key}`);
      }
      if (question.default !== undefined) writeAt(config, question.key, question.default);
      continue;
    }
    if (question.secret) {
      writeAt(secrets, question.key, value);
      continue;
    }
    writeAt(config, question.key, value);
  }
  return {config, secrets};
}

async function fromPrompt(root) {
  const rl = createInterface({input: stdin, output: stdout});
  const config = {imagegen: {}, sku: {}, fx: {}};
  const secrets = {};
  try {
    console.log("一次性配置：所有私有信息问完即写本地，之后 doctor / demo / pack 直接读，不再逐项缺失。\n");
    for (const question of QUESTIONS) {
      if (question.when && !question.when(config)) continue;
      while (true) {
        const suffix = question.default === null || question.default === "" ? "" : ` [${question.default}]`;
        const answer = await rl.question(`${question.label}${suffix}\n  ${question.hint}\n> `);
        try {
          const value = coerce(answer, question);
          if (question.secret) {
            if (!value) throw new Error(`${question.label} 不能为空`);
            writeAt(secrets, question.key, value);
          } else {
            writeAt(config, question.key, value);
          }
          break;
        } catch (error) {
          console.log(`  ! ${error.message}`);
        }
      }
    }
  } finally {
    rl.close();
  }
  const imagegen = {enabled: config.imagegen.enabled === true};
  if (imagegen.enabled) {
    delete config.imagegen.apiKey;
    Object.assign(imagegen, config.imagegen);
  } else {
    config.imagegen = {enabled: false};
  }
  config.imagegen = imagegen;
  return {config, secrets};
}

function summarize(config, secrets) {
  const apiKey = readAt(secrets, "imagegen.apiKey");
  const lines = [
    `生图：${config.imagegen.enabled ? `真实通道 ${config.imagegen.model} @ ${config.imagegen.baseUrl}` : "占位图模式"}`,
    config.imagegen.enabled ? `  请求尺寸 ${config.imagegen.requestSize} → 统一裁到 900x1200，单张成本 ${config.imagegen.unitPriceCny ?? "未知"}` : null,
    `  key：${apiKey ? `已写入 ${SECRET_PATH}（${String(apiKey).length} 字符）` : "无"}`,
    `SKU 来源：${config.sku.mode}${config.sku.historyDir ? ` ← ${config.sku.historyDir}` : ""}`,
    `默认法域：${config.defaultRegion}`,
    `汇率缓存：${config.fx.forceRefresh ? "每次强制刷新" : "TTL 内复用"}`
  ].filter(Boolean);
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const root = args.includes("--root") ? resolve(args[args.indexOf("--root") + 1]) : process.cwd();
  const answersFile = args.includes("--answers") ? args[args.indexOf("--answers") + 1] : null;

  const {config, secrets} = answersFile ? await fromAnswersFile(root, answersFile) : await fromPrompt(root);

  const configPath = join(root, CONFIG_PATH);
  const secretPath = join(root, SECRET_PATH);
  await mkdir(dirname(configPath), {recursive: true});
  for (const question of QUESTIONS.filter((item) => item.secret)) deleteAt(config, question.key);
  await writeFile(configPath, `${JSON.stringify({...config, updatedAt: new Date().toISOString()}, null, 2)}\n`, "utf8");

  if (Object.keys(secrets).length > 0) {
    await writeFile(secretPath, `${JSON.stringify(secrets, null, 2)}\n`, {encoding: "utf8", mode: 0o600});
  } else if (await exists(secretPath)) {
    console.log(`注意：${SECRET_PATH} 仍保留旧 key，本次未覆盖。`);
  }

  console.log(`\n已写入 ${CONFIG_PATH}`);
  console.log(summarize(config, secrets));
  console.log("\n下一步：npm run doctor && npm run demo");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
