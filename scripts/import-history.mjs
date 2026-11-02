import {createHash} from "node:crypto";
import {copyFile, mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import {basename, extname, join, resolve} from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import sharp from "sharp";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const SKU_KEYS = ["sku", "destination", "category", "facts", "platforms"];

function parseArgs(args) {
  const options = {root: process.cwd(), from: null, sku: null, apply: false, maxDepth: 5};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--from") options.from = args[++index];
    else if (arg === "--sku") options.sku = args[++index];
    else if (arg === "--root") options.root = args[++index];
    else if (arg === "--max-depth") options.maxDepth = Number(args[++index]);
    else if (arg === "--apply") options.apply = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.from) throw new Error("usage: import-history --from <dir> [--sku <name>] [--apply]");
  return options;
}

async function walk(directory, depth, maxDepth, acc) {
  if (depth > maxDepth) return acc;
  let entries;
  try {
    entries = await readdir(directory, {withFileTypes: true});
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(full, depth + 1, maxDepth, acc);
    } else if (extname(entry.name).toLowerCase() === ".json") {
      acc.json.push(full);
    } else if (IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      acc.images.push(full);
    }
  }
  return acc;
}

function looksLikeSkuInput(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    SKU_KEYS.every((key) => key in value);
}

async function imageProfile(file) {
  try {
    const buffer = await readFile(file);
    const metadata = await sharp(buffer).metadata();
    return {
      file,
      width: metadata.width ?? null,
      height: metadata.height ?? null,
      format: metadata.format ?? null,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      bytes: buffer.length
    };
  } catch (error) {
    return {file, error: error instanceof Error ? error.message : String(error)};
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = resolve(options.root);
  const source = resolve(options.from);

  const collected = await walk(source, 0, options.maxDepth, {json: [], images: []});

  const schema = JSON.parse(await readFile(join(root, "schemas/product-input.schema.json"), "utf8"));
  const ajv = new Ajv2020({strict: false});
  ajv.addSchema(JSON.parse(await readFile(join(root, "schemas/fact.schema.json"), "utf8")));
  ajv.addSchema(JSON.parse(await readFile(join(root, "schemas/title-tokens.schema.json"), "utf8")));
  const validateInput = ajv.compile(schema);

  const skuCandidates = [];
  for (const file of collected.json) {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch {
      continue;
    }
    if (!looksLikeSkuInput(parsed)) continue;
    const valid = validateInput(parsed);
    skuCandidates.push({
      file,
      sku: parsed.sku,
      destination: parsed.destination,
      platformCount: Array.isArray(parsed.platforms) ? parsed.platforms.length : 0,
      usable: valid,
      schemaErrors: valid ? [] : (validateInput.errors ?? []).slice(0, 5).map((error) =>
        `${error.instancePath || "/"} ${error.message}`)
    });
  }

  const images = [];
  for (const file of collected.images) images.push(await imageProfile(file));
  const usableImages = images.filter((item) => item.sha256 && item.width && item.height);
  const exactFrame = usableImages.filter((item) => item.width === 900 && item.height === 1200);
  const uniqueHashes = new Set(usableImages.map((item) => item.sha256));

  const report = {
    source,
    generatedAt: new Date().toISOString(),
    applied: options.apply,
    scanned: {json: collected.json.length, images: collected.images.length},
    sku_candidates: skuCandidates.sort((left, right) => Number(right.usable) - Number(left.usable)),
    images: {
      readable: usableImages.length,
      exact_900x1200: exactFrame.length,
      unique: uniqueHashes.size,
      frames: [...new Set(usableImages.map((item) => `${item.width}x${item.height}`))].slice(0, 10)
    },
    plan: []
  };

  if (options.apply) {
    const targetSku = options.sku ?? skuCandidates.find((item) => item.usable)?.sku ?? null;
    if (!targetSku) throw new Error("no usable SKU input found; pass --sku with a checked name");

    const reusable = skuCandidates.find((item) => item.usable && item.sku === targetSku);
    if (reusable) {
      await mkdir(join(root, "input"), {recursive: true});
      const target = join(root, "input", `${targetSku}.json`);
      await copyFile(reusable.file, target);
      report.plan.push({action: "copy_input", from: reusable.file, to: target});
    } else {
      report.plan.push({
        action: "skip_input",
        reason: "no schema-valid SKU input found for this name; nothing was rewritten",
        sku: targetSku
      });
    }

    if (uniqueHashes.size > 0) {
      const reuseDir = join(root, "cache/reuse", targetSku);
      await mkdir(reuseDir, {recursive: true});
      const seen = new Set();
      let copied = 0;
      for (const item of usableImages) {
        if (seen.has(item.sha256)) continue;
        seen.add(item.sha256);
        const name = `${String(++copied).padStart(2, "0")}-${item.sha256.slice(0, 8)}${extname(item.file).toLowerCase()}`;
        await copyFile(item.file, join(reuseDir, name));
        report.plan.push({action: "copy_image", from: item.file, to: join(reuseDir, name), frame: `${item.width}x${item.height}`});
      }
      report.reuse_dir = reuseDir;
      report.reused_image_count = copied;
    }
  }

  await mkdir(join(root, "out/verification"), {recursive: true});
  const reportPath = join(root, "out/verification/import-report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    applied: report.applied,
    scanned: report.scanned,
    sku_candidates: skuCandidates.length,
    usable_sku: skuCandidates.filter((item) => item.usable).length,
    images: report.images,
    plan_steps: report.plan.length,
    report: reportPath
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
