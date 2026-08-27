/**
 * 章内雷同句检测（批次1 · 检查层自动化 P0-1）。
 *
 * 背景：AI 为补足字数会直接复制/近义改写已有内容（xianxia 开发 check_repeat 的根因）。
 * 阈值直接继承 xianxia 校准值：
 *  - 完全重复句：>=8 字完整句出现 >=2 次 → 零容忍
 *  - 近似句：>=12 字句子两两比较，字级 bigram+trigram Jaccard 相似度 >=0.62 报疑似
 *  - 短句跳过（相似度虚高）、长度差 >40% 降权、每章最多 N 对
 *
 * 纯函数，供监督报告/返工闭环复用；自带白名单豁免（刻意首尾呼应句/角色口头禅可豁免）。
 */

export interface RepeatIssue {
  /** 类型标签：[REPEAT]=完全重复句 | [APPROX]=近似句（疑似） */
  type: "REPEAT" | "APPROX";
  /** 匹配到的句子文本 */
  text: string;
  /** 相似度（仅 APPROX） */
  similarity?: number;
  /** 在原文第几句出现（0 基） */
  index: number;
  /** 句内行号 */
  line: number;
}

export interface RepeatDetectOptions {
  /** 完全重复句最小长度（字） */
  exactMinLen?: number;
  /** 近似句最小长度（字） */
  approxMinLen?: number;
  /** 近似句相似度阈值（0~1） */
  similarityThreshold?: number;
  /** 单章最大报告对数 */
  maxPairs?: number;
  /** 豁免句：以开头匹配（角色口头禅/刻意首尾呼应）则不报 */
  exemptPrefixes?: string[];
}

/** 按标点/换行切句，过滤过短句（小于 minLen 丢弃） */
export function splitSentences(text: string, minLen: number): Array<{ text: string; index: number; line: number }> {
  const out: Array<{ text: string; index: number; line: number }> = [];
  // 按句号/问号/叹号/省略号/换行切分，保留切分原始位置
  const regex = /[^。！？…\n]+[。！？…]?/g;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = regex.exec(text)) !== null) {
    const s = m[0].trim();
    if (s.length >= minLen) {
      out.push({ text: s, index: idx++, line: locateLineByOffset(text, m.index) });
    } else {
      idx++;
    }
  }
  return out;
}

/** 由字符偏移定位行号 */
function locateLineByOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/** 字级 n-gram 抽取（bigram/trigram）返回 Set；剥除标点，只比汉字/字母数字，防句号干扰句式比对 */
function extractNGrams(sentence: string, n: number): Set<string> {
  const set = new Set<string>();
  const chars = Array.from(sentence).filter((c) => /[\u4e00-\u9fa5A-Za-z0-9]/.test(c));
  for (let i = 0; i + n <= chars.length; i++) {
    set.add(chars.slice(i, i + n).join(""));
  }
  return set;
}

/** 两个 Set 的 Jaccard 相似度（交集 / 并集），空集返回 0 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 剥除标点后的有效长度（供长度差降权，避免句号干扰） */
function cleanLength(sentence: string): number {
  return Array.from(sentence).filter((c) => /[\u4e00-\u9fa5A-Za-z0-9]/.test(c)).length;
}

/**
 * 句对近似度：字级 bigram + trigram 的加权 Jaccard，长度差 >40% 降权（乘以 0.8，防长句强行匹配短句）。
 */
export function sentenceSimilarity(a: string, b: string): number {
  const aBig = extractNGrams(a, 2);
  const aTri = extractNGrams(a, 3);
  const bBig = extractNGrams(b, 2);
  const bTri = extractNGrams(b, 3);
  const big = (jaccard(aBig, bBig) + jaccard(aTri, bTri)) / 2;
  const lenDiff = Math.abs(cleanLength(a) - cleanLength(b)) / Math.max(cleanLength(a), cleanLength(b), 1);
  return lenDiff > 0.4 ? big * 0.8 : big;
}

/**
 * 章节内雷同检测。
 *
 * @param text 正文章节文本
 * @param opts 阈值配置
 * @returns 问题列表（REPEAT + APPROX）；白名单/短句自动豁免
 */
export function detectRepeats(text: string, opts: RepeatDetectOptions = {}): RepeatIssue[] {
  const exactMinLen = opts.exactMinLen ?? 8;
  const approxMinLen = opts.approxMinLen ?? 12;
  const threshold = opts.similarityThreshold ?? 0.62;
  const maxPairs = opts.maxPairs ?? 5;
  const exemptPrefixes = opts.exemptPrefixes ?? [];

  const issues: RepeatIssue[] = [];

  // ---- 完全重复句（>=8 字完整句出现 >=2 次） ----
  const lines = text.split("\n");
  const exactCount = new Map<string, { count: number; line: number }>();
  for (let li = 0; li < lines.length; li++) {
    const lineText = lines[li].trim();
    if (lineText.length < exactMinLen) continue;
    if (exemptPrefixes.some((p) => lineText.startsWith(p))) continue;
    // 元数据字段行豁免（E2E 实测：大纲逐章条目「- 字数：约3000」「- 阶段：起」等结构性重复——
    // 列表标记 + 字段名 + 冒号 + 短值（≤16 字），是文档字段非叙事句子；章节正文不产生此形态，
    // 值超过 16 字的长内容（真正的钩子/剧情句重复）仍正常检测）
    if (/^[-*·]\s*[\u4e00-\u9fa5A-Za-z]+[：:]\s*\S{0,16}$/.test(lineText)) continue;
    const c = exactCount.get(lineText);
    if (c) c.count++;
    else exactCount.set(lineText, { count: 1, line: li + 1 });
  }
  for (const [s, v] of exactCount) {
    if (v.count >= 2) {
      issues.push({ type: "REPEAT", text: s, index: 0, line: v.line });
    }
  }

  // ---- 近似句（>=12 字句子两两比较） ----
  const sentences = splitSentences(text, approxMinLen).filter(
    (s) => !exemptPrefixes.some((p) => s.text.startsWith(p)),
  );
  let approxPairs = 0;
  outer: for (let i = 0; i < sentences.length; i++) {
    for (let j = i + 1; j < sentences.length; j++) {
      const sim = sentenceSimilarity(sentences[i].text, sentences[j].text);
      if (sim >= threshold) {
        issues.push({
          type: "APPROX",
          text: sentences[i].text,
          similarity: sim,
          index: sentences[i].index,
          line: sentences[i].line,
        });
        approxPairs++;
        if (approxPairs >= maxPairs) break outer;
      }
    }
  }

  return issues;
}

/** 默认导出对齐（保持调用一致性） */
export default detectRepeats;
