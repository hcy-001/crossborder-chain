import assert from "node:assert/strict";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {createJournal, readJournal} from "../../core/judge/journal.mjs";
import {judgePoint, judgeSequence} from "../../core/judge/run.mjs";
import * as mockChannel from "../../channels/llm/mock.mjs";

async function withJournal(fn) {
  const dir = await mkdtemp(join(tmpdir(), "judge-"));
  try {
    return await fn(createJournal({dir}), dir);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}

const ctx = {category: "女装", region: {regime: "x", currency: "CNY", locales: ["ru-RU"]}, health: {}, knownKeys: []};

test("合法且不冲突的 LLM 决定被采用，并落盘可回放", async () => {
  await withJournal(async (journal, dir) => {
    const result = await judgePoint({pointId: "market_profile", ctx, channel: mockChannel, journal, scope: "s1"});
    assert.equal(result.source, "llm");
    assert.equal(result.accepted, true);
    assert.equal(result.value.profile_id, "young_minimal");

    const entries = await readJournal(dir);
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.equal(entry.point, "market_profile");
    assert.equal(entry.scope, "s1");
    assert.ok(entry.prompt_sha256.length === 64);
    assert.equal(entry.schema_ok, true);
    assert.equal(entry.accepted, true);
    assert.ok(entry.usage.total_tokens > 0);
    assert.ok(entry.input, "台账必须留下送进去的事实，否则无法复盘");
  });
});

test("schema 不符时回退，并且回退值一定过 schema", async () => {
  await withJournal(async (journal) => {
    const result = await judgePoint({
      pointId: "market_profile",
      ctx,
      channel: mockChannel,
      journal,
      scenario: "invalid"
    });
    assert.equal(result.source, "fallback");
    assert.equal(result.schema_ok, false);
    assert.match(result.reject_reason, /schema_rejected/);
    assert.equal(result.value.profile_id, "baseline_minimal");
  });
});

test("与事实冲突时回退：进深 2.4 米给 135mm 全身会被拒", async () => {
  await withJournal(async (journal) => {
    const result = await judgePoint({
      pointId: "shoot_plan",
      ctx,
      channel: mockChannel,
      journal,
      scenario: "conflict"
    });
    assert.equal(result.source, "fallback");
    assert.match(result.reject_reason, /conflict_rejected/);
    assert.ok(result.conflicts.some((item) => item.severity === "block"));
    // binding 点的语义：被拒之后下游拿到的必须是确定性解，而不是被拒的那个值
    assert.equal(result.value.location.depth_m, 6);
  });
});

test("不可解析时回退，且台账记下失败类别而不是空手成功", async () => {
  await withJournal(async (journal, dir) => {
    const result = await judgePoint({
      pointId: "platform_mapping",
      ctx,
      channel: mockChannel,
      journal,
      scenario: "unparsable"
    });
    assert.equal(result.source, "fallback");
    assert.match(result.reject_reason, /unparsable/);
    const entries = await readJournal(dir);
    assert.equal(entries[0].accepted, false);
    assert.equal(entries[0].source, "fallback");
  });
});

test("通道不可用时直接回退，不抛异常也不假装成功", async () => {
  const result = await judgePoint({pointId: "copy_pitch", ctx, channel: null});
  assert.equal(result.source, "fallback");
  assert.equal(result.reject_reason, "channel_not_configured");
  assert.equal(result.value.desc, "");
});

test("串行判别：后面的点能读到前面的结论", async () => {
  await withJournal(async (journal) => {
    const {results} = await judgeSequence({
      pointIds: ["market_profile", "shoot_plan"],
      ctx,
      channel: mockChannel,
      journal, // 共用台账：两次判别都要留痕
      scope: "seq"
    });
    assert.equal(results.market_profile.source, "llm");
    assert.equal(results.shoot_plan.source, "llm");
    const entries = await journalSummary(journal);
    assert.equal(entries, 2);
  });
});

async function journalSummary(journal) {
  await readFile(join(journal.dir, "market_profile--seq.json"), "utf8");
  return journal.entries().length;
}

test("台账汇总能区分 LLM 与回退，并给出 token 账", async () => {
  await withJournal(async (journal) => {
    await judgePoint({pointId: "market_profile", ctx, channel: mockChannel, journal, scope: "a"});
    await judgePoint({pointId: "market_profile", ctx, channel: mockChannel, journal, scope: "b", scenario: "invalid"});
    const summary = journal.summary();
    assert.equal(summary.total, 2);
    assert.equal(summary.by_source.llm, 1);
    assert.equal(summary.by_source.fallback, 1);
    assert.equal(summary.rejected.length, 1);
    assert.equal(summary.rejected[0].point, "market_profile");
    assert.ok(summary.usage.total_tokens > 0);
  });
});

test("形状对但字段不合契约时先修复一轮，修得动就不回退", async () => {
  await withJournal(async (journal, dir) => {
    let calls = 0;
    const channel = {
      complete: async () => {
        calls += 1;
        const bad = {
          profile_id: "women_eaeu_basic_01", age_band: "25-34", hair: "深棕色", complexion: "白皙",
          palette: ["米白", "雾霾蓝"], scene_pool: ["studio"], rationale: "按品类常识给的一档", confidence: "medium"
        };
        const good = {...bad, palette: ["#efe7d8", "#7f8ea3"]};
        return {
          ok: true,
          value: calls === 1 ? bad : good,
          attempts: 1,
          parse_layer: "strict",
          usage: {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15}
        };
      }
    };
    const result = await judgePoint({pointId: "market_profile", ctx, channel, journal, scope: "repair"});
    assert.equal(calls, 2, "必须真的发第二轮修复请求");
    assert.equal(result.source, "llm");
    assert.equal(result.repair_rounds, 1);
    assert.deepEqual(result.value.palette, ["#efe7d8", "#7f8ea3"]);
    const entries = await readJournal(dir);
    assert.equal(entries[0].repair_rounds, 1);
    assert.equal(entries[0].usage.total_tokens, 30, "修复轮的 token 必须并进账里");
  });
});

test("修复轮改不动就老实回退，并保留第二版错误", async () => {
  await withJournal(async (journal) => {
    let calls = 0;
    const channel = {
      complete: async () => {
        calls += 1;
        return {
          ok: true,
          value: {profile_id: "women_eaeu_basic_01", age_band: "25-34", hair: "深棕色", complexion: "白皙", palette: ["米白"], scene_pool: ["studio"], rationale: "按品类常识给的一档", confidence: "medium"},
          attempts: 1,
          parse_layer: "strict",
          usage: {total_tokens: 9}
        };
      }
    };
    const result = await judgePoint({pointId: "market_profile", ctx, channel, journal, scope: "repair-fail"});
    assert.equal(calls, 2);
    assert.equal(result.source, "fallback");
    assert.equal(result.repair_rounds, 1);
    assert.match(result.reject_reason, /schema_rejected/);
  });
});
