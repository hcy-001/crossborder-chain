import test from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {refreshFacts} from "../../core/data/refresh-facts.mjs";

const nowIso = "2026-10-29T12:00:00.000Z";
const scope = {region: null, platform: null, category: null};
const oldFact = {
  key: "fx.USD_CNY", value: 6.6, unit: "CNY/USD", scope,
  source: "frankfurter-usd-cny",
  source_url: "https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY",
  source_type: "official", fetched_at: "2026-10-20T00:00:00.000Z",
  ttl_hours: 24, stale: false, cross_check: [], divergence_pct: null, override: null
};

function source(id, run, extra = {}) {
  return {
    id, kind: "source", source_type: "official", enabled: true,
    ttl_hours: 24, scope, pair: "USD_CNY", role: "primary",
    capabilities: {key: "fx.USD_CNY", unit: "CNY/USD"},
    mapping: {key: "fx.USD_CNY", unit: "CNY/USD", cost_direction: "higher_is_worse"},
    run, ...extra
  };
}

function success(value, extra = {}) {
  return {
    ok: true, value, unit: "CNY/USD",
    source_url: "https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY",
    source_type: "official", fetched_at: nowIso, ttl_hours: 24,
    http_status: 200, ...extra
  };
}

test("fresh fact is preserved without a network call", async () => {
  let calls = 0;
  const fresh = {...oldFact, fetched_at: nowIso};
  const result = await refreshFacts({
    sources: [source(fresh.source, async () => { calls += 1; })],
    facts: [fresh], nowIso
  });
  assert.equal(calls, 0);
  assert.deepEqual(result.facts, [fresh]);
  assert.equal(result.receipts[0].status, "fresh");
  assert.deepEqual(result.pricing, {status: "available"});
});

test("failed refresh preserves old value and exposes stale receipt", async () => {
  const failing = source(oldFact.source, async () => {
    throw Object.assign(new Error("fixture timeout"), {code: "ETIMEDOUT"});
  });
  const result = await refreshFacts({sources: [failing], facts: [oldFact], nowIso});
  assert.equal(result.facts[0].value, 6.6);
  assert.equal(result.facts[0].fetched_at, oldFact.fetched_at);
  assert.equal(result.facts[0].stale, true);
  assert.equal(result.receipts[0].status, "stale");
  assert.equal(result.receipts[0].expired_days, 8);
  assert.equal(result.receipts[0].error.code, "ETIMEDOUT");
  assert.deepEqual(result.pricing, {status: "available"});
});

test("failed initial refresh reports missing and invents no fact", async () => {
  const failing = source("frankfurter-usd-cny", async () => {
    throw Object.assign(new Error("no data"), {code: "NO_DATA"});
  });
  const result = await refreshFacts({sources: [failing], facts: [], nowIso});
  assert.deepEqual(result.facts, []);
  assert.equal(result.receipts[0].status, "missing");
  assert.equal(result.receipts[0].key, "fx.USD_CNY");
  assert.equal(result.pricing.status, "unavailable");
  assert.equal(result.pricing.reasons.some((reason) =>
    reason.code === "missing_fx" && reason.key === "fx.USD_CNY"), true);
});

