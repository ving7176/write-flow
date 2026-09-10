/**
 * 去 AI 味词表（deslop lexicon · 去AI味三层融合方案·检测层）。
 *
 * 来源（三方合并去重，均 MIT）：
 * - oh-story-claudecode story-deslop references/banned-words.md 一级禁用词
 * - novel-creator-skill scripts/text_humanizer.py AI_VOCAB
 * - 本仓 bannedWordScan.DEFAULT_BANNED_WORDS poison 词条 + xianxia 扫描史实证（淡淡道）
 *
 * 分级原则（story-deslop 番茄高分样本校准：高频词不可 0 容忍硬禁令）：
 * - DESLOP_POISON_WORDS：真人语料几乎不出现的 AI 特有词/套话 → 零容忍（hard，命中触发返工）
 * - DESLOP_CONTEXT_SENSITIVE：正常文本也高频的语境敏感词 → density 限频每词每章 ≤3（soft 报告级）
 * - DESLOP_ADVERB_GROUP：弱化副词组共享配额，每千字合计 ≤3（soft 报告级）
 * - 明确排除：坚定/冰冷/深邃/凛冽类普通形容词（两来源的自身校准均反对对其硬禁）
 *
 * 同步约定（人工三处对齐）：本词表 ↔ novel_execution.md 第八节（prompt 侧词表）↔
 * novel_deslop.md（叙事姿态规范）；词条增删需同步检查另两处。
 */
import type { BannedWordRule } from "@/pipeline/bannedWordScan";

/** 零容忍 AI 特有词（poison，逐次命中逐条报） */
export const DESLOP_POISON_WORDS: string[] = [
  // 比喻/感知套话（text_humanizer AI_VOCAB + story-deslop 情态类；仿佛/如同/好似属高频语境词入 density）
  "不禁",
  "犹如",
  "宛如",
  "宛若",
  "恍若",
  "仿若",
  // 视觉过渡套话
  "映入眼帘",
  "涌入眼帘",
  "跃入眼帘",
  // 时间膨胀
  "此时此刻",
  "就在此时",
  "恰在此时",
  "在这一刻",
  // 内心独白套话
  "心中暗道",
  "心中暗想",
  "暗自思忖",
  "心中一动",
  "心中一凛",
  "心念一动",
  "心头一震",
  "心下了然",
  "心底泛起",
  // 对话标签套话
  "沉声道",
  "淡淡地说",
  "淡淡道",
  "轻声道",
  "缓缓说道",
  "淡然道",
  "漠然道",
  // 反应/动作套话
  "脸色一变",
  "神情一凛",
  "眉头微皱",
  "身形一顿",
  "脚步一顿",
  "身子微微一颤",
  // 表情/微动作模板（story-deslop 表情类）
  "眼中闪过",
  "嘴角微扬",
  "嘴角勾起",
  "勾起一抹弧度",
  "眉眼低垂",
  "瞳孔微缩",
  "瞳孔收缩",
  "瞳孔一缩",
  "指节泛白",
  "眼神锐利",
  "目光锐利",
  // 眼睛描写套话
  "目光如炬",
  "目光深邃",
  "深邃的眸子",
  // 动作套话
  "深吸一口气",
  // 场景过渡套话（「只见」已移出：老牛 200 章校准撞「只见过」子串 2 例误报，precision 优先；
  // 回收需改否定后顾正则，见 deslop-audit 调参名单）
  "但见",
  // 情感套话
  "感慨良多",
  "百感交集",
  // 主体性剥夺词
  "不由得",
  "不由自主",
  "情不自禁",
  // 判断类（评论性插入）
  "不容置疑",
  "不容置喙",
  "不易察觉",
  "显而易见",
  "毫无疑问",
  "不可否认",
  "前所未有",
  "闪烁着光芒",
  "狡黠",
  // 过渡套话
  "话锋一转",
  // 语境标志词
  "毫无征兆",
  "几不可闻",
  "微不可察",
  // 本仓既有 poison（DEFAULT_BANNED_WORDS）
  "嘴里念念有词",
  "一见面就",
];

/** 语境敏感词（density：正常文本也高频，每词每章 threshold 3 才报，soft） */
export const DESLOP_CONTEXT_SENSITIVE: string[] = [
  "突然",
  "陡然",
  "骤然",
  "猛然",
  "猛地",
  "好像",
  "似乎",
  "仿佛",
  "如同",
  "好似",
  "死死地",
  "一丝",
  "一抹",
  "些许",
  "几分",
  "隐约",
];

/** 弱化副词组（density group：组内共享配额，每千字合计 ≤perKilo 才报，soft） */
export const DESLOP_ADVERB_GROUP = {
  name: "弱化副词",
  perKilo: 3,
  words: ["微微", "淡淡", "缓缓", "轻轻", "悄悄", "悄然", "深深", "静静", "慢慢", "默默", "暗暗", "隐隐", "渐渐", "徐徐"],
} as const;

/** 组装后的去味规则表（poison + 语境敏感 density + 弱化副词组） */
export const DESLOP_RULES: BannedWordRule[] = [
  ...DESLOP_POISON_WORDS.map((word) => ({ word, kind: "poison" as const })),
  ...DESLOP_CONTEXT_SENSITIVE.map((word) => ({ word, kind: "density" as const, threshold: 3 })),
  ...DESLOP_ADVERB_GROUP.words.map((word) => ({
    word,
    kind: "density" as const,
    group: DESLOP_ADVERB_GROUP.name,
    perKilo: DESLOP_ADVERB_GROUP.perKilo,
  })),
];
