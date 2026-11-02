import test from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import {readFile} from "node:fs/promises";

const scoreSchema = JSON.parse(await readFile(new URL("../../schemas/score.schema.json", import.meta.url), "utf8"));
const complianceSchema = JSON.parse(await readFile(new URL("../../schemas/compliance-report.schema.json", import.meta.url), "utf8"));

const dimensions = {D: 70, G: 60, M: 65, L: 80, C: 40};
const evidence = Object.fromEntries(Object.keys(dimensions).map((key) => [key, [{
  signal_id: `signal-${key}`,
  source: "fixture",
  url: "https://example.com/signals"
}]]));
const candidates = ["a", "b", "c"].map((id) => ({
  id,
  opportunity: `opportunity-${id}`,
  dimensions,
  evidence,
  risks: ["risk-1", "risk-2", "risk-3"],
  confidence: "secondary",
  signal_coverage: "low"
}));
const ranking = candidates.map((candidate, index) => ({
  candidate_id: candidate.id,
  score: 65,
  rank: index + 1,
  vector: [70, 60, 65, 80, 60]
}));

test("score schema separates confidence from signal coverage", () => {
  const validate = new Ajv2020().compile(scoreSchema);
  const score = {
    input_sha256: "a".repeat(64),
    candidates,
    rankings: {conservative: ranking, aggressive: ranking, pilot: ranking}
  };
  assert.equal(validate(score), true, JSON.stringify(validate.errors));
  assert.equal(validate({...score, generated_at: "2026-10-29T00:00:00.000Z"}), false);
  assert.equal(validate({...score, candidates: candidates.map((item) => ({...item, confidence: "low"}))}), false);
});

test("compliance schema accepts a traceable report", () => {
  const validate = new Ajv2020().compile(complianceSchema);
  const report = {
    sku: "demo-sku",
    destination: "RU",
    items: [{
      layer: "access",
      requirement: "declaration required",
      applies_because: "outerwear",
      owner: "importer",
      status: "required",
      source_url: "https://eec.eaeunion.org",
      checked_at: "2026-10-29T00:00:00.000Z",
      confidence: "secondary"
    }],
    blockers: [],
    notes: "official verification required"
  };
  assert.equal(validate(report), true, JSON.stringify(validate.errors));
});