test("successful refresh builds a schema-valid fact and updates its cross-check", async () => {
  const primary = source("frankfurter-usd-cny", async () => success(7, {
    note: "provider_date=2026-10-28"
  }));
  const cross = source("cbr-usd-cny-cross", async () => success(7.01, {
    source_url: "https://www.cbr-xml-daily.ru/daily_json.js",
    source_type: "official-mirror", note: "derived from RUB quotes"
  }), {
    source_type: "official-mirror",
    role: "cross-check", capabilities: {key: "fx.USD_CNY", unit: "CNY/USD"}
  });
  const result = await refreshFacts({sources: [primary, cross], facts: [oldFact], nowIso});
  const fact = result.facts[0];
  assert.equal(fact.value, 7);
  assert.equal(fact.ttl_hours, 24);
  assert.deepEqual(fact.scope, scope);
  assert.equal(fact.stale, false);
  assert.equal(fact.cross_check.length, 1);
  assert.equal(fact.cross_check[0].source, "cbr-usd-cny-cross");
  assert.equal(fact.cross_check[0].value, 7.01);
  assert.equal(fact.divergence_pct, 0.142857142857);
  assert.equal(result.receipts.find((r) => r.role === "cross_check").status, "fresh");
  assert.equal(result.receipts[0].source_note, "provider_date=2026-10-28");
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.pricing, {status: "available"});

  const schema = JSON.parse(await readFile(new URL("../../schemas/fact.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv2020().compile(schema);
  assert.equal(validate(fact), true, JSON.stringify(validate.errors));
});

test("cross-check failure is visible and never replaces the terminal value", async () => {
  const primary = source("frankfurter-usd-cny", async () => success(7));
  const cross = source("cbr-usd-cny-cross", async () => {
    throw Object.assign(new Error("mirror unavailable"), {code: "HTTP_503"});
  }, {
    source_type: "official-mirror",
    role: "cross-check", capabilities: {key: "fx.USD_CNY", unit: "CNY/USD"}
  });
  const result = await refreshFacts({sources: [primary, cross], facts: [oldFact], nowIso});
  assert.equal(result.facts[0].value, 7);
  assert.equal(result.facts[0].source, "frankfurter-usd-cny");
  assert.deepEqual(result.facts[0].cross_check, []);
  const receipt = result.receipts.find((r) => r.role === "cross_check");
  assert.equal(receipt.status, "missing");
  assert.equal(receipt.error.code, "HTTP_503");
  assert.equal(result.pricing.status, "unavailable");
  assert.equal(result.pricing.reasons.some((reason) =>
    reason.code === "cross_check_unavailable" && reason.source === cross.id), true);
});

test("a secondary cross source cannot become a terminal fact", async () => {
  let calls = 0;
  const secondary = source("secondary-cross", async () => {
    calls += 1;
    return success(9);
  }, {
    source_type: "secondary",
    role: "cross-check", capabilities: {key: "fx.USD_CNY", unit: "CNY/USD"}
  });
  const result = await refreshFacts({sources: [secondary], facts: [], nowIso});
  assert.equal(calls, 0);
  assert.deepEqual(result.facts, []);
});

for (const sourceType of ["secondary", "user-override"]) {
  test(`${sourceType} facts refuse automatic refresh`, async () => {
    let calls = 0;
    const id = `${sourceType}-source`;
    const fact = {...oldFact, source: id, source_type: sourceType};
    const manual = source(id, async () => {
      calls += 1;
      return success(9);
    }, {source_type: sourceType});
    const result = await refreshFacts({sources: [manual], facts: [fact], nowIso});
    assert.equal(calls, 0);
    assert.equal(result.facts[0].value, 6.6);
    assert.equal(result.facts[0].stale, true);
    assert.equal(result.receipts[0].error.code, "SOURCE_UNAVAILABLE");
    if (sourceType === "secondary") {
      assert.equal(result.pricing.status, "available");
      assert.equal(result.pricing.quality, "secondary", "a secondary-sourced value must be flagged, never passed off as official");
      assert.deepEqual(result.pricing.secondary_keys, ["fx.USD_CNY"]);
    } else {
      assert.deepEqual(result.pricing, {status: "available"});
    }
  });
}

test("facts accept only an array or a top-level facts wrapper", async () => {
  const fresh = {...oldFact, fetched_at: nowIso};
  for (const facts of [[fresh], {facts: [fresh]}]) {
    const result = await refreshFacts({sources: [], facts, nowIso});
    assert.deepEqual(result.facts, [fresh]);
  }
  await assert.rejects(
    refreshFacts({sources: [], facts: {nested: {facts: [fresh]}}, nowIso}),
    /array|facts/
  );
});

test("higher_is_worse selects the adverse side and records a resolved conflict", async () => {
  const primary = source("frankfurter-usd-cny", async () => success(7));
  const cross = source("cbr-usd-cny-cross", async () => success(7.07), {
    source_type: "official-mirror", role: "cross-check"
  });
  const result = await refreshFacts({sources: [primary, cross], facts: [oldFact], nowIso});
  const fact = result.facts[0];
  assert.equal(fact.value, 7.07);
  assert.equal(fact.status, "conflicted");
  assert.equal(fact.divergence_pct, 1);
  assert.equal(fact.conflict_id, result.conflicts[0].id);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].status, "divergent");
  assert.equal(result.conflicts[0].pair, "USD_CNY");
  assert.equal(result.conflicts[0].selected_value, 7.07);
  assert.equal(result.conflicts[0].selected_source, "cbr-usd-cny-cross");
  assert.equal(result.conflicts[0].resolved, true);
  assert.deepEqual(result.pricing, {status: "available"});
});

