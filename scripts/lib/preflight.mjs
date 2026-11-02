import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {join, resolve} from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import {createSourceChannel} from "../../channels/source/http-json.mjs";
import {refreshFacts, writeConflicts} from "../../core/data/refresh-facts.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const pretty = (value) => `${JSON.stringify(value, null, 2)}\n`;

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function hashFile(file) {
  return sha256(await readFile(file));
}

function makeRunId(nowIso, input) {
  const suffix = sha256(`${nowIso}:${input}`).slice(0, 4);
  return `${nowIso.slice(0, 10).replaceAll("-", "")}-${nowIso.slice(11, 19).replaceAll(":", "")}-${suffix}`;
}

function hardFailure(error) {
  return {
    ok: false,
    exitCode: 1,
    state: {
      run_id: null,
      status: "hard_failure",
      error: {code: error?.code ?? "PREFLIGHT_ERROR", message: error instanceof Error ? error.message : String(error)}
    }
  };
}

export async function runDoctor({root, nowIso = new Date().toISOString(), channelFactory = createSourceChannel} = {}) {
  const projectRoot = resolve(root ?? process.cwd());
  const sourcesPath = join(projectRoot, "data/sources.json");
  const variablesPath = join(projectRoot, "data/variables/fx.json");
  try {
    if (!Number.isFinite(Date.parse(nowIso))) throw new TypeError("Invalid nowIso timestamp");
    const [sourcesRaw, variablesRaw, sourceSchema, factSchema] = await Promise.all([
      readFile(sourcesPath, "utf8"),
      readFile(variablesPath, "utf8"),
      readJson(join(projectRoot, "schemas/source.schema.json")),
      readJson(join(projectRoot, "schemas/fact.schema.json"))
    ]);
    const sources = JSON.parse(sourcesRaw);
    const storedFacts = JSON.parse(variablesRaw);
    if (!Array.isArray(sources)) throw new TypeError("sources.json must be an array");
    if (!Array.isArray(storedFacts) && !Array.isArray(storedFacts?.facts)) {
      throw new TypeError("fx.json must be an array or a top-level facts wrapper");
    }
    const ajv = new Ajv2020();
    const validateSource = ajv.compile(sourceSchema);
    const validateFact = ajv.compile(factSchema);
    for (const source of sources) {
      if (!validateSource(source)) throw new TypeError(`Invalid source config: ${JSON.stringify(validateSource.errors)}`);
    }
    for (const fact of Array.isArray(storedFacts) ? storedFacts : storedFacts.facts) {
      if (!validateFact(fact)) throw new TypeError(`Invalid stored fact: ${JSON.stringify(validateFact.errors)}`);
    }

    const channels = sources.map((source) => channelFactory(source));
    const refreshed = await refreshFacts({sources: channels, facts: storedFacts, nowIso});
    for (const fact of refreshed.facts) {
      if (!validateFact(fact)) throw new TypeError(`Invalid refreshed fact: ${JSON.stringify(validateFact.errors)}`);
    }
    await writeFile(variablesPath, pretty(refreshed.facts));
    await writeConflicts(join(projectRoot, "data/conflicts.json"), refreshed.conflicts);

    const runId = makeRunId(nowIso, `${sourcesRaw}:${variablesRaw}`);
    const runDir = join(projectRoot, "runs", runId);
    await mkdir(runDir, {recursive: true});
    const snapshot = {snapshot_id: runId, created_at: nowIso, facts: refreshed.facts};
    const snapshotPath = join(runDir, "variables.snapshot.json");
    await writeFile(snapshotPath, pretty(snapshot));
    const snapshotSha256 = await hashFile(snapshotPath);
    const state = {
      run_id: runId,
      status: refreshed.pricing.status === "available" ? "ok" : "pricing_unavailable",
      checked_at: nowIso,
      sources_sha256: sha256(sourcesRaw),
      variables_sha256: await hashFile(variablesPath),
      snapshot_sha256: snapshotSha256,
      snapshot_path: `runs/${runId}/variables.snapshot.json`,
      pricing: refreshed.pricing,
      receipts: refreshed.receipts,
      conflicts: refreshed.conflicts,
      facts: refreshed.facts
    };
    await writeFile(join(runDir, "doctor.json"), pretty(state));
    await writeFile(join(projectRoot, "runs/latest-doctor.json"), pretty({run_id: runId}));
    return {ok: true, exitCode: 0, state};
  } catch (error) {
    return hardFailure(error);
  }
}

export async function assertPreflightCurrent(root, state) {
  try {
    const projectRoot = resolve(root ?? process.cwd());
    const [sourcesHash, variablesHash, snapshotHash] = await Promise.all([
      hashFile(join(projectRoot, "data/sources.json")),
      hashFile(join(projectRoot, "data/variables/fx.json")),
      hashFile(join(projectRoot, state.snapshot_path))
    ]);
    return sourcesHash === state.sources_sha256 &&
      variablesHash === state.variables_sha256 &&
      snapshotHash === state.snapshot_sha256;
  } catch {
    return false;
  }
}

export async function loadLatestPreflight(root) {
  const projectRoot = resolve(root ?? process.cwd());
  const pointer = await readJson(join(projectRoot, "runs/latest-doctor.json"));
  const state = await readJson(join(projectRoot, "runs", pointer.run_id, "doctor.json"));
  if (!await assertPreflightCurrent(projectRoot, state)) {
    throw new Error("doctor state is stale; rerun doctor before demo or pack");
  }
  return state;
}
