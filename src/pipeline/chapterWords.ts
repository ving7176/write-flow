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

/**
 * CP3 分拍字数配额表：把单一「约 3000」软锚换成逐拍结构化锚——模型对逐拍配额的遵循
 * 远好于全局数字（短稿根治 · 236/239 连续短稿取证后的内容侧杠杆）。
 * 节拍数按章卡 summary 的加粗小标题计数（markdown 加粗小标题，如 节拍一/喘点）；无结构（<2 拍）给单段配额。
 */
export function buildBeatQuotaBlock(cardSummary: string, wordMin: number, wordMax: number): string {
  const beats = (cardSummary ?? "").match(/\*\*[^*\n]{1,20}\*\*/g) ?? [];
  const n = beats.length;
  const mid = Math.round((wordMin + wordMax) / 2);
  if (n < 2) {
    return [
      "【本章字数配额（硬性）】",
      `- 全文可见字数 ${wordMin}~${wordMax} 字，目标 ${mid} 字左右，交付前自行清点`,
    ].join("\n");
  }
  const per = Math.round(mid / n);
  const lines = [
    "【本章字数配额（硬性，逐拍清点）】",
    `- 共 ${n} 拍，每拍约 ${per} 字（±80），全部拍合计须落在 ${wordMin}~${wordMax} 字`,
    ...beats.map((b, i) => `  - ${b} → 约 ${i === n - 1 ? mid - per * (n - 1) : per} 字${i === n - 1 ? "（含章尾钩子）" : ""}`),
    "- 任一拍明显偏短即整章不达标：写不满就展开对话回合与动作细节，禁止概括带过",
  ];
  return lines.join("\n");
}

export default checkChapterWords;
