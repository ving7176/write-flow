/**
 * 章节监督报告解析与红线判定（afterSubAgent 自动返工闭环用）。
 *
 * 监督 skill（novel_agent_supervision.md）输出 <supervisionReport>，issues 每条带类型标签：
 * - [LOGIC]/[ABILITY]/[KNOWLEDGE]/[ERA]/[NUMERIC] → hard 红线（自动返工）
 * - [OTHER] / 无标签 → 报告交人工（不自动返工）
 *
 * 报告是 LLM 自由输出，解析失败返回 null（调用方降级：不阻断、不返工）。
 */

import type { NumericViolation } from "@/pipeline/constraintChecker";
import { verifyConstraintRefs } from "@/pipeline/constraintChecker";

/** hard 红线类型（命中即触发自动重生成） */
export const HARD_REDLINE_TYPES = new Set(["LOGIC", "ABILITY", "KNOWLEDGE", "ERA", "NUMERIC"]);

/** 统一扫描器命中项结构（P0-1：代码扫描结果接入返工闭环） */
export interface ScanIssue {
  /** 标签：BANNED / REPEAT / APPROX / DESC / RATIO / WORD */
  type: string;
  text: string;
  /** true=硬红线（HARD_REDLINE_TYPES 判定）；false=报告级（仅回灌提示，不强制重生成） */
  hard: boolean;
}

/**
 * 把扫描器命中项映射为监督 issue 列表，并标记是否触发返工（P0-1）。
 * 红线规则（对齐 xianxia 校准与现有红线）：
 *  - [BANNED]/[REPEAT]/[DESC]（描写>30%）→ 硬红线（文案附原文+行号，便于回灌）
 *  - [APPROX]/[RATIO]/[WORD]（字数超 soft）→ 报告级，仅提示不返工
 */
export function mapScanIssuesToSupervision(scanIssues: ScanIssue[]): SupervisionIssue[] {
  return scanIssues.map((s) => ({ type: s.type, text: s.text }));
}

/** 扫描器命中项中属于硬红线的（供 autoRepairChapter 并入 hardIssues） */
export function hardScanIssues(scanIssues: ScanIssue[]): SupervisionIssue[] {
  return scanIssues.filter((s) => s.hard).map((s) => ({ type: s.type, text: s.text }));
}

/** 自定义红线集合（新增 BANNED/REPEAT/DESC 为硬红线，仅扫描器路径用，不污染原有 5 类语义） */
export function isScanHardTrace(issue: SupervisionIssue): boolean {
  return HARD_REDLINE_TYPES.has(issue.type) || issue.type === "BANNED" || issue.type === "REPEAT" || issue.type === "DESC";
}

export interface SupervisionIssue {
  /** 类型标签（LOGIC/ABILITY/KNOWLEDGE/ERA/NUMERIC/OTHER） */
  type: string;
  text: string;
}

export interface SupervisionReport {
  grade: string;
  summary: string;
  issues: SupervisionIssue[];
  maxRisk: string;
  /** 批次2：可选结构化指标（<metrics> JSON 块：爽点数/钩子落地/字数偏差等，检查度量落表用） */
  metrics?: Record<string, unknown>;
}

