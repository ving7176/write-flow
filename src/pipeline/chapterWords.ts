/**
 * 单章字数校验（批次1 · 检查层自动化 P0-3）。
 *
 * 背景：xianxia 单章字数上限收紧 3150->3100 时 18 章超限需压缩回改——字数超限是签约/合规硬约束。
 * 番茄平台口径：统计正文可见字符，不含 frontmatter 与空白行。
 *
 * 实现纯函数：
 *  - stripFrontmatter：剥除 YAML frontmatter（首 `---` 到次 `---`）
 *  - visibleChars：统计可见字符（去空白/空白行后的有效字符数）
 *  - checkChapterWords：对目标区间做不达标/达标/超限判定
 */

export interface ChapterWordsOptions {
  /** 目标下限（默认 2850） */
  min?: number;
  /** 目标上限（默认 3050） */
  max?: number;
}

export interface ChapterWordsResult {
  count: number;
  min: number;
  max: number;
  /** 放宽区间（超限 5% 内仍不算红线，供人工复核） */
  overLimit: boolean;
  message: string;
}

/** 剥除 YAML frontmatter：若以 `---` 开头，截取到第二个 `---` 之后 */
export function stripFrontmatter(text: string): string {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[0].trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        return lines.slice(i + 1).join("\n");
      }
    }
  }
  return text;
}

/** 统计可见字符（去掉空白字符后的有效字符数）。番茄口径：以 Array.from 计码点，含汉字/标点/数字 */
export function visibleChars(text: string): number {
  const cleaned = text.replace(/\s+/g, "");
  return Array.from(cleaned).length;
}

/** 单章字数判定（含 frontmatter 自动剥离） */
export function checkChapterWords(rawText: string, opts: ChapterWordsOptions = {}): ChapterWordsResult {
  const min = opts.min ?? 2850;
  const max = opts.max ?? 3050;
  const body = stripFrontmatter(rawText);
  const count = visibleChars(body);
  const soft = Math.round(max * 1.05); // 5% 宽松
  const overLimit = count > soft;
  let message: string;
  if (count < min) message = `字数不足：${count} < ${min}`;
  else if (count > max) message = overLimit ? `字数超限：${count} > ${soft}` : `字数超出目标：${count} > ${max}`;
  else message = `字数达标：${count}（${min}~${max}）`;
  return { count, min, max, overLimit, message };
}

export default checkChapterWords;
