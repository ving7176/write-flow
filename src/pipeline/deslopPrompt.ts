/**
 * 去 AI 味修复 prompt 组装（deslop action 专用，纯函数；去AI味三层融合方案·修复层）。
 *
 * 检测驱动修复（novel-creator-skill text_humanizer.py 的 prompt 子命令同款思路）：
 * 扫描命中清单 + AI 味密度分档（story-deslop 量化标准：≤5/千字轻度、6-15 中度、>15 重度）
 * → 两遍式自审指令（第一遍按清单清除 → AI 自审列 3-5 条残留 → 第二遍修正，单次调用内完成）。
 */
import { buildRuleSet, scanBannedWords, scanSlopPatterns } from "@/pipeline/bannedWordScan";
import { DESLOP_RULES } from "@/pipeline/deslopLexicon";

export type DeslopTier = "light" | "medium" | "heavy";

export interface DeslopHitList {
  tier: DeslopTier;
  /** 每千字零容忍命中数（poison 词 + hard 句式） */
  hardPerKilo: number;
  /** 回灌 prompt 的命中清单（Markdown 列表；零命中返回空串） */
  block: string;
}

/** 组装去AI味命中清单与分档：poison 词 + hard 句式计密度定档，命中按词聚合（同词多处合并计数） */
export function buildDeslopHitList(text: string, whitelist: readonly string[] = []): DeslopHitList {
  const kilo = Math.max(text.replace(/\s/g, "").length, 1) / 1000;
  const wordIssues = scanBannedWords(text, buildRuleSet(DESLOP_RULES), whitelist);
  const slopIssues = scanSlopPatterns(text, undefined, whitelist);
  const hardHits = [...wordIssues.filter((i) => i.kind === "poison"), ...slopIssues.filter((i) => i.kind === "poison")];
  const softHits = [...wordIssues.filter((i) => i.kind === "density"), ...slopIssues.filter((i) => i.kind === "density")];
  const hardPerKilo = hardHits.length / kilo;
  const tier: DeslopTier = hardPerKilo <= 5 ? "light" : hardPerKilo <= 15 ? "medium" : "heavy";
  // hard 命中按词聚合（同一词多处命中给一行计数，避免清单被重复词占满）；soft 命中扫描器已按词聚合
  const agg = new Map<string, { count: number; snippet: string; line?: number; threshold?: number; soft: boolean }>();
  for (const i of hardHits) {
    const a = agg.get(i.word);
    if (a) a.count++;
    else agg.set(i.word, { count: 1, snippet: i.snippet, line: i.line, soft: false });
  }
  for (const i of softHits) {
    agg.set(`${i.word}(限频)`, { count: i.count, snippet: i.snippet, line: i.line, threshold: i.threshold, soft: true });
  }
  const lines = [...agg.entries()].slice(0, 30).map(([word, a]) =>
    a.soft
      ? `- [限频] ${word} x${a.count}${a.threshold ? `（阈值 ${a.threshold}）` : ""}：…${a.snippet}…`
      : `- [零容忍] ${word} x${a.count}（行 ${a.line ?? "-"}）：…${a.snippet}…`,
  );
  return { tier, hardPerKilo: Math.round(hardPerKilo * 10) / 10, block: lines.join("\n") };
}

const TIER_LABEL: Record<DeslopTier, string> = { light: "轻度", medium: "中度", heavy: "重度" };
const TIER_SCOPE: Record<DeslopTier, string> = {
  light: "只处理禁用词与 AI 味句式",
  medium: "处理禁用词、AI 味句式，并做情绪落地与节奏调整",
  heavy: "全量处理：禁用词、句式、情绪落地、节奏、对话腔调、章末收束",
};

/** 两遍式自审指令（tier 决定处理范围，防过度改写；替换不复用原则防新模板指纹） */
export function deslopTwoPassInstructions(tier: DeslopTier): string {
  return [
    `AI 味等级：${TIER_LABEL[tier]}（处理范围：${TIER_SCOPE[tier]}）。`,
    "按两遍式执行：",
    "第一遍：对照命中清单逐类清除——零容忍词替换为具体动作/细节/后果（展示替代告知，禁止同义词轮换，同词多处命中各处给不同写法）；句式问题删掉否定铺垫直接写后项；解释腔/上帝视角叙述改为角色视角内呈现。",
    "第二遍：改完后自问「这段文字哪些地方还是明显 AI 生成的感觉」，列出 3-5 条残留问题并针对性修正，只输出最终稿。",
    "硬约束：不新增情节/设定/关系；不整段删除正文；篇幅变化不超过 ±10%；未涉及段落原样保留。",
  ].join("\n");
}
