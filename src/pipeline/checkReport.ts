import u from "@/utils";

/**
 * 检查报告落表（批次2 检查体系产品化）：o_check_report 统一存阶段质检/章节监督/中期/里程碑/手动检查，
 * 替代「ilike 捞聊天记录」的弱检索（o_chatHistory 仍保留原文归档供回测）。
 *
 * 设计：
 * - 报告是产品功能（作者速查面板/报告中心数据源），落库失败不阻断主流程（warn 降级）
 * - reportType：stage=阶段质检 / chapter=章节监督 / midterm=中期 / milestone=里程碑 / manual=手动检查 / compliance=合规
 */

export type CheckReportType = "stage" | "chapter" | "midterm" | "milestone" | "manual" | "compliance" | "metrics";

export interface CheckReportInput {
  projectId: number;
  reportType: CheckReportType;
  stageKey?: string;
  chapterIndex?: number | null;
  rating?: string;
  summary?: string;
  issues?: Array<{ type?: string; text: string } | string>;
  metrics?: Record<string, unknown>;
  detailMd?: string;
}

/** 本地 id 生成（同 utils.nextIntId：绕开 @/utils 循环依赖） */
function nextIntId(): number {
  return (Date.now() % 2000000000) + Math.floor(Math.random() * 1000);
}

export async function saveCheckReport(input: CheckReportInput): Promise<number | null> {
  try {
    const id = nextIntId();
    const issues = Array.isArray(input.issues) ? input.issues.map((i) => (typeof i === "string" ? { text: i } : i)).slice(0, 100) : [];
    await u.db("o_check_report").insert({
      id,
      projectId: input.projectId,
      reportType: input.reportType,
      stageKey: input.stageKey ?? null,
      chapterIndex: input.chapterIndex ?? null,
      rating: input.rating ?? null,
      summary: input.summary ?? null,
      issues: JSON.stringify(issues),
      metrics: input.metrics ? JSON.stringify(input.metrics) : null,
      detailMd: input.detailMd ?? null,
      createTime: Date.now(),
    });
    return id;
  } catch (e) {
    console.warn("[checkReport] 报告落库失败（不阻断）:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/**
 * 报告解析失败占位落表（缺口⑤：自动路径 midterm/milestone/阶段质检解析失败不再静默黑洞，
 * 报告中心可查「解析失败 + 原文留档」；落库自身失败只 warn 不抛）。
 */
export async function saveCheckReportPlaceholder(input: {
  projectId: number;
  reportType: CheckReportType;
  stageKey?: string;
  chapterIndex?: number | null;
  detailMd: string;
  reason: string;
}): Promise<void> {
  await saveCheckReport({
    projectId: input.projectId,
    reportType: input.reportType,
    stageKey: input.stageKey,
    chapterIndex: input.chapterIndex ?? null,
    summary: `质检报告解析失败（原文留档）：${input.reason}`,
    issues: [{ type: "parse", text: "报告格式解析失败，人工复核原文" }],
    detailMd: input.detailMd,
  });
}

/** 读报告列表（报告中心：按项目 + 可选类型/章号过滤，最新 200 条） */
export async function listCheckReports(
  projectId: number,
  opts: { reportType?: string; chapterIndex?: number; limit?: number } = {},
): Promise<Array<Record<string, unknown>>> {
  let q = u.db("o_check_report").where("projectId", projectId);
  if (opts.reportType) q = q.where("reportType", opts.reportType);
  if (opts.chapterIndex != null) q = q.where("chapterIndex", opts.chapterIndex);
  const rows = (await q.orderBy("createTime", "desc").limit(opts.limit ?? 200).select("*")) as any[];
  const parseArr = (v: unknown): Array<{ type?: string; text: string }> => {
    if (Array.isArray(v)) return v;
    if (typeof v === "string") {
      try {
        const p = JSON.parse(v);
        return Array.isArray(p) ? p : [];
      } catch {
        return [];
      }
    }
    return [];
  };
  const parseObj = (v: unknown): Record<string, unknown> | null => {
    if (v && typeof v === "object") return v as Record<string, unknown>;
    if (typeof v === "string") {
      try {
        return JSON.parse(v);
      } catch {
        return null;
      }
    }
    return null;
  };
  return rows.map((r) => ({
    id: r.id,
    reportType: r.reportType,
    stageKey: r.stageKey,
    chapterIndex: r.chapterIndex,
    rating: r.rating,
    summary: r.summary,
    issues: parseArr(r.issues),
    metrics: parseObj(r.metrics),
    detailMd: r.detailMd,
    createTime: r.createTime,
  }));
}
