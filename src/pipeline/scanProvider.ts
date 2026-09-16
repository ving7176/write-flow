import type { ScanIssue } from "@/agents/novelAgent/supervision";
import { scanBannedWords, scanSlopPatterns, DEFAULT_SLOP_PATTERNS, type BannedWordRule } from "@/pipeline/bannedWordScan";
import { DESLOP_RULES } from "@/pipeline/deslopLexicon";
import { detectRepeats } from "@/pipeline/repeatDetect";
import { computeDescriptionRatio } from "@/pipeline/descriptionRatio";
import { checkChapterWords } from "@/pipeline/chapterWords";
import { scanEraAnachronism, deriveWorldEraFromConstraints, deriveTransportExemption } from "@/pipeline/eraScan";
import { mergeConstraintRules, buildRuleSet } from "@/pipeline/bannedWordScan";
import { detectHumorSignals } from "@/pipeline/humorSignal";

/**
 * 章节代码扫描 provider 工厂（P0-1）：给定正文 → 4 扫描器联合输出 ScanIssue[]。
 * 供 autoRepairChapter 的 scanProvider 使用（每轮重生成稿重扫）。
 *
 * 红线映射（对齐 xianxia 校准）：
 *  - [BANNED] poison 禁用词 / [REPEAT] 完全重复句 / [DESC] 描写>30% → hard=true（触发返工）
 *  - [RATIO] 限频词 / [APPROX] 近似句 / [WORD] 字数超 soft / [DESC] 未超红线但偏高 → hard=false（报告级）
 *
 * 词表：运行时由约束（taboo）合并，调用方可传 baseRules；缺省内置。
 */

export type ScanProvider = (content: string) => ScanIssue[];

