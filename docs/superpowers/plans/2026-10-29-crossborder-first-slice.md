# Crossborder Delivery Skill First Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a portable repository whose decoupling gates provably fail on bad fixtures, whose FX facts refresh online with provenance and TTL, and whose mock image/LAB channels run without keys.

**Architecture:** A Node ESM modular monolith keeps pure domain code in `core/`, external access in `channels/`, and machine contracts in `schemas/`. The first slice does not implement scoring, compliance or platform projection; it establishes the gates and ports those modules must use.

**Tech Stack:** Node.js >=20, ESM `.mjs`, `node:test`, Ajv, Sharp.

**Spec:** `docs/superpowers/specs/2026-10-29-crossborder-delivery-skill-design.md`

## Global Constraints

- Four public commands only: `npm ci`, `npm run doctor`, `npm run demo`, `npm run pack -- <sku>`.
- Acceptance demo is zero key + online; offline package generation is not a requirement.
- Mock replaces image generation only, never external facts.
- `source_type` and `confidence` are separate vocabularies.
- No region, language, platform or domain literals in `core/`.
- No absolute home paths or credentials in the repository.
- Every gate must be tested with both passing and failing fixtures.
- Root configuration and `schemas/` are modified only by the lead agent.

---

### Task 1: Repository Bootstrap and Machine Contracts

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `schemas/fact.schema.json`
- Create: `schemas/source.schema.json`
- Create: `tests/contracts/fact-schema.test.mjs`

**Interfaces:**
- Produces: `Fact` JSON Schema with required `key/value/unit/scope/source/source_url/source_type/fetched_at/ttl_hours/stale/cross_check/divergence_pct/override`.
- Produces: source config schema consumed by the data channel.

- [ ] **Step 1: Write the failing schema test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import {readFile} from "node:fs/promises";

const schema = JSON.parse(await readFile(new URL("../../schemas/fact.schema.json", import.meta.url), "utf8"));

test("fact rejects a missing source_url", () => {
  const ajv = new Ajv2020();
  const validate = ajv.compile(schema);
  const fact = {
    key: "fx.USD_CNY", value: 6.6, unit: "CNY/USD",
    scope: {region: null, platform: null, category: null},
    source: "frankfurter", source_type: "official",
    fetched_at: "2026-10-29T00:00:00.000Z", ttl_hours: 24,
    stale: false, cross_check: [], divergence_pct: null, override: null
  };
  assert.equal(validate(fact), false);
});
```

- [ ] **Step 2: Run the test and confirm the missing schema failure**

Run: `npm test -- tests/contracts/fact-schema.test.mjs`
Expected: FAIL because `schemas/fact.schema.json` does not exist.

- [ ] **Step 3: Add root configuration and strict schemas**

`package.json` defines `type: "module"`, `engines.node: ">=20"`, scripts `test/doctor/demo/pack/check:decouple/add-region`, and dependencies `ajv` and `sharp`. `.gitignore` excludes `node_modules/`, `.env`, `runs/`, `package/`, and generated diagnostic logs.

- [ ] **Step 4: Install and verify**

Run: `npm install && npm test -- tests/contracts/fact-schema.test.mjs`
Expected: PASS; `package-lock.json` exists.

### Task 2: Decoupling Gate With Red/Green Fixtures

**Files:**
- Create: `scripts/gates/check-decouple.mjs`
- Create: `tests/gates/decouple.test.mjs`
- Create: `tests/fixtures/gate-valid/data/variables/fx.json`
- Create: `tests/fixtures/gate-valid/data/specs/platforms/example.json`
- Create: `tests/fixtures/gate-valid/data/specs/wrapped.json` using `{"facts": [...]}`
- Create: `tests/fixtures/gate-valid/regions/RU/profile.json`

**Interfaces:**
- CLI: `node scripts/gates/check-decouple.mjs --root <absolute-or-relative-root>`.
- Exit `0` when all four checks pass; exit `1` with check id and offending path on failure.

- [ ] **Step 1: Write failing process-level tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";

const runGate = (root) => spawnSync(process.execPath,
  ["scripts/gates/check-decouple.mjs", "--root", root], {encoding: "utf8"});

test("gate rejects a platform literal in core", () => {
  const result = runGate("tests/fixtures/gate-platform");
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /G1-CORE/);
});
```

Add equivalent tests for a clean fixture, a missing `source_url`, an absolute home path, and an invalid region profile.

- [ ] **Step 2: Run tests and confirm module-not-found failure**

