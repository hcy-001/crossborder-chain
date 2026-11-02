import {createHash} from "node:crypto";
import {cp, mkdir, readFile, writeFile} from "node:fs/promises";
import {basename, extname, join, relative, resolve} from "node:path";
import sharp from "sharp";
import Ajv2020 from "ajv/dist/2020.js";
import {lintTitle, titleRulesFromFacts} from "../../core/listing/title-rules.mjs";

const [validateSchema, cropSchema, cropDocumentSchema] = await Promise.all([
  readFile(new URL("../../schemas/validate.schema.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../../schemas/crop.schema.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../../schemas/crop-document.schema.json", import.meta.url), "utf8").then(JSON.parse)
]);
const ajv = new Ajv2020();
ajv.addSchema(cropSchema);
const validateDocument = ajv.compile(validateSchema);
const validateCropDocument = ajv.compile(cropDocumentSchema);
// 两种几何处理，各有各的适用场景：
// - center_crop：真的需要裁（素材图、非白底场景），但**会丢画面**；
// - contain_pad：等比缩放后补白底到目标比例，**一个像素都不丢**。
// 1:1 平台（Shopee/Lazada/TikTok）同时要求「白底」与「商品完整可见」，
// 对 3:4 服装母版做中心裁切会切掉上下各 12.5%（裙摆与领口），所以默认走补边。
const CROP_ALGORITHM = "center-crop-12.5pct-v1";
const PAD_ALGORITHM = "contain-pad-white-v1";

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell);
  return cells;
}

function factsFrom(platformSpec) {
  const facts = Array.isArray(platformSpec) ? platformSpec : platformSpec?.facts;
  if (!Array.isArray(facts)) throw new TypeError("platformSpec.facts must be an array");
  return facts;
}

function factBySuffix(facts, suffix) {
  return facts.find((fact) => fact.key?.endsWith(suffix));
}

