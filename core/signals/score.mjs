import {createHash} from "node:crypto";

const DIMENSIONS = ["D", "G", "M", "L", "C"];

export const PROFILE_WEIGHTS = Object.freeze({
  conservative: Object.freeze({D: 0.20, G: 0.05, M: 0.15, L: 0.35, C: 0.25}),
  aggressive: Object.freeze({D: 0.35, G: 0.30, M: 0.20, L: 0.05, C: 0.10}),
  pilot: Object.freeze({D: 0.15, G: 0.00, M: 0.25, L: 0.50, C: 0.10})
});

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareCandidates(a, b) {
  if (a.score !== b.score) return b.score - a.score;
  if (a.candidate_id < b.candidate_id) return -1;
  if (a.candidate_id > b.candidate_id) return 1;
  return 0;
}

export function scoreCategories(input) {
  const candidates = structuredClone(input.candidates);
  const rankings = {};

  for (const [profile, weights] of Object.entries(PROFILE_WEIGHTS)) {
    rankings[profile] = candidates.map((candidate) => {
      const dimensions = candidate.dimensions;
      const vector = [dimensions.D, dimensions.G, dimensions.M, dimensions.L, 100 - dimensions.C];
      const score = DIMENSIONS.reduce((total, dimension, index) =>
        total + weights[dimension] * vector[index], 0);
      return {candidate_id: candidate.id, score, vector};
    }).sort(compareCandidates).map((entry, index) => ({
      candidate_id: entry.candidate_id,
      score: entry.score,
      rank: index + 1,
      vector: entry.vector
    }));
  }

  return {
    input_sha256: createHash("sha256").update(canonicalJson(input)).digest("hex"),
    candidates,
    rankings
  };
}
