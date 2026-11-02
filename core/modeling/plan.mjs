/**
 * 建模任务的计划层。
 *
 * 立场：建模不是「再调一次图」，它是**另一条独立产线**，与生图共享同一份上游事实
 * （市场画像的配色、商品的材质），但不共享失败 —— 生图挂了，建模照样能出；
 * 建模环境没装，生图也不该等。
 *
 * 所以这一层只产出一张「任务单」，不执行。执行在编排层，两条产线并行。
 */

const PALETTE_HEX = {
  cream: "#efe7d8",
  sand: "#d9c7a7",
  "soft white": "#f7f5f1",
  "light grey": "#d6d6d3",
  camel: "#b98f63",
  charcoal: "#3a3a3c",
  black: "#1c1c1e",
  white: "#fbfbf9",
  grey: "#9a9a97",
  beige: "#e3d9c6",
  navy: "#26303f",
  brown: "#5a4132"
};

function hexFor(name) {
  const key = String(name ?? "").trim().toLowerCase();
  // 判别层现在直接给 #RRGGBB；颜色词表只作为旧输入的兼容字典。
  if (/^#[0-9a-f]{6}$/.test(key)) return key;
  return PALETTE_HEX[key] ?? null;
}

/**
 * 把商品事实与市场配色落到展陈设计上。
 * 只改**材质色**与标识，不动几何、不动机位 —— 几何是经过校验的，改它就是重新引入风险。
 */
export function deriveExhibitDesign({basePreset, sku, palette = [], facts = {}}) {
  if (!basePreset || typeof basePreset !== "object") {
    throw new Error("deriveExhibitDesign requires a base preset object");
  }
  const design = structuredClone(basePreset);
  design.meta = {
    ...(design.meta ?? {}),
    name: `exhibit-${sku}`,
    derivedFrom: basePreset.meta?.name ?? "unknown",
    derivedBy: "core/modeling/plan.mjs",
    units: basePreset.meta?.units ?? "m"
  };

  const colors = palette.map(hexFor).filter(Boolean);
  // 分配顺序有语义：墙面（paint）是画面的主色面，先吃 palette[0]；
  // 其余材质按名字排序后顺延，保证同一输入永远得到同一套配色。
  const rank = (key) => (key === "paint" ? 0 : 1);
  const materialKeys = Object.keys(design.materials ?? {})
    .sort((left, right) => (rank(left) - rank(right)) || left.localeCompare(right));
  const assignments = [];
  materialKeys.forEach((key, index) => {
    const hex = colors[index];
    if (!hex) return;
    design.materials[key] = {...design.materials[key], color: hex};
    assignments.push({material: key, color: hex, from: palette[index]});
  });

  return {
    design,
    assignments,
    untouched: {
      site: Boolean(design.site),
      groups: Object.keys(design.groups ?? {}).length,
      note: "几何与机位沿用基准设计，未按商品改动 —— 避免把已校验的几何重新变成未校验"
    },
    evidence: {
      materials_from_facts: facts.material ?? null,
      palette_used: palette
    }
  };
}

/**
 * 产建模任务单。kind 只有两种：
 * - exhibit_render：用本地渲染管线出展陈图（不需要外部 key）
 * - product_3d：调用三维生成模型出商品资产（需要 key）
 * 选择规则是确定性的：有本地渲染就优先本地，因为它可复现、零单次成本；
 * 只有在显式要求商品级三维资产时才走外部模型。
 */
export function planModeling({
  sku,
  category,
  palette = [],
  facts = {},
  basePreset = null,
  wantProductAsset = false,
  slots = ["hero", "detail"]
}) {
  const derived = basePreset ? deriveExhibitDesign({basePreset, sku, palette, facts}) : null;
  return {
    sku,
    category,
    kind: wantProductAsset ? "product_3d" : "exhibit_render",
    reason: wantProductAsset
      ? "显式要求商品级三维资产，走外部三维生成"
      : "默认走本地渲染：可复现、零单次成本、有质检判据",
    slots,
    // 说清楚这段渲染到底证明了什么：几何来自基准展位，商品本体并不在场景里。
    // 不写这一条，回执上的「已渲染」会被读成「商品三维已出」，那是等级夸大。
    product_in_scene: wantProductAsset,
    // 对"上架材料"的贡献：展位渲染贡献为 0 —— 平台要的是商品图与尺码表，不是场景图。
    // 写进计划不是为了记账，是为了让"这段该不该留"变成可判断的问题，而不是审美问题。
    listing_contribution: wantProductAsset ? "unknown" : "none",
    scene_note: wantProductAsset
      ? "商品级三维资产由外部模型生成，不在本地渲染管线内"
      : `基准展位 ${basePreset?.meta?.name ?? "未知"} 的几何复用（含技能内置招牌文案）；材质色按市场配色写入设计文件，` +
        "但渲染场景的观感由建模技能的 scene.html 固定，色值是否参与渲染未做像素级验证；商品本体不在场景内",
    design: derived?.design ?? null,
    design_notes: derived
      ? {assignments: derived.assignments, untouched: derived.untouched, evidence: derived.evidence}
      : {assignments: [], untouched: null, evidence: {palette_used: palette}},
    output: {
      designPath: `assets/3d/${sku}/design.json`,
      manifestPath: `assets/3d/${sku}/manifest.json`,
      renderGlob: `assets/3d/${sku}/*.png`
    },
    parallel_with: "imagegen",
    sharing: {
      upstream_facts: ["market palette", "material composition"],
      not_shared: "失败与重试 —— 两条产线各自降级，不互相阻塞"
    }
  };
}
