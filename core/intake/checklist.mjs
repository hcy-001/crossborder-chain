/**
 * 上架前必问清单（唯一真源）。
 *
 * 设计原则：**问法要让人答得出来**。
 * 一个第一次做跨境的人，看到「平台佣金率（小数）」会卡住；看到「佣金一般 15%–25%，写 0.18 或 18 都行，不确定写 unknown」才答得动。
 * 所以每条都带 `example`（照抄级样例）与 `unknown_ok`（不确定时怎么表态）。
 *
 * **任何必答项都可以写 `unknown`** —— 这是明确表态，不是缺答。
 * 系统会据此如实降级（不出价 / 不出尺码卡 / 标未核），而不是逼人编一个数字。
 * 编数字的代价比"缺一项"高得多：错的价格会一路算进毛利。
 *
 * 键名必须与下游（`computePricing`、尺码映射、授权门）读的键**完全一致**——
 * 问卷问 `platform_commission` 而代码读 `platform_commission_rate`，
 * 就是"填了但没生效"的事故源，所以这里用 type 把契约钉死。
 *
 * 三档：
 * - blocking：没答就不出包/不出价（可以答 unknown，但要答）
 * - confirm：必须确认一次，允许默认但要留痕
 * - defaultable：可默认，只需记录
 */
