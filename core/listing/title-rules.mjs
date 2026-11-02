/**
 * 标题合规判定。
 *
 * 只做判定，不生成：标题该写什么由文案与类目属性决定，这里负责回答
 * 「这一版会不会被审核打回、因为哪一条」。
 *
 * 规则不放这里 —— 全部来自平台事实（`title.max_chars` / `title.charset` 等），
 * 本模块不含任何平台名或地区码，换法域只换事实。
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const EMOJI = /\p{Extended_Pictographic}/u;
const CYRILLIC = /[\u0400-\u04ff]/u;
const ALLOWED_SYMBOLS = new Set([".", ",", ":", ";", "(", ")", "-", "/", "&", '"', "!", "?", " "]);

/**
 * @param {string} text 待判定标题
 * @param {{max_chars?:number, max_word_chars?:number, charset?:object}} rules
 * @returns {{ok: boolean, violations: {code: string, detail: string}[], stats: object}}
 */
export function lintTitle(text, rules = {}) {
  const value = String(text ?? "");
  const violations = [];
  const charset = rules.charset ?? {};
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return {ok: false, violations: [{code: "title_empty", detail: "标题为空"}], stats: {chars: 0, words: 0, longest_word: 0}};
  }

  const maxChars = Number.isInteger(rules.max_chars) ? rules.max_chars : null;
  if (maxChars && trimmed.length > maxChars) {
    violations.push({code: "title_too_long", detail: `${trimmed.length} 字符，上限 ${maxChars}`});
  }

  // 字节上限（部分平台按字节限额）：中文 1 字 = 3 字节，按字符数校验会把超长标题放过去。
  const maxBytes = Number.isInteger(rules.max_bytes) ? rules.max_bytes : null;
  const byteLength = Buffer.byteLength(trimmed, "utf8");
  if (maxBytes && byteLength > maxBytes) {
    const cjkChars = (trimmed.match(new RegExp(CJK.source, "gu")) ?? []).length;
    violations.push({
      code: "title_too_many_bytes",
      detail: `${byteLength} 字节，上限 ${maxBytes}（${trimmed.length} 字符，其中汉字 ${cjkChars} 个；纯中文约 ${Math.floor(maxBytes / 3)} 字封顶）`
    });
  }

  const minChars = Number.isInteger(rules.min_chars) ? rules.min_chars : null;
  if (minChars && trimmed.length < minChars) {
    violations.push({code: "title_too_short", detail: `${trimmed.length} 字符，下限 ${minChars}`});
  }

  // 按语种分别给上限（有的平台对英文与中文给不同额度）。
  // 判语种用"是否含汉字"来分：一个标题要么按英文算、要么按中文算，不叠加。
  const byScript = rules.max_chars_by_script ?? null;
  if (byScript) {
    const hasCjk = CJK.test(trimmed);
    const limit = hasCjk ? byScript.cjk : byScript.latin;
    if (Number.isInteger(limit) && trimmed.length > limit) {
      violations.push({
        code: "title_too_long_for_script",
        detail: `${hasCjk ? "中文" : "英文"}标题 ${trimmed.length} 字符，该类标题上限 ${limit}`
      });
    }
  }

  // 中英混填（部分平台的硬规则）：混填会导致部分词不被翻译，进而整条被禁。
  if (rules.language_mixing === "forbidden") {
    const hasCjk = CJK.test(trimmed);
    const hasLatinWord = /\p{Script=Latin}{2,}/u.test(trimmed);
    if (hasCjk && hasLatinWord) {
      violations.push({
        code: "mixed_language",
        detail: "中英文混填：官方明确「不要在同一标题里混用中英文」，否则部分词不翻译、商品会被禁"
      });
    }
  }

  // 全大写（有的平台明确列为禁止项）。品牌名常全大写，所以只提醒不判死。
  const allCapsWarning = (() => {
    if (!rules.no_all_caps) return null;
    const letters = trimmed.replace(/[^\p{L}]/gu, "");
    if (letters.length < 4) return null;
    if (letters !== letters.toUpperCase()) return null;
    return {code: "all_caps", detail: "整条标题全大写；官方把「全部大写」列为禁止项（品牌名除外）"};
  })();

  // 明令禁止的促销语（如优惠 x%、免费配送、100% 保证质量…）
  for (const phrase of rules.forbidden_phrases ?? []) {
    if (!phrase) continue;
    if (trimmed.toLowerCase().includes(String(phrase).toLowerCase())) {
      violations.push({code: "forbidden_phrase", detail: `含平台明令禁止的促销/营销表述「${phrase}」`});
    }
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  const longest = words.reduce((best, word) => (word.length > best.length ? word : best), "");
  const maxWord = Number.isInteger(rules.max_word_chars) ? rules.max_word_chars : null;
  if (maxWord && longest.length > maxWord) {
    violations.push({code: "word_too_long", detail: `单词「${longest}」${longest.length} 字符，上限 ${maxWord}`});
  }

  for (const symbol of charset.forbidden ?? []) {
    if (trimmed.includes(symbol)) {
      violations.push({code: "forbidden_char", detail: `含禁用符号「${symbol}」`});
    }
  }

  if (charset.must_start_uppercase !== false) {
    // 中文/日文没有大小写概念：对以汉字开头的标题要求"首字母大写"是无意义的误报，
    // 会把完全合规的中文标题判死。只在首字符确实有大小写区分时才校这一条。
    const first = [...trimmed][0] ?? "";
    const hasCase = /\p{L}/u.test(first) && first.toLowerCase() !== first.toUpperCase();
    if (hasCase && !/^\p{Lu}/u.test(first)) {
      violations.push({code: "not_capitalized", detail: "首字母必须大写"});
    }
  }

  if (charset.requires_cyrillic && !CYRILLIC.test(trimmed)) {
    violations.push({code: "no_cyrillic", detail: "标题必须含西里尔文；纯拉丁文或纯中文都会被判为「名称为拉丁语」类错误"});
  }

  if ((charset.forbidden_scripts ?? []).includes("cjk") && CJK.test(trimmed)) {
    violations.push({code: "cjk_char", detail: "含汉字；官方错误示例明确列了「名称中含有不允许的符号，如表情符号或汉字」"});
  }
  if ((charset.forbidden_scripts ?? []).includes("emoji") && EMOJI.test(trimmed)) {
    violations.push({code: "emoji", detail: "含表情符号"});
  }

  if (/\u00a0|&nbsp;/i.test(value)) {
    violations.push({code: "nbsp", detail: "含不间断空格"});
  }
  if (/<\/?[a-z][^>]*>/i.test(value)) {
    violations.push({code: "html_tag", detail: "含 HTML 标记"});
  }
  if (/https?:\/\//i.test(value)) {
    violations.push({code: "external_ref", detail: "含外部链接或引用"});
  }

  // 破折号等非白名单符号：只提示，不判死 —— 官方允许的符号表是穷举的，
  // 但把一条可人工判定的提示当硬拒因，会让正常标题也被卡住。
  const unknownSymbols = [...new Set([...trimmed].filter((char) => {
    if (ALLOWED_SYMBOLS.has(char)) return false;
    if (/[\p{L}\p{N}]/u.test(char)) return false;
    return true;
  }))];
  const warnings = unknownSymbols.length
    ? [{code: "symbol_outside_list", detail: `非官方白名单符号：${unknownSymbols.join(" ")}`}]
    : [];
  if (allCapsWarning) warnings.push(allCapsWarning);

  // 模块化标题：主标题超了 item_name 上限，亮点字段就提交不上去。
  // 这不是"标题违规"，是"该把后半段拆出去"，所以给提示并说明拆法。
  if (Number.isInteger(rules.item_name_max) && trimmed.length > rules.item_name_max && !Number.isInteger(rules.max_chars)) {
    warnings.push({
      code: "exceeds_item_name",
      detail: `主标题 ${trimmed.length} 字超过 ${rules.item_name_max}，超出的部分应拆到 Item Highlights（上限 ${rules.differentiation_max ?? "?"}）`
    });
  } else if (Number.isInteger(rules.item_name_max) && trimmed.length > rules.item_name_max) {
    warnings.push({
      code: "exceeds_item_name",
      detail: `主标题 ${trimmed.length} 字超过 ${rules.item_name_max}；虽在合计上限内，但主标题超长时亮点字段无法提交，建议拆到 Item Highlights`
    });
  }


  return {
    ok: violations.length === 0,
    violations,
    warnings,
    stats: {
      chars: trimmed.length,
      bytes: byteLength,
      words: words.length,
      longest_word: longest.length
    }
  };
}

