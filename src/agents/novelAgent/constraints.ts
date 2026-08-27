import u from "@/utils";

/**
 * 小说线约束体系（预防针机制）：constraints 是跨阶段累积的结构化约束清单。
 *
 * 工作区字段（o_agentWorkData key="novelAgent"）：
 * - constraints: NovelConstraint[]（JSON 数组）
 * - constraintTransforms: 约束转化路径（outline 阶段规划，P2 用，字段预留）
 *
 * 约束生命周期：brief(全局约束) → world(设定约束) → characters(角色约束) 各阶段产出
 * <constraints> XML 标签追加；status: active(生效) / transformed(已转化) / resolved(已解除)。
 * 转化必须记录 resolvedAt + resolvedReason——无记录的转化即违约（监督按此判定）。
 *
 * 纪律：只加不偷偷删——追加按 id 去重（已有 id 保留工作区版本，防 redo 覆盖用户编辑）；
 * 删改必须经用户确认点（前端约束编辑，P2）。
 */

/** 约束类型枚举（监督按类型分发判定策略） */
export const CONSTRAINT_TYPES = [
  "resource", // 资源/金钱/物品
  "ability", // 能力边界
  "knowledge", // 知识/认知边界
  "era", // 时代/科技水平
  "relationship", // 关系状态
  "personality", // 性格底线
  "plot", // 剧情进度
  "taboo", // 题材红线/合规
  "style", // 文风（简洁/华丽/白描等写作风格约束；监督为报告级，非红线）
] as const;
export type ConstraintType = (typeof CONSTRAINT_TYPES)[number];

/** 约束状态 */
export const CONSTRAINT_STATUS = ["active", "transformed", "resolved"] as const;
export type ConstraintStatus = (typeof CONSTRAINT_STATUS)[number];

/** 单条约束（statement 给 LLM 守约/监督语义理解，machineHint 给判定逻辑做数值比对） */
export interface NovelConstraint {
  id: string;
  type: ConstraintType;
  subject: string;
  statement: string;
  /** 治本1 结构化：era 约束显式世界观时代（brief 按 schema 指引产出；扫描器权威判定源） */
  worldEra?: "modern" | "ancient";
  /** 治本1 结构化：穿越类声明（carriers=穿越者角色名；扫描器据此放行穿越者行现代词） */
  transport?: { carriers?: string[] };
  machineHint?: Record<string, unknown>;
  /** 来源阶段：brief | world | characters */
  source: string;
  /** 引入章号（0=全书生效） */
  createdAt: number;
  status: ConstraintStatus;
  resolvedAt?: number;
  resolvedReason?: string;
}

/** 过滤畸形约束条目：id/type/statement 是必需字段 */
function filterValidConstraints(parsed: unknown[]): NovelConstraint[] {
  return parsed.filter((c): c is NovelConstraint => {
    if (!c || typeof c !== "object") return false;
    const obj = c as Record<string, unknown>;
    return typeof obj.id === "string" && typeof obj.statement === "string" && typeof obj.type === "string";
  });
}

/**
 * 从产物 XML 提取 <constraints> 标签内的 JSON 数组（取最长标签，兼容 LLM 多标签输出）；
 * 兼容纯 JSON 文本（已提取的标签内容，见 xmlConsume 消费路径）。
 * @returns 合法约束数组；无标签或解析失败返回 null（不阻断落库）
 */
export function parseConstraintsXml(xml: string): NovelConstraint[] | null {
  const trimmed = xml.trim();
  // 纯 JSON 文本（消费路径传入已提取的标签内容）
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return filterValidConstraints(parsed);
    } catch {
      /* fallthrough 到 XML 正则 */
    }
  }
  const re = /<constraints[^>]*>([\s\S]*?)<\/constraints>/g;
  const items: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) items.push(m[1].trim());
  if (items.length === 0) return null;
  const raw = items.reduce((a, b) => (b.length > a.length ? b : a));
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return filterValidConstraints(parsed);
  } catch {
    return null;
  }
}

/** 合并约束：按 id 去重追加（只加不偷偷删；已有 id 保留工作区版本，防 redo 覆盖用户编辑） */
export function mergeConstraints(existing: NovelConstraint[], incoming: NovelConstraint[]): NovelConstraint[] {
  const byId = new Set(existing.map((c) => c.id));
  const merged = [...existing];
  for (const c of incoming) {
    if (!byId.has(c.id)) {
      byId.add(c.id);
      merged.push(c);
    }
  }
  return merged;
}

/** 读工作区约束（兼容旧数据：字段缺失/非数组返回 []） */
export async function readWorkConstraints(projectId: number): Promise<NovelConstraint[]> {
  const row = await u.db("o_agentWorkData").where({ projectId, key: "novelAgent" }).first();
  try {
    const data = row?.data ? JSON.parse(row.data) : {};
    const raw = data.constraints;
    if (Array.isArray(raw)) return raw as NovelConstraint[];
    if (typeof raw === "string") {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as NovelConstraint[]) : [];
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * 过滤「指定章号时仍生效」的约束：
 * - status=active 全部生效
 * - status=transformed/resolved 且转化发生在指定章号之后（resolvedAt > chapterNo）的，
 *   转化发生前仍需校验；转化当章起约束解除（转化是否合法由返工 prompt 的「必须交代来源」兜底）
 * chapterNo 缺省 0（全书开始）：active + 已规划的转化约束都纳入（章节外场景的全量生效集）。
 */
export function activeConstraints(all: NovelConstraint[], chapterNo = 0): NovelConstraint[] {
  return all.filter((c) => c.status === "active" || (typeof c.resolvedAt === "number" && c.resolvedAt > chapterNo));
}

/** 格式化硬约束块（chapter 子 Agent prompt 注入：只列生效约束，跨章节生效违反即返工） */
export function formatConstraintBlock(constraints: NovelConstraint[]): string {
  if (constraints.length === 0) return "";
  const lines = constraints.map((c) => `- [${c.id} ${c.type}] ${c.subject}：${c.statement}`);
  return `⚠️ 以下为本书已确立的硬约束（跨章节生效，本章必须遵守，违反即返工）：\n${lines.join("\n")}`;
}

/** 格式化监督核查清单（监督层逐条对照的靶子） */
export function formatConstraintCheckList(constraints: NovelConstraint[]): string {
  if (constraints.length === 0) return "";
  return constraints.map((c) => `- [${c.id} ${c.type}] ${c.statement}`).join("\n");
}
