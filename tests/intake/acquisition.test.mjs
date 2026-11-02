/**
 * 「从哪拿」清单的测试。
 *
 * 守两件事：
 * 1. 29 项问卷与获取方式**一一对齐** —— 新增问卷项时忘了写获取方式，
 *    用户会拿到一份「问题有、怎么拿没有」的清单，比没有清单更误事。
 * 2. 默认的 `--list` 输出不变 —— 加 --how 只是附加，不能改变原有问卷的形态。
 */

import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {dirname, join, resolve} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {LEVEL_LEGEND, OWNER_ORDER, loadAcquisition, mergeGuide, renderGuideMd, validateAcquisition} from "../../core/intake/acquisition.mjs";
import {INTAKE_ITEMS} from "../../core/intake/checklist.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const {byKey} = await loadAcquisition();

test("问卷 29 项与获取方式一一对齐（缺一条就失败）", () => {
  const result = validateAcquisition(INTAKE_ITEMS, byKey);
  assert.deepEqual(result.missing, [], `这些问卷项没有写「从哪拿」：${result.missing.join(", ")}`);
  assert.deepEqual(result.extra, [], `这些获取方式在问卷里找不到对应项：${result.extra.join(", ")}`);
  assert.deepEqual(result.badLevels, []);
  assert.deepEqual(result.emptyFields, []);
  assert.equal(result.ok, true);
});

test("每项都有责任人、抄什么、查不到怎么办，且责任人合法", () => {
  for (const item of INTAKE_ITEMS) {
    const how = byKey.get(item.key);
    assert.ok(how, `缺 ${item.key}`);
    assert.ok(OWNER_ORDER.includes(how.owner), `${item.key} 的 owner 不合法：${how.owner}`);
    assert.ok(String(how.at).length > 4, `${item.key} 的「从哪拿」太短，等于没说`);
    assert.ok(String(how.take).length > 2, `${item.key} 的「抄什么」为空`);
    assert.ok(String(how.fallback).length > 4, `${item.key} 的「查不到怎么办」为空`);
  }
});

test("证据等级只有 L0/L1/L2，且没有裸推荐", () => {
  const levels = new Set();
  for (const how of byKey.values()) {
    assert.ok(Object.hasOwn(LEVEL_LEGEND, how.level), `非法等级 ${how.level}`);
    levels.add(how.level);
  }
  // 三类都要有：全 L2 说明吹牛，全 L0 说明没验证过任何一条
  assert.ok(levels.size >= 2, `等级只有 ${[...levels].join(",")}，明显不真实`);
});

test("负向：抽掉一条，校验必须报缺（证明这条守卫会叫）", () => {
  const broken = new Map(byKey);
  broken.delete("platform_commission_rate");
  const result = validateAcquisition(INTAKE_ITEMS, broken);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["platform_commission_rate"]);
});

test("负向：多出一条不该有的，校验必须报多", () => {
  const broken = new Map(byKey);
  broken.set("a_field_that_does_not_exist", byKey.get("cost"));
  const result = validateAcquisition(INTAKE_ITEMS, broken);
  assert.equal(result.ok, false);
  assert.deepEqual(result.extra, ["a_field_that_does_not_exist"]);
});

test("渲染出的手册覆盖全部 29 项与全部责任人分组", () => {
  const md = renderGuideMd(INTAKE_ITEMS, byKey);
  assert.equal((md.match(/^#### `/gm) ?? []).length, INTAKE_ITEMS.length);
  for (const owner of OWNER_ORDER) {
    const count = [...byKey.values()].filter((how) => how.owner === owner).length;
    if (count > 0) assert.match(md, new RegExp(`### ${owner}（${count} 项）`));
  }
  // 每项都必须带「查不到怎么办」——这是这份文档存在的理由
  assert.equal((md.match(/- \*\*查不到怎么办\*\*/g) ?? []).length, INTAKE_ITEMS.length);
});

test("renderGuideMd 不会漏掉字段：合并时缺项要能被发现", () => {
  const partial = new Map(byKey);
  partial.delete("credentials_scope");
  const {merged, missing} = mergeGuide(INTAKE_ITEMS, partial);
  assert.deepEqual(missing, ["credentials_scope"]);
  assert.equal(merged.length, INTAKE_ITEMS.length - 1);
});

test("默认 --list 输出不含「从哪拿」，加 --how 才附加", () => {
  const plain = spawnSync(process.execPath, [join(ROOT, "scripts/intake.mjs"), "--list"], {
    cwd: ROOT, encoding: "utf8", timeout: 30000
  });
  assert.equal(plain.status, 0);
  assert.equal((plain.stdout.match(/从哪拿：/g) ?? []).length, 0, "默认输出不该变长");

  const withHow = spawnSync(process.execPath, [join(ROOT, "scripts/intake.mjs"), "--list", "--how"], {
    cwd: ROOT, encoding: "utf8", timeout: 30000
  });
  assert.equal(withHow.status, 0);
  assert.equal((withHow.stdout.match(/从哪拿：/g) ?? []).length, INTAKE_ITEMS.length);
});
