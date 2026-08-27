/**
 * 禁用词代码扫描（批次1 · 检查层自动化 P0-1）。
 *
 * 背景：xianxia-novel 的 20 项自查 + 禁用词原本 100% 靠 LLM，已知必漏（ch-023/038/039
 * 近似雷同、ch124 随机/ch125 淡淡道/ch126 隐隐 都是脚本抓出来的）。这里落地代码硬校验。
 *
 * 设计：
 * - 纯函数，词表经参数传入（默认内置常用词，运行时由配置覆盖，不硬编码数据库）
 * - 词表分类：poison=零容忍（命中即问题）| density=限频（enabledRatio>1 时 hit 超过阈值才报告）
 * - 返回带类型标签的问题列表（[BANNED]/[RATIO]），供监督报告/返工闭环复用
 * - 内层点号路径取值、缺失降级等语义与 constraintChecker 一致：数据缺失不阻断
 */

export interface BannedWordRule {
  /** 词条原始文本 */
  word: string;
  /** 分类：poison=零容忍必报 | density=限频（超 threshold 才报） */
  kind: "poison" | "density";
  /** density 类的每章允许次数（≤该值不报）/ 频率上限（>= 该值触发） */
  threshold?: number;
}

export interface BannedScanIssue {
  /** 类型标签：[BANNED]=零容忍 | [RATIO]=频次超限（报告级，非红线） */
  type: "BANNED" | "RATIO";
  word: string;
  kind: "poison" | "density";
  /** 命中位置（首个命中片段，附上下文方便定位） */
  snippet: string;
  /** density 类的实际命中次数 */
  count: number;
  threshold?: number;
  /** 命中行的行内起点 */
  line?: number;
}

/** 默认内置词表（QIFLOW 视角的通用网文毒点，来自 writing_standard + xianxia 沉淀）。
 *  运行时可由配置覆盖/追加（见 buildRuleSet）。 */
export const DEFAULT_BANNED_WORDS: BannedWordRule[] = [
  // 零容忍：模板化神态/强灌设定观感词
  { word: "嘴里念念有词", kind: "poison" },
  { word: "一见面就", kind: "poison" },
  // density 类：每章限频词（xianxia 条款：却每章≤2、顿时/瞬间/不由得每章≤3）
  { word: "顿时", kind: "density", threshold: 3 },
  { word: "瞬间", kind: "density", threshold: 3 },
  { word: "不由得", kind: "density", threshold: 3 },
];

/** 通用零容忍禁用词小表（写作侧毒点，能扫则扫；实际以运行时配置为准） */
export const COMMON_POISON_WORDS: string[] = [
  "既然这样",
  "就这样吧",
  "说到底",
  "毋庸置疑",
  "可想而知",
  "众所周知",
];

/** 从规则数组构建查询用 Map（word -> rule），重复词条后者覆盖 */
export function buildRuleSet(rules: BannedWordRule[]): Map<string, BannedWordRule> {
  const m = new Map<string, BannedWordRule>();
  for (const r of rules) m.set(r.word, r);
  return m;
}

/** 统计一文本内某子串的出现次数（非重叠） */
export function countOccurrences(text: string, sub: string): number {
  if (!sub) return 0;
  let count = 0;
  let idx = text.indexOf(sub);
  while (idx !== -1) {
    count++;
    idx = text.indexOf(sub, idx + sub.length);
  }
  return count;
}

/** 提取命中片段（词条在原文中的上下文，最长 24 字符） */
function makeSnippet(text: string, idx: number, len: number): string {
  const start = Math.max(0, idx - 4);
  const end = Math.min(text.length, idx + len + 4);
  return text.slice(start, end);
}

/** 定位命中处的行号（首个命中） */
export function locateLine(text: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/** 从 novel constraints(taboo/禁用类) 提取扫描规则（批次2 · 动态语料桥接）。
 *  tokens 为提取出的词条数组（通常来自 constraint.statement 的逗号/顿号分隔词条）。
 *  设计：复用现有约束体系（o_agentWorkData.constraints），不新建数据表/路由。
 *  分类约定：rule 前缀 "poison:" 词条入零容忍；默认入 density（限频，threshold > 1 才报）。 */
export interface ConstraintToRuleOptions {
  /** density 类的默认阈值（不满足即视为低频可容忍） */
  defaultThreshold?: number;
}

export function rulesFromConstraintTokens(
  tokens: string[],
  opts: ConstraintToRuleOptions = {},
): BannedWordRule[] {
  const threshold = opts.defaultThreshold ?? 1;
  return tokens
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      if (t.startsWith("poison:")) return { word: t.slice("poison:".length), kind: "poison" as const };
      return { word: t, kind: "density" as const, threshold };
    });
}

/** 从 NovelConstraint 数组里取 type=taboo 且 status 生效的条目，抽取其 statement 中的词条。
 *  词条分隔支持中英文逗号、顿号、分号、换行。合并到传入的规则集（不覆盖已有，map 合并语义）。 */
export function mergeConstraintRules(
  constraints: Array<{ type?: string; statement?: string; status?: string }>,
  ruleSet: Map<string, BannedWordRule>,
  opts: ConstraintToRuleOptions = {},
): Map<string, BannedWordRule> {
  const merged = new Map(ruleSet);
  for (const c of constraints) {
    if (c.type !== "taboo" || c.status === "resolved") continue;
    if (typeof c.statement !== "string" || !c.statement.trim()) continue;
    const tokens = c.statement.split(/[,，、;/]/);
    for (const r of rulesFromConstraintTokens(tokens, opts)) merged.set(r.word, r);
  }
  return merged;
}

/**
 * 扫描文本命中禁用词。
 *
 * @param text 正文章节文本（frontmatter 已在外部剥除）
 * @param ruleSet 词表（Map）。缺省用默认内置表
 * @returns 问题列表；零命中返回 []
 *
 * 语义：
 * - poison 类：每命中一次报一条 [BANNED]
 * - density 类：统计全章次数，>= threshold 报一条 [RATIO]（附 count）；低于 threshold 不报
 */
export function scanBannedWords(text: string, ruleSet?: Map<string, BannedWordRule>): BannedScanIssue[] {
  const rules = ruleSet ?? buildRuleSet(DEFAULT_BANNED_WORDS);
  const issues: BannedScanIssue[] = [];
  const densitySeen = new Set<string>();

  for (const [word, rule] of rules) {
    if (rule.kind === "poison") {
      let idx = text.indexOf(word);
      while (idx !== -1) {
        issues.push({
          type: "BANNED",
          word,
          kind: "poison",
          snippet: makeSnippet(text, idx, word.length),
          count: 1,
          line: locateLine(text, idx),
        });
        idx = text.indexOf(word, idx + word.length);
      }
    } else {
      // density：全章统计一次
      const count = countOccurrences(text, word);
      const threshold = rule.threshold ?? 1;
      if (count >= threshold && !densitySeen.has(word)) {
        densitySeen.add(word);
        const idx = text.indexOf(word);
        issues.push({
          type: "RATIO",
          word,
          kind: "density",
          snippet: idx === -1 ? "" : makeSnippet(text, idx, word.length),
          count,
          threshold,
          line: idx === -1 ? undefined : locateLine(text, idx),
        });
      }
    }
  }
  return issues;
}