Run: `npm test -- tests/gates/decouple.test.mjs`
Expected: FAIL because the gate module is absent.

- [ ] **Step 3: Implement the four checks without changing business logic**

Checks are `G1-CORE`, `G1-PATH`, `G1-FACT`, `G1-PROFILE`. Ignore documentation and fixture literals when scanning the real repository, but never ignore a fixture root passed explicitly to the gate.

- [ ] **Step 4: Prove both exit states**

Run: `node scripts/gates/check-decouple.mjs --root tests/fixtures/gate-valid`
Expected: exit `0` with four PASS lines and nonzero `scanned_core_files`, `scanned_facts`, and `scanned_profiles` counts asserted by the fixture tests.

Run: `node scripts/gates/check-decouple.mjs --root tests/fixtures/gate-platform`
Expected: exit `1` with `G1-CORE` and the injected path.

Run: `npm test -- tests/gates/decouple.test.mjs`
Expected: all gate tests PASS.

### Task 3: Online FX Facts and TTL Doctor Port

**Files:**
- Create: `core/data/facts.mjs`
- Create: `core/data/refresh-facts.mjs`
- Create: `channels/source/http-json.mjs`
- Create: `channels/source/frankfurter.mjs`
- Create: `channels/source/cbr.mjs`
- Create: `data/sources.json`
- Create: `data/conflicts.json`
- Create: `data/variables/fx.json`
- Create: `tests/data/facts.test.mjs`
- Create: `tests/data/refresh-facts.test.mjs`

**Interfaces:**
- `assessFact(fact, nowIso)` returns `{status: "fresh"|"stale"|"missing", expiredDays: number|null}`; missing input never reuses an old value.
- `refreshFacts({sources, facts, nowIso})` returns refreshed facts plus refresh receipts, including cross-check divergence and conflict records.
- `createSourceChannel(sourceConfig)` exposes `probe()` and `run(input)`; business modules never call `fetch` directly.
- Generic `http-json` sources use configured JSON Pointer `mapping`; adding a same-shape source changes `data/sources.json` only.

- [ ] **Step 1: Write fake-clock and failure-channel tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import {assessFact} from "../../core/data/facts.mjs";
import {refreshFacts} from "../../core/data/refresh-facts.mjs";

const oldFact = {
  key: "fx.USD_CNY", value: 6.6, unit: "CNY/USD",
  scope: {region: null, platform: null, category: null},
  source: "frankfurter", source_url: "https://api.frankfurter.dev/v1/latest?base=USD",
  source_type: "official", fetched_at: "2026-10-20T00:00:00.000Z",
  ttl_hours: 24, stale: false, cross_check: [], divergence_pct: null, override: null
};
const failingSources = [{id: oldFact.source, kind: "source", run: async () => {
  throw Object.assign(new Error("fixture timeout"), {code: "ETIMEDOUT"});
}}];

test("expired fact reports whole elapsed days", () => {
  const fact = {fetched_at: "2026-10-20T00:00:00.000Z", ttl_hours: 24};
  assert.deepEqual(assessFact(fact, "2026-10-29T12:00:00.000Z"),
    {status: "stale", expiredDays: 8});
});

test("failed refresh preserves old value and exposes stale receipt", async () => {
  const result = await refreshFacts({sources: failingSources, facts: [oldFact],
    nowIso: "2026-10-29T12:00:00.000Z"});
  assert.equal(result.facts[0].stale, true);
  assert.equal(result.receipts[0].status, "stale");
});
```

Add explicit fixtures for missing input, secondary and user-override refresh refusal, a CBR `official-mirror` fact, cross-check divergence above 0.5%, and a third same-shape JSON source added only through `sources.json`.

- [ ] **Step 2: Confirm tests fail before implementation**

Run: `npm test -- tests/data/facts.test.mjs tests/data/refresh-facts.test.mjs`
Expected: FAIL because the data modules are absent.

- [ ] **Step 3: Implement pure TTL logic and source channels**

Use official Frankfurter for currencies it covers and the CBR mirror for RUB crosses. Every value carries source URL, actual fetch time, TTL and cross-check data. Network errors become receipts; no source adapter invents a rate.

- [ ] **Step 4: Run local and live probes**

Run: `npm test -- tests/data/facts.test.mjs tests/data/refresh-facts.test.mjs`
Expected: PASS.

Run: `node channels/source/frankfurter.mjs probe`
Expected: exit `0`, HTTP 200, actual `fetched_at`, and no key required. A network failure is reported as UNVERIFIED, never converted into a hardcoded success.

### Task 4: Mock Image and LAB Storage Channels

**Files:**
- Create: `channels/imagegen/mock.mjs`
- Create: `channels/imagegen/http-openai-compat.mjs`
- Create: `channels/storage/lab.mjs`
- Create: `tests/channels/mock-image.test.mjs`
- Create: `tests/channels/lab-storage.test.mjs`
- Create: `tests/channels/openai-probe.test.mjs`

**Interfaces:**
- All channels export `meta`, `probe()`, `run(input)`, `fault(error)` as defined in the design.
- `mock.run({width, height, count, outputDir})` writes real PNG files and returns their paths.
- `lab.run({files, outputDir})` writes content-addressed filenames and a local manifest.

- [ ] **Step 1: Write binary and hashing tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import {readFile, mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import sharp from "sharp";
import * as mock from "../../channels/imagegen/mock.mjs";

test("mock emits a PNG with requested dimensions", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "mock-image-"));
  const result = await mock.run({width: 900, height: 1200, count: 1, outputDir: tempDir});
  const buffer = await readFile(result.files[0]);
  assert.equal(buffer.subarray(1, 4).toString(), "PNG");
  const metadata = await sharp(buffer).metadata();
  assert.equal(metadata.width, 900);
  assert.equal(metadata.height, 1200);
});
```

