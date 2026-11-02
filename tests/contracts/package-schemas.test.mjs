import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";

const readSchema = async (name) => JSON.parse(await readFile(new URL(`../../schemas/${name}`, import.meta.url), "utf8"));
const [manifestSchema, cropSchema, validateSchema, receiptSchema, titleSchema] = await Promise.all([
  readSchema("manifest.schema.json"),
  readSchema("crop.schema.json"),
  readSchema("validate.schema.json"),
  readSchema("receipt.schema.json"),
  readSchema("title-tokens.schema.json")
]);

const images = Array.from({length: 9}, (_, index) => ({
  file: `images/img-${String(index + 1).padStart(2, "0")}-abcdef12.png`,
  width: 900,
  height: 1200,
  sha256: "a".repeat(64),
  role: index === 0 ? "white_background" : index > 6 ? "size" : index > 3 ? "detail" : "scene",
  quality: "placeholder",
  crop_safe: true
}));

test("master manifest carries facts, nine images and unavailable video", () => {
  const validate = new Ajv2020().compile(manifestSchema);
  const manifest = {
    sku: "demo-sku",
    region: "RU",
    category: "outerwear",
    snapshot_id: "snapshot-demo",
    product_facts: [{
      key: "material.composition",
      value: "polyester 100%",
      unit: null,
      source_kind: "reported",
      basis: "supplier fixture",
      confidence: "medium"
    }],
    images,
    compliance: "compliance/report.json",
    video: {status: "unavailable", file: null, reason: "optional"},
    variants: []
  };
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
  assert.equal(validate({...manifest, images: images.slice(0, 8)}), false);
});

test("crop, validation, receipt and title schemas accept their contracts", () => {
  const ajv = new Ajv2020();
  assert.equal(ajv.compile(cropSchema)({
    src: "master/images/img-01-abcdef12.png",
    src_sha256: "a".repeat(64),
    output: "platforms/example/images/img-01-abcdef12-1x1.png",
    box: [112, 0, 675, 900],
    mode: "contain_pad",
    canvas: [900, 900],
    algo_version: "contain-pad-white-v1"
  }), true);
  assert.equal(ajv.compile(validateSchema)({
    platform: "example",
    quality: "placeholder",
    passed: ["png_dimensions"],
    violations: [],
    conflicts: [],
    crop_unsafe: [],
    notes: "not for publishing"
  }), true);
  assert.equal(ajv.compile(receiptSchema)({
    run_id: "20261029-010000-abcd",
    sku: "demo-sku",
    snapshot_sha256: "b".repeat(64),
    started_at: "2026-10-29T01:00:00.000Z",
    finished_at: "2026-10-29T01:00:01.000Z",
    duration_ms: 1000,
    gates: [{id: "G6", status: "pass", level: "L1", evidence: "local demo"}],
    degradations: [{kind: "imagegen", detail: "mock placeholder"}],
    divergences: [],
    stale: [],
    providers: [{kind: "imagegen", detail: "mock"}]
  }), true);
  assert.equal(ajv.compile(titleSchema)({
    brand: "example",
    product_type: "coat",
    key_attrs: ["long"],
    spec: "M",
    material: "polyester",
    audience: "women"
  }), true);
});
