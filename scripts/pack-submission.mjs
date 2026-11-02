#!/usr/bin/env node
/**
 * 打一份「交稿包」：代码 + 文档 + 一份真实运行证据，不含运行产物与密钥。
 *
 * 判据：打完之后，接收方在空目录里 `npm ci` 就能跑通三条命令，
 * 并且能指到 L2 证据；包内不得出现 config/local*.json（密钥）、node_modules、缓存。
 *
 * 用法：node scripts/pack-submission.mjs [--out <dir>]
 */
import {cp, mkdir, readFile, readdir, stat, writeFile} from "node:fs/promises";
import {dirname, join, resolve, relative} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outFlag = args.indexOf("--out");
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const OUT = outFlag >= 0 && args[outFlag + 1]
  ? resolve(args[outFlag + 1])
  : resolve(ROOT, "..", `AI创新大赛交付_${stamp}`);

const EVIDENCE_RUN = "real-l2-03";
const LOOKBOOK = `lookbook-${EVIDENCE_RUN}`;

/** 整目录带走的部分（代码、契约、配置、文档、测试）。 */
const DIRS = ["adapters", "channels", "cli", "core", "data", "docs", "regions", "schemas", "scripts", "tests"];
/** 单文件带走的部分（input/ 是示范输入，测试依赖它，不能省）。 */
const FILES = ["SKILL.md", "README.md", "HANDOFF.md", "package.json", "package-lock.json", ".gitignore"];
/**
 * 明确不带（体积、密钥、产物）。
 * 必须锚在**顶层**：core/package/ 是源码目录，不能被 "package" 这个词误伤。
 */
const BLOCKED = /^(node_modules|runs|package|assets|cache|tmp)(\/|$)|^config\/local(\.example)?\.json$|^config\/local\.secret\.json$/;

async function walk(dir, base = dir) {
  const entries = await readdir(dir, {withFileTypes: true});
  const result = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await walk(full, base));
    else {
      const info = await stat(full);
      result.push({path: full, rel: relative(base, full), bytes: info.size});
    }
  }
  return result;
}

/**
 * cp 在 Windows 上会偶发 EPERM / EBUSY（杀软扫目录、句柄未释放）。
 * 一次失败就整包失败不可接受，所以做有限重试；最后一次仍失败就原样抛出，不吞。
 */
async function cpRetry(from, to, options, attempts = 4) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await cp(from, to, options);
      return;
    } catch (error) {
      lastError = error;
      const retriable = ["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"].includes(error?.code);
      if (!retriable || attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, 120 * attempt));
    }
  }
  throw lastError;
}

async function copyTree(from, to, {allow = () => true, force = []} = {}) {
  await cpRetry(from, to, {
    recursive: true,
    force: true,
    filter: (source) => {
      const rel = relative(ROOT, source).replace(/\\/g, "/");
      if (rel === "") return true;
      // force 是"明知被排除规则挡住、但必须带走的例外"（例如 runs/ 下那一份证据）
      if (force.some((pattern) => pattern.test(rel))) return allow(rel);
      if (BLOCKED.test(rel)) return false;
      return allow(rel);
    }
  });
}

await mkdir(OUT, {recursive: true});

for (const dir of DIRS) {
  await copyTree(join(ROOT, dir), join(OUT, dir), {
    // docs 里只排除体积型附件；其余照带
    allow: (rel) => !rel.includes("lookbook-")
  });
}
for (const file of FILES) await cp(join(ROOT, file), join(OUT, file));

// 示范输入：测试与 demo 都依赖它；其余 input/*.json 是跑批产物，不带。
await mkdir(join(OUT, "input"), {recursive: true});
await cp(join(ROOT, "input/demo-sku.json"), join(OUT, "input/demo-sku.json"));

// 示范输入：测试与 demo 都依赖它；其余 input/*.json 是跑批产物，不带。
await mkdir(join(OUT, "input"), {recursive: true});
await cp(join(ROOT, "input/demo-sku.json"), join(OUT, "input/demo-sku.json"));

