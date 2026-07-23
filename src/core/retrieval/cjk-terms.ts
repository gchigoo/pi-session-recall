/**
 * CJK 词项辅助（P0 spike / 后续 retrieval 共用）。
 */

/**
 * 提取汉字 unigram/bigram 词项。
 */
export function cjkBigrams(text: string): string[] {
  const chars = [...text].filter((char) => /\p{Script=Han}/u.test(char));
  if (chars.length === 0) {
    return [];
  }
  if (chars.length === 1) {
    return [chars[0]!];
  }
  const grams: string[] = [];
  for (let i = 0; i < chars.length - 1; i += 1) {
    grams.push(`${chars[i]}${chars[i + 1]}`);
  }
  return grams;
}

/**
 * 为查询生成受限词项（最多 32 个）。
 */
export function queryTerms(raw: string): string[] {
  const normalized = raw.normalize("NFC").trim();
  const latin = normalized.match(/[A-Za-z0-9_./-]+/g) ?? [];
  const grams = cjkBigrams(normalized);
  return [...new Set([...latin, ...grams])].slice(0, 32);
}