export const INTAKE_ITEMS = Object.freeze([
  {
    key: "platform",
    group: "平台",
    type: "string",
    severity: "blocking",
    question: "这批货要上哪个平台？（填平台名；两个都上的话两个都写）",
    example: "<平台名>　或　<平台名>, <平台名>（两个都上就都写）",
    why: "两个平台的尺码结构、标题规则、图片比例、变体规则都不同：同一件货不能复用一套字段。",
    consequence: "平台未知 → 尺码与标题都无法确定，只能出包不能上架。"
  },
  {
    key: "seller_account_status",
    group: "平台",
    type: "string",
    severity: "blocking",
    question: "你在平台上的账号到哪一步了？（开户未开店 / 已开店 / 还没有账号）",
    example: "已开店　或　开户未开店　或　还没有账号",
    unknown_ok: true,
    why: "这条决定后面几件事能不能做：能不能自己去后台核字段名、能不能拿到本类目的佣金率、能不能提交。没店的人不缺口径，缺的是店。",
    consequence: "答「还没有账号」→ 字段名一律保持未核，不得声称可上架；不确定就写 unknown，系统按未开店处理。"
  },
  {
    key: "platform_size_field",
    group: "平台",
    type: "string",
    severity: "blocking",
    question: "后台商品页里，尺码那一格叫什么名字？（照抄后台显示的名字；没看过就写 unknown）",
    example: "Российский размер　或　techSize　或　unknown",
    unknown_ok: true,
    why: "字段名只在后台可见（公开接口被 WAF 挡、开发者文档有反爬）。开店的人上架时天天见这个名字，所以开局就问，不留到事后补。",
    consequence: "答 unknown → 尺码映射照做但标「字段待核」，不声称可直接上架；答具体名字 → 记下并可跑 npm run sizing:confirm 落盘。"
  },
  {
    key: "size_system",
    group: "尺码",
    type: "string",
    severity: "blocking",
    question: "尺码用哪套？有没有本地码和国内码/国际码的对照表？",
    example: "俄码 42-52，无对照表　或　俄码 42-52 + 国际码 XS/M/L/XL 对照",
    unknown_ok: true,
    why: "俄码与国际码不是同一套数轴；平台只认本地码，国际码仅作对照。服装审核常见的拒因之一就是尺码标注不合本地标准。",
    consequence: "没对照表 → 只出本地码，国际码留空（不猜）。"
  },
  {
    key: "size_chart_rows",
    group: "尺码",
    type: "string",
    severity: "blocking",
    question: "尺码表的具体数字是多少？（一个码号一行，写「码号: 胸围, 衣长」；没有就写 unknown）",
    example: "48: 96-104, 72\n50: 100-108, 74",
    unknown_ok: true,
    why: "尺码图与平台属性都要用真实数字；只有码号没有数值，等于给了半张表。",
    consequence: "答 unknown 或不填 → 尺码示意图跳过，平台只能填码号、填不了尺寸。"
  },
  {
    key: "weight_g",
    group: "价格与费用",
    type: "number",
    severity: "blocking",
    question: "单件**带包装**多重？（克）",
    example: "280　（一件针织衫连袋约 250–350 克）",
    unknown_ok: true,
    why: "跨境运费按计费重（实重与体积重取大）算；只给净重会系统性低估运费。",
    consequence: "答 unknown → 价格算不出来（不拿一个估的重量顶上）。"
  },
  {
    key: "package_dimensions_cm",
    group: "价格与费用",
    type: "number[]",
    severity: "blocking",
    question: "包装尺寸是多少？（长 × 宽 × 高，厘米；三个数字）",
    example: "[30, 24, 6]　（一件衣服的袋子大约这么大）",
    unknown_ok: true,
    why: "轻的东西按体积重计费，只填实重会少算运费；体积重除数按渠道口径不同（本链路默认 6000，可改）。",
    consequence: "答 unknown → 只用实重计费，回执标「体积重未知」，价格偏低要人工复核。"
  },
  {
    key: "cost",
    group: "价格与费用",
    type: "number",
    severity: "blocking",
    question: "采购价多少？（人民币，不含运费）",
    example: "67　（1688 拿货价）",
    unknown_ok: true,
    why: "成本是定价的起点；含税与不含税差一个进项税，直接影响毛利。",
    consequence: "答 unknown → 只出包不出价。"
  },
  {
    key: "international_shipping_fee_cny",
    group: "价格与费用",
    type: "number",
    severity: "blocking",
    question: "国际段运费一件多少？（人民币；按重量分档的话，填这件的档位）",
    example: "33　（小包 300–500 克常见 25–45 元）",
    unknown_ok: true,
    why: "运费是跨境最大的一项变动成本，且随重量跳档；估错会吃掉全部毛利。",
    consequence: "答 unknown → 价格算不出来。"
  },
  {
    key: "platform_commission_rate",
    group: "价格与费用",
    type: "number",
    severity: "blocking",
    question: "这个类目的平台佣金是多少？（写百分数或小数都行）",
    example: "18%　或　0.18　（服装类常见 15%–25%）",
    unknown_ok: true,
    why: "佣金按类目阶梯，差几个百分点就是利润差；口径不同会算错净利。",
    consequence: "答 unknown → 价格算不出来（不按行业均值代替）。"
  },
  {
    key: "vat_rate",
    group: "价格与费用",
    type: "number",
    severity: "blocking",
    question: "税费按多少算？（写百分数或小数；由谁承担写清楚）",
    example: "6%　或　0.06　（不确定就写 unknown，别猜）",
    unknown_ok: true,
    why: "税负随政策变动，必须以官方口径为准；申报价与售价必须分开记。",
    consequence: "答 unknown → 价格算不出来；系统不会用印象里的税率凑数。"
  },
  {
    key: "payment_fee_rate",
    group: "价格与费用",
    type: "number",
    severity: "blocking",
    question: "回款/支付手续费多少？（写百分数或小数）",
    example: "2%　或　0.02",
    unknown_ok: true,
    why: "这项常被忽略，但按流水扣，回款周期越长影响越大。",
    consequence: "答 unknown → 价格算不出来。"
  },
  {
    key: "insurance_fee_cny",
    group: "价格与费用",
    type: "number",
    severity: "confirm",
    default: null,
    question: "有没有投保？一件保费多少？（没有就写 0）",
    example: "2.5　或　0",
    unknown_ok: true,
    why: "保险影响理赔上限；默认「没保」是最常见的隐性损失。",
    consequence: "不填 → 成本表里记「保险未知」，不按 0 计。"
  },
  {
    key: "return_policy",
    group: "履约",
    type: "string",
    severity: "blocking",
    question: "退货怎么处理？（谁承担运费、有没有本地退货地址、几天无理由）",
    example: "14 天无理由，运费我承担，本地退货地址已有",
    unknown_ok: true,
    why: "服装退货率高；退货成本与退货地址是上架前置条件，平台侧通常是必填项。",
    consequence: "答 unknown → 交接说明标「退货政策未定」，包照出但不可直接上架。"
  },
  {
    key: "certs",
    group: "合规",
    type: "string",
    severity: "blocking",
    question: "这个品类要的认证有哪些？现在有哪几份？（EAC / GOST / 质检报告）",
    example: "需要 EAC，已有 或 需要 EAC，还没有 或 unknown",
    unknown_ok: true,
    why: "缺认证会被平台审核拒，而拒因不会告诉你补什么。",
    consequence: "答 unknown → 合规清单标未核，交接说明提示先补认证再提交。"
  },
  {
    key: "brand_authorization",
    group: "合规",
    type: "string",
    severity: "blocking",
    question: "这是你自己的牌子、白牌，还是别人的牌子？（别人的话有授权书吗）",
    example: "自有品牌　或　白牌　或　代理某品牌，有授权书",
    unknown_ok: true,
    why: "没授权就上品牌款是侵权下架的高频原因，平台处罚重。",
    consequence: "答代理但没授权书 / 答 unknown → 决策封顶只能观察，交接说明标「品牌授权未证」。"
  },
  {
    key: "credentials_path",
    group: "账号与权限",
    type: "string",
    severity: "confirm",
    question: "平台凭证放在哪个文件？（.env 的绝对路径；不把密钥贴进对话）",
    example: "仓库外某个 .env 的绝对路径（不要贴密钥本身）",
    unknown_ok: true,
    default: null,
    why: "有了凭证才能把\"猜的规则\"换成\"平台自己说的\"：类目树、必填属性、字典取值、佣金、能否写入。"
      + "没有凭证时本工具只出待核包，不出可提交包。凭证一律放在仓库外，且不复制进项目。",
    consequence: "不给 → 平台事实停留在 candidate，包只能标\"待核\"；给了 → 跑一次 probe:account 就能判定能读什么、能不能发布。"
  },
  {
    key: "credentials_scope",
    group: "账号与权限",
    type: "string",
    severity: "confirm",
    question: "这把 key 的权限范围是什么？（决定是\"只做预检\"还是\"直接发布\"）",
    options: ["只读（read-only）", "读写（read-write）", "不确定，让工具探"],
    example: "读写（read-write）",
    unknown_ok: true,
    default: "不确定，让工具探",
    why: "只读 key 与读写 key 能做的事差一个数量级。选\"不确定\"时由 scripts/probe-account.mjs 用\"参数必然非法但不落地数据\"的请求探出来，不靠人猜。",
    consequence: "答只读 → 工具只产材料不提交；答读写但实际只读 → 探测会当场揭穿，不会等到提交失败才发现。"
  },
  {
    key: "publishing_mode",
    group: "账号与权限",
    type: "string",
    severity: "confirm",
    question: "出包之后怎么办：人工提交，还是让工具提交？",
    options: ["人工提交（默认，最安全）", "工具生成草稿待人工确认", "工具直接提交并回读结果"],
    example: "人工提交（默认，最安全）",
    unknown_ok: false,
    default: "人工提交（默认，最安全）",
    why: "提交是有副作用的一步：一旦上架就会有曝光与订单。默认停在\"材料齐备\"这一步，把取舍留给卖家。",
    consequence: "选直接提交 → 需要读写 key + 明确的类目与价格，且失败要能回滚（下架接口同样要权限）。"
  },
  {
    key: "color",
    group: "商品",
    type: "string",
    severity: "confirm",
    question: "商品主色是什么？（用目标市场语言写，只填一个主色）",
    example: "белый　或　чёрный　或　хаки",
    unknown_ok: true,
    default: null,
    why: "颜色是平台必填属性，而选品工单里经常没有这一栏。不能从商品图推：同一张图在不同显示器上不是一个颜色，猜出来的值会同时错颜色和错字典项。",
    consequence: "不填 → 属性表缺颜色，提交被打回；填了但语言不对 → 被字典校验拒掉。"
  },
  {
    key: "gender",
    group: "商品",
    type: "string",
    severity: "confirm",
    question: "目标人群性别是哪一个？（用目标市场语言写平台的取值，不是写中文）",
    example: "Женский　或　Мужской　或　Унисекс",
    unknown_ok: true,
    default: null,
    why: "性别同为平台必填属性，且是字典型取值：写成中文「女」会被字典校验拒掉，必须写平台字典里的那一项。",
    consequence: "不填 → 属性表缺性别；填中文 → 表单有值但提交被拒（检查器会标出）。"
  },
  {
    key: "material_composition",
    group: "商品",
    type: "string",
    severity: "blocking",
    question: "面料成分和比例是多少？（有检测报告就提一句）",
    example: "80% 聚酯纤维 / 20% 氨纶，无检测报告",
    unknown_ok: true,
    why: "服装类目必填属性；成分写错直接推高退货率，还涉及虚假描述。",
    consequence: "答 unknown → 属性表留空并标未核，不按图片猜。"
  },
  {
    key: "fulfillment",
    group: "履约",
    type: "string",
    severity: "confirm",
    default: "FBS",
    question: "发货方式是哪一种？（FBS 自己发 / FBO 发到平台仓 / RFBS）",
    example: "FBS　（默认；不确定就用默认）",
    unknown_ok: true,
    why: "决定仓储费、时效承诺、退货地址落在哪，也决定运费能否按包干估算。",
    consequence: "用默认 FBS；若实际是 FBO，仓储与退货成本会漏算。"
  },
  {
    key: "target_language",
    group: "本地化",
    type: "string",
    severity: "confirm",
    default: "目标语言母语级",
    question: "标题和描述要不要当地人校一遍？（还是机翻后自己看一遍就行）",
    example: "要母语校对　或　机翻即可",
    unknown_ok: true,
    why: "机翻在服装类目读起来像坏句子，直接影响转化与审核。",
    consequence: "用默认 → 给目标语言稿并标「机翻草稿」，交付说明里写需母语校对。"
  },
  {
    key: "model_usage",
    group: "本地化",
    type: "string",
    severity: "confirm",
    default: "允许",
    question: "商品图能用模特吗？（含 AI 模特；品牌方有没有限制）",
    example: "允许　或　只能用平铺图",
    unknown_ok: true,
    why: "白底主图不能有人；场景图是否用模特涉及品牌调性与平台规则。",
    consequence: "用默认允许；若禁止，出图策略改为平铺/静物。"
  },
  {
    key: "currency_and_payout",
    group: "价格与费用",
    type: "string",
    severity: "defaultable",
    default: "平台结算币种",
    question: "回款是什么币种、多久结一次？",
    example: "卢布，每周一次",
    unknown_ok: true,
    why: "回款币种与周期决定汇率风险敞口，长周期回款等于隐性汇损。",
    consequence: "用默认；只有要评估汇损时才需要。"
  },
  {
    key: "spreadsheet_or_api",
    group: "平台",
    type: "string",
    severity: "defaultable",
    default: "人工提交",
    question: "最后是人工在后台填，还是用表格/ERP 批量传？",
    example: "人工填　或　Excel 模板　或　ERP",
    unknown_ok: true,
    why: "本链路不代提交；走 API/ERP 的字段校验标准不同，会先被接口拒一次。",
    consequence: "用默认人工提交，交付说明按人工口径写。"
  }
]);

