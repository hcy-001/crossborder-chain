import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import sharp from "sharp";
import {resolveSupplier} from "../../core/sourcing/match.mjs";
import {planModeling} from "../../core/modeling/plan.mjs";
import {buildListingInput} from "../../core/listing/build.mjs";
import {
  briefFrom,
  computePricing,
  chainDegradations,
  judgeEvidenceLevels,
  persistModelingPlan,
  probeReferences,
  rankCandidates,
  runModeling,
  ticketAttributes,
  ticketSignals
} from "../../scripts/lib/chain-stages.mjs";
import {asciiSlug} from "../../scripts/lib/slug.mjs";

const ticket = {
  kind: "sourcing_ticket",
  slug: "kardigan-udlinennyi-zhenskii",
  keyword: "кардиган удлиненный женский",
  merge_attribute: "kardigan-udlinennyi-zhenskii",
  cn_title: "韩版中长款针织毛衣外套女",
  trend_score: 100,
  signal_date: "2026-09-27",
  offer_url: "https://detail.1688.com/offer/731640136874.html",
  price_cny: 67,
  weight_g: 500,
  composition: "Полиэстер 80%, эластан 20%",
  listed_hits: 6,
  signals: {"S2-场景需求": 26, "S7-互动量": 10},
  design_elements: [{word: "вязан", dim: "面料"}]
};

test("工单信号只做搬运：topic/提及量与时间戳来源清晰", () => {
  const {signals, supply} = ticketSignals([ticket]);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].topic, ticket.merge_attribute);
  assert.equal(signals[0].mentions, 100);
  assert.equal(signals[0].fetched_at, "2026-09-27T00:00:00.000Z");
  assert.equal(supply[0].price_cny, 67);
});

test("排序逐字节可复现：同输入两次结果完全相同", () => {
  const a = rankCandidates({tickets: [ticket, {...ticket, slug: "b", merge_attribute: "b", trend_score: 40}]});
  const b = rankCandidates({tickets: [ticket, {...ticket, slug: "b", merge_attribute: "b", trend_score: 40}]});
  assert.deepEqual(JSON.parse(JSON.stringify(a.candidates)), JSON.parse(JSON.stringify(b.candidates)));
  assert.equal(a.score.input_sha256, b.score.input_sha256);
  assert.equal(a.candidates[0].score >= a.candidates[1].score, true);
});

test("SKU 可读：西里尔标题转成能被人翻出来的 ASCII 名", () => {
  assert.equal(asciiSlug("кардиган удлиненный"), "kardigan-udlinennyi");
  assert.equal(asciiSlug("  Юбка-плиссе  "), "iubka-plisse");
});

test("brief 只写画面里看得见的东西：不出现光比与色温数值", () => {
  const shootPlan = {
    value: {
      location: {family: "studio", light_source: "north_window", depth_m: 6, ceiling_m: 3.2, interactives: []},
      shots: [{slot: "scene", framing: "three_quarter", lens: "50mm", action: "walk"}],
      rationale: "x",
      confidence: "medium"
    }
  };
  const brief = briefFrom({shootPlan, marketProfile: {value: {age_band: "20-28", hair: "brown", complexion: "fair", palette: ["cream"]}}, slot: "scene"});
  const text = Object.values(brief).filter(Boolean).join(" ");
  assert.match(text, /north wall/);
  assert.doesNotMatch(text, /\d+:\d+/);
  assert.doesNotMatch(text, /\d{4}K/);
  assert.match(text, /three-quarter/);
});

test("brief 在没有拍摄计划时返回 null，而不是编一段默认布光", () => {
  assert.equal(briefFrom({shootPlan: null, marketProfile: null, slot: "scene"}), null);
});

