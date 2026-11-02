import {assessFact} from "./facts.mjs";

function errorDetails(error) {
  return {
    code: error?.code ?? "SOURCE_ERROR",
    message: error instanceof Error ? error.message : String(error)
  };
}

function receipt(status, key, source, nowIso, extra = {}) {
  return {status, key, source, checked_at: nowIso, ...extra};
}

function sourceKey(source) {
  return source.mapping?.key ?? source.capabilities?.key;
}

function normalizeFacts(input) {
  if (input === null || input === undefined) return [];
  if (Array.isArray(input)) return input;
  if (typeof input === "object" && Array.isArray(input.facts)) return input.facts;
  throw new TypeError("Facts must be an array or a top-level {facts: [...]} object");
}

function isCrossCheck(source) {
  return source.role === "cross-check" || source.capabilities?.role === "cross_check";
}

function isTerminalSource(source) {
  return source && source.enabled !== false && typeof source.run === "function" &&
    source.source_type !== "secondary" && source.source_type !== "user-override" &&
    !isCrossCheck(source);
}

function canSeedMissingFact(source) {
  return source && source.enabled !== false && typeof source.run === "function" &&
    source.source_type !== "user-override" && !isCrossCheck(source);
}

function mergeFact(oldFact, source, result, nowIso) {
  if (result?.value === undefined) {
    throw Object.assign(new Error("Source returned no value"), {code: "NO_DATA"});
  }
  return {
    ...oldFact,
    value: result.value,
    unit: result.unit ?? oldFact.unit,
    source_url: result.source_url ?? source.url ?? oldFact.source_url,
    source_type: result.source_type ?? source.source_type ?? oldFact.source_type,
    fetched_at: result.fetched_at ?? nowIso,
    ttl_hours: oldFact.ttl_hours,
    stale: false
  };
}

function createFact(source, result, nowIso) {
  if (result?.value === undefined) {
    throw Object.assign(new Error("Source returned no value"), {code: "NO_DATA"});
  }
  return {
    key: sourceKey(source),
    value: result.value,
    unit: result.unit ?? source.capabilities?.unit ?? source.mapping?.unit ?? "",
    scope: structuredClone(source.scope),
    source: source.id,
    source_url: result.source_url ?? source.url,
    source_type: result.source_type ?? source.source_type,
    fetched_at: result.fetched_at ?? nowIso,
    ttl_hours: source.ttl_hours,
    stale: false,
    cross_check: [],
    divergence_pct: null,
    override: null
  };
}

function staleResult(fact, sourceId, nowIso, expiredDays, error) {
  return {
    fact: {...fact, stale: true},
    receipt: receipt("stale", fact.key, sourceId, nowIso, {
      expired_days: expiredDays,
      error: errorDetails(error),
      ...(error?.http_status ? {http_status: error.http_status} : {})
    })
  };
}

function divergence(primary, checks) {
  if (!Number.isFinite(primary) || primary === 0 || checks.length === 0) return null;
  const values = checks
    .map((check) => check.value)
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.abs(value - primary) / Math.abs(primary) * 100);
  return values.length ? Number(Math.max(...values).toFixed(12)) : null;
}

function conflictsForFact(fact, primarySource, sources, nowIso) {
  if (!primarySource?.pair || !Number.isFinite(fact.value) || fact.value === 0) return [];
  const checks = (Array.isArray(fact.cross_check) ? fact.cross_check : []).flatMap((check) => {
    const cross = sources.find((source) => source.id === check.source &&
      source.pair === primarySource.pair && isCrossCheck(source));
    if (!cross || !Number.isFinite(check.value)) return [];
    const divergencePct = Number((Math.abs(check.value - fact.value) /
      Math.abs(fact.value) * 100).toFixed(12));
    return [{source: cross.id, value: check.value, divergence_pct: divergencePct, config: cross}];
  });
  const divergentChecks = checks.filter((check) => check.divergence_pct > 0.5);
  if (divergentChecks.length === 0) return [];

  const costDirection = primarySource.mapping?.cost_direction ??
    divergentChecks[0].config.mapping?.cost_direction ?? null;
  const canResolve = isTerminalSource(primarySource) &&
    ["higher_is_worse", "lower_is_worse"].includes(costDirection);
  const candidates = [{source: fact.source, value: fact.value}, ...checks];
  const selected = canResolve ? candidates.reduce((chosen, candidate) =>
    costDirection === "higher_is_worse"
      ? (candidate.value > chosen.value ? candidate : chosen)
      : (candidate.value < chosen.value ? candidate : chosen)
  ) : null;
  const first = divergentChecks[0];
  return [{
    id: `fx-divergence:${fact.key}`,
    key: fact.key,
    pair: primarySource.pair,
    status: "divergent",
    resolved: selected !== null,
    primary_source: fact.source,
    primary_value: fact.value,
    cross_check_source: first.source,
    cross_check_value: first.value,
    cross_checks: divergentChecks.map((check) => ({
      source: check.source, value: check.value, divergence_pct: check.divergence_pct
    })),
    divergence_pct: Math.max(...divergentChecks.map((check) => check.divergence_pct)),
    cost_direction: costDirection,
    selected_source: selected?.source ?? null,
    selected_value: selected?.value ?? null,
    detected_at: nowIso
  }];
}