/** 解析 <metrics> JSON 块（批次2；可缺失——旧报告/未输出时返回 null） */
export function parseMetricsBlock(raw: string): Record<string, unknown> | null {
  const m = raw.match(/<metrics>([\s\S]*?)<\/metrics>/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1].trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 解析 <supervisionReport>：提取 grade/summary/maxRisk + issues（markdown 列表逐行解析，带类型标签）+ metrics。
 * @returns 结构化报告；标签缺失或格式无法解析返回 null
 */
export function parseSupervisionReport(raw: string): SupervisionReport | null {
  // 容错（MiMo 系模型）：先剥 ``` 代码围栏再匹配——模型常把结构化 XML 包进围栏输出
  const cleaned = (raw ?? "").replace(/```[a-zA-Z]*\n?/g, "");
  const m = cleaned.match(/<supervisionReport>([\s\S]*?)<\/supervisionReport>/);
  if (!m) return null;
  const body = m[1];
  const grade = body.match(/<grade>([\s\S]*?)<\/grade>/)?.[1]?.trim() ?? "";
  const summary = body.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() ?? "";
  const maxRisk = body.match(/<maxRisk>([\s\S]*?)<\/maxRisk>/)?.[1]?.trim() ?? "";
  // issues 为 markdown 列表：`- [TYPE] 问题描述（引用位置）`，逐行解析（<issues> 块内）
  const issuesBlock = body.match(/<issues>([\s\S]*?)<\/issues>/)?.[1] ?? "";
  const issues: SupervisionIssue[] = [];
  for (const line of issuesBlock.split("\n")) {
    const im = line.match(/-\s*\[([A-Z]+)\]\s*(.+)/);
    if (im) issues.push({ type: im[1], text: im[2].trim() });
  }
  return { grade, summary, issues, maxRisk, metrics: parseMetricsBlock(body) ?? undefined };
}

/** hard 红线判定（命中类型集合即自动返工） */
export function isHardRedline(issue: SupervisionIssue): boolean {
  return HARD_REDLINE_TYPES.has(issue.type);
}

// ── 章节返工择优（P1a：返工稿劣化即止损，防「B 级初稿被 D 级返工稿覆盖」）──

/** 监督评级 → 质量分（A=4/B=3/C=2/D=1；未知/缺失=0 视为最差，不采用） */
const GRADE_RANK: Record<string, number> = { A: 4, B: 3, C: 2, D: 1 };

export function gradeRankOf(grade: string): number {
  const g = (grade ?? "").trim().toUpperCase();
  return GRADE_RANK[g] ?? 0;
}

/**
 * 稿质量对比（B2 字数前置维）：**字数不达标者永远输**（字数不足不许通过，即使评级更高也不保留残次稿）；
 * 双方达标时评级高者优；评级相同 hard 红线数少者优。返回 >0=a 更优，<0=a 更差，0=平
 */
export function compareQuality(
  a: { rank: number; hardCount: number; wordOk?: boolean },
  b: { rank: number; hardCount: number; wordOk?: boolean },
): number {
  const aw = a.wordOk !== false;
  const bw = b.wordOk !== false;
  if (aw !== bw) return aw ? 1 : -1;
  if (a.rank !== b.rank) return a.rank - b.rank;
  return b.hardCount - a.hardCount;
}

// ── 跨章监督触发（P2 三层架构）与 5 章语义（纯函数，可单测） ──

/**
 * 层2 中期核查触发判定（每 5 章，状态机固定间隔）：
 * 用 lastMidterm+5 而非 chapterNo%5==0——删章/重写后也能正确推进，不会卡在倍数。
 */
export function midtermDue(chapterNo: number, lastMidterm: number): boolean {
  return chapterNo >= lastMidterm + 5;
}

/** 层3 里程碑终审触发判定（每 10 章，同上状态机语义） */
export function milestoneDue(chapterNo: number, lastMilestone: number): boolean {
  return chapterNo >= lastMilestone + 10;
}

/** 单次连写上限：放开到 10 章（对齐 xianxia 一句话写 10 章；chat 入口按目标联动 aiCallBudget） */
export const CHAPTER_TARGET_MAX = 10;

/**
 * 解析单次对话目标章数：从用户消息提取「写/生成/续写 N 章」，
 * clamp 到 1~10；未匹配返回 1（单章）。按钮路径 text 为空 → 1。
 */
export function parseChapterTarget(text: string | undefined): number {
  const m = (text ?? "").match(/(?:写|生成|续写|连写|要)\s*(\d+)\s*章/);
  if (!m) return 1;
  const raw = Number(m[1]);
  return Math.max(1, Math.min(Number.isFinite(raw) ? raw : 1, CHAPTER_TARGET_MAX));
}

// ── 章节自动修复闭环（afterSubAgent 调用，抽离为纯函数便于单测） ──

export interface RepairChapterInput {
  reel?: string;
  chapter?: string;
  content?: string;
}

/** 修复闭环依赖的最小工具接口（stageTools 的鸭子类型，测试可 mock；ai SDK Tool.execute 返回类型宽，用 unknown 收敛） */
export interface RepairStageTools {
  run_sub_agent_supervision: {
    execute?: (input: { prompt: string }, opts: unknown) => unknown;
  };
  chapter: {
    execute?: (input: { prompt: string }, opts: unknown) => unknown;
  };
  /** B2：章节字数下限（供 best 择优与 continue 式返工判定；缺省用 WORD_TARGET） */
  chapterWordMin?: number;
}

export interface RepairResult {
  raw: string;
  parsed: unknown;
  /** 实际重生成次数（0=首稿即通过） */
  attempts: number;
  /** 最终是否通过红线审核（false=重试耗尽落库交人工） */
  passed: boolean;
  /** 最优稿监督评级（P1c 章节质量门禁：C/D 时 full 模式强制停交人工） */
  grade?: string;
  /** B2 字数硬闸：全部稿（含 best）字数未达标 → 调用方拒绝落库（不足不许通过），本章标失败 */
  wordRejected?: boolean;
}

/** 从工具返回值提取 raw 字符串（ai SDK execute 返回 {raw, parsed?, error?} 或 string 或流，只认对象形态的 raw） */
function extractRaw(resp: unknown): string {
  if (resp && typeof resp === "object" && !Array.isArray(resp)) {
    const raw = (resp as Record<string, unknown>).raw;
    if (typeof raw === "string") return raw;
  }
  return "";
}

/** 从工具返回值提取字段（对象形态窄化） */
function extractField(resp: unknown, field: string): unknown {
  if (resp && typeof resp === "object" && !Array.isArray(resp)) {
    return (resp as Record<string, unknown>)[field];
  }
  return undefined;
}

/** 构造监督审核 prompt（当前稿正文，截断 3000 字） */
export function buildSupervisionPrompt(current: RepairChapterInput): string {
  return `请审核刚生成的章节：\n卷：${current.reel ?? ""}\n章名：${current.chapter ?? ""}\n正文：\n${(current.content ?? "").slice(0, 3000)}\n\n请按审核规范输出审核报告。`;
}

/** 构造重生成 prompt（约束回灌：违反的约束 + 证据；措辞用「交代来源」而非「改写情节」，避免为自洽写僵硬） */
/** 章节目标字数下限（与 createChapterScanProvider 缺省 wordMin=2850 同源；告警文案用） */
const WORD_TARGET = 2850;

/** D 试点：hard 问题分类修正策略——整章重写是返工稿稳定劣化的根因（E2E 实测 B→D/B→C），
 *  改为「保留未涉内容、只定点修问题段」；best 择优仍兜底（劣化稿不落库，试点安全） */
const REPAIR_STRATEGY: Record<string, string> = {  BANNED: "替换为具体动作/细节/后果（展示替代告知），禁止同义词轮换替换（同词多处命中各处给不同写法，防止替换产物成为新模板指纹），未涉及段落原样保留",
  ERA: "若该现代词属穿越者合法持有（约束已声明穿越设定）则保留并补一句交代来源；否则替换为世界观内的等价表达",
  REPEAT: "保留其中一处重复句，其余改写为同义表达，维持上下文连贯",
  DESC: "压缩静态写景/冗余描写至符合红线（连续写景>120字拆散或删减），保留动作与对话推进",
  WORD: "若超量则删减冗余段落至目标字数；若字数不足则在现有内容基础上扩写补足（展开场景、细化对话与动作），不重写已写好的部分",
  NUMERIC: "修正与账本/约束冲突的数值条目，保留其余内容",
  LOGIC: "修复该处逻辑断点（衔接/因果/来源），保留其余情节",
  OTHER: "针对问题定点修改，未涉及内容原样保留",
};

export function buildRepairPrompt(current: RepairChapterInput, hardIssues: SupervisionIssue[]): string {
  // B2 续写补足分支：**仅** WORD 类硬伤（正文达标线问题）时走续写式补足——
  // 整章重生成有缩短方差（E2E 实测：2521 字稿两轮返工越修越短被拒收），续写是对短稿唯一稳定的修法
  if (hardIssues.length > 0 && hardIssues.every((i) => i.type === "WORD")) {
    return buildWordContinuePrompt(current, hardIssues);
  }
  const byType = new Map<string, SupervisionIssue[]>();
  for (const i of hardIssues) byType.set(i.type, [...(byType.get(i.type) ?? []), i]);
  const guidance = [...byType.entries()].map(
    ([type, items]) =>
      `### ${type}（${items.length} 处）\n${items.map((i) => `- [${type}] ${i.text}`).join("\n")}\n修正方式：${REPAIR_STRATEGY[type] ?? REPAIR_STRATEGY.OTHER}`,
  );
  const wordHint = byType.has("WORD") ? `- 存在字数问题：修正稿正文字数**必须达到约 ${WORD_TARGET} 字**（不含标点空行的正文主体），交付前自行清点` : "";
  return [
    `你上一稿章节存在以下问题，请**定点修正**（不是整章重写）：`,
    "",
    ...guidance,
    "",
    "定点修正要求：",
    "- **原样保留所有未涉及问题的段落、对话与叙事**——它们没有错，整章重写反而引入新问题（此前实测返工稿常劣化于原稿）",
    "- 仅针对问题段做最小改动：替换违禁表述、压缩冗余描写、修正数值/逻辑、补足或删减字数",
    wordHint,
    "- 问题涉及金钱/物品/能力/知识来源时，必须交代合理的获取或习得途径，严禁凭空获得",
    "- 必须遵守本书已确立的硬约束（见工作区数据），修复后不得引入新的矛盾",
    "- 输出**完整章节全文**（不是补丁），篇幅与原文相近",
  ].filter(Boolean).join("\n");
}

/** 字数不足的续写补足 prompt（B2）：原文逐字保留，只从结尾自然续写到达标——不触发整章重写的缩短方差 */
export function buildWordContinuePrompt(current: RepairChapterInput, issues: SupervisionIssue[]): string {
  const content = current.content ?? "";
  const curChars = content.replace(/\s+/g, "").length;
  // gap 补偿系数：模型续写实际输出 ≈ 要求的 2/3（E2E 实测要求 400 实补 266），缓冲 +300 保证一次过线
  const gap = Math.max(WORD_TARGET + 300 - curChars, 200);
  const tail = content.slice(-200);
  const issueText = issues.map((i) => i.text).join("；");
  return [
    "本章正文字数不足，执行**续写补足**任务（不是改写、不是重写）：",
    "",
    `字数验收：现有正文约 ${curChars} 字（要求 ${WORD_TARGET} 字以上）。${issueText}`,
    "",
    "续写要求：",
    `- 从现有正文结尾**自然衔接**继续往下写约 ${gap} 字（场景延展/对话展开/动作细节/环境五感），使全文达到 ${WORD_TARGET}~${WORD_TARGET + 200} 字`,
    "- **现有正文逐字保留**——禁止改写、删减、压缩任何已写内容",
    "- 续写只用既有场景与人物（不新增情节/设定/人物），把正在发生的这一拍写透：反应、动作、一句对话、一个物件细节",
    `- 写足字数后按原计划收尾：章尾钩子用动作/对话/悬念落点，${(current.chapter ?? "").trim() ? `本章是「${(current.chapter ?? "").trim()}」` : ""}结尾禁止总结升华`,
    "",
    "现有正文结尾（从这里接下去）：",
    `……${tail}`,
    "",
    "输出**完整章节全文**（现有正文 + 续写部分合并为连续一文），不要输出补丁、说明或分隔标记。",
  ].join("\n");
}

/**
 * 章节自动修复闭环：监督审核 → hard 红线判定 → 重生成（约束回灌）→ 再审，上限 maxRetries 次。
 * 返工发生在落库之前（afterSubAgent 在 persistStage 前执行），调用方拿到覆盖稿后最终落库修复版。
 *
 * 2B 扩展：numericViolations（代码数值断言命中）并入 hard 红线触发返工（U1 双层兜底：
 * 硬冲突强制返工，耗尽走 passed=false 落最优稿交人工）；knownConstraintIds 做监督报告
 * 约束 id 回查（引用未知约束标记可疑，不阻断）。
 *
 * 2D 扩展：onDegrade 回调——监督异常/报告解析失败/返工耗尽等「质量降级」场景显式上报
 * （不再静默 console.warn），调用方据此 socket 推前端标红 + 落 trace。
 *
 * @returns 修复后的覆盖稿（返工发生过）；无需修复/重试耗尽/监督降级返回 null（调用方保持原稿）
 */
export async function autoRepairChapter(
  stageTools: RepairStageTools,
  chapter: RepairChapterInput,
  raw: string,
  maxRetries = 2,
  numericViolations: NumericViolation[] = [],
  knownConstraintIds?: Set<string>,
  onDegrade?: (reason: string) => void,
  onReport?: (report: SupervisionReport, reportRaw: string) => void,
  scanProvider?: (content: string) => ScanIssue[],
  /** 观察项2修复：与系统事实矛盾的 LLM hard 类型抑制（worldEra=modern 时抑制 LLM 的 [ERA]——
   *  代码扫描是 era 权威判定源，LLM 偶发判不稳定浪费返工次数）；报告级仍展示 */
  suppressLlmTypes?: string[],
): Promise<RepairResult | null> {
  let current: RepairChapterInput = { ...chapter };
  let currentRaw = raw;
  let attempts = 0;
  // 章节字数下限（B2 硬闸：不足不许通过，永不入库；continue 式返工补足）
  const wordMin = stageTools.chapterWordMin ?? WORD_TARGET;
  const wordOkOf = (content: string): boolean => {
    const n = (content ?? "").replace(/\s+/g, "").length;
    return n >= wordMin;
  };
  // P1a 择优 + B2 字数前置：best 以首稿为初值（wordOk=false 保守初始化，首轮审核后更新——
  // 审核降级路径返回时 wordRejected 裁决仍成立）；返工稿仅「优于 best」才替换，
  // 且 compareQuality 字数前置——字数不足稿即使评级高也不覆盖达标稿（杜绝 1484 字 B 级入库）
  let best: { raw: string; parsed: unknown; rank: number; hardCount: number; grade: string; wordOk: boolean } = {
    raw: currentRaw,
    parsed: current,
    rank: 0,
    hardCount: 0,
    grade: "",
    wordOk: false,
  };
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 1. 监督审核当前稿
    let report: SupervisionReport | null = null;
    let reportRaw = "";
    try {
      const supResp = await stageTools.run_sub_agent_supervision.execute?.(
        { prompt: buildSupervisionPrompt(current) },
        { toolCallId: "stage-chapter-supervision", messages: [] },
      );
      reportRaw = extractRaw(supResp);
      report = parseSupervisionReport(reportRaw);
    } catch (e) {
      // 监督失败不阻断落库（沿用现有降级语义），2D：显式上报降级
      // B2：降级返回也带 wordRejected——best 未更新时 wordOk=false（保守），消费端字数硬闸兜底拒收
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[novelAgent] 章节监督审核失败（不阻断落库）:", msg);
      onDegrade?.(`监督审核异常: ${msg}`);
      return attempts > 0 ? { raw: best.raw, parsed: best.parsed, attempts, passed: false, grade: best.grade, wordRejected: !best.wordOk } : null;
    }
    if (!report) {
      // 报告解析失败：先重试一次监督（MiMo 系输出格式有方差，一次重试消掉大半），再失败才降级
      console.warn("[novelAgent] 监督报告解析失败，重试一次监督审核");
      try {
        const retryResp = await stageTools.run_sub_agent_supervision.execute?.(
          { prompt: buildSupervisionPrompt(current) },
          { toolCallId: `stage-chapter-supervision-retry-${attempt}`, messages: [] },
        );
        report = parseSupervisionReport(extractRaw(retryResp));
      } catch (e) {
        console.warn("[novelAgent] 监督重试仍异常:", e instanceof Error ? e.message : String(e));
      }
    }
    if (!report) {
      // 重试后仍解析失败：降级不返工，2D：显式上报降级
      onDegrade?.("监督报告解析失败（重试后仍未产出 <supervisionReport>）");
      return attempts > 0 ? { raw: best.raw, parsed: best.parsed, attempts, passed: false, grade: best.grade, wordRejected: !best.wordOk } : null;
    }
    // 批次2：每次审核报告透出（调用方落 o_check_report——人工写作章节检查/报告中心的章节监督数据源）
    onReport?.(report, reportRaw);
    // 2B 约束 id 回查：issue 引用的约束 id 必须存在于已知清单，未知 id 标记可疑（不阻断）
    if (knownConstraintIds && knownConstraintIds.size > 0) {
      const suspicious = verifyConstraintRefs(report.issues, knownConstraintIds);
      if (suspicious.length) console.warn(`[novelAgent] 监督报告引用未知约束 id: ${suspicious.join(",")}（标记可疑，不阻断）`);
    }
    // 2. hard 红线判定（命中 LOGIC/NUMERIC/ABILITY/KNOWLEDGE/ERA 类型即自动返工；
    //    2B：代码数值断言命中并入，作为硬冲突强制返工——U1 兜底）
    //    观察项2：suppressLlmTypes 命中的 LLM hard 降为报告级（系统性事实优先，代码扫描为 era 权威源）
    const llmHardIssues = report.issues.filter((i) => isHardRedline(i) && !(suppressLlmTypes?.includes(i.type)));
    const suppressedLlmHard = report.issues.filter((i) => isHardRedline(i) && !!suppressLlmTypes?.includes(i.type));
    if (suppressedLlmHard.length) {
      console.warn(`[novelAgent] 监督 [${suppressedLlmHard.map((i) => i.type).join("/")}] 与系统判定矛盾，降报告级不返工`);
    }
    const numericIssues: SupervisionIssue[] = numericViolations.map((v) => ({
      type: "NUMERIC",
      text: `[数值断言] ${v.statement}（${v.field} 实际=${v.actual}，约束须 ${v.op} ${v.expected}）`,
    }));
    // P0-1：代码扫描（当轮稿重扫，保证重生成后也已扫描）；硬红线（BANNED/REPEAT/DESC）并入触发返工，
    // 报告级（APPROX/RATIO/WORD）不强制返工。扫描失败（provider 抛错）降级为空，不阻断。
    let scanHardIssues: SupervisionIssue[] = [];
    if (scanProvider) {
      try {
        const scan = scanProvider(current.content ?? "");
        scanHardIssues = scan.filter((s) => s.hard).map((s) => ({ type: s.type, text: s.text }));
      } catch (e) {
        console.warn("[novelAgent] 章节代码扫描失败（降级不阻断）:", e instanceof Error ? e.message : String(e));
      }
    }
    const hardIssues = [...llmHardIssues, ...numericIssues, ...scanHardIssues];
    // P1a 择优 + B2 字数前置：wordOk 单一权威源=scanProvider 的 WORD hard（区间含 config.words 口径）；
    // 无 scanProvider 时回退 wordOkOf 内算（番茄可见字符口径）。双源并存会导致判定分裂（测试暴露）
    const rank = gradeRankOf(report.grade);
    const curWordOk = scanProvider ? !scanHardIssues.some((i) => i.type === "WORD") : wordOkOf(current.content ?? "");
    const curQuality = { rank, hardCount: hardIssues.length, wordOk: curWordOk };
    if (attempts === 0 || compareQuality(curQuality, best) >= 0) {
      best = { raw: currentRaw, parsed: current, rank, hardCount: hardIssues.length, grade: report.grade, wordOk: curQuality.wordOk };
    } else {
      // 返工稿劣化 → 立即止损返回最优稿（不再烧下一次返工）
      console.warn(`[novelAgent] 章节自动修复稿质量劣化（${best.grade}→${report.grade}），保留更优稿交人工（红线：${hardIssues.map((i) => i.type).join("/")}）`);
      const shortfallNote = !best.wordOk
        ? `；注意：保留稿字数未达标（低于 ${wordMin}），拒绝入库`
        : "";
      onDegrade?.(`返工稿质量劣化（${best.grade}→${report.grade}），保留更优稿交人工复核${shortfallNote}`);
      return attempts > 0 ? { raw: best.raw, parsed: best.parsed, attempts, passed: false, grade: best.grade, wordRejected: !best.wordOk } : null;
    }
    if (hardIssues.length === 0) return attempts > 0 ? { raw: currentRaw, parsed: current, attempts, passed: true, grade: best?.grade } : null; // 通过 → 保持当前稿
    if (attempt >= maxRetries) {
      console.warn(`[novelAgent] 章节自动修复 ${maxRetries} 次仍未通过红线审核，落库最优稿交人工（红线：${hardIssues.map((i) => i.type).join("/")}）`);
      const shortfallNote = !best.wordOk
        ? `；注意：字数未达标（低于 ${wordMin}），拒绝入库`
        : "";
      onDegrade?.(`返工 ${maxRetries} 次耗尽仍不过红线（${hardIssues.map((i) => i.type).join("/")}），落库最优稿交人工复核${shortfallNote}`);
      return attempts > 0 ? { raw: best.raw, parsed: best.parsed, attempts, passed: false, grade: best.grade, wordRejected: !best.wordOk } : null;
    }
    // 3. 重生成（约束回灌）
    try {
      const regenResp = await stageTools.chapter.execute?.(
        { prompt: buildRepairPrompt(current, hardIssues) },
        { toolCallId: `stage-chapter-regen-${attempt}`, messages: [] },
      );
      const regenParsed = extractField(regenResp, "parsed");
      if (regenParsed) {
        current = { ...(regenParsed as RepairChapterInput) };
        const regenRaw = extractRaw(regenResp);
        if (regenRaw) currentRaw = regenRaw;
        attempts++;
        continue; // 回监督再审
      }
      console.warn("[novelAgent] 章节自动修复重生成产物无效，落库最优稿:", String(extractField(regenResp, "error") ?? "无 error"));
      onDegrade?.("重生成产物无效（无 parsed），落库最优稿交人工复核");
      return attempts > 0 ? { raw: best.raw, parsed: best.parsed, attempts, passed: false, grade: best.grade, wordRejected: !best.wordOk } : null;
    } catch (e) {
      console.warn("[novelAgent] 章节自动修复失败（不阻断落库）:", e instanceof Error ? e.message : String(e));
      onDegrade?.(`章节自动修复异常: ${e instanceof Error ? e.message : String(e)}`);
      return attempts > 0 ? { raw: best.raw, parsed: best.parsed, attempts, passed: false, grade: best.grade, wordRejected: !best.wordOk } : null;
    }
  }
  return attempts > 0 ? { raw: best.raw, parsed: best.parsed, attempts, passed: false, grade: best.grade, wordRejected: !best.wordOk } : null;
}
