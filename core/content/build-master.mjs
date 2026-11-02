import {createHash} from "node:crypto";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, join} from "node:path";
import sharp from "sharp";
import {renderSizeCard} from "../sizing/card.mjs";
import Ajv2020 from "ajv/dist/2020.js";

const WIDTH = 900;
const HEIGHT = 1200;
const IMAGE_COUNT = 9;
const ROLES = [
  "white_background",
  "scene",
  "scene",
  "scene",
  "detail",
  "detail",
  "detail",
  "size",
  "size"
];
const manifestSchema = JSON.parse(await readFile(
  new URL("../../schemas/manifest.schema.json", import.meta.url),
  "utf8"
));
const validateManifest = new Ajv2020().compile(manifestSchema);

function requiredObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeCopy(outputDir, copy) {
  requiredObject(copy, "copy");
  await mkdir(outputDir, {recursive: true});
  if (typeof copy.desc === "string") {
    await writeFile(join(outputDir, "desc.txt"), copy.desc, "utf8");
  }
  if (Array.isArray(copy.bullets)) {
    await writeJson(join(outputDir, "bullets.json"), copy.bullets);
  }
  if (Array.isArray(copy.keywords)) {
    await writeJson(join(outputDir, "keywords.json"), copy.keywords);
  }
  for (const [name, value] of Object.entries(copy)) {
    if (["desc", "bullets", "keywords"].includes(name)) continue;
    if (!/^[\w.-]+\.[\w]+$/.test(name) || typeof value !== "string") {
      throw new TypeError("additional copy entries must be named text files");
    }
    await writeFile(join(outputDir, name), value, "utf8");
  }
}

