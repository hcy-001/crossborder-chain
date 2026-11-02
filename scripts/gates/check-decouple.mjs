import {readdir, readFile} from "node:fs/promises";
import {basename, join, resolve, sep} from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

const CHECK_IDS = ["G1-CORE", "G1-PATH", "G1-FACT", "G1-PROFILE", "G2-NET", "G1-SOURCES", "G3-JUDGE"];
const FACT_FIELDS = ["source_url", "fetched_at", "ttl_hours"];
const NETWORK_PATTERNS = [
  {label: "bare fetch call", pattern: /\bfetch\s*\(/},
  {label: "globalThis.fetch", pattern: /globalThis\s*\.\s*fetch/},
  {label: "node http/https/net/tls import", pattern: /(?:from|require\()\s*["']node:(?:http|https|net|tls)["']/},
  {label: "http client library", pattern: /\b(?:undici|axios|node-fetch|got|superagent)\b/}
];
const CORE_PATTERNS = [
  {
    label: "region code",
    pattern: /\b(?:RU|SA|AE|SEA|SG|MY|TH|VN|PH|ID|UAE)\b/
  },
  {
    label: "region name",
    pattern: /\b(?:Russia|Russian Federation|Saudi Arabia|United Arab Emirates|Singapore|Malaysia|Thailand|Vietnam|Philippines|Indonesia)\b|俄罗斯|沙特阿拉伯|阿联酋|新加坡|马来西亚|泰国|越南|菲律宾|印度尼西亚/i
  },
  {
    label: "BCP47 locale",
    pattern: /\b[a-z]{2,3}(?:-[a-z]{4})?-[a-z]{2}\b/i
  },
  {
    label: "platform literal",
    pattern: /\b(?:ozon|wildberries|wb|amazon|aliexpress|noon|salla|zid|tiktok|shopee|lazada|temu|shein|ebay)\b/i
  },
  {
    label: "domain literal",
    pattern: /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|dev|ru|sa|ae|co|gov|cn|xyz|app)\b/i
  }
];
const HOME_PATH_PATTERN = /C:\/Users\/|\/home\//i;

const profileSchema = {
  type: "object",
  required: ["id", "regime", "locales", "currency", "platforms"],
  properties: {
    id: {type: "string", minLength: 1},
    regime: {type: "string", minLength: 1},
    locales: {type: "array", minItems: 1, items: {type: "string", minLength: 1}},
    currency: {type: "string", minLength: 1},
    platforms: {type: "array", minItems: 1, items: {type: "string", minLength: 1}}
  }
};

const validateProfile = new Ajv2020().compile(profileSchema);

function parseRoot(args) {
  let root = process.cwd();
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--root" || !args[index + 1]) {
      throw new Error("usage: node scripts/gates/check-decouple.mjs [--root <root>]");
    }
    root = args[index + 1];
    index += 1;
  }
  return resolve(root);
}

function isFixtureRoot(root) {
  const normalized = root.split(sep).join("/");
  return /(?:^|\/)tests\/fixtures(?:\/|$)/.test(normalized) || /^gate-/.test(basename(root));
}

function shouldIgnore(relativePath, fixtureRoot) {
  const parts = relativePath.split("/");
  if (/\.(?:md|markdown)$/i.test(relativePath)) return true;
  if (parts.some((part) => ["node_modules", ".git", "docs", "out"].includes(part))) {
    return true;
  }
  return !fixtureRoot && parts.some((part, index) => part === "tests" && parts[index + 1] === "fixtures");
}

async function walkFiles(root) {
  const fixtureRoot = isFixtureRoot(root);
  const files = [];

  async function walk(directory, relativeDirectory = "") {
    const entries = await readdir(directory, {withFileTypes: true});
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (shouldIgnore(relativePath, fixtureRoot)) continue;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.push({absolutePath, relativePath});
      }
    }
  }

  await walk(root);
  return files;
}

/**
 * SVG / XML 命名空间是技术必需品，不是"数据源域名"。
 * 放行且仅放行 W3C 命名空间；其余 URL 照旧拦 —— 这是窄化误报，不是放宽规则。
 */
const SAFE_NAMESPACES = [/https?:\/\/www\.w3\.org\/[0-9]{4}\/[a-z-]+/gi];

function withoutSafeNamespaces(content) {
  return SAFE_NAMESPACES.reduce((text, pattern) => text.replace(pattern, ""), content);
}

async function checkCore(files) {
  const failures = [];
  const coreFiles = files.filter(({relativePath}) => relativePath.startsWith("core/"));
  for (const file of coreFiles) {
    const content = withoutSafeNamespaces(await readFile(file.absolutePath, "utf8"));
    for (const {label, pattern} of CORE_PATTERNS) {
      if (pattern.test(content)) {
        failures.push(`${file.relativePath}: ${label}`);
      }
    }
  }
  return {failures, count: coreFiles.length};
}

async function checkPaths(files) {
  const failures = [];
  for (const file of files) {
    const content = await readFile(file.absolutePath, "utf8");
    if (HOME_PATH_PATTERN.test(content)) {
      failures.push(`${file.relativePath}: absolute home path`);
    }
  }
  return {failures, count: files.length};
}