function conflictRecords(facts) {
  const records = new Map();
  for (const fact of facts) {
    let status = null;
    if (fact.conflict_id) status = "conflicted";
    else if (["candidate", "conflicted", "unverified"].includes(fact.status)) status = fact.status;
    else if (fact.source_type === "secondary") status = "candidate";
    if (status) records.set(`${fact.key}:${status}`, {key: fact.key, status});
  }
  return [...records.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function renderTitle(tokens, template, maxChars) {
  const rendered = template.replace(/\{\{([a-z_]+)\}\}/g, (_match, key) => {
    const value = tokens[key];
    return Array.isArray(value) ? value.join(" ") : String(value ?? "");
  }).replace(/\s+/g, " ").trim();
  return Number.isInteger(maxChars) && maxChars > 0 ? rendered.slice(0, maxChars).trim() : rendered;
}

async function projectAttributes(masterDir, outputDir, facts) {
  const source = await readFile(join(masterDir, "attributes.csv"), "utf8");
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines[0]);
  const mapFact = facts.find((fact) => fact.key?.endsWith(".attribute_map") || fact.key?.endsWith(".attributes.map"));
  const mapping = mapFact?.value && typeof mapFact.value === "object" ? mapFact.value : {};
  const rows = lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
  const output = [
    "platform_key,canonical_key,value,confidence",
    ...rows.map((row) => [
      mapping[row.canonical_key] ?? row.canonical_key,
      row.canonical_key,
      row.value,
      row.confidence
    ].map(csvCell).join(","))
  ].join("\n");
  await writeFile(join(outputDir, "attributes.csv"), `${output}\n`, "utf8");
}

async function copyRatioImages(masterDir, outputDir, images) {
  const imagesDir = join(outputDir, "images");
  await mkdir(imagesDir, {recursive: true});
  for (const image of images) {
    const source = join(masterDir, image.file);
    const buffer = await readFile(source);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    if (sha256 !== image.sha256) throw new Error(`source image hash mismatch: ${image.file}`);
    await writeFile(join(imagesDir, basename(image.file)), buffer);
  }
  return {crops: []};
}

/**
 * 把 3:4 母版变成 1:1：等比缩放到画布内，四周补白。
 *
 * 为什么不是裁切：服装主图平台普遍同时要求「纯白底」和「商品完整可见」。
 * 对 900×1200 做 1:1 中心裁切要切掉上下各 150px（画面 25%），
 * 裙摆、领口、腰部细节都在那两条带上——裁完主图就废了。
 * 补白边则完整保留商品，且白底本身也满足平台的背景要求。
 */
async function fitSquareImages(masterDir, outputDir, images, side = 900) {
  const imagesDir = join(outputDir, "images");
  await mkdir(imagesDir, {recursive: true});
  const packageDir = resolve(masterDir, "..");
  const crops = [];
  for (const image of images) {
    const source = join(masterDir, image.file);
    const buffer = await readFile(source);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    if (sha256 !== image.sha256) throw new Error(`source image hash mismatch: ${image.file}`);
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height) throw new Error(`cannot read image size: ${image.file}`);
    // 等比缩放到画布内，取整后仍保持原比例（内容区不会变形）
    const scale = Math.min(side / meta.width, side / meta.height);
    const innerW = Math.max(1, Math.round(meta.width * scale));
    const innerH = Math.max(1, Math.round(meta.height * scale));
    const left = Math.floor((side - innerW) / 2);
    const top = Math.floor((side - innerH) / 2);
    const extension = extname(image.file);
    const outputName = basename(image.file, extension).concat("-1x1", extension);
    const output = join(imagesDir, outputName);
    await sharp(buffer)
      .resize(innerW, innerH, {fit: "fill"})
      .extend({
        top,
        bottom: side - innerH - top,
        left,
        right: side - innerW - left,
        background: "#FFFFFF"
      })
      .toFile(output);
    crops.push({
      src: relative(packageDir, source).replaceAll("\\", "/"),
      src_sha256: sha256,
      output: relative(packageDir, output).replaceAll("\\", "/"),
      // box 是「内容区在输出画布里的位置」，不是裁切框：补边没有丢掉任何像素
      box: [left, top, innerW, innerH],
      mode: "contain_pad",
      canvas: [side, side],
      algo_version: PAD_ALGORITHM
    });
  }
  return {crops};
}

