import {createHash} from "node:crypto";
import {readFile, readdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import sharp from "sharp";
import Ajv2020 from "ajv/dist/2020.js";

const receiptSchema = JSON.parse(await readFile(
  new URL("../../schemas/receipt.schema.json", import.meta.url),
  "utf8"
));
const validateReceipt = new Ajv2020().compile(receiptSchema);
const PLACEHOLDER_NOTICE = "本包图片为占位图，仅用于验证流程，不可直接投放";

function imageNotice(imageQuality, imageProvider) {
  if (imageQuality === "placeholder") return PLACEHOLDER_NOTICE;
  if (imageQuality === "generated") {
    return `本包图片由 ${imageProvider ?? "图像模型"} 实时生成（quality=generated），未经人工审图`;
  }
  if (imageQuality === "reused") {
    return `本包图片复用自 ${imageProvider ?? "历史素材"}（quality=reused），未重新生成`;
  }
  return null;
}

export async function aHash8x8(file) {
  const {data} = await sharp(file).resize(8, 8, {fit: "fill"}).greyscale().raw().toBuffer({resolveWithObject: true});
  const average = data.reduce((sum, value) => sum + value, 0) / data.length;
  let hash = 0n;
  for (let index = 0; index < data.length; index += 1) {
    if (data[index] >= average) hash |= 1n << BigInt(index);
  }
  return hash.toString(16).padStart(16, "0");
}

function hammingDistance(left, right) {
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let distance = 0;
  while (value) {
    distance += Number(value & 1n);
    value >>= 1n;
  }
  return distance;
}

export async function assertNoDuplicateImages(files) {
  if (!Array.isArray(files)) throw new TypeError("files must be an array");
  const hashes = [];
  for (const file of files) {
    const sha256 = createHash("sha256").update(await readFile(file)).digest("hex");
    hashes.push({file, hash: await aHash8x8(file), sha256});
  }
  for (let left = 0; left < hashes.length; left += 1) {
    for (let right = left + 1; right < hashes.length; right += 1) {
      const distance = hammingDistance(hashes[left].hash, hashes[right].hash);
      if (distance === 0) {
        const error = new Error(`duplicate image aHash 8x8 (Hamming distance 0; SHA-256 evidence: ${hashes[left].sha256} / ${hashes[right].sha256}): ${hashes[left].file} == ${hashes[right].file}`);
        error.code = "DUPLICATE_IMAGE";
        throw error;
      }
    }
  }
  return hashes;
}

/** 阻断项给"怎么解"：外行看到"缺 EAC"也不知道下一步找谁。 */
function blockerFix(text) {
  if (/DataMatrix|诚信标签|маркировк/i.test(text)) return "找代运营/服务商办诚信标签（Честный знак），办完再上这一批";
  if (/EAC|сертификат|认证/i.test(text)) return "先办 EAC 认证；证书主体、标签申请主体、报关主体必须是同一家";
  if (/品牌授权/.test(text)) return "补授权书；有不了就把品牌字段改成白牌/自有，别带品牌名上架";
  if (/上架信息未收齐/.test(text)) return "跑 `node scripts/intake.mjs --list`，把缺的必答项补齐后用 --intake 重跑";
  if (/图片/.test(text)) return "按 handoff 里 images/ 的顺序重传；占位图不能投放";
  return "按上面这条找对应材料；拿不准就问平台招商经理，不要猜着提交";
}

export function renderHandoff({sku, blockers = [], extraBlockers = [], placeholder = false, projections = [], imageQuality = null, imageProvider = null, regionBrief = null} = {}) {
  const lines = [];
  const allBlockers = [...blockers, ...extraBlockers];
  // 阻断项分条列、每条带"怎么解"：塞成一行等于让人自己去拆句子。
  if (allBlockers.length > 0) {
    lines.push(`BLOCKED: 本包暂不可直接上架（${allBlockers.length} 项待解）`);
    allBlockers.forEach((item, index) => {
      const text = typeof item === "string" ? item : item.text;
      const fix = (typeof item === "string" ? null : item.fix) ?? blockerFix(text);
      lines.push(`  ${index + 1}. ${text}`);
      if (fix) lines.push(`     怎么解：${fix}`);
    });
  }
  const notice = imageNotice(placeholder ? "placeholder" : imageQuality, imageProvider);
  if (notice) lines.push(notice);
  lines.push(
    "",
    "# 人工交付说明",
    `SKU：${sku}`,
    "",
    ...(regionBrief ? [
      `## 这个市场的基本盘（${regionBrief.region}）`,
      `- ${regionBrief.summary}`,
      ...(regionBrief.climate ? [`- ${regionBrief.climate}`] : []),
      ...(regionBrief.trade ? [`- 这个品类能卖多大：${regionBrief.trade}`] : []),
      ...(regionBrief.tax ? [`- 税：${regionBrief.tax}`] : []),
      ...(regionBrief.holidays ? [`- ${regionBrief.holidays}`] : []),
      `- 数据来源：${regionBrief.sources}；明细见 \`data/specs/regions/${regionBrief.region}.json\``,
      ""
    ] : []),
    "## 开工三步（先做这三件，其余按下面的平台小节走）",
    "1. 打开 `platforms/<平台>/`，只照这个目录填，不要动 `master/`。",
    "2. 填尺码：读该平台的 `size-mapping.json` 照做；各平台结构不同（有的是集合型属性、有的是变体选项、有的要尺码表），别套用别的平台的做法。",
    "3. 再贴图片与文案：`images/` 按文件名顺序上传，`copy/` 逐字粘贴。",
    "",
    "## 文件地图",
    "| 文件 | 用途 |",
    "|---|---|",
    "| `images/` | 直接拖进商品图片位，保持文件名顺序 |",
    "| `attributes.csv` | 属性逐行填；值不要改写 |",
    "| `size-mapping.json` | 尺码怎么填（属性名、属性编号、多码分隔符、尺码表属性） |",
    "| `title.tokens.json` | 标题组件；有 `title.candidate.txt` 时作参考，需人工对照平台规则 |",
    "| `copy/` | 描述、要点、关键词 |",
    "| `validate.json` | 平台校验结果与口径分歧 |",
    "",
    "本包只用于人工提交；系统不调用上架接口、不保存商户凭证。",
    "视频：本平台可选。"
  );
  for (const projection of projections) {
    const validate = projection.validate ?? projection;
    const platform = validate.platform ?? projection.platform;
    lines.push(
      "",
      `## ${platform}`,
      "1. 打开卖家后台的商品编辑页，不上传 master/，只使用本节目录。",
      "2. 将 images/ 内图片全选拖入商品图片位，保持文件名顺序。",
      "3. 按 attributes.csv 填写字段；尺码按 size-mapping.json 填。",
      "4. 从 copy/ 逐字粘贴描述、要点与关键词，不要改写后再回传母版。",
      `5. 人工核查 validate.json；当前质量标记为 ${validate.quality}。`,
      "常见退回原因：图片尺寸或格式不符、字段漏填、尺码与外包装标注不一致、标题规则未经核实。"
    );
    if (projection.sizeMapping) {
      const mapping = projection.sizeMapping;
      const attribute = mapping.payload?.attribute_name ?? null;
      const attributeId = mapping.payload?.attribute_id ?? null;
      const separator = mapping.payload?.multi_size_separator ?? null;
      const tableAttribute = mapping.payload?.size_table_attribute ?? null;
      if (mapping.status === "blocked") {
        lines.push(`尺码：本平台暂时填不了（${(mapping.missing ?? []).join("、")}）——先补齐尺码行再重跑。`);
      } else if (attribute) {
        lines.push(
          `尺码：属性「${attribute}」${attributeId ? `（编号 ${attributeId}）` : ""}，值 = ${mapping.payload.attribute_value ?? "（空）"}`
          + `${separator ? `；多码用「${separator}」串起来` : ""}`
        );
        if (tableAttribute) {
          lines.push(`尺码表：另填属性「${tableAttribute.name}」${tableAttribute.id ? `（编号 ${tableAttribute.id}）` : ""}，内容是 JSON 字符串，不要塞进尺码值里。`);
        }
      }
      if (mapping.needs_field_confirmation) {
        lines.push("注意：本平台字段名尚未核实（公开接口被挡），填之前先在后台核对一次，或跑 `npm run sizing:confirm`。");
      }
    }
    if (projection.requiredAttributes?.items?.length) {
      const items = projection.requiredAttributes.items;
      lines.push(`平台必填项（官方口径，共 ${items.length} 项，逐项对 attributes.csv 核）：`);
      for (const item of items) {
        const dict = item.dictionary_id ? `，字典#${item.dictionary_id}` : "，自由填";
        const multi = item.is_collection ? "，可多选" : "";
        lines.push(`  - #${item.id} ${item.name}${dict}${multi}`);
      }
      lines.push("说明：上述是平台要的字段名；本包 attributes.csv 用的是内部键，两边映射尚未建立 —— 按这份清单逐项核对后再提交。");
    }
    if (validate.conflicts?.length) {
      lines.push(`口径分歧（未定稿，人工确认后再提交）：${validate.conflicts.map((item) => `${item.key}=${item.status}`).join("；")}`);
    }

    if (validate.notes) lines.push("详细口径（英文原文）见 validate.json；上表已列出需要人工确认的项。");
  }
  return `${lines.join("\n")}\n`;
}

async function imageFiles(directory) {
  return (await readdir(directory, {withFileTypes: true}))
    .filter((entry) => entry.isFile() && /\.(?:png|jpe?g)$/i.test(entry.name))
    .map((entry) => join(directory, entry.name))
    .sort();
}

export async function assemblePackage({packageDir, complianceReport, receipt, extraBlockers = [], regionBrief = null} = {}) {
  if (typeof packageDir !== "string" || !packageDir) throw new TypeError("packageDir is required");
  if (!receipt || typeof receipt !== "object") throw new TypeError("receipt is required");
  const manifest = JSON.parse(await readFile(join(packageDir, "master", "manifest.json"), "utf8"));
  if (receipt.sku !== manifest.sku) throw new Error("receipt sku does not match master manifest");

  const masterImages = await imageFiles(join(packageDir, "master", "images"));
  await assertNoDuplicateImages(masterImages);
  const platformsDir = join(packageDir, "platforms");
  const platformEntries = await readdir(platformsDir, {withFileTypes: true});
  const projections = [];
  for (const entry of platformEntries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const directory = join(platformsDir, entry.name);
    await assertNoDuplicateImages(await imageFiles(join(directory, "images")));
    // 尺码映射由链路写在平台目录里；handoff 直接读它，保证"交接说明说的"与"磁盘上有的"是同一份。
    const sizeMapping = await readFile(join(directory, "size-mapping.json"), "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => null);
    const requiredAttributes = await readFile(join(directory, "required-attributes.json"), "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => null);
    projections.push({
      platform: entry.name,
      validate: JSON.parse(await readFile(join(directory, "validate.json"), "utf8")),
      sizeMapping,
      requiredAttributes
    });
  }

  const handoff = renderHandoff({
    sku: manifest.sku,
    blockers: complianceReport?.blockers ?? [],
    extraBlockers,
    placeholder: manifest.images.some((image) => image.quality === "placeholder"),
    projections,
    imageQuality: manifest.images[0]?.quality ?? null,
    imageProvider: (receipt?.providers ?? []).find((item) => item.kind === "imagegen")?.detail ?? null,
    regionBrief
  });
  const completedReceipt = {
    ...receipt,
    gates: [
      ...(receipt.gates ?? []).filter((gate) => gate.id !== "P5-aHash-8x8"),
      {
        id: "P5-aHash-8x8",
        status: "pass",
        level: "L1",
        evidence: `master_images=${masterImages.length}; projection_sets=${projections.length}; duplicate_pairs=0`
      }
    ]
  };
  if (!validateReceipt(completedReceipt)) {
    throw new Error(`invalid receipt: ${JSON.stringify(validateReceipt.errors)}`);
  }
  await writeFile(join(packageDir, "handoff.md"), handoff, "utf8");
  await writeFile(join(packageDir, "receipt.json"), `${JSON.stringify(completedReceipt, null, 2)}\n`, "utf8");
  return {receipt: completedReceipt, handoff, projectionCount: projections.length};
}
