/**
 * 文案写作：把「谁买、在哪个市场、平台有什么长度规矩」变成一份可执行的写作任务。
 *
 * 为什么不让模板填槽：平台上的女装文案不是"把属性拼成句子"。
 * 同一个款，莫斯科 20–28 岁通勤人群和 35+ 家庭主妇人群，卖点排序、句长、语气完全不同；
 * 平台对标题长度的容忍度也不同。所以这里只做三件事：
 *   1. 组装写作任务（市场 / 人群 / 商品事实 / 长度与禁忌）；
 *   2. 校验模型产出（结构、长度、禁用表达）；
 *   3. 把"规矩来源"标清楚 —— 哪条是官方口径，哪条是经验假设。
 *
 * 不做：不写死模板句、不给"最优长度"的假数字（未查证就标未查证）。
 */

/** 平台文案规矩：能查到的写来源，查不到的写未查证，不编数字。 */
export function copyRulesFor({platformSpec, platformId}) {
  const title = platformSpec?.facts?.find?.((fact) => fact.key?.endsWith("title.max_chars")) ?? null;
  const value = title?.value ?? null;
  const status = title?.status ?? "unverified";
  return {
    platform: platformId,
    title: {
      max_chars: typeof value === "number" ? value : null,
      rule_status: status,
      note:
        status === "final"
          ? "官方口径"
          : "未定稿：按后台输入框提示为准，生成时留 10% 余量，不硬截断到数字"
    },
    description: {
      max_chars: null,
      rule_status: "unverified",
      note: "平台未给统一字符上限：按后台提示为准；写作时控制在一屏内可读完（约 600–900 字符）"
    },
    banned: [
      "医疗/功效宣称（治疗、消炎、瘦身等）",
      "绝对化用语（最好、第一、100%）",
      "他人品牌名（除自有品牌）",
      "与实物不符的材质或产地"
    ]
  };
}

/**
 * 组装写作任务。输出是给模型看的结构化指令，不是散文。
 * 每个字段都来自上游判别或用户答复，缺就写 unknown —— 不猜。
 */
export function planCopy({region, persona = null, product = {}, marketProfile = null, platformSpec = null, platformId = null, locale = null}) {
  const rules = copyRulesFor({platformSpec, platformId});
  // locale / platformId 由调用方给（core 不认识具体平台与地区）
  const audience = persona?.audience ?? persona?.segment ?? null;
  const buyingHabits = marketProfile?.shopping_habits ?? marketProfile?.notes ?? null;
  const priceBand = marketProfile?.price_band ?? null;

  return {
    market: {
      region: region?.id ?? region ?? null,
      locale,
      currency: region?.currency ?? null,
      note: "文案用目标市场母语写，不要中英混排；尺码与度量用公制"
    },
    audience: {
      segment: audience,
      buying_habits: buyingHabits,
      price_band: priceBand,
      note: audience
        ? "卖点排序按这个人群的关注点来：先说他们最在意的，再说工艺与细节"
        : "人群未定：按该市场主流女装人群写，并把这一点标为假设"
    },
    product: {
      category: product.category ?? null,
      subject: product.subject ?? product.title ?? null,
      material: product.material ?? null,
      colour: product.colour ?? null,
      sizes: product.sizes ?? null,
      note: "只写事实；没有的字段不要编，宁可不提"
    },
    structure: {
      title: "核心关键词 + 关键属性 + 品牌（无品牌写无品牌），不用堆砌形容词",
      bullets: "3–5 条，每条一个卖点，先说场景后说工艺",
      description: "先一句话定位人群与场景，再展开材质/版型/尺码建议，最后写保养与注意事项",
      keywords: "8–15 个，含同义词与场景词，不与标题重复堆砌"
    },
    limits: rules,
    output_schema: {
      title: "string",
      bullets: "string[]（3–5）",
      description: "string",
      keywords: "string[]（8–15）",
      notes: "string —— 你做了哪些假设，用一句话说明"
    }
  };
}

/** 校验模型产出：结构对不对、长度超没超、有没有踩禁用表达。 */
export function validateCopy(copy, rules) {
  const problems = [];
  if (!copy || typeof copy !== "object") return {ok: false, problems: ["产出不是对象"]};

  if (typeof copy.title !== "string" || copy.title.trim().length === 0) problems.push("缺标题");
  if (!Array.isArray(copy.bullets) || copy.bullets.length < 3 || copy.bullets.length > 5) {
    problems.push(`卖点应为 3–5 条，实际 ${Array.isArray(copy.bullets) ? copy.bullets.length : 0}`);
  }
  if (typeof copy.description !== "string" || copy.description.trim().length < 80) {
    problems.push("描述太短（<80 字符），像是没写完");
  }
  if (!Array.isArray(copy.keywords) || copy.keywords.length < 8) {
    problems.push(`关键词应 ≥8 个，实际 ${Array.isArray(copy.keywords) ? copy.keywords.length : 0}`);
  }

  const titleMax = rules?.title?.max_chars ?? null;
  const titleLen = typeof copy.title === "string" ? copy.title.length : 0;
  if (titleMax && titleLen > titleMax) problems.push(`标题 ${titleLen} 字符，超过平台上限 ${titleMax}`);
  // 规则未定稿时不做硬判定，但把风险写出来（不假装合规）
  const titleWarn = titleMax && rules?.title?.rule_status !== "final" && titleLen > titleMax * 0.9
    ? `标题已用掉 ${Math.round((titleLen / titleMax) * 100)}% 上限，但该上限未定稿`
    : null;

  const text = [copy.title, copy.description, ...(copy.bullets ?? []), ...(copy.keywords ?? [])].join(" ");
  const bannedHits = (rules?.banned ?? []).filter((rule) => {
    if (rule.includes("医疗")) return /治疗|消炎|瘦身|疗效/.test(text);
    if (rule.includes("绝对化")) return /最好|第一|100%|最便宜/.test(text);
    return false;
  });
  if (bannedHits.length > 0) problems.push(`踩到禁用表达：${bannedHits.join("；")}`);

  return {ok: problems.length === 0, problems, title_len: titleLen, title_max: titleMax, warn: titleWarn};
}
