import u from "@/utils";
import type { NovelStageKey } from "@/pipeline/schemas/novel";
import { StageDependencyError, assertStageReady } from "@/pipeline/stageGate";

/**
 * 小说创作确定性工作流（Workflow）：阶段表 + Gate 4 依赖门禁 + 缺口查找。
 *
 * 与决策层（runDecisionAI）的关系：决策层只做对话/引导/确认，阶段执行一律经
 * run_workflow_stage 工具（见 index.ts）走本文件的确定性编排——七阶段依赖是固定 DAG，
 * 顺序由代码保证，不再由 LLM 自主编排（历史架构：决策层持有 7 个子 Agent 工具自主调序，
 * 存在乱序/漏调风险，scriptAgent 被迫加 completeMissingStages 兜底）。
 *
 * 依赖表是 SSOT：散落在 createSubAgent 各 execute 里的 preloadKeys 与 Gate4 dependsOn
 * 在此集中声明（对齐 pipeline DRAMA_STAGES 形态，修掉其 prompt 死代码问题）。
 */

/** 阶段 key 白名单（socket 路由 / run_workflow_stage 校验用） */
export const NOVEL_STAGE_KEYS = ["brief", "world", "characters", "synopsis", "outline", "chapter"] as const;

export interface NovelStageDef {
  stageKey: NovelStageKey;
  /** 中文阶段名（日志/错误提示用） */
  name: string;
  /** Gate 4 门禁：执行前必须已落库的工作区 key（直接前置，顺序保证传递性） */
  dependsOn: string[];
  /** 子 Agent 预加载字段（含自身初稿供细化阶段参考；createSubAgent 从此处读取，单一来源） */
  preloadKeys: string[];
  /** 章节阶段：一次一章 + 每章强制监督审核（runStageDirect 内处理） */
  chapter?: boolean;
  /** 阶段质检 skill 文件名（data/skills/novel_stage_check_*.md）：产出后强制跑轻量自查，输出 <checkReport> 分级报告 */
  supervision?: string;
  /** 全局第一步（确认点无「上一步」按钮；替代循环内硬编码 stageKey） */
  isFirst?: boolean;
  /** 全局最后一步 */
  isLast?: boolean;
}

/**
 * 小说七阶段 DAG：answers → 构思 → 世界模型 → 人物设定 → 简介 → 大纲 → 章节
 * - 构思无门禁依赖：answers（立项问卷）允许缺失，prompt 用项目 intro 兜底
 * - 简介依赖世界+人物；章节依赖大纲；已有章节时不自动续写（一次生成一章，对齐现状）
 * - world/characters 依赖 briefConfirmed（用户选版确认标记）：构思只出 3 版简介，选版回写 briefConfirmed
 *   后才放行世界/人物——方向未定前禁止基于默认第一版生成设定（历史 bug：阶段 0 连跑三件套蒙第一版）
 * - supervision：非章节 5 阶段轻量自查（chapter 沿用现有 20 项监督，不走此处）
 */
export const NOVEL_STAGES: NovelStageDef[] = [
  { stageKey: "brief", name: "构思", dependsOn: [], preloadKeys: ["answers"], supervision: "novel_stage_check_brief.md", isFirst: true },
  { stageKey: "world", name: "世界模型", dependsOn: ["brief", "briefConfirmed"], preloadKeys: ["world", "brief", "answers"], supervision: "novel_stage_check_world.md" },
  { stageKey: "characters", name: "人物设定", dependsOn: ["world", "briefConfirmed"], preloadKeys: ["characters", "world", "brief", "answers"], supervision: "novel_stage_check_characters.md" },
  { stageKey: "synopsis", name: "简介", dependsOn: ["world", "characters"], preloadKeys: ["world", "characters", "cheat", "brief", "answers"], supervision: "novel_stage_check_synopsis.md" },
  { stageKey: "outline", name: "大纲", dependsOn: ["synopsis"], preloadKeys: ["synopsis", "characters", "world", "cheat", "backstoryEvents", "brief", "answers", "volumePlan"], supervision: "novel_stage_check_outline.md" },
  { stageKey: "chapter", name: "章节", dependsOn: ["outline"], preloadKeys: ["outline", "synopsis", "world", "characters", "cheat", "backstoryEvents", "subplots", "chapters", "entityFocus", "styleGuide"], chapter: true, isLast: true },
];

