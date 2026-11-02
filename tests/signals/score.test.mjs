import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import {PROFILE_WEIGHTS, scoreCategories} from "../../core/signals/score.mjs";

const input = JSON.parse(await readFile(new URL("./fixtures/signals.json", import.meta.url), "utf8"));
const scoreSchema = JSON.parse(await readFile(new URL("../../schemas/score.schema.json", import.meta.url), "utf8"));
const signalSchema = JSON.parse(await readFile(new URL("../../schemas/signal.schema.json", import.meta.url), "utf8"));

function rankedIds(result, profile) {
  return result.rankings[profile].map((entry) => entry.candidate_id);
}

test("all profile weights are non-negative and sum to one", () => {
  assert.deepEqual(Object.keys(PROFILE_WEIGHTS), ["conservative", "aggressive", "pilot"]);
  for (const weights of Object.values(PROFILE_WEIGHTS)) {
    assert.ok(Object.values(weights).every((weight) => weight >= 0));
    assert.ok(Math.abs(Object.values(weights).reduce((sum, weight) => sum + weight, 0) - 1) < 1e-12);
  }
});

test("C is inverted exactly once and each profile produces its specified ranking", () => {
  const result = scoreCategories(input);
  assert.deepEqual(rankedIds(result, "conservative"), ["steady", "pilot", "growth"]);
  assert.deepEqual(rankedIds(result, "aggressive"), ["growth", "steady", "pilot"]);
  assert.deepEqual(rankedIds(result, "pilot"), ["pilot", "steady", "growth"]);

  const steady = result.rankings.conservative[0];
  assert.deepEqual(steady.vector, [60, 50, 60, 95, 80]);
  assert.equal(steady.score, 76.75);
  assert.deepEqual(result.rankings.conservative.map((entry) => entry.rank), [1, 2, 3]);
});

test("changing any scoring input changes the input hash", () => {
  const changed = structuredClone(input);
  changed.candidates[0].dimensions.D += 1;
  assert.match(scoreCategories(input).input_sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(scoreCategories(changed).input_sha256, scoreCategories(input).input_sha256);
});

test("the same input serializes to byte-identical JSON on two runs", () => {
  const first = Buffer.from(`${JSON.stringify(scoreCategories(input), null, 2)}\n`);
  const second = Buffer.from(`${JSON.stringify(scoreCategories(structuredClone(input)), null, 2)}\n`);
  assert.ok(first.equals(second));
});

test("score output validates against score.schema.json", () => {
  const validate = new Ajv2020().compile(scoreSchema);
  const result = scoreCategories(input);
  assert.equal(validate(result), true, JSON.stringify(validate.errors));
});

test("equal scores use candidate id as a deterministic tie-break", () => {
  const tied = structuredClone(input);
  for (const candidate of tied.candidates) {
    candidate.dimensions = {D: 50, G: 50, M: 50, L: 50, C: 50};
  }
  tied.candidates.reverse();
  assert.deepEqual(rankedIds(scoreCategories(tied), "conservative"), ["growth", "pilot", "steady"]);
});

test("T+1 source signals cannot claim realtime", () => {
  const validate = new Ajv2020().compile(signalSchema);
  const delayed = input.signals["signal-demand"];
  assert.equal(delayed.reporting_lag, "T+1");
  assert.equal(delayed.is_realtime, false);
  assert.equal(validate(delayed), true, JSON.stringify(validate.errors));
  assert.equal(validate({...delayed, is_realtime: true}), false);
});