export async function projectPlatform({masterDir, platformSpec, platformId, outputDir} = {}) {
  if (typeof masterDir !== "string" || typeof outputDir !== "string" || typeof platformId !== "string" || !platformId) {
    throw new TypeError("masterDir, platformId and outputDir are required");
  }
  const facts = factsFrom(platformSpec);
  const manifest = JSON.parse(await readFile(join(masterDir, "manifest.json"), "utf8"));
  const ratioFact = factBySuffix(facts, ".image.ratio");
  const ratio = ratioFact?.value;
  // 有的平台官方只规定最小尺寸、不规定比例（例如 Яндекс Маркет）。
  // 这种情况不该"猜一个比例去裁"，而是**保持原图不裁** —— 不裁不会违规，猜着裁会丢画面。
  const ratioPolicy = factBySuffix(facts, ".image.ratio_policy")?.value ?? null;
  const preserveSource = ratioPolicy === "preserve";
  if (!preserveSource && (!ratio || !Number.isInteger(ratio.width) || !Number.isInteger(ratio.height))) {
    // 事实不全就不许出投影：按一个猜出来的比例裁图，裁错不可逆。
    // 但要给调用方一个可识别的错误码，好让它降级并说清缺什么，而不是整条链路崩掉。
    const error = new Error(`image ratio fact is required for ${platformId}`);
    error.code = "FACTS_INCOMPLETE";
    error.platform = platformId;
    throw error;
  }

  await mkdir(outputDir, {recursive: true});
  await Promise.all([
    cp(join(masterDir, "copy"), join(outputDir, "copy"), {recursive: true}),
    cp(join(masterDir, "title.tokens.json"), join(outputDir, "title.tokens.json")),
    projectAttributes(masterDir, outputDir, facts)
  ]);

  let cropDocument;
  let imagePass;
  if (preserveSource) {
    // 平台没规定比例：原图原样搬过去，不做任何几何变换
    cropDocument = await copyRatioImages(masterDir, outputDir, manifest.images);
    imagePass = "ratio_preserve_source_copy";
  } else if (ratio.width * 4 === ratio.height * 3) {
    cropDocument = await copyRatioImages(masterDir, outputDir, manifest.images);
    imagePass = "ratio_3x4_source_copy";
  } else if (ratio.width === ratio.height) {
    // 1:1：补白边而不是裁切，商品必须完整
    const side = 900;
    cropDocument = await fitSquareImages(masterDir, outputDir, manifest.images, side);
    imagePass = "ratio_1x1_contain_pad";
  } else {
    throw new Error("unsupported projection ratio; source regeneration is forbidden");
  }
  if (!validateCropDocument(cropDocument)) {
    throw new Error(`invalid crop document: ${JSON.stringify(validateCropDocument.errors)}`);
  }
  await writeJson(join(outputDir, "crop.json"), cropDocument);

  const tokens = JSON.parse(await readFile(join(masterDir, "title.tokens.json"), "utf8"));
  const titleFacts = titleRulesFromFacts(facts);
  const templateFact = factBySuffix(facts, ".title.template");
  const maxCharsFact = factBySuffix(facts, ".title.max_chars");
  const titleTemplate = typeof templateFact?.value === "string" ? templateFact.value : null;
  let titleOutcome = {final: false, candidate: false, reason: "template_missing"};
  if (titleFacts.auto_generated?.enabled) {
    // 该品类由平台按必填特征自动生成名称，名称字段填什么都不生效。
    // 这时还产出一份"请复制粘贴"的 title.txt，是给人一个假动作；只交规则与依据。
    // 参考名只用来给人看"按公式会拼成什么样"，不参与提交；用 {{token}} 语法走同一条渲染。
    const preview = renderTitle(tokens, "{{brand}} {{product_type}} {{key_attrs}}", null);
    await writeJson(join(outputDir, "title.auto.json"), {
      status: "auto_generated_by_platform",
      platform_format: titleFacts.auto_generated.format,
      applies_to: titleFacts.auto_generated.scope_categories ?? [],
      why: titleFacts.auto_generated.why,
      reference_name_preview: preview,
      reference_lint: lintTitle(preview, titleFacts),
      what_to_do: "名称由「必填特征」拼出：改名字请改属性（类型/品牌/系列），不要改标题字符串",
      rules: {
        max_chars: titleFacts.max_chars,
        max_word_chars: titleFacts.max_word_chars,
        charset: titleFacts.charset
      },
      sources: titleFacts.sources
    });
    titleOutcome = {final: false, candidate: false, reason: "auto_generated_by_platform", auto_generated: true};
  } else if (templateFact?.status === "final" && templateFact.source_type === "official" && titleTemplate) {
    const maxChars = maxCharsFact?.status === "final" && maxCharsFact.source_type === "official" ? maxCharsFact.value : null;
    const rendered = renderTitle(tokens, titleTemplate, maxChars);
    const lint = lintTitle(rendered, titleFacts);
    await writeFile(join(outputDir, "title.txt"), `${rendered}\n`, "utf8");
    await writeJson(join(outputDir, "title.lint.json"), lint);
    titleOutcome = {final: true, candidate: false, reason: null, chars: rendered.length, length_ok: lint.ok};
  } else if (titleTemplate) {
    // 模板未经验证：**不生成 title.txt**（那是"可直接提交"的位置），
    // 但材料不能缺 —— 出一份明确标 candidate 的稿子，供人工对照平台规则复核后改名为 title.txt。
    const maxChars = Number.isInteger(maxCharsFact?.value) ? maxCharsFact.value : null;
    const renderedTitle = renderTitle(tokens, titleTemplate, maxChars);
    const lengthOk = !Number.isInteger(maxChars) || renderedTitle.length <= maxChars;
    await writeFile(join(outputDir, "title.candidate.txt"), `${renderedTitle}\n`, "utf8");
    await writeJson(join(outputDir, "title.candidate.json"), {
      status: "candidate",
      template: titleTemplate,
      template_status: templateFact?.status ?? "unknown",
      template_source_type: templateFact?.source_type ?? "unknown",
      max_chars: maxChars,
      rendered: renderTitle(tokens, titleTemplate, maxChars),
      note: "平台标题模板未经验证：本文件仅供人工复核后使用，不得直接提交；复核通过请改名为 title.txt"
    });
    titleOutcome = {final: false, candidate: true, reason: "template_not_official", chars: renderedTitle.length, length_ok: lengthOk};
  }

  const conflicts = conflictRecords(facts);
  // 1:1 走补边后不存在「这张图不能裁所以跳过」的情况，所有图都完整保留；
  // crop_safe 字段保留，但只在真要裁切（center_crop）时才具有约束力。
  const cropUnsafe = [];
  const violations = [];
  const passed = ["copy_byte_identical", "title_tokens_preserved", "attributes_mapped", imagePass];
  const maxCount = factBySuffix(facts, ".image.max_count")?.value;
  if (Number.isInteger(maxCount)) {
    if (manifest.images.length <= maxCount) passed.push("image_count");
    else violations.push({code: "image_count", detail: `${manifest.images.length} exceeds ${maxCount}`});
  }
  const maxBytes = factBySuffix(facts, ".image.max_bytes")?.value;
  if (Number.isInteger(maxBytes)) {
    for (const image of manifest.images) {
      const buffer = await readFile(join(masterDir, image.file));
      if (buffer.length > maxBytes) violations.push({code: "image_bytes", detail: `${image.file} exceeds ${maxBytes}`});
    }
    if (!violations.some((item) => item.code === "image_bytes")) passed.push("image_bytes");
  }
  const minSize = factBySuffix(facts, ".image.min_size")?.value;
  if (minSize && manifest.images.every((image) => image.width >= minSize.width && image.height >= minSize.height)) {
    passed.push("image_dimensions");
  }
  const placeholder = manifest.images.some((image) => image.quality === "placeholder");
  const notes = [
    conflicts.length ? `Non-final facts retained as conflicts: ${conflicts.map((item) => `${item.key}=${item.status}`).join(", ")}` : "All applied facts are final.",
    titleOutcome.auto_generated
      ? `Title is generated by the platform from required attributes (${titleFacts.auto_generated.format}); no title.txt was written. See title.auto.json.`
      : titleOutcome.candidate
        ? "Title template is unverified or secondary; title.txt was not generated. title.candidate.txt/.json were written for human review."
        : titleOutcome.final
          ? "Title template is final and official; title.txt was generated and linted."
          : "Title template missing; no title file was written.",
    placeholder ? "Placeholder images skip aesthetic pixel gates and are not for publishing." : "Image quality recorded from master."
  ].join("\n");
  const validate = {
    platform: platformId,
    title: titleOutcome,
    quality: placeholder ? "placeholder" : conflicts.length ? "unverified" : "validated",
    passed,
    violations,
    conflicts,
    crop_unsafe: cropUnsafe,
    notes
  };
  if (!validateDocument(validate)) {
    throw new Error(`invalid projection validation: ${JSON.stringify(validateDocument.errors)}`);
  }
  await writeJson(join(outputDir, "validate.json"), validate);
  return {platform: platformId, outputDir, validate, cropDocument};
}