export function createChapterScanProvider(options?: {
  bannedRules?: BannedWordRule[];
  wordMin?: number;
  wordMax?: number;
  /** 去AI味白名单（workData.config.deslopWhitelist）：命中位置附近含白名单字面片段则豁免（防世界观术语误报） */
  deslopWhitelist?: string[];
  /**
   * 世界观时代（修复③的章节路径缺口）：非章节扫描已从 era 约束 derive 传入，
   * 章节扫描器漏传 → 现代题材章节的「手机/直播」全被缺省 ancient 报 [ERA] 硬红线，
   * 触发误返工（E2E 实测：A 级稿被「修复时代错位」重写后劣化 A→B）。
   * 不传时保持 scanEraAnachronism 的 ancient 缺省（保守口径）。
   */
  worldEra?: "modern" | "ancient";
  /** 穿越豁免（结构化）：穿越者/携带物语境现代词合法，本土穿帮仍报 */
  transportExemption?: import("@/pipeline/eraScan").TransportExemption;
}): ScanProvider {
  const bannedRules = options?.bannedRules ?? undefined;
  const wordMin = options?.wordMin ?? 2850;
  const wordMax = options?.wordMax ?? 3050;
  const deslopWhitelist = options?.deslopWhitelist ?? [];
  const worldEra = options?.worldEra;
  const transportExemption = options?.transportExemption;

  return (content: string): ScanIssue[] => {
    const issues: ScanIssue[] = [];

    // 1. 禁用词（去AI味词表 DESLOP_RULES 恒定并入，运行时约束词条后置覆盖——constraints 优先级最高）
    const ruleMap = buildRuleSet([...DESLOP_RULES, ...(bannedRules ?? [])]);
    const banned = scanBannedWords(content, ruleMap, deslopWhitelist);
    for (const b of banned) {
      issues.push({
        type: "BANNED",
        text: `[BANNED] 禁用词「${b.word}」x${b.count}` + (b.word.length ? `（上下文：${b.snippet || "—"}${b.line ? `，行 ${b.line}` : ""}）` : ""),
        hard: b.kind === "poison",
      });
    }

    // 1b. AI 味句式（SLOP：hard=确定性句式触发返工，soft=报告级；去AI味三层融合方案·检测层）
    const slop = scanSlopPatterns(content, DEFAULT_SLOP_PATTERNS, deslopWhitelist);
    for (const s of slop) {
      issues.push({
        type: "SLOP",
        text: `[SLOP] AI味句式「${s.word}」x${s.count}（上下文：${s.snippet || "—"}${s.line ? `，行 ${s.line}` : ""}）`,
        hard: s.kind === "poison",
      });
    }

    // 2. 雷同句（完全重复硬红线；近似句报告级）
    const repeats = detectRepeats(content);
    for (const r of repeats) {
      if (r.type === "REPEAT") {
        issues.push({ type: "REPEAT", text: `[REPEAT] 完全重复句：「${r.text}」（行 ${r.line}）`, hard: true });
      } else {
        const sim = r.similarity != null ? `（相似度 ${(r.similarity * 100).toFixed(0)}%）` : "";
        issues.push({ type: "APPROX", text: `[APPROX] 近似句疑似「${r.text}」${sim}（行 ${r.line}）`, hard: false });
      }
    }

    // 3. 描写（P0-2 校准后判定口径变更）：
    //    - 连续静态写景 >120 字 → 硬红线（staticSceneryExceeded，可靠标准，对齐 xianxia static_desc_limit）
    //    - 占比 30% 红线 → 报告级参考（启发式对对话为主章节误报，不单独作硬红线）
    const desc = computeDescriptionRatio(content);
    if (desc.totalChars > 0) {
      const pct = (desc.ratio * 100).toFixed(0);
      if (desc.staticSceneryExceeded) {
        issues.push({ type: "DESC", text: `[DESC] 连续静态写景超限（>120 字无动作无对话，疑似水文）`, hard: true });
      } else if (desc.overLimit) {
        issues.push({ type: "DESC", text: `[DESC] 描写占比约 ${pct}% 超 30% 参考线（连续静态写景未超限，供作者收敛）`, hard: false });
      } else if (desc.ratio > 0.25) {
        issues.push({ type: "DESC", text: `[DESC] 描写占比约 ${pct}% 偏高（建议收敛）`, hard: false });
      }
    }

    // 4. 单章字数（B2 代码硬闸加强：区间外一律 hard——不足不许通过（拒绝入库由调用端裁决），超限同样不放行；
    //    原 85% 容差与 soft 超限缓冲废除：容差只让残次稿溜进库（E2E 实测 1484/2018 字稿入库的病灶））
    const words = checkChapterWords(content, { min: wordMin, max: wordMax });
    if (words.count < wordMin) {
      issues.push({ type: "WORD", text: `[WORD] 章节字数 ${words.count} < 下限 ${wordMin}，必须补足至 ${wordMin}-${wordMax} 字（在既有内容上扩写场景/对话/动作，禁止重写已写好的部分）`, hard: true });
    } else if (words.count > wordMax) {
      issues.push({ type: "WORD", text: `[WORD] 章节字数 ${words.count} > 上限 ${wordMax}，压缩冗余描写/对话至 ${wordMin}-${wordMax} 字（禁止整段删除剧情功能）`, hard: true });
    }

    // 5. 时代错位（非现代世界观命中现代词 → [ERA] 硬红线，HARD_REDLINE_TYPES 含 ERA）
    const era = scanEraAnachronism(content, { ...(worldEra ? { worldEra } : {}), ...(transportExemption ? { transportExemption } : {}) });
    for (const e of era) {
      issues.push({ type: "ERA", text: `[ERA] 时代错位「${e.word}」出现在非现代世界观（行 ${e.line}）`, hard: true });
    }

    // 6. 幽默信号（报告级：连续 2 章零幽默红线由监督层依据 cross-chapter 判定，本模块给单章信号）
    const humor = detectHumorSignals(content);
    if (humor.totalChars > 200 && !humor.hasSignal) {
      issues.push({ type: "HUMOR", text: `[HUMOR] 本章未检出幽默信号（反差/自嘲/戏仿/拌嘴），供「连续 2 章零幽默」红线参考`, hard: false });
    }

    return issues;
  };
}