test("货源事实：有链接的标价算 reported，缺成本时不编估算", () => {
  const supplier = resolveSupplier({
    offers: [{ref: "ref-01", price_cny: 67, weight_g: 500, url: ticket.offer_url, fetched_at: "2026-09-27T00:00:00.000Z"}],
    decision: {picks: [{ref: "ref-01", role: "hero", why: "工单已锁定"}], rejected: []},
    sku: "s1"
  });
  assert.equal(supplier.status, "complete");
  const cost = supplier.facts.find((fact) => fact.key === "cost");
  assert.equal(cost.source_kind, "reported");
  assert.equal(supplier.pricing_facts.length, 2);
  assert.match(supplier.pricing_facts[0].source_url, /^https:\/\//);
});

test("匹配不到主供就不产出成本事实：宁可定价不可用，也不拿近似款顶替", () => {
  const supplier = resolveSupplier({offers: [], decision: null, sku: "s1"});
  assert.equal(supplier.status, "unavailable");
  assert.equal(supplier.facts.length, 0);
});

test("建模计划只改材质色，不动几何", () => {
  const basePreset = {
    meta: {name: "base"},
    site: {w: 6},
    materials: {paint: {color: "#000000"}, oak: {color: "#111111"}},
    groups: {a: {}, b: {}}
  };
  const plan = planModeling({sku: "s1", category: "女装", palette: ["cream", "camel"], basePreset});
  assert.equal(plan.design.materials.paint.color, "#efe7d8");
  assert.equal(plan.design.materials.oak.color, "#b98f63");
  assert.equal(plan.design.site.w, 6);
  assert.equal(Object.keys(plan.design.groups).length, 2);
  assert.equal(plan.kind, "exhibit_render");
});

test("参考图几何探测：小图被标低清，无视觉通道时明确记 vision=false", async () => {
  const dir = await mkdtemp(join(tmpdir(), "refs-"));
  try {
    const path = join(dir, "tiny.png");
    await sharp({create: {width: 320, height: 480, channels: 3, background: "#cccccc"}}).png().toFile(path);
    const refs = await probeReferences([path]);
    assert.equal(refs.length, 1);
    assert.equal(refs[0].probe.vision, false);
    assert.ok(refs[0].probe.flags.includes("low_resolution"));
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test("视觉通道可用时把画面判定并进 flags", async () => {
  const dir = await mkdtemp(join(tmpdir(), "refs2-"));
  try {
    const path = join(dir, "shot.png");
    await sharp({create: {width: 900, height: 1200, channels: 3, background: "#ffffff"}}).png().toFile(path);
    const refs = await probeReferences([path], {
      vision: async () => ({
        ok: true,
        value: {subjects: 2, selfie: true, handheld: true, second_person: true, plain_background: false, garment: "x"}
      })
    });
    assert.equal(refs[0].probe.vision, true);
    for (const flag of ["selfie", "handheld", "multi_subject", "busy_background"]) {
      assert.ok(refs[0].probe.flags.includes(flag), flag);
    }
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test("建模执行：exit 3 记为 qa_failed 而不是静默成功", async () => {
  const failed = await runModeling({
    modelingRoot: "/tmp",
    designPath: "/tmp/x.json",
    outDir: "/tmp/out",
    dry: false,
    runner: async () => {
      const error = new Error("qa failed");
      error.code = 3;
      throw error;
    }
  });
  assert.equal(failed.status, "qa_failed");
});

test("上品输入：缺文案时标 copy unavailable，不填空串冒充成品", () => {
  const {input, meta} = buildListingInput({
    sku: "s1",
    destination: "RU",
    category: "女装",
    productFacts: [{key: "material.composition", value: "хлопок", unit: null, source_kind: "reported", basis: "货源页", confidence: "medium"}],
    attributes: [],
    copyPitch: null,
    platforms: ["p1"]
  });
  assert.equal(meta.copy_status, "unavailable");
  assert.equal(input.copy.desc, "");
  assert.equal(input.facts.length, 1);
  assert.equal(meta.estimated_facts.length, 0);
});

test("建模计划落盘产出 design.json 与 plan.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-"));
  try {
    const plan = planModeling({
      sku: "s1",
      category: "女装",
      palette: ["cream"],
      basePreset: {meta: {name: "b"}, site: {}, materials: {paint: {color: "#000"}}, groups: {}},
      slots: ["hero"]
    });
    const persisted = await persistModelingPlan({root: dir, plan});
    assert.equal(persisted.designPath, join(dir, "assets", "3d", "s1", "design.json"));
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test("工单属性：商品身份进得了上品输入，值保持源语言原样", () => {
  const rows = ticketAttributes({
    brand: "无品牌",
    cn_title: "韩版中长款针织毛衣外套女",
    composition: "Полиэстер 80%, эластан 20%",
    gender: "Женский",
    specs: [{color: "хаки", color_name: "Khaki"}]
  });
  const byKey = Object.fromEntries(rows.map((row) => [row.canonical_key, row.value]));
  assert.equal(byKey.brand, "NO BRAND");
  assert.equal(byKey.product_type, "韩版中长款针织毛衣外套女");
  assert.equal(byKey.color, "хаки");
  assert.equal(byKey.material, "Полиэстер 80%, эластан 20%");
  assert.equal(byKey.audience, "Женский");
  // 规范化字典只有七个键，不认识的键不许自己造
  for (const row of rows) {
    assert.ok(["brand", "product_type", "color", "size", "material", "audience", "merge_card"].includes(row.canonical_key));
  }
});

test("工单属性：没有的字段就留空，不拿品类词凑数", () => {
  assert.deepEqual(ticketAttributes({}), []);
  const rows = ticketAttributes({cn_title: "针织开衫"});
  assert.deepEqual(rows.map((row) => row.canonical_key), ["product_type"]);
});

test("工单属性：merge_card 取工单唯一货号（官方口径：不合并就填唯一值）", () => {
  const rows = ticketAttributes({cn_title: "针织开衫", slug: "kardigan-01cfdb"});
  const merge = rows.find((row) => row.canonical_key === "merge_card");
  assert.equal(merge?.value, "kardigan-01cfdb");
  assert.equal(merge?.confidence, "high");
  // 没有 slug 就退回 name，两者都没有就缺席，不编货号
  const fallback = ticketAttributes({cn_title: "针织开衫", name: "kardigan-fallback"});
  assert.equal(fallback.find((row) => row.canonical_key === "merge_card")?.value, "kardigan-fallback");
  assert.deepEqual(ticketAttributes({cn_title: "针织开衫"}).filter((row) => row.canonical_key === "merge_card"), []);
});

test("降级从台账读：判别全回退时不许报「降级：无」", () => {
  const degradations = chainDegradations({
    doctor: {ok: true},
    llmSelection: {degraded: false, detail: "http-openai-compat:doubao"},
    imageSelection: {degraded: false, detail: "http-openai-compat:seedream"},
    tickets: {missing_dirs: []},
    modeling: null,
    judges: {
      total: 6,
      by_source: {fallback: 6},
      rejected: [{reason: "channel_not_configured"}, {reason: "channel_not_configured"}]
    }
  });
  const llm = degradations.find((item) => item.kind === "llm");
  assert.ok(llm, "全部回退必须有降级条目");
  assert.match(llm.detail, /6\/6/);
  assert.match(llm.detail, /channel_not_configured/);
});

test("判别全过时不该凭空造降级", () => {
  const degradations = chainDegradations({
    doctor: {ok: true},
    llmSelection: {degraded: false, detail: "http-openai-compat:doubao"},
    imageSelection: {degraded: false, detail: "http-openai-compat:seedream"},
    tickets: {missing_dirs: []},
    modeling: {status: "rendered", detail: "ok"},
    judges: {total: 6, by_source: {llm: 6}, rejected: []}
  });
  assert.deepEqual(degradations, []);
});

test("证据等级按实际调用算：0 次模型返回不许写 L2", () => {
  const allFallback = judgeEvidenceLevels({judges: {total: 6, by_source: {fallback: 6}}, imageCount: 9});
  assert.match(allFallback.llm, /^L1/);
  assert.match(allFallback.images, /^L2/);
  const mixed = judgeEvidenceLevels({judges: {total: 6, by_source: {llm: 4, fallback: 2}}, imageCount: 9});
  assert.match(mixed.llm, /L2 部分（4\/6/);
  const allLlm = judgeEvidenceLevels({judges: {total: 6, by_source: {llm: 6}}, imageCount: 9});
  assert.match(allLlm.llm, /^L2/);
  assert.match(judgeEvidenceLevels({judges: {total: 0, by_source: {}}, imageStubbed: true}).images, /占位图/);
  assert.match(judgeEvidenceLevels({judges: {total: 2, by_source: {llm: 2}}, imageCount: 0}).images, /^L0/);
  // 通道降级时，即便有 llm 记录也不能算 L2
  assert.match(judgeEvidenceLevels({judges: {total: 2, by_source: {llm: 2}}, channelDegraded: true}).llm, /^L1/);
});

test("建模计划必须自报「商品本体在不在场景里」", () => {
  const base = {meta: {name: "zoomcare-pillbox"}, site: {}, materials: {paint: {color: "#000"}}, groups: {}};
  const exhibit = planModeling({sku: "s1", category: "女装", palette: ["beige"], basePreset: base});
  assert.equal(exhibit.kind, "exhibit_render");
  assert.equal(exhibit.product_in_scene, false);
  assert.match(exhibit.scene_note, /商品本体不在场景内/);
  assert.match(exhibit.scene_note, /zoomcare-pillbox/);

  const asset = planModeling({sku: "s1", category: "女装", palette: [], basePreset: base, wantProductAsset: true});
  assert.equal(asset.kind, "product_3d");
  assert.equal(asset.product_in_scene, true);
});

test("定价：缺运费/佣金/税/手续费时不出价，并逐项点名", () => {
  const ticket = {price_cny: 67, weight_g: 280};
  const region = {currency: "RUB"};
  const costPolicy = {required_components: ["shipping", "commission", "tax", "payment_fee"]};
  const fxFacts = [
    {key: "fx.USD_CNY", value: 6.6664},
    {key: "fx.USD_RUB", value: 80.8664}
  ];

  const missing = computePricing({ticket, region, costPolicy, fxFacts});
  assert.equal(missing.status, "unavailable");
  for (const reason of ["shipping_missing", "commission_missing", "tax_missing", "payment_fee_missing"]) {
    assert.ok(missing.reasons.includes(reason), `应点名 ${reason}`);
  }
});

test("定价：四项齐了才出价，汇率走 USD 交叉且算得出来", () => {
  const result = computePricing({
    ticket: {price_cny: 67, weight_g: 280},
    region: {currency: "RUB"},
    costPolicy: {required_components: ["shipping", "commission", "tax", "payment_fee"]},
    intakeAnswers: {
      international_shipping_fee_cny: 33,
      platform_commission_rate: 0.18,
      vat_rate: 0.06,
      payment_fee_rate: 0.02
    },
    fxFacts: [
      {key: "fx.USD_CNY", value: 6.6664},
      {key: "fx.USD_RUB", value: 80.8664}
    ]
  });
  assert.equal(result.status, "available");
  assert.ok(result.total > 0);
  assert.ok(result.total_cny >= 100);
  // 新口径：平台费按售价抽成，明细必须自洽（固定+佣金+税+手续费+利润 = 售价）
  const entry = result.breakdown_cny;
  assert.equal(entry.fixed_cny, 100, "固定成本 = 采购 67 + 运费 33");
  const sum = entry.fixed_cny + entry.commission_cny + entry.tax_cny + entry.payment_fee_cny + entry.profit_cny;
  assert.ok(Math.abs(sum - entry.price_cny) <= 0.02, `明细必须自洽：${sum} vs ${entry.price_cny}`);
  assert.equal(entry.profit_rate, 0, "不给目标毛利时算的是保本价，利润为 0");
  assert.equal(result.pricing_model, "price_from_rates");
  assert.ok(Math.abs(result.fx.target_per_cny - 80.8664 / 6.6664) < 1e-6);
});

test("定价：汇率缺失同样不出价，不拿 1:1 顶上", () => {
  const result = computePricing({
    ticket: {price_cny: 67, weight_g: 280},
    region: {currency: "RUB"},
    costPolicy: {required_components: ["shipping"]},
    intakeAnswers: {international_shipping_fee_cny: 30},
    fxFacts: []
  });
  assert.equal(result.status, "unavailable");
  assert.ok(result.reasons.includes("fx_missing"));
});

test("定价：目标毛利 30% 时，毛利率精确等于 30%（按售价口径）", () => {
  const result = computePricing({
    ticket: {price_cny: 67, weight_g: 280},
    region: {currency: "RUB"},
    costPolicy: {required_components: ["shipping", "commission", "tax", "payment_fee"]},
    intakeAnswers: {
      international_shipping_fee_cny: 33,
      platform_commission_rate: "18%",
      vat_rate: "6%",
      payment_fee_rate: "2%",
      target_margin_rate: "30%"
    },
    fxFacts: [
      {key: "fx.USD_CNY", value: 6.6664},
      {key: "fx.USD_RUB", value: 80.8664}
    ]
  });
  assert.equal(result.status, "available");
  // 分母法：100 / (1 - 0.18 - 0.06 - 0.02 - 0.30) = 227.27 CNY
  assert.ok(Math.abs(result.target.breakdown.price_cny - 227.27) < 0.02, `售价应为 227.27，实际 ${result.target.breakdown.price_cny}`);
  const entry = result.target.breakdown;
  assert.equal(entry.profit_rate, 0.3, "毛利率必须精确落在 30%");
  const sum = entry.fixed_cny + entry.commission_cny + entry.tax_cny + entry.payment_fee_cny + entry.profit_cny;
  assert.ok(Math.abs(sum - entry.price_cny) <= 0.03, `明细必须自洽：${sum} vs ${entry.price_cny}`);
  // 佣金必须按售价抽，而不是按成本：227.27 × 18% ≈ 40.91
  assert.ok(Math.abs(entry.commission_cny - 40.91) < 0.05);
});

test("定价：费率+毛利达到 100% 时明确报不可行，不给一个假价", () => {
  const result = computePricing({
    ticket: {price_cny: 67, weight_g: 280},
    region: {currency: "RUB"},
    costPolicy: {required_components: ["shipping", "commission", "tax", "payment_fee"]},
    intakeAnswers: {
      international_shipping_fee_cny: 33,
      platform_commission_rate: "60%",
      vat_rate: "10%",
      payment_fee_rate: "2%",
      target_margin_rate: "30%"
    },
    fxFacts: [{key: "fx.USD_CNY", value: 6.6664}, {key: "fx.USD_RUB", value: 80.8664}]
  });
  assert.equal(result.status, "available");
  assert.equal(result.target.price, null);
  assert.equal(result.target.reason, "margin_unreachable");
});
