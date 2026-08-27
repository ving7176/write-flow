/**
 * 章节唯一键（novel 章节去重/upsert 用）
 *
 * 章节标题格式不统一：`第1章 · 下山` / `第2章·黑粉炸了` / `第一章 穿越` / `楔子` / `序章`。
 * 历史缺陷：仅匹配 `第\d+章` 时「楔子/第一章（中文数字）」返回 null → 每次 INSERT 新行 → 同章双份。
 *
 * 统一策略（返回稳定字符串键）：
 * - `第N章`（阿拉伯或中文数字）→ `num:N`
 * - 楔子/序章/引子/尾声/番外 → 固定 `pre:楔子` 等（各自独立，不与正文章节冲突）
 * - 无法识别 → 按原文精确键 `raw:<原文>`（至少同文本不再重复插入）
 */
export function chapterKey(chapter?: string): string {
  const t = (chapter ?? "").trim();
  if (!t) return `raw:`;
  // 中文数字 → 阿拉伯（支持一到九十九，含「零」）
  const cnToNum = (s: string): number | null => {
    const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (/^[0-9]+$/.test(s)) return Number(s);
    // 十/百 组合：十几 → 10+n；几十 → n*10；几十几 → n*10+m
    let total = 0;
    let section = 0;
    for (const ch of s) {
      if (ch === "十") {
        section = section === 0 ? 10 : section * 10;
        total += section;
        section = 0;
      } else if (ch === "百") {
        section = section === 0 ? 100 : section * 100;
        total += section;
        section = 0;
      } else if (ch in digits) {
        section = digits[ch];
      } else {
        return null;
      }
    }
    return total + section;
  };
  // 第N章（容忍空格与前后缀：`第1章 · 下山（修订版）` → 1）
  const numM = t.match(/第\s*([0-9一二三四五六七八九十百零两]+)\s*章/);
  if (numM) {
    const n = cnToNum(numM[1]);
    if (n != null) return `num:${n}`;
  }
  // 楔子/序章/引子/尾声/番外/后记：固定命名键
  const preM = t.match(/^(楔子|序章|引子|尾声|番外|后记)/);
  if (preM) return `pre:${preM[1]}`;
  return `raw:${t}`;
}

/** 提取阿拉伯章号（仅 `第N章` 且为阿拉伯数字时返回数字；其余返回 null） */
export function chapterNum(chapter?: string): number | null {
  const t = (chapter ?? "").trim();
  const m = t.match(/第\s*([0-9]+)\s*章/);
  return m ? Number(m[1]) : null;
}

/**
 * 提取章号（中文数字 + 阿拉伯均支持；批次1 章卡结构化用）。
 * `第一章 穿越` → 1；`第 12 章 · 下山` → 12；楔子/序章/无章号 → null。
 */
export function chapterNoOf(chapter?: string): number | null {
  const t = (chapter ?? "").trim();
  const m = t.match(/第\s*([0-9一二三四五六七八九十百零两]+)\s*章/);
  if (!m) return null;
  const s = m[1];
  if (/^[0-9]+$/.test(s)) return Number(s);
  // 中文数字（与 chapterKey 内 cnToNum 同逻辑：十/百组合）
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let total = 0;
  let section = 0;
  for (const ch of s) {
    if (ch === "十") {
      section = section === 0 ? 10 : section * 10;
      total += section;
      section = 0;
    } else if (ch === "百") {
      section = section === 0 ? 100 : section * 100;
      total += section;
      section = 0;
    } else if (ch in digits) {
      section = digits[ch];
    } else {
      return null;
    }
  }
  return total + section;
}
