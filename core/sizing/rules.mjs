/**
 * 尺码「值」的合规判定。
 *
 * 职责边界：只认配置里声明的规则，不认识任何平台。规则内容（步长、区间、折叠阈值）
 * 由 `regions/<CC>/sizing.json` 的 `size_value_rules` 提供，依据写在那里。
 *
 * 为什么单独一层：尺码**表**（长什么样）与尺码**值**（填什么）是两件事。
 * 值填错不会报错，只会让卡片搜不到或被审核打回 —— 必须在上品之前拦住。
 */

/** 把 "42" / 42 / "42,44" 统一成数字数组；非数字返回 null 表示无法判定。 */
function toNumbers(values) {
  const numbers = [];
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text === "") continue;
    const number = Number(text);
    if (!Number.isFinite(number)) return null;
    numbers.push(number);
  }
  return numbers;
}

/** 连续尺码段的最大长度（步长按配置）。[42,44,46,48] → 4 */
function longestConsecutiveRun(numbers, step) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  let best = sorted.length ? 1 : 0;
  let run = sorted.length ? 1 : 0;
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] - sorted[index - 1] === step) {
      run += 1;
      best = Math.max(best, run);
    } else {
      run = 1;
    }
  }
  return best;
}

/**
 * @param {string[]} values 卖家尺码表里的本地码（按表顺序）
 * @param {object|null} rules 配置里的 size_value_rules；null 表示该法域没登记规则
 * @returns {{value: string|null, values: string[], violations: object[], actions: string[], applied: string[], status: string}}
 */
export function evaluateSizeValues(values, rules) {
  const list = (values ?? []).map((value) => String(value ?? "").trim()).filter((value) => value !== "");
  const violations = [];
  const actions = [];
  const applied = [];

  if (!rules) {
    return {
      value: list.join(";") || null,
      values: list,
      violations,
      actions,
      applied: ["未登记 size_value_rules：按分号直接拼接（无合规校验）"],
      status: "unchecked"
    };
  }

  const separator = rules.separator ?? ";";
  const numbers = toNumbers(list);
  if (list.length === 0) {
    return {value: null, values: [], violations, actions, applied, status: "empty"};
  }
  if (!numbers) {
    // 非纯数字（如 "42-44"、"XL"）：不做算术判定，但仍把它当值用，并留下要人核的痕迹。
    return {
      value: list.join(separator),
      values: list,
      violations,
      actions: ["尺码不是纯数字，步长/区间规则未判定：请人工对照平台尺码说明核一眼"],
      applied,
      status: "non_numeric"
    };
  }

  const step = rules.adult?.step ?? null;
  if (step) {
    for (const number of numbers) {
      if (number % step !== 0) {
        violations.push({code: "size_step", detail: `${number} 不是 ${step} 的整数倍；本市场成尺码以 ${step} 为步长`});
      }
    }
  }
  if (rules.adult?.min !== undefined || rules.adult?.max !== undefined) {
    for (const number of numbers) {
      if (number < (rules.adult.min ?? -Infinity) || number > (rules.adult.max ?? Infinity)) {
        violations.push({code: "size_range", detail: `${number} 超出成人码区间 ${rules.adult.min}–${rules.adult.max}`});
      }
    }
  }

  const collapse = rules.collapse ?? null;
  if (collapse?.when_consecutive_at_least) {
    const run = longestConsecutiveRun(numbers, step ?? 1);
    if (run >= collapse.when_consecutive_at_least) {
      applied.push(
        `连续 ${run} 个尺码 ≥ ${collapse.when_consecutive_at_least}：按平台规则不再逐个填，改为「${collapse.label}」`
      );
      // 折叠后的值取决于平台字典里的那一项，配置没给确切取值就不猜 ——
      // 写一个像模像样的字符串进上架字段，比留空更难排查。
      const collapsed = collapse.value ?? null;
      if (collapsed) {
        return {value: collapsed, values: list, violations, actions, applied, status: "collapsed"};
      }
      actions.push(`在平台尺码字段里选「${collapse.label}」这一项（本包不代填，避免写错字典项）`);
      return {value: null, values: list, violations, actions, applied, status: "needs_manual_pick"};
    }
  }

  for (const rule of rules.value_patterns ?? []) {
    const pattern = new RegExp(rule.pattern);
    if (!pattern.test(list.join(separator))) {
      violations.push({code: rule.code ?? "size_pattern", detail: rule.why ?? `值不符合 ${rule.pattern}`});
    }
  }

  return {
    value: list.join(separator),
    values: list,
    violations,
    actions,
    applied,
    status: violations.length ? "invalid" : "ok"
  };
}

/** 身高是独立属性，规则同源于同一份配置。 */
export function evaluateHeight(value, rules) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return {ok: true, violations: [], actions: []};
  }
  const height = Number(value);
  if (!Number.isFinite(height)) {
    return {ok: false, violations: [{code: "height_not_numeric", detail: String(value)}], actions: []};
  }
  const range = rules?.height ?? null;
  if (!range) return {ok: true, violations: [], actions: []};
  const violations = [];
  if (height < range.min || height > range.max) {
    violations.push({code: "height_range", detail: `身高 ${height} 超出 ${range.min}–${range.max}`});
  }
  return {ok: violations.length === 0, violations, actions: violations.length ? [`身高填 ${range.min}–${range.max} 之间的数值`] : []};
}