/** 从平台事实里取标题规则，缺项按 null 处理，不补默认值。 */
export function titleRulesFromFacts(facts = []) {
  const bySuffix = (suffix) => facts.find((fact) => String(fact?.key ?? "").endsWith(suffix)) ?? null;
  const maxChars = bySuffix(".title.max_chars");
  const maxWord = bySuffix(".title.max_word_chars");
  const charset = bySuffix(".title.charset");
  const auto = bySuffix(".title.auto_generated");
  const maxBytes = bySuffix(".title.max_bytes");
  const minChars = bySuffix(".title.min_chars");
  const maxEn = bySuffix(".title.max_chars_en");
  const maxZh = bySuffix(".title.max_chars_zh");
  const mixing = bySuffix(".title.language_mixing");
  const forbidden = bySuffix(".title.forbidden");
  const forbiddenChars = bySuffix(".title.forbidden_chars");
  const promo = bySuffix(".title.promo_forbidden");
  const itemNameMax = bySuffix(".title.item_name_max_chars");
  const differentiationMax = bySuffix(".title.differentiation_max_chars");

  // 有的平台把禁用项做成一个数组，里面混着 HTML/全大写/促销语/符号：
  // 拆成"短语"和"符号"两类分别交给校验器，不整包塞进 forbidden 字符表。
  const forbiddenValue = Array.isArray(forbidden?.value) ? forbidden.value : [];
  const symbolList = forbiddenValue
    .filter((item) => typeof item === "string" && /^[!*$?^~<>|]+$/.test(item))
    .flatMap((item) => [...item]);
  // 平台若单独给了"禁用字符"事实，直接用，不必从描述性数组里猜。
  // 禁用字符有两种写法：连续串（"^~<>|"）与空格分隔（"@ ^ * # &"）。
  // 一律先按空白分段再逐段展开 —— 直接 [...string] 会把分隔用的空格也当成禁用符，
  // 结果所有带空格的标题全被判违规。
  const splitChars = (value) => String(value).split(/\s+/).filter(Boolean).flatMap((segment) => [...segment]);
  const explicitChars = Array.isArray(forbiddenChars?.value)
    ? forbiddenChars.value.flatMap((item) => splitChars(item))
    : typeof forbiddenChars?.value === "string"
      ? splitChars(forbiddenChars.value)
      : [];
  const charSet = [...new Set([...symbolList, ...explicitChars])];

  const byScript = Number.isInteger(maxEn?.value) || Number.isInteger(maxZh?.value)
    ? {latin: maxEn?.value ?? null, cjk: maxZh?.value ?? null}
    : null;

  return {
    max_chars: Number.isInteger(maxChars?.value) ? maxChars.value : null,
    max_word_chars: Number.isInteger(maxWord?.value) ? maxWord.value : null,
    max_bytes: Number.isInteger(maxBytes?.value) ? maxBytes.value : null,
    min_chars: Number.isInteger(minChars?.value) ? minChars.value : null,
    max_chars_by_script: byScript,
    language_mixing: typeof mixing?.value === "string" ? mixing.value : null,
    // 模块化标题（部分平台把标题拆成主标题 + 亮点两段）：主标题超限，亮点字段就提交不上去。
    item_name_max: Number.isInteger(itemNameMax?.value) ? itemNameMax.value : null,
    differentiation_max: Number.isInteger(differentiationMax?.value) ? differentiationMax.value : null,
    no_all_caps: forbiddenValue.some((item) => typeof item === "string" && item.includes("全大写")),
    forbidden_phrases: Array.isArray(promo?.value) ? promo.value.filter((item) => typeof item === "string") : [],
    charset: charset?.value ?? (charSet.length ? {forbidden: charSet} : null),
    auto_generated: auto?.value ?? null,
    sources: [maxChars, maxWord, charset, auto, maxBytes, minChars, maxEn, maxZh, mixing, forbidden, forbiddenChars, promo]
      .filter(Boolean)
      .map((fact) => ({
        key: fact.key,
        status: fact.status,
        source_type: fact.source_type,
        source_url: fact.source_url
      }))
  };
}