export const GROUPS = Object.freeze([...new Set(INTAKE_ITEMS.map((item) => item.group))]);

/** 数值型答案的合法区间：费率是 0–1 的小数（允许百分数写法），金额/重量必须为正。 */
const NUMERIC_RULES = {
  weight_g: {min: 1, max: 50000, label: "克", percent: false},
  cost: {min: 0.01, max: 100000, label: "元", percent: false},
  international_shipping_fee_cny: {min: 0, max: 100000, label: "元", percent: false},
  insurance_fee_cny: {min: 0, max: 100000, label: "元", percent: false},
  platform_commission_rate: {min: 0, max: 1, label: "费率", percent: true},
  vat_rate: {min: 0, max: 1, label: "费率", percent: true},
  payment_fee_rate: {min: 0, max: 1, label: "费率", percent: true}
};

/** 统一的"我答不了"写法。 */
export const UNKNOWN = "unknown";

function explainShape(item) {
  if (item.type === "number[]") return `${item.key}（三个数字）`;
  if (item.type === "number") return `${item.key}（数字）`;
  return `${item.key}（文字）`;
}

export function renderQuestionnaire() {
  const lines = [
    "怎么答：照 example 的样子写；不确定就写 unknown——那是明确表态，不是漏答。",
    "写 unknown 的项，系统会如实降级（不出价/不出图/标未核），不会替你编数字。"
  ];
  let index = 0;
  for (const group of GROUPS) {
    lines.push(`\n【${group}】`);
    for (const item of INTAKE_ITEMS.filter((entry) => entry.group === group)) {
      index += 1;
      const tag = item.severity === "blocking" ? "必答" : item.severity === "confirm" ? "要确认" : "可默认";
      lines.push(`${index}. [${tag}] ${item.question}`);
      lines.push(`   怎么写：${item.example}`);
      lines.push(`   键名：${explainShape(item)}`);
      lines.push(`   为什么问：${item.why}`);
      lines.push(`   不答会怎样：${item.consequence}`);
    }
  }
  return lines.join("\n");
}