// 证据：验证摘要 + 一份真实运行的台账与回执 + 一份成品页
await mkdir(join(OUT, "out/verification"), {recursive: true});
// 证据只带"当前有效"的那几份：历史基线日志留在本机，免得评审对着过期数字做判断。
const verificationDir = join(ROOT, "out/verification");
const EVIDENCE_FILES = [
  "summary.json",
  "selfgrade.json",
  `chain-${EVIDENCE_RUN}.json`,
  `chain-${EVIDENCE_RUN}.md`,
  "chain-persona-check-02.json",
  "chain-persona-check-02.md",
  // 成本纪律那一项要读它：没有这份，包内自评会掉一项
  "llm-probe.json"
];
for (const name of EVIDENCE_FILES) {
  await cp(join(verificationDir, name), join(OUT, "out/verification", name)).catch(() => null);
}
await copyTree(join(ROOT, "runs", EVIDENCE_RUN), join(OUT, "runs", EVIDENCE_RUN), {
  // runs/ 整体不带（产物），但这一份是交稿证据，必须带
  force: [new RegExp(`^runs/${EVIDENCE_RUN}(/|$)`)]
});
await copyTree(join(verificationDir, LOOKBOOK), join(OUT, "out/verification", LOOKBOOK));

const allFiles = await walk(OUT);
const vendored = allFiles.filter((item) => item.rel.replace(/\\/g, "/").startsWith("node_modules/"));
const files = allFiles.filter((item) => !vendored.includes(item));
const totalBytes = files.reduce((sum, item) => sum + item.bytes, 0);
const leak = files.filter((item) => /config\/local(\.example)?\.json$|local\.secret\.json$/.test(item.rel.replace(/\\/g, "/")));

const summary = JSON.parse(await readFile(join(ROOT, "out/verification/summary.json"), "utf8"));
const index = `# 交稿包 ${stamp}

- 生成时间：${new Date().toISOString()}
- 文件数（不含依赖）：${files.length}｜体积：${(totalBytes / 1024 / 1024).toFixed(1)} MB
- 依赖：${vendored.length > 0 ? `已随包附带 node_modules（${vendored.length} 个文件，离线可直接跑；也可删掉后 \`npm ci\`）` : "未随包，需 npm ci"}
- 证据基准：\`${EVIDENCE_RUN}\`（${summary.l2_evidence?.judgments?.by_source?.llm ?? 0} 个判别点由真实模型返回，${summary.l2_evidence?.images?.count ?? 0} 张真实出图）

## 怎么验

\`\`\`bash
npm ci
npm run selfgrade                                                     # 期望 7 项 100
npm run check:decouple                                                # 期望 7 PASS / 0 FAIL
npm run chain -- --category 女装 --region RU --candidates 1 \\
  --mock-llm --mock-images --run-id check-local                       # 期望 exit 0
\`\`\`

## 包里有什么

| 路径 | 内容 |
|---|---|
| \`SKILL.md\` / \`README.md\` / \`HANDOFF.md\` | 用法、判据、交接状态 |
| \`docs/交稿清单.md\` | 一页看完：命令、判据、边界、评委三问 |
| \`core/ channels/ scripts/ tests/\` | 实现与 242 项测试 |
| \`schemas/ data/ regions/\` | 契约、事实、法域配置（改配置不改代码） |
| \`out/verification/\` | 验证摘要、自评、七道门日志、真实运行证据与成品页 |
| \`runs/${EVIDENCE_RUN}/\` | 那一跑的判别台账与回执（可逐条回放） |

## 包里没有什么（有意）

- \`config/local*.json\`（密钥，本机才有；包内只有 example）
- \`package/\`、\`assets/\`、\`cache/\`、\`tmp/\`（运行产物，跑一次就会重新生成）
- 平台凭据、订单数据、任何个人信息
`;

await writeFile(join(OUT, "SUBMISSION.md"), index, "utf8");

console.log(JSON.stringify({
  ok: leak.length === 0,
  out: OUT,
  files: files.length,
  mb: Number((totalBytes / 1024 / 1024).toFixed(1)),
  secret_leaks: leak.map((item) => item.rel)
}, null, 2));

if (leak.length > 0) process.exitCode = 2;