/**
 * Gate 4 编排门禁（novel 线）：执行某阶段前，检查其 dependsOn 的工作区 key 是否有值。
 * 公共实现见 pipeline/stageGate.ts（novel / drama / script 三线共用）。
 * @param stageKey 阶段 key（错误信息展示用）
 * @param dependsOn 必须已落库的工作区 key；空/未传视为无依赖直接放行
 */
export function assertNovelStageReady(projectId: number, stageKey: string, dependsOn?: string[]): Promise<void> {
  return assertStageReady(projectId, "novelAgent", stageKey, dependsOn);
}

export { StageDependencyError };

/**
 * 旧数据兼容（懒补，零迁移）：改造前 brief 落库为 selected 纯文本（非 JSON），且无 briefConfirmed。
 * 旧流程「阶段 0 连跑三件套」已默认第一版生成 world/characters，视为方向已定 → 补 briefConfirmed 放行。
 * 新流程 brief 落库为完整 JSON（以 { 开头），不触发补写——方向必须由用户选版确认。
 *
 * 存量异常补充（2026-08-14 排查）：部分已立项（o_project.status=active）项目 brief 为 JSON 但
 * briefConfirmed 为空（历史立项未回写）——已立项即方向已确认，不应再显示选版确认条/被 awaitSelection 卡住，
 * 此处补写放行（幂等：已有确认标记不重复写）。
 *
 * 触发位置：getPlanData 路由（前端打开项目必经入口）——修复死锁：旧项目重开时门禁不再卡 world。
 * （原第二触发点 confirmNovelProjectFromWorkData 已随「brief 落库即立项」hook 删除而移除，
 *   立项时机回归用户选版确认——/project/confirmNovelProject 置 active 后本函数自然放行。）
 *
 * @returns true=本次补写；false=无需补（新流程 JSON+未立项 / 已确认 / 无 brief）
 */
export async function lazyBackfillBriefConfirmed(data: Record<string, any>, projectId: number, agentKey = "novelAgent"): Promise<boolean> {
  if (data.brief && !data.briefConfirmed) {
    const briefText = String(data.brief).trim();
    const isJson = briefText.startsWith("{");
    // JSON brief：仅当项目已立项（active）时视为方向已确认补写；draft 必须等用户选版
    if (isJson) {
      let isActive = false;
      try {
        const proj = await u.db("o_project").where("id", projectId).select("status").first();
        isActive = (proj as { status?: string } | undefined)?.status === "active";
      } catch {
        isActive = false;
      }
      if (!isActive) return false;
    }
    data.briefConfirmed = "1";
    await u.db("o_agentWorkData").where({ projectId, key: agentKey }).update({ data: JSON.stringify(data) });
    return true;
  }
  return false;
}

/** 读小说创作工作区（o_agentWorkData key="novelAgent"） */
export async function getNovelWorkData(projectId: number): Promise<Record<string, any>> {
  const row = await u.db("o_agentWorkData").where({ projectId, key: "novelAgent" }).first();
  try {
    return row?.data ? JSON.parse(row.data) : {};
  } catch {
    return {};
  }
}

/**
 * 下一章号（章号基准唯一来源）：max(chapterIndex)+1，而非 count(*)+1。
 * 历史缺陷：删过章后 count<max，beforeRunStage 被告知写「第 count+1 章」、落库却到 max+1，
 * 章卡/账本/报告与正文章号系统性错位。index.ts 生成章号与 xmlConsume 落库章号统一走此函数。
 */
export async function nextChapterNo(projectId: number): Promise<number> {
  try {
    const maxRow = await u.db("o_novel").where("projectId", projectId).max("chapterIndex as max").first();
    return Number((maxRow as { max?: number } | undefined)?.max ?? 0) + 1;
  } catch {
    return 1;
  }
}

/**
 * 批次0：brief「已产出未选版」判定（纯函数）。
 * 新流程 brief 落库为完整 JSON（{ 开头），briefConfirmed 由前端选版回写——
 * brief 已产出且未确认 = 用户停在选版步（刷新后前端据此重建选版界面，不再依赖聊天内存态）。
 * 旧流程纯文本 brief 经 lazyBackfillBriefConfirmed 已补 briefConfirmed，不会误报。
 */
export function isAwaitingBriefSelection(data: Record<string, any>): boolean {
  const brief = typeof data.brief === "string" ? data.brief : "";
  return !!brief.trim() && brief.trim().startsWith("{") && !data.briefConfirmed;
}