export async function buildMaster({
  outputDir,
  product,
  titleTokens,
  copy,
  attributes,
  complianceReport,
  snapshotId,
  imageChannel,
  storageChannel,
  cropSafety
} = {}) {
  if (typeof outputDir !== "string" || outputDir.length === 0) {
    throw new TypeError("outputDir is required");
  }
  requiredObject(product, "product");
  requiredObject(titleTokens, "titleTokens");
  requiredObject(complianceReport, "complianceReport");
  if (!Array.isArray(product.facts) || !Array.isArray(attributes)) {
    throw new TypeError("product.facts and attributes must be arrays");
  }
  if (typeof snapshotId !== "string" || snapshotId.length === 0) {
    throw new TypeError("snapshotId is required");
  }
  if (typeof imageChannel?.run !== "function" || typeof storageChannel?.run !== "function") {
    throw new TypeError("imageChannel and storageChannel must implement run()");
  }
  if (cropSafety !== undefined && (!Array.isArray(cropSafety) || cropSafety.length !== IMAGE_COUNT)) {
    throw new TypeError(`cropSafety must contain ${IMAGE_COUNT} booleans`);
  }

  let sizeCard = {ok: false, reason: "not_attempted"};
  const directories = ["images", "copy", "material", "compliance", "size", "video"];
  await Promise.all(directories.map((directory) => mkdir(join(outputDir, directory), {recursive: true})));
  await Promise.all([
    writeJson(join(outputDir, "title.tokens.json"), titleTokens),
    writeJson(join(outputDir, "compliance", "report.json"), complianceReport),
    writeJson(join(outputDir, "material", "facts.json"), {
      facts: product.facts.filter((fact) => fact.key.startsWith("material."))
    }),
    writeJson(join(outputDir, "size", "size.json"), product.size ?? {
      status: "unavailable",
      reason: "size details not provided"
    }),
    // 尺码示意图：数据驱动、可核对。没有尺码行就不出图，回执里写明原因。
    renderSizeCard({
      size: product.size,
      outFile: join(outputDir, "size", "size-card.png"),
      title: titleTokens?.product_type ? String(titleTokens.product_type).slice(0, 24) : null
    }).then((result) => {
      sizeCard = result;
    }),
    writeCopy(join(outputDir, "copy"), copy)
  ]);

  const csv = [
    "canonical_key,value,synonyms,confidence",
    ...attributes.map((row) => [row.canonical_key, row.value, row.synonyms, row.confidence].map(csvCell).join(","))
  ].join("\n");
  await writeFile(join(outputDir, "attributes.csv"), `${csv}\n`, "utf8");

  const temporaryDir = await mkdtemp(join(tmpdir(), "master-images-"));
  let generated;
  let stored;
  try {
    generated = await imageChannel.run({
      width: WIDTH,
      height: HEIGHT,
      count: IMAGE_COUNT,
      outputDir: temporaryDir,
      product,
      roles: ROLES
    });
    if (!generated?.ok || !Array.isArray(generated.files) || generated.files.length !== IMAGE_COUNT) {
      throw new Error(`image channel must return exactly ${IMAGE_COUNT} files`);
    }
    stored = await storageChannel.run({files: generated.files, outputDir: join(outputDir, "images")});
    if (!stored?.ok || !Array.isArray(stored.files) || stored.files.length !== IMAGE_COUNT) {
      throw new Error("storage channel did not preserve the master image set");
    }
  } finally {
    await rm(temporaryDir, {recursive: true, force: true});
  }

  const quality = generated.quality ?? generated.meta?.quality ?? "generated";
  const images = [];
  for (let index = 0; index < stored.files.length; index += 1) {
    const buffer = await readFile(stored.files[index]);
    const metadata = await sharp(buffer).metadata();
    if (metadata.width !== WIDTH || metadata.height !== HEIGHT || !["png", "jpeg"].includes(metadata.format)) {
      throw new Error(`master image ${index + 1} must be ${WIDTH}x${HEIGHT} PNG or JPEG`);
    }
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const name = basename(stored.files[index]);
    const expectedName = `img-${String(index + 1).padStart(2, "0")}-${sha256.slice(0, 8)}.${metadata.format === "jpeg" ? "jpg" : "png"}`;
    if (name !== expectedName) {
      throw new Error(`storage channel returned a non-content-addressed name: ${name}`);
    }
    images.push({
      file: `images/${name}`,
      width: metadata.width,
      height: metadata.height,
      sha256,
      role: ROLES[index],
      quality,
      crop_safe: cropSafety ? cropSafety[index] === true : quality === "placeholder"
    });
  }

  const manifest = {
    sku: product.sku,
    region: product.region,
    category: product.category,
    snapshot_id: snapshotId,
    product_facts: product.facts,
    images,
    compliance: "compliance/report.json",
    // 尺码示意图是唯一"数据驱动"的图形产物：能核对，才配进交付包。
    size_card: sizeCard.ok
      ? {
        status: "rendered",
        file: "size/size-card.png",
        width: sizeCard.width ?? null,
        height: sizeCard.height ?? null,
        rows: sizeCard.rows ?? null,
        reason: null,
        note: "由工单尺码表直接绘制；数字未经实测复核"
      }
      : {
        status: "skipped",
        file: null,
        width: null,
        height: null,
        rows: null,
        reason: sizeCard.reason ?? "unknown",
        note: sizeCard.detail ?? null
      },
    video: {status: "unavailable", file: null, reason: "optional video not provided"},
    variants: product.variants ?? []
  };
  if (!validateManifest(manifest)) {
    throw new Error(`invalid master manifest: ${JSON.stringify(validateManifest.errors)}`);
  }
  await writeJson(join(outputDir, "manifest.json"), manifest);

  return {
    manifest,
    outputDir,
    providers: [
      {kind: "imagegen", detail: imageChannel.meta?.name ?? "injected"},
      {kind: "storage", detail: storageChannel.meta?.name ?? "injected"}
    ],
    degradations: [
      ...(quality === "placeholder" ? [{kind: "imagegen", detail: "placeholder images"}] : []),
      {kind: "video", detail: "unavailable; optional"}
    ]
  };
}
