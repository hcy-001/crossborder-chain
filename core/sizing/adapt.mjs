/**
 * 尺码表 → 平台字段。
 *
 * 现实约束（跨境卖家的典型踩坑）：
 * 1. 各平台的尺码**不是同一张表**：有的把尺码当一个属性值（一卡一码），
 *    有的用独立的尺寸数组（一卡多码）。字段名与结构都不同；
 * 2. 各地区的尺码体系也不同：本地码与国际码不是同一套数轴；
 * 3. 本地码↔国际码的对照表属行业惯例而非官方标准 —— 拿不到就留空，
 *    用本地码冒充国际码，是"看起来填满了"的假数据。
 *
 * 因此本模块**不认识任何平台名**：平台结构由 `regions/<CC>/sizing.json` 的
 * `platform_fields[platform].shape` 声明（`attribute` / `sizes_array`），
 * 这里只按声明做通用映射。平台名与字段名一律落在配置里。
 */

import {evaluateSizeValues} from "./rules.mjs";

function normRows(size) {
  const rows = size?.rows ?? null;
  if (!rows) return [];
  if (Array.isArray(rows)) return rows.map((cells) => ({key: String(cells?.[0] ?? ""), cells: cells.map(String)}));
  return Object.entries(rows).map(([key, cells]) => ({
    key: String(key),
    cells: Array.isArray(cells) ? [String(key), ...cells.map(String)] : [String(key), String(cells)]
  }));
}

/** 该法域+平台的尺码要求摘要，供调用方（AI/人）在动手前读一遍。 */
export function describeSizeRequirements({regionSizing, platform}) {
  const fields = regionSizing?.platform_fields?.[platform];
  if (!fields) return {platform, known: false, text: `未登记 ${platform} 的尺码字段，先补 regions/<CC>/sizing.json`};
  return {
    platform,
    known: true,
    status: fields.status ?? "unverified",
    text: [
      `尺码体系：${regionSizing.system}（单位 ${regionSizing.unit}）`,
      fields.shape === "attribute"
        ? `结构：属性值 · 主字段 ${fields.size_attribute}`
        : `结构：${fields.sizes_table ?? "sizes[]"} · ${fields.tech_size_field}${fields.wb_size_field ? ` / ${fields.wb_size_field}` : ""}`,
      fields.note ?? null
    ].filter(Boolean).join(" · ")
  };
}