/**
 * 通用阶段代码扫描 provider 工厂（P1c 双轨：非章节阶段确定性硬校验，不依赖 LLM 评级）。
 *
 * 与 createChapterScanProvider 的区别：只保留**阶段无关**的确定性硬规则——
 * BANNED(poison 禁用词) / REPEAT(完全重复句) / ERA(时代错位)，任何阶段文本都适用。
 * WORD(章字数 2850-3050) / HUMOR(幽默信号) / DESC(描写比例) / APPROX(近似句) 是章节正文专属，
 * 对 synopsis/outline 等概述性产物会误报，故不纳入。
 *
 * 词表：运行时由约束（taboo）合并，调用方可传 bannedRules；缺省内置。
 */
export function createGenericScanProvider(options?: {
  bannedRules?: BannedWordRule[];
  worldEra?: "modern" | "ancient" | "xianxia";
  /** 穿越豁免（结构化）：穿越者/携带物语境现代词合法，本土穿帮仍报 */
  transportExemption?: import("@/pipeline/eraScan").TransportExemption;
}): ScanProvider {
  const bannedRules = options?.bannedRules ?? undefined;
  const worldEra = options?.worldEra;
  const transportExemption = options?.transportExemption;

  return (content: string): ScanIssue[] => {
    const issues: ScanIssue[] = [];

    // 1. 禁用词（poison 零容忍 → 硬红线；density 限频词属章节节奏语义，此处不报）
    const banned = scanBannedWords(content, new Map((bannedRules ?? []).map((r) => [r.word, r])));
    for (const b of banned) {
      if (b.kind !== "poison") continue;
      issues.push({
        type: "BANNED",
        text: `[BANNED] 禁用词「${b.word}」x${b.count}` + (b.word.length ? `（上下文：${b.snippet || "—"}${b.line ? `，行 ${b.line}` : ""}）` : ""),
        hard: true,
      });
    }

    // 2. 完全重复句 → 硬红线
    for (const r of detectRepeats(content)) {
      if (r.type === "REPEAT") {
        issues.push({ type: "REPEAT", text: `[REPEAT] 完全重复句：「${r.text}」（行 ${r.line}）`, hard: true });
      }
    }

    // 3. 时代错位（非现代世界观命中现代词 → 硬红线）。worldEra 未传 = 世界观时代未声明
    //    （brief 首产前 era 约束尚未建立）→ 跳过 ERA：无判定依据不猜（缺省 ancient 曾把现代
    //    题材设定文档的现代词全部误报，E2E 实测门禁停机）；BANNED/REPEAT 与世界观无关照跑
    for (const e of worldEra ? scanEraAnachronism(content, { worldEra, ...(transportExemption ? { transportExemption } : {}) }) : []) {
      issues.push({ type: "ERA", text: `[ERA] 时代错位「${e.word}」出现在非现代世界观（行 ${e.line}）`, hard: true });
    }

    return issues;
  };
}

/**
 * 治本2b 规则单点化：novel 线扫描上下文唯一组装点——era/transport 推导 + 禁忌词合并
 * 曾在 stageEngine（非章节）与 novelAgent/index（章节）两处各写一份样板，修复只改手边
 * 那条路径导致「章节 ERA 缺口」类漏改（E2E 实测）。所有 novel 扫描入口一律经此函数。
 *
 * 约定：era 约束未建立（brief 首产前）→ worldEra undefined → 扫描器跳过 ERA（宁缺勿杀）。
 */
export function buildNovelScanContext(
  constraints: Array<{ type?: string; subject?: string; statement?: string; status?: string }>,
): {
  bannedRules: BannedWordRule[];
  worldEra?: "modern" | "ancient";
  transportExemption?: import("@/pipeline/eraScan").TransportExemption;
} {
  const bannedRules = Array.from(mergeConstraintRules(constraints, buildRuleSet([])).values());
  const hasEraConstraint = constraints.some((c) => c?.type === "era");
  const worldEra = hasEraConstraint ? deriveWorldEraFromConstraints(constraints) : undefined;
  const transportExemption = deriveTransportExemption(constraints);
  return { bannedRules, ...(worldEra ? { worldEra } : {}), ...(transportExemption ? { transportExemption } : {}) };
}