Add a test that identical LAB input produces identical names and a one-byte change alters the SHA-8 name. Test OpenAI-compatible probe against a local HTTP fixture; do not spend on a real generation call.

- [ ] **Step 2: Confirm channel tests fail before implementation**

Run: `npm test -- tests/channels/mock-image.test.mjs tests/channels/lab-storage.test.mjs tests/channels/openai-probe.test.mjs`
Expected: FAIL because channel modules are absent.

- [ ] **Step 3: Implement minimal channels**

Mock images are explicitly marked `quality: "placeholder"`; LAB storage never invents a public URL. OpenAI-compatible capability detection returns declared capabilities only.

- [ ] **Step 4: Verify**

Run: `npm test -- tests/channels/mock-image.test.mjs tests/channels/lab-storage.test.mjs tests/channels/openai-probe.test.mjs`
Expected: PASS and real PNG byte/dimension assertions in output.

A real one-image OpenAI generation is a separate opt-in L2 action requiring explicit key, quoted unit price and user confirmation. Until that action runs, report OpenAI generation as UNVERIFIED; the local probe is L1 only.

### Task 5: Lead Integration and First-Slice Evidence

**Files:**
- Create: `scripts/doctor.mjs`
- Create: `scripts/lib/preflight.mjs`
- Create: `tests/integration/doctor.test.mjs`
- Create: `out/P1/fx-report.json`
- Create: `out/P2/channel-report.json`
- Create: `out/P6/gate-report.json`
- Modify: `README.md`

**Interfaces:**
- `npm run doctor` calls the data refresh port and writes a nonzero exit only for invalid configuration or required environment failure; stale facts are visibly reported.
- Later demo/pack tasks consume the same channel contracts without modification.

- [ ] **Step 1: Wire doctor through channels**

The lead agent is the only writer of `scripts/doctor.mjs` and `scripts/lib/preflight.mjs`; they import the data port rather than fetching URLs themselves. Exit 1 is reserved for unreadable configuration/schema or invalid required runtime. Stale, missing, pricing_unavailable, compliance blockers and unavailable capabilities remain runnable with exit 0 and explicit receipts. The preflight record hashes parsed sources, configuration and snapshot inputs for later demo/pack consistency checks.

Write process-level tests for the full matrix: readable config + stale/missing/blockers => exit 0 with package permission and pricing state; unreadable schema/config => exit 1 and refusal; schema divergence from the frozen preflight state => exit 1 rather than silently continuing.

- [ ] **Step 2: Run the full local suite**

Run: `npm test && npm run check:decouple && npm run doctor`
Expected: all tests PASS, decoupling exit `0`, doctor writes actual source receipts and FX facts, and each exit-matrix branch has a real spawned-process result.

- [ ] **Step 3: Record real evidence**

Save command, exit code and summary in `out/P6/gate-report.json`, `out/P1/fx-report.json`, and `out/P2/channel-report.json`. Do not claim L2 for any provider or platform not exercised against its real service.

- [ ] **Step 4: Review against the spec**

Confirm that no task implements scoring, compliance or projection prematurely, that offline package generation is absent from acceptance, and that all first-slice requirements map to a passing test or an explicitly marked live-source limitation.