function isBlank(value) {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

function isUnknown(value) {
  return typeof value === "string" && value.trim().toLowerCase() === UNKNOWN;
}

/**
 * 类型校验：填了但填错，比不填更危险 —— 它会一路算进价格。
 * 费率额外宽容：写 18 与写 0.18 都当 18% 处理（人就是会这么写）。
 */
function checkType(item, value) {
  if (isUnknown(value)) return null;
  if (item.type === "number") {
    const raw = String(value).replace(/[%％\s]/g, "");
    const num = Number(raw);
    if (!Number.isFinite(num)) return `${item.key} 需要数字，收到 ${JSON.stringify(value)}`;
    const rule = NUMERIC_RULES[item.key];
    if (rule?.percent && num > 1) {
      const scaled = num / 100;
      if (scaled < rule.min || scaled > rule.max) {
        return `${item.key} 超出范围（应写 0–100% 或 0–1），收到 ${num}`;
      }
      return null;
    }
    if (rule && (num < rule.min || num > rule.max)) {
      return `${item.key} 超出范围 [${rule.min}, ${rule.max}]（${rule.label}），收到 ${num}`;
    }
    return null;
  }
  if (item.type === "number[]") {
    const dims = (Array.isArray(value) ? value : String(value).split(/[,，x×*]/))
      .map((entry) => Number(String(entry).trim()))
      .filter((entry) => Number.isFinite(entry));
    if (dims.length !== 3 || !dims.every((entry) => entry > 0)) {
      return `${item.key} 需要三个正数（长宽高 cm），收到 ${JSON.stringify(value)}`;
    }
    return null;
  }
  return null;
}

/**
 * 校验用户答复。
 * 三类问题分开报：没答的必答项 / 填错的 / 用默认顶上的 ——
 * 混在一起报，人就分不清"该去问"还是"该去改"。
 */
export function validateIntake(answers = {}) {
  const blockingMissing = [];
  const confirmMissing = [];
  const invalid = [];
  const defaultsUsed = [];
  const filled = [];
  const unknown = [];

  for (const item of INTAKE_ITEMS) {
    const raw = answers[item.key];
    if (isBlank(raw)) {
      if (item.severity === "blocking") {
        blockingMissing.push({key: item.key, type: item.type, question: item.question, example: item.example, consequence: item.consequence});
      } else if (item.severity === "confirm") {
        confirmMissing.push({key: item.key, question: item.question, default: item.default ?? null});
        defaultsUsed.push({key: item.key, value: item.default ?? null, source: "default"});
      } else {
        defaultsUsed.push({key: item.key, value: item.default ?? null, source: "default"});
      }
      continue;
    }
    if (isUnknown(raw)) {
      unknown.push(item.key);
      continue;
    }
    const typeError = checkType(item, raw);
    if (typeError) {
      invalid.push({key: item.key, reason: typeError, example: item.example});
      continue;
    }
    filled.push(item.key);
  }

  return {
    ok: blockingMissing.length === 0 && invalid.length === 0,
    total: INTAKE_ITEMS.length,
    filled,
    unknown,
    blocking_missing: blockingMissing,
    confirm_missing: confirmMissing,
    invalid,
    defaults_used: defaultsUsed,
    summary: {
      filled: filled.length,
      unknown: unknown.length,
      blocking_missing: blockingMissing.length,
      confirm_missing: confirmMissing.length,
      invalid: invalid.length,
      defaults_used: defaultsUsed.length
    }
  };
}