async function checkFacts(files) {
  const failures = [];
  let count = 0;
  const factFiles = files.filter(({relativePath}) =>
    relativePath.endsWith(".json") &&
    (relativePath.startsWith("data/specs/") || relativePath.startsWith("data/variables/"))
  );

  for (const file of factFiles) {
    let value;
    try {
      value = JSON.parse(await readFile(file.absolutePath, "utf8"));
    } catch (error) {
      failures.push(`${file.relativePath}: invalid JSON (${error.message})`);
      continue;
    }

    const wrapped = value && typeof value === "object" && !Array.isArray(value) &&
      Object.hasOwn(value, "facts");
    if (wrapped && !Array.isArray(value.facts)) {
      failures.push(`${file.relativePath}: facts must be an array`);
      continue;
    }
    const direct = value && typeof value === "object" && !Array.isArray(value) && !wrapped;
    if (direct && (!Object.hasOwn(value, "key") || !Object.hasOwn(value, "value"))) {
      failures.push(`${file.relativePath}: invalid wrapper; expected a fact, an array, or {facts: [...]}`);
      continue;
    }
    const records = Array.isArray(value) ? value : wrapped ? value.facts : [value];
    count += records.length;
    records.forEach((record, index) => {
      const suffix = Array.isArray(value) || wrapped ? `[${index}]` : "";
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        failures.push(`${file.relativePath}${suffix}: fact must be an object`);
        return;
      }
      const missing = FACT_FIELDS.filter((field) => !Object.hasOwn(record, field));
      if (missing.length > 0) {
        failures.push(`${file.relativePath}${suffix}: missing ${missing.join(", ")}`);
      }
    });
  }
  return {failures, count};
}

async function checkNetwork(files) {
  const failures = [];
  const coreFiles = files.filter(({relativePath}) => relativePath.startsWith("core/"));
  const channelFiles = files.filter(({relativePath}) => relativePath.startsWith("channels/"));
  for (const file of coreFiles) {
    const content = await readFile(file.absolutePath, "utf8");
    for (const {label, pattern} of NETWORK_PATTERNS) {
      if (pattern.test(content)) {
        failures.push(`${file.relativePath}: ${label} (network access belongs in channels/)`);
      }
    }
  }
  return {failures, count: coreFiles.length, channels: channelFiles.length};
}

async function checkProfiles(files) {
  const failures = [];
  const present = new Set(files.map(({relativePath}) => relativePath));
  const profileFiles = files.filter(({relativePath}) =>
    relativePath.startsWith("regions/") && basename(relativePath) === "profile.json"
  );

  for (const file of profileFiles) {
    let profile;
    try {
      profile = JSON.parse(await readFile(file.absolutePath, "utf8"));
    } catch (error) {
      failures.push(`${file.relativePath}: invalid JSON (${error.message})`);
      continue;
    }
    if (!validateProfile(profile)) {
      const details = validateProfile.errors
        .map((error) => `${error.instancePath || "/"} ${error.message}`)
        .join("; ");
      failures.push(`${file.relativePath}: ${details}`);
      continue;
    }
    if (profile.completion === "full") {
      const regionDir = file.relativePath.slice(0, file.relativePath.lastIndexOf("/"));
      if (!present.has(`${regionDir}/compliance/rules.json`)) {
        failures.push(`${file.relativePath}: completion=full but ${regionDir}/compliance/rules.json is missing`);
      }
      for (const platform of profile.platforms) {
        if (!present.has(`data/specs/platforms/${platform}.json`)) {
          failures.push(`${file.relativePath}: completion=full but data/specs/platforms/${platform}.json is missing`);
        }
      }
    }
  }
  return {failures, count: profileFiles.length};
}