test("lower_is_worse selects the lower side of a divergent pair", async () => {
  const primary = source("frankfurter-usd-cny", async () => success(7), {
    mapping: {key: "fx.USD_CNY", unit: "CNY/USD", cost_direction: "lower_is_worse"}
  });
  const cross = source("cbr-usd-cny-cross", async () => success(6.9), {
    source_type: "official-mirror", role: "cross-check"
  });
  const result = await refreshFacts({sources: [primary, cross], facts: [oldFact], nowIso});
  assert.equal(result.conflicts[0].selected_value, 6.9);
  assert.equal(result.conflicts[0].selected_source, "cbr-usd-cny-cross");
  assert.equal(result.conflicts[0].resolved, true);
  assert.equal(result.facts[0].value, 6.9);
  assert.deepEqual(result.pricing, {status: "available"});
});

test("divergence without cost_direction remains unresolved and blocks pricing", async () => {
  const primary = source("frankfurter-usd-cny", async () => success(7), {
    mapping: {key: "fx.USD_CNY", unit: "CNY/USD"}
  });
  const cross = source("cbr-usd-cny-cross", async () => success(7.07), {
    source_type: "official-mirror", role: "cross-check",
    mapping: {key: "fx.USD_CNY", unit: "CNY/USD"}
  });
  const result = await refreshFacts({sources: [primary, cross], facts: [oldFact], nowIso});
  assert.equal(result.facts[0].value, 7);
  assert.equal(result.facts[0].status, "conflicted");
  assert.equal(result.conflicts[0].resolved, false);
  assert.equal(result.conflicts[0].selected_value, null);
  assert.equal(result.pricing.status, "unavailable");
  assert.equal(result.pricing.reasons.some((reason) =>
    reason.code === "divergence_unresolved" && reason.key === "fx.USD_CNY"), true);
});

test("divergence at exactly 0.5 percent remains within tolerance", async () => {
  const primary = source("frankfurter-usd-cny", async () => success(8));
  const cross = source("cbr-usd-cny-cross", async () => success(8.04), {
    source_type: "official-mirror", role: "cross-check"
  });
  const result = await refreshFacts({sources: [primary, cross], facts: [oldFact], nowIso});
  assert.equal(result.facts[0].divergence_pct, 0.5);
  assert.equal(result.facts[0].status, undefined);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.pricing, {status: "available"});
});

test("writeConflicts generates the data/conflicts.json array format", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fx-conflicts-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const filePath = join(directory, "conflicts.json");
  const records = [{id: "fx-divergence:fx.USD_CNY", status: "divergent"}];
  const {writeConflicts} = await import("../../core/data/refresh-facts.mjs");
  await writeConflicts(filePath, records);
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), records);
});

test("a secondary source seeds a missing fact when no official quote exists", async () => {
  let calls = 0;
  const secondary = source("secondary-only", async () => {
    calls += 1;
    return success(3.75, {source_type: "secondary"});
  }, {
    source_type: "secondary",
    priority: 20,
    capabilities: {key: "fx.USD_SAR", unit: "SAR/USD"},
    mapping: {key: "fx.USD_SAR", unit: "SAR/USD", cost_direction: "higher_is_worse"}
  });

  const result = await refreshFacts({sources: [secondary], facts: [], nowIso});

  assert.equal(calls, 1);
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].value, 3.75);
  assert.equal(result.facts[0].source_type, "secondary");
  assert.equal(result.pricing.quality, "secondary", "secondary seed must never look official");
  assert.deepEqual(result.pricing.secondary_keys, ["fx.USD_SAR"]);
});

test("an official failure falls through to the next candidate and keeps both receipts", async () => {
  const official = source("official-down", async () => {
    throw Object.assign(new Error("HTTP 503"), {code: "HTTP_ERROR", http_status: 503});
  }, {priority: 10});
  const backup = source("secondary-backup", async () => success(6.61, {source_type: "secondary"}), {
    source_type: "secondary", priority: 20
  });

  const result = await refreshFacts({sources: [official, backup], facts: [], nowIso});

  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].source, "secondary-backup");
  assert.equal(result.facts[0].value, 6.61);
  const missing = result.receipts.find((item) => item.status === "missing" && item.source === "official-down");
  assert.equal(missing.error.code, "HTTP_ERROR");
  assert.equal(result.pricing.quality, "secondary");
});

test("priority ordering decides which candidate becomes the terminal value", async () => {
  const later = source("priority-90", async () => success(6.9), {priority: 90});
  const earlier = source("priority-10", async () => success(6.1), {priority: 10});

  const result = await refreshFacts({sources: [later, earlier], facts: [], nowIso});

  assert.equal(result.facts[0].source, "priority-10");
  assert.equal(result.facts[0].value, 6.1);
  const crossCheck = result.facts[0].cross_check.find((item) => item.source === "priority-90");
  assert.equal(crossCheck.value, 6.9, "the losing candidate must be kept as a cross-check");
});
