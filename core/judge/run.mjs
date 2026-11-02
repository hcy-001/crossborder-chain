import {asData, decisionEnvelope, describeErrors, describeSchema, validateDecision} from "./contract.mjs";
import {getPoint} from "./points.mjs";
import {sha256} from "./journal.mjs";

/** 两轮调用的用量合并：修复轮的 token 也算进这次判别的账上。 */
function mergeUsage(first, second) {
  if (!first) return second ?? null;
  if (!second) return first;
  const sum = (key) => Number(first[key] ?? 0) + Number(second[key] ?? 0);
  return {
    ...first,
    prompt_tokens: sum("prompt_tokens"),
    completion_tokens: sum("completion_tokens"),
    total_tokens: sum("total_tokens")
  };
}

/**
 * 判别机。一次判别只有三种结局，且每种都能被机器复述：
 *
 *   llm        通过 schema 且无阻断级冲突 → 采用 LLM 的决定
 *   fallback   schema 不过 / 有阻断级冲突 / 通道不可用 → 采用确定性实现，并写清拒收原因
 *   之外没有第四种：不存在「差不多能用」的决定
 *
 * 注意 binding 的语义：binding=true 的点被拒收时，下游**必须**拿到 fallback，
 * 不允许把未通过校验的值继续往下传（这点由 tests/judge 的用例守住）。
 */
export async function judgePoint({
  pointId,
  ctx = {},
  channel,
  journal = null,
  scope = "default",
  scenario,
  maxTokens = 2_048
}) {
  const point = getPoint(pointId);
  const builtInput = asData(point.build(ctx));
  const user = JSON.stringify(builtInput, null, 2);
  // 输出键名从 schema 现算，不靠 system 正文和 schema 两处手工对齐。
  const system = `${point.system}\n\n【输出契约】\n${describeSchema(point.schema)}`;
  const promptSha = sha256(`${system}\n--\n${user}`);

  let result = null;
  let source = "fallback";
  let rejectReason = null;
  let conflicts = [];
  let schemaOk = false;
  let schemaErrors = [];
  let fault = null;
  let repairRounds = 0;

  if (typeof channel?.complete === "function") {
    result = await channel.complete({
      point: pointId,
      input: builtInput,
      system,
      user,
      schema: point.schema,
      maxTokens,
      scenario
    });
  } else {
    rejectReason = "channel_not_configured";
  }

  /**
   * 一次修复轮，只针对「形状对了但某字段不合契约」。
   * 现实缺陷：模型把 complexion 写成「白皙」（2 字），而 schema 曾要求 ≥3 字，
   * 一次语言相关的挑剔就把整点打回确定性回退 —— 值本身其实是对的。
   * 修复优先于回退：把校验错误原样递回，让模型自己改；改不动才回退。
   */
  if (result?.ok) {
    let validation = validateDecision(point.schema, result.value);
    if (!validation.ok && typeof channel?.complete === "function") {
      repairRounds = 1;
      const repaired = await channel.complete({
        point: pointId,
        input: builtInput,
        system,
        user: `${user}\n\n【上一次输出未通过校验】${describeErrors(validation.errors)}\n按【输出契约】重新输出**完整** JSON，只修这些位置，其余字段保持原值。`,
        schema: point.schema,
        maxTokens,
        scenario
      });
      if (repaired?.ok) {
        const retryValidation = validateDecision(point.schema, repaired.value);
        // 修复轮也要能证明自己更好；改不动就保留第一版的错误，回退理由才讲得清。
        if (retryValidation.ok) {
          result = repaired;
          result.usage = mergeUsage(result.usage, repaired.usage);
          validation = retryValidation;
        } else {
          schemaErrors = retryValidation.errors;
        }
      }
    }
    schemaOk = validation.ok;
    schemaErrors = validation.ok ? [] : (schemaErrors.length > 0 ? schemaErrors : validation.errors);
    if (!validation.ok) {
      rejectReason = `schema_rejected: ${describeErrors(schemaErrors)}`;
    } else {
      conflicts = point.check(result.value, ctx) ?? [];
      const blocking = conflicts.filter((item) => item.severity === "block");
      if (blocking.length > 0) {
        rejectReason = `conflict_rejected: ${blocking.map((item) => item.code).join(",")}`;
      } else {
        source = "llm";
      }
    }
  } else if (result) {
    fault = result.fault ?? {kind: "unknown", reason: "unknown", detail: null};
    rejectReason = `channel_failed: ${fault.kind}/${fault.reason}`;
  }

  const value = source === "llm" ? result.value : point.fallback(ctx);
  const envelope = decisionEnvelope({
    pointId,
    version: point.version,
    value,
    source,
    binding: point.binding,
    confidence: value?.confidence,
    conflicts,
    schemaOk,
    schemaErrors,
    usage: result?.usage ?? null,
    latencyMs: result?.latency_ms ?? null,
    model: result?.model ?? null,
    fault
  });

  const entry = {
    point: pointId,
    version: point.version,
    binding: Boolean(point.binding),
    scope,
    at: new Date().toISOString(),
    model: result?.model ?? null,
    parse_layer: result?.parse_layer ?? null,
    attempts: result?.attempts ?? 0,
    repair_rounds: repairRounds,
    prompt_sha256: promptSha,
    system_chars: system.length,
    user_chars: user.length,
    input: builtInput,
    raw: result?.raw ?? null,
    parsed: result?.value ?? null,
    schema_ok: schemaOk,
    schema_errors: schemaErrors,
    conflicts,
    confidence: value?.confidence ?? null,
    accepted: source === "llm",
    source,
    reject_reason: rejectReason,
    fallback_value: source === "llm" ? null : value,
    usage: result?.usage ?? null,
    latency_ms: result?.latency_ms ?? null
  };

  const file = journal ? await journal.write(entry) : null;
  return {...envelope, journal_file: file, reject_reason: rejectReason, repair_rounds: repairRounds};
}

/**
 * 串行判别：后面的判别点可以看到前面的结论（例如拍摄计划要用市场画像）。
 * 串行是刻意的 —— 判别点之间有真实的因果关系，并行会把因果压成猜测。
 */
export async function judgeSequence({pointIds, ctx = {}, channel, journal = null, scope = "default", scenario}) {
  const judgments = {...(ctx.judgments ?? {})};
  const results = {};
  for (const pointId of pointIds) {
    const result = await judgePoint({
      pointId,
      ctx: {...ctx, judgments},
      channel,
      journal,
      scope,
      scenario
    });
    results[pointId] = result;
    judgments[pointId] = result;
  }
  return {results, judgments};
}