async function checkJudgeLayer(root, files) {
  const failures = [];
  const coreJudge = files.filter(({relativePath}) => relativePath.startsWith("core/judge/"));
  if (coreJudge.length === 0) return {failures, count: 0, fallbacks: 0, skipped: true};

  // 静态：判别层不许自己联网，也不许 import 通道 —— 通道由编排层注入。
  for (const file of coreJudge) {
    const content = await readFile(file.absolutePath, "utf8");
    if (/from\s+["'][^"']*channels\//.test(content) || /import\(\s*["'][^"']*channels\//.test(content)) {
      failures.push(`${file.relativePath}: judge layer imports a channel (inject it from the orchestrator instead)`);
    }
  }

  // 动态：每个判别点的回退实现必须**与 LLM 输出同形**（过自己的 schema）。
  // 这条守的是「降级不是换个形状糊过去」，靠人读代码守不住。
  let registry;
  try {
    registry = await import(new URL(`file://${join(root, "core/judge/points.mjs").replaceAll("\\", "/")}`).href);
  } catch (error) {
    // 部分副本（例如测试用的仓库快照）没有 node_modules：动态校验无法进行，
    // 这时必须 SKIP 而不是 FAIL —— 也不能因为跳过就报「通过」。
    if (error?.code === "ERR_MODULE_NOT_FOUND" && !String(error.message).includes("core/judge")) {
      return {failures, count: coreJudge.length, fallbacks: 0, skipped: true, reason: "deps_missing"};
    }
    failures.push(`core/judge/points.mjs 无法加载：${error.message}`);
    return {failures, count: coreJudge.length, fallbacks: 0, skipped: false};
  }

  const points = registry.POINTS ?? {};
  const ids = Object.keys(points);
  if (ids.length === 0) failures.push("core/judge/points.mjs 没有注册任何判别点");

  const ajv = new Ajv2020({allErrors: true, strict: false});
  let fallbacksOk = 0;
  for (const id of ids) {
    const point = points[id];
    for (const method of ["build", "check", "fallback"]) {
      if (typeof point[method] !== "function") failures.push(`${id}: missing ${method}()`);
    }
    if (!point.schema || point.schema.type !== "object") failures.push(`${id}: schema must be an object schema`);
    if (!Number.isInteger(point.version) || point.version < 1) failures.push(`${id}: version must be a positive integer`);
    if (typeof point.binding !== "boolean") failures.push(`${id}: binding must be declared as boolean`);
    if (typeof point.system !== "string" || point.system.length < 80) {
      failures.push(`${id}: system prompt too short to carry the protocol`);
    }
    if (typeof point.fallback !== "function" || !point.schema) continue;

    let fallbackValue;
    try {
      fallbackValue = point.fallback({category: "probe", region: {}, facts: {}, refs: [], health: {}, knownKeys: []});
    } catch (error) {
      failures.push(`${id}: fallback threw on empty context (${error.message})`);
      continue;
    }
    const validate = ajv.compile(point.schema);
    if (!validate(fallbackValue)) {
      const detail = (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
      failures.push(`${id}: fallback output violates its own schema (${detail})`);
      continue;
    }
    fallbacksOk += 1;
  }

  return {failures, count: coreJudge.length, fallbacks: fallbacksOk, points: ids.length, skipped: false};
}

async function checkSourcePool(root) {
  const failures = [];
  let sources;
  try {
    sources = JSON.parse(await readFile(join(root, "data/sources.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {failures, count: 0};
    return {failures: [`data/sources.json unreadable: ${error.message}`], count: 0};
  }
  if (!Array.isArray(sources)) return {failures: ["data/sources.json must be an array"], count: 0};

  const byPair = new Map();
  for (const source of sources) {
    if (!source || typeof source !== "object" || source.enabled === false || !source.pair) continue;
    if (!byPair.has(source.pair)) byPair.set(source.pair, []);
    byPair.get(source.pair).push(source);
  }

  for (const [pair, list] of byPair) {
    if (list.length < 2) {
      failures.push(`${pair}: only ${list.length} enabled source, a single failure removes the quote with no fallback`);
    }
    if (!list.some((item) => item.role === "primary")) {
      failures.push(`${pair}: no role=primary candidate, the pair can never produce a terminal value`);
    }
    const hosts = new Set(list.map((item) => {
      try {
        return new URL(item.url).host;
      } catch {
        return "invalid-url";
      }
    }));
    if (list.length >= 2 && hosts.size < 2) {
      failures.push(`${pair}: all ${list.length} candidates hit the same host, that is not an independent fallback`);
    }
  }
  return {failures, count: byPair.size};
}

async function main() {
  let root;
  try {
    root = parseRoot(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  let files;
  try {
    files = await walkFiles(root);
  } catch (error) {
    console.error(`G1-PATH FAIL ${root}: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const results = await Promise.all([
    checkCore(files),
    checkPaths(files),
    checkFacts(files),
    checkProfiles(files),
    checkNetwork(files),
    checkSourcePool(root),
    checkJudgeLayer(root, files)
  ]);

  const countLabels = [
    "scanned_core_files",
    "scanned_files",
    "scanned_facts",
    "scanned_profiles",
    "scanned_core_files",
    "scanned_pairs",
    "scanned_judge_files"
  ];
  results.forEach(({failures, count, channels, skipped, points, fallbacks, reason}, index) => {
    if (failures.length === 0) {
      if (index === 4) {
        if (count === 0) {
          console.log(`G2-NET SKIP scanned_core_files=0 (no core files under this root)`);
          return;
        }
        console.log(`G2-NET PASS scanned_core_files=${count} network_allowed_channels=${channels}`);
        return;
      }
      if (index === 5 && count === 0) {
        console.log(`G1-SOURCES SKIP scanned_pairs=0 (no data/sources.json under this root)`);
        return;
      }
      if (index === 6) {
        if (skipped) {
          console.log(`G3-JUDGE SKIP scanned_judge_files=${count} reason=${reason ?? "no_judge_layer"}`);
          return;
        }
        console.log(`G3-JUDGE PASS scanned_judge_files=${count} points=${points} fallbacks_schema_ok=${fallbacks}`);
        return;
      }
      console.log(`${CHECK_IDS[index]} PASS ${countLabels[index]}=${count}`);
      return;
    }
    for (const failure of failures) {
      console.log(`${CHECK_IDS[index]} FAIL ${failure}`);
    }
  });

  process.exitCode = results.some(({failures}) => failures.length > 0) ? 1 : 0;
}

await main();