export async function refreshFacts({sources, facts: factsInput, nowIso}) {
  if (!Number.isFinite(Date.parse(nowIso))) throw new TypeError("Invalid nowIso timestamp");
  const factList = normalizeFacts(factsInput);
  const working = factList.map((fact) => structuredClone(fact));
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const receipts = [];
  const crossFailures = new Map();
  const crossCheckIndexes = new Set();

  for (let index = 0; index < working.length; index += 1) {
    const fact = working[index];
    const assessment = assessFact(fact, nowIso);
    if (assessment.status === "fresh") {
      receipts.push(receipt("fresh", fact.key, fact.source, nowIso, {
        fetched_at: fact.fetched_at
      }));
      continue;
    }

    crossCheckIndexes.add(index);
    const source = sourceById.get(fact.source);
    if (!isTerminalSource(source)) {
      const error = Object.assign(new Error("Terminal source is unavailable or not refreshable"), {
        code: "SOURCE_UNAVAILABLE"
      });
      const failed = staleResult(fact, fact.source, nowIso, assessment.expiredDays, error);
      working[index] = failed.fact;
      receipts.push(failed.receipt);
      continue;
    }

    try {
      const result = await source.run({fact, key: fact.key, nowIso});
      working[index] = mergeFact(fact, source, result, nowIso);
      receipts.push(receipt("fresh", fact.key, source.id, nowIso, {
        fetched_at: working[index].fetched_at,
        ...(result.note ? {source_note: result.note} : {}),
        ...(result.http_status ? {http_status: result.http_status} : {})
      }));
    } catch (error) {
      const failed = staleResult(fact, source.id, nowIso, assessment.expiredDays, error);
      working[index] = failed.fact;
      receipts.push(failed.receipt);
    }
  }

  const terminalKeys = new Set(working.map((fact) => fact.key));
  const orderedSources = [...sources].sort((left, right) =>
    (left.priority ?? 100) - (right.priority ?? 100)
  );
  for (const source of orderedSources) {
    const key = sourceKey(source);
    if (!key || !canSeedMissingFact(source)) continue;
    const held = working.find((fact) => fact.key === key);
    if (held) {
      if (held.source === source.id) continue;
      try {
        const result = await source.run({key, nowIso});
        if (result?.value === undefined) {
          throw Object.assign(new Error("Fallback source returned no value"), {code: "NO_DATA"});
        }
        held.cross_check = [
          ...held.cross_check.filter((item) => item.source !== source.id),
          {
            source: source.id,
            value: result.value,
            note: [
              result.note,
              `fetched_at=${result.fetched_at ?? nowIso}`,
              `source_url=${result.source_url ?? source.url}`
            ].filter(Boolean).join("; ")
          }
        ];
        held.divergence_pct = divergence(held.value, held.cross_check);
        receipts.push(receipt("fresh", key, source.id, nowIso, {
          role: "cross_check",
          fallback_candidate: true,
          fetched_at: result.fetched_at ?? nowIso,
          ...(result.note ? {source_note: result.note} : {}),
          ...(result.http_status ? {http_status: result.http_status} : {})
        }));
      } catch (error) {
        receipts.push(receipt("missing", key, source.id, nowIso, {
          role: "cross_check",
          fallback_candidate: true,
          error: errorDetails(error),
          ...(error?.http_status ? {http_status: error.http_status} : {})
        }));
      }
      continue;
    }
    try {
      const result = await source.run({key, nowIso});
      working.push(createFact(source, result, nowIso));
      const index = working.length - 1;
      terminalKeys.add(key);
      crossCheckIndexes.add(index);
      receipts.push(receipt("fresh", key, source.id, nowIso, {
        fetched_at: working[index].fetched_at,
        ...(result.note ? {source_note: result.note} : {}),
        ...(result.http_status ? {http_status: result.http_status} : {})
      }));
    } catch (error) {
      receipts.push(receipt("missing", key, source.id, nowIso, {
        error: errorDetails(error),
        ...(error?.http_status ? {http_status: error.http_status} : {})
      }));
    }
  }

  for (const index of crossCheckIndexes) {
    const fact = working[index];
    const primarySource = sourceById.get(fact.source);
    const pair = primarySource?.pair;
    if (!pair) continue;
    for (const source of sources) {
      if (source.pair !== pair || !isCrossCheck(source) || source.id === fact.source) continue;
      const failureKey = `${fact.key}:${source.id}`;
      if (source.enabled === false || source.source_type === "user-override" ||
          typeof source.run !== "function") {
        const error = Object.assign(new Error("Cross-check is not refreshable"), {
          code: "SOURCE_UNAVAILABLE"
        });
        crossFailures.set(failureKey, {key: fact.key, pair, source: source.id});
        receipts.push(receipt("missing", fact.key, source.id, nowIso, {
          role: "cross_check", error: errorDetails(error)
        }));
        continue;
      }
      try {
        const result = await source.run({fact, key: fact.key, nowIso});
        if (result?.value === undefined) {
          throw Object.assign(new Error("Cross-check returned no value"), {code: "NO_DATA"});
        }
        const check = {
          source: source.id,
          value: result.value,
          note: [
            result.note,
            `fetched_at=${result.fetched_at ?? nowIso}`,
            `source_url=${result.source_url ?? source.url}`
          ].filter(Boolean).join("; ")
        };
        fact.cross_check = [...fact.cross_check.filter((item) => item.source !== source.id), check];
        fact.divergence_pct = divergence(fact.value, fact.cross_check);
        crossFailures.delete(failureKey);
        receipts.push(receipt("fresh", fact.key, source.id, nowIso, {
          role: "cross_check",
          fetched_at: result.fetched_at ?? nowIso,
          ...(result.note ? {source_note: result.note} : {}),
          ...(result.http_status ? {http_status: result.http_status} : {})
        }));
      } catch (error) {
        crossFailures.set(failureKey, {key: fact.key, pair, source: source.id});
        const hadValue = fact.cross_check.some((item) => item.source === source.id);
        receipts.push(receipt(hadValue ? "stale" : "missing", fact.key, source.id, nowIso, {
          role: "cross_check",
          error: errorDetails(error),
          ...(error?.http_status ? {http_status: error.http_status} : {})
        }));
      }
    }
  }

  const conflicts = working.flatMap((fact) =>
    conflictsForFact(fact, sourceById.get(fact.source), sources, nowIso)
  );
  for (const conflict of conflicts) {
    const fact = working.find((item) => item.key === conflict.key &&
      item.source === conflict.primary_source);
    if (fact) {
      fact.status = "conflicted";
      fact.conflict_id = conflict.id;
      if (conflict.resolved) fact.value = conflict.selected_value;
    }
    receipts.push(receipt("divergent", conflict.key, conflict.cross_check_source, nowIso, {
      role: "cross_check",
      pair: conflict.pair,
      divergence_pct: conflict.divergence_pct,
      selected_source: conflict.selected_source,
      selected_value: conflict.selected_value,
      resolved: conflict.resolved
    }));
  }

  const pricingReasons = [];
  const addUnavailable = (record) => {
    if (!pricingReasons.some((item) => item.key === record.key &&
        item.source === record.source && item.code === record.code)) {
      pricingReasons.push(record);
    }
  };

  for (const source of sources) {
    if (!isTerminalSource(source) || !source.pair) continue;
    const key = sourceKey(source);
    const pair = source.pair;
    const fact = working.find((item) => item.key === key &&
      sourceById.get(item.source)?.pair === pair);
    if (!fact || !Number.isFinite(fact.value)) {
      if (!fact || receipts.some((item) => item.status === "missing" && item.source === source.id)) {
        addUnavailable({code: "missing_fx", key, pair, source: source.id, reason: "missing"});
      }
      continue;
    }
    for (const cross of sources.filter((item) => item.pair === pair && isCrossCheck(item))) {
      if (crossFailures.has(`${key}:${cross.id}`)) {
        addUnavailable({
          code: "cross_check_unavailable", key, pair, source: cross.id, reason: "cross_check_failed"
        });
      } else if (!(Array.isArray(fact.cross_check) ? fact.cross_check : [])
        .some((check) => check.source === cross.id)) {
        addUnavailable({
          code: "cross_check_unavailable", key, pair, source: cross.id, reason: "cross_check_missing"
        });
      }
    }
  }
  for (const conflict of conflicts.filter((item) => !item.resolved)) {
    addUnavailable({
      code: "divergence_unresolved",
      key: conflict.key,
      pair: conflict.pair,
      source: conflict.cross_check_source,
      reason: "divergent"
    });
  }
  if (working.length === 0 && pricingReasons.length === 0) {
    addUnavailable({code: "missing_fx", key: null, pair: null, source: null, reason: "missing"});
  }
  for (const item of pricingReasons) {
    receipts.push(receipt("pricing_unavailable", item.key, item.source, nowIso, {
      pair: item.pair,
      reason: item.reason
    }));
  }

  const pricing = pricingReasons.length
    ? {status: "unavailable", reasons: pricingReasons}
    : {status: "available"};
  const secondaryKeys = [...new Set(working
    .filter((fact) => sourceById.get(fact.source)?.source_type === "secondary" &&
      Number.isFinite(fact.value))
    .map((fact) => fact.key))];
  if (secondaryKeys.length > 0) {
    pricing.quality = "secondary";
    pricing.secondary_keys = secondaryKeys;
  }
  return {facts: working, receipts, conflicts, pricing};
}

export async function writeConflicts(filePath, conflicts) {
  if (!Array.isArray(conflicts)) throw new TypeError("Conflicts must be an array");
  const {writeFile} = await import("node:fs/promises");
  await writeFile(filePath, `${JSON.stringify(conflicts, null, 2)}\n`, "utf8");
}