export function adaptSizeToPlatform({size, regionSizing, platform, fieldConfirmation = null}) {
  const rows = normRows(size);
  const fields = regionSizing?.platform_fields?.[platform] ?? null;
  const unverified = [];
  const notes = [];

  if (rows.length === 0) {
    return {platform, status: "blocked", missing: ["size_rows"], payload: null, unverified, notes: ["尺码表没有数据行，不能映射"]};
  }
  if (!fields) {
    return {platform, status: "blocked", missing: ["platform_size_fields"], payload: null, unverified, notes: [`未登记 ${platform} 的尺码字段`]};
  }
  const confirmation = fieldConfirmation ?? regionSizing?.confirmation?.status ?? "pending_seller";
  // 三种"已确认"：卖家手填、API 实测、配置本身标 final
  const confirmedBySeller = ["confirmed_by_seller", "confirmed_api"].includes(confirmation)
    || (fields.status ?? "") === "confirmed_api";
  if ((fields.status ?? "unverified") !== "final" && !confirmedBySeller) {
    unverified.push(`platform_fields.${platform}.status=${fields.status ?? "unverified"}`);
  }
  // 字段名没被卖家确认过：映射照做，但结论里必须留一个要人核一眼的钩子。
  const needsFieldConfirmation = !confirmedBySeller;

  const sizeValues = rows.map((row) => row.key);
  const intMap = regionSizing?.chart?.int_equivalence ?? null;
  let international = null;
  if (intMap) {
    international = sizeValues.map((value) => ({size: value, international: intMap[value] ?? null}));
    if (international.some((item) => item.international === null)) {
      notes.push("部分本地码在本法域的对照表里没有对应项，已留空");
    }
  } else {
    unverified.push("chart.int_equivalence=null（未取到官方对照表，不生成国际码）");
  }

  if (fields.shape === "attribute") {
    // 实测语义：本地尺码可能是"集合型"属性 —— 一个商品卡上可填多个码，用分隔符串起来
    // （实测的属性描述原文：42–44 写成 "42;44"，卡片按区间展示）。
    // 但「能串起来」不等于「随便串」：连续 4 个及以上要折叠成"通用"，成码有步长与区间。
    // 规则来自 regions/<CC>/sizing.json 的 size_value_rules，本层不内置任何平台口径。
    const separator = fields.multi_size_separator ?? null;
    const sizeRules = regionSizing?.size_value_rules ?? null;
    const evaluated = evaluateSizeValues(sizeValues, sizeRules);
    if (evaluated.violations.length > 0) {
      notes.push(...evaluated.violations.map((item) => `尺码值不合规：${item.detail}`));
    }
    notes.push(...evaluated.applied, ...evaluated.actions);
    const attributeValue = evaluated.value;
    const valueUndecided = evaluated.values.length > 0 && attributeValue === null;
    const internationalSupported = Boolean(fields.international_attribute);
    if (!internationalSupported && fields.international_note) {
      notes.push(String(fields.international_note));
    }
    const sizeTable = fields.size_table_attribute ?? null;
    if (sizeTable) {
      notes.push(`尺码表走独立属性 #${sizeTable.id}「${sizeTable.name}」（${sizeTable.type ?? "String"}，JSON 字符串）`);
    }
    return {
      platform,
      status: valueUndecided
        ? "needs_manual_pick"
        : evaluated.violations.length > 0
          ? "invalid_value"
          : internationalSupported ? (international ? "ready" : "partial") : "ready",
      missing: valueUndecided
        ? ["size_value_decision"]
        : internationalSupported && !international ? ["international_equivalence"] : [],
      payload: {
        attribute_name: fields.size_attribute,
        attribute_id: fields.size_attribute_id ?? null,
        attribute_value: attributeValue,
        attribute_sizes: sizeValues,
        size_value_check: {
          status: evaluated.status,
          applied: evaluated.applied,
          violations: evaluated.violations,
          actions: evaluated.actions
        },
        multi_size_separator: separator,
        international_attribute: internationalSupported ? fields.international_attribute : null,
        international: internationalSupported ? international : null,
        size_table_attribute: sizeTable
      },
      needs_field_confirmation: needsFieldConfirmation,
      variant_strategy: separator
        ? {mode: "multi_size_in_one_attribute", note: `集合型属性：多码用「${separator}」串在同一字段，单卡可覆盖多码`}
        : {mode: "one_value_per_attribute", note: "单值属性：一个商品卡一个尺码值，多码需多 SKU"},
      unverified,
      notes: [...notes, sizeTable ? "尺码表与尺码值是两类字段，别把表格塞进尺码值" : "属性型平台：按属性字典填值"]
    };
  }

  if (fields.shape === "variation") {
    // 变体型平台：尺码不是一个"属性值"，而是变体维度上的一个选项。
    // 与数组型的区别：数组型一次提交多码到同一字段；变体型要逐个选项 + 各自的价格库存。
    const variationName = fields.variation_name ?? "Size";
    return {
      platform,
      status: "ready",
      missing: [],
      payload: {
        variation_name: variationName,
        options: sizeValues,
        option_count: sizeValues.length,
        size_chart_required: fields.size_chart_required ?? null,
        size_table_attribute: null
      },
      needs_field_confirmation: needsFieldConfirmation,
      variant_strategy: {
        mode: "variation_options",
        note: `变体维度「${variationName}」下逐个建选项；颜色是另一个维度，两个维度组合会乘出 SKU 数`
      },
      unverified,
      notes: [...notes, `变体型平台：尺码是「${variationName}」的选项，不是一个属性里的分号串`]
    };
  }

  if (fields.shape === "sizes_array") {
    const nativeSizeKnown = Boolean(regionSizing?.chart?.native_size_equivalence);
    if (!nativeSizeKnown) {
      unverified.push("chart.native_size_equivalence 未登记（平台自有尺码码表留空，不用本地码冒充）");
    }
    return {
      platform,
      status: "partial",
      missing: nativeSizeKnown ? [] : ["native_size_equivalence"],
      payload: {
        sizes: sizeValues.map((value) => ({
          [fields.tech_size_field ?? "techSize"]: value,
          ...(fields.wb_size_field ? {[fields.wb_size_field]: null} : {})
        }))
      },
      needs_field_confirmation: needsFieldConfirmation,
      variant_strategy: {mode: "single_card_multi_size", note: "数组型平台一卡多码；拆卡会拆散评论与销量历史"},
      unverified,
      notes: [...notes, "数组型平台：尺码是独立数组；平台自有码需码表，未取到即 null"]
    };
  }

  return {platform, status: "blocked", missing: ["unknown_shape"], payload: null, unverified, notes: [`${platform} 声明的 shape=${fields.shape} 未实现`]};
}
