const TRANSLIT = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "i",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "iu", я: "ia"
};

/**
 * 目标语言标题 → 可用作目录名/文件名/SKU 的 ASCII 串。
 *
 * 为什么不用哈希顶替：SKU 是要被人在包里翻出来的东西。`kardigan-udlinennyi`
 * 一眼知道是哪件；`cand-3-a1b2c3` 只能回表查。哈希只作为去重后缀。
 */
export function transliterate(value) {
  return String(value ?? "")
    .toLowerCase()
    .split("")
    .map((char) => (TRANSLIT[char] !== undefined ? TRANSLIT[char] : char))
    .join("");
}

export function asciiSlug(value, {maxLength = 32} = {}) {
  return transliterate(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, maxLength)
    .replace(/-+$/, "");
}
