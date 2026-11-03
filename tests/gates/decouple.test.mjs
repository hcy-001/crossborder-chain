import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {cp, mkdir, mkdtemp, rm, writeFile, symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {join} from "node:path";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const gatePath = join(repoRoot, "scripts/gates/check-decouple.mjs");

const runGate = (root) => spawnSync(process.execPath, [gatePath, "--root", root], {
  cwd: repoRoot,
  encoding: "utf8"
});

function assertPositivePassCount(output, id, label) {
  const match = output.match(new RegExp(`${id} PASS ${label}=(\\d+)`));
  assert.ok(match, `${id} must report ${label}; output:\n${output}`);
  const count = Number(match[1]);
  assert.ok(count > 0, `${id} must scan a non-empty target; output:\n${output}`);
  return count;
}

test("clean fixture passes all four gates with non-empty scan counts", () => {
  const result = runGate("tests/fixtures/gate-valid");
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assertPositivePassCount(output, "G1-CORE", "scanned_core_files");
  assertPositivePassCount(output, "G1-PATH", "scanned_files");
  assert.equal(assertPositivePassCount(output, "G1-FACT", "scanned_facts"), 4);
  assertPositivePassCount(output, "G1-PROFILE", "scanned_profiles");
});

test("gate rejects a platform literal in core", () => {
  const result = runGate("tests/fixtures/gate-platform");
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /G1-CORE FAIL/);
  assert.match(output, /core\/platform\.mjs/);
});

test("gate rejects a fact without source_url", () => {
  const result = runGate("tests/fixtures/gate-fact");
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /G1-FACT FAIL/);
  assert.match(output, /data\/variables\/fx\.json/);
});

test("gate rejects implicit nested fact wrappers", () => {
  const result = runGate("tests/fixtures/gate-fact-wrapper");
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /G1-FACT FAIL/);
  assert.match(output, /data\/variables\/nested\.json/);
});

test("gate rejects an absolute home path", () => {
  const result = runGate("tests/fixtures/gate-path");
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /G1-PATH FAIL/);
  assert.match(output, /core\/local-path\.mjs/);
});

test("gate rejects a region profile without platforms", () => {
  const result = runGate("tests/fixtures/gate-profile");
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /G1-PROFILE FAIL/);
  assert.match(output, /regions\/RU\/profile\.json/);
});

test("real repository copy turns red for an injected bad fact and green after repair", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gate-real-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  await cp(join(repoRoot, "core"), join(root, "core"), {recursive: true});
  await cp(join(repoRoot, "data"), join(root, "data"), {recursive: true});
  // 复制出来的目录要能解析第三方依赖（core/judge 会 import ajv）。
  // 不建这条链接时，本机能过是因为向上查找恰好撞到某个 node_modules，
  // 而在 CI 的 /home/runner/work 下没有，G3-JUDGE 直接 FAIL —— 典型的「只在我机器上过」。
  await symlink(
    join(repoRoot, "node_modules"),
    join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir"
  );

  const baseline = runGate(root);
  const baselineOutput = baseline.stdout + baseline.stderr;
  assert.equal(baseline.status, 0, baselineOutput);
  const baselineFacts = assertPositivePassCount(baselineOutput, "G1-FACT", "scanned_facts");
  assertPositivePassCount(baselineOutput, "G1-CORE", "scanned_core_files");

  const injectedPath = join(root, "data/variables/gate-injected.json");
  const injectedFact = {
    key: "gate.injected_formats",
    value: ["jpg", "png"],
    unit: "media-format-list",
    source_url: "https://example.com/specs/formats",
    fetched_at: "2026-10-29T00:00:00.000Z",
    ttl_hours: 24
  };
  const badFact = {...injectedFact};
  delete badFact.source_url;
  await writeFile(injectedPath, JSON.stringify(badFact, null, 2));

  const red = runGate(root);
  const redOutput = red.stdout + red.stderr;
  assert.equal(red.status, 1, redOutput);
  assert.match(redOutput, /G1-FACT FAIL data\/variables\/gate-injected\.json/);
  assert.match(redOutput, /missing source_url/);

  await writeFile(injectedPath, JSON.stringify(injectedFact, null, 2));
  const green = runGate(root);
  const greenOutput = green.stdout + green.stderr;
  assert.equal(green.status, 0, greenOutput);
  assert.equal(
    assertPositivePassCount(greenOutput, "G1-FACT", "scanned_facts"),
    baselineFacts + 1
  );
  assertPositivePassCount(greenOutput, "G1-CORE", "scanned_core_files");
});

test("W3C 命名空间放行，但普通域名仍然被拦（不放宽规则）", async () => {
  // 用能通过全部门禁的 fixture 作底：空目录会因"扫描计数为 0"判红，混淆被测行为。
  const base = join(repoRoot, "tests/fixtures/gate-valid");
  const root = await mkdtemp(join(tmpdir(), "gate-ns-"));
  try {
    await cp(base, root, {recursive: true});
    const coreDir = join(root, "core");
    await writeFile(join(coreDir, "svg.mjs"),
      "export const ns = 'http://www.w3.org/2000/svg';\n", "utf8");
    const ok = await runGate(root);
    // 只看 G1-CORE 这一条：整道门还会因"源/判别层缺失"给 SKIP，那不是本用例的被测对象。
    assert.match(ok.stdout, /G1-CORE PASS/, ok.stdout + ok.stderr);
    assert.doesNotMatch(ok.stdout, /domain literal/);

    await writeFile(join(coreDir, "leak.mjs"),
      "export const url = 'https://api.example.com/v1/data';\n", "utf8");
    const bad = await runGate(root);
    assert.notEqual(bad.code, 0, "普通域名必须继续判红");
    assert.match(bad.stdout, /core\/leak\.mjs: domain literal/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
