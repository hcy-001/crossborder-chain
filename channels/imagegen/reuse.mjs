import {createHash} from "node:crypto";
import {mkdir, readFile, readdir} from "node:fs/promises";
import {join, extname} from "node:path";
import sharp from "sharp";
import {classifyFault} from "./fault.mjs";

export const meta = {
  name: "reuse",
  kind: "imagegen",
  requires: "none",
  capabilities: {reuse: true},
  cost: {currency: "CNY", unit_price: 0}
};

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

async function collectImages(directory, depth = 0) {
  if (depth > 4) return [];
  let entries;
  try {
    entries = await readdir(directory, {withFileTypes: true});
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      found.push(...await collectImages(full, depth + 1));
    } else if (IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      found.push(full);
    }
  }
  return found.sort();
}

export async function probe(input = {}) {
  if (!input.sourceDir) return {ok: false, detail: "missing_source_dir"};
  const files = await collectImages(input.sourceDir);
  if (files.length === 0) return {ok: false, detail: "no_images_found"};
  return {ok: true, detail: `ready (${files.length} candidates)`};
}

export async function run(input = {}) {
  const {width, height, count, outputDir, sourceDir} = input;
  if (typeof sourceDir !== "string" || sourceDir.length === 0) {
    return {ok: false, files: [], meta: {reason: "missing_source_dir"}, usage: {}};
  }
  if (!Number.isInteger(count) || count <= 0) throw new TypeError("count must be a positive integer");
  if (typeof outputDir !== "string" || outputDir.length === 0) throw new TypeError("outputDir is required");

  try {
    const candidates = await collectImages(sourceDir);
    const seen = new Set();
    const picked = [];
    for (const file of candidates) {
      const raw = await readFile(file);
      const sha256 = createHash("sha256").update(raw).digest("hex");
      if (seen.has(sha256)) continue;
      seen.add(sha256);
      picked.push({file, raw, sha256});
    }
    if (picked.length < count) {
      return {
        ok: false,
        files: [],
        meta: {
          reason: "insufficient_reused_images",
          available: picked.length,
          required: count,
          sourceDir
        },
        usage: {}
      };
    }

    await mkdir(outputDir, {recursive: true});
    const files = [];
    const provenance = [];
    for (let index = 0; index < count; index += 1) {
      const source = picked[index];
      const target = join(outputDir, `reused-${String(index + 1).padStart(2, "0")}.png`);
      await sharp(source.raw).resize(width, height, {fit: "cover", position: "centre"}).png().toFile(target);
      files.push(target);
      provenance.push({index: index + 1, source: source.file, source_sha256: source.sha256});
    }

    return {
      ok: true,
      files,
      quality: "reused",
      meta: {quality: "reused", width, height, count, sourceDir, provenance},
      usage: {images: count, unit_price: 0, cost_cny: 0}
    };
  } catch (error) {
    return {
      ok: false,
      files: [],
      meta: {reason: error instanceof Error ? error.message : "reuse_failed"},
      usage: {},
      fault: classifyFault(error)
    };
  }
}

export function fault(error) {
  return classifyFault(error);
}
