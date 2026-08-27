import u from "@/utils";
import { recordTrace } from "@/pipeline/trace";

/**
 * Gate 4 编排门禁（公共实现，novel / drama / script 三线共用）。
 *
 * 历史：pipeline/index.ts 的 StageDependencyError + assertStageReady（drama/script 线）与
 * novelAgent/workflow.ts 的 NovelStageDependencyError + assertNovelStageReady（novel 线）
 * 是 1:1 重复实现（同 DB 查询、同 missing 过滤、同错误信息模板），合并到本模块统一。
 */

/**
 * Gate 4 编排门禁错误：执行某阶段前前置依赖缺失时抛出。
 */
export class StageDependencyError extends Error {
  readonly stage: string;
  readonly missing: string[];
  constructor(stage: string, missing: string[]) {
    super(`[Gate4] 阶段「${stage}」前置依赖缺失：${missing.join(", ")}。请先完成对应阶段。`);
    this.name = "StageDependencyError";
    this.stage = stage;
    this.missing = missing;
  }
}

/**
 * Gate 4 编排门禁：执行某阶段前，检查其 dependsOn 的工作区 key 是否有值。
 * 缺失则抛 StageDependencyError（由调用方决定中断或提示）。
 * @param agentKey 工作区定位键（如 novelAgent / dramaAgent / scriptAgent / productionAgent）
 * @param stageName 阶段名（错误信息展示用，中文名或 key 均可）
 * @param dependsOn 必须已落库的工作区 key；空/未传视为无依赖直接放行
 * @param episodesId production 按集隔离（o_agentWorkData.episodesId=scriptId；三线不传）
 */
/** 结构化字段（JSON 数组/对象形态）：门禁深度校验时额外检查 JSON 可解析性（软校验） */
const STRUCTURED_KEYS = new Set(["constraints", "stateLedger", "timeLine", "foreshadows", "chapters", "constraintTransforms"]);

export async function assertStageReady(projectId: number, agentKey: string, stageName: string, dependsOn?: string[], episodesId?: number): Promise<void> {
  if (!dependsOn || dependsOn.length === 0) return;
  const row = await u
    .db("o_agentWorkData")
    .where({ projectId, key: agentKey, ...(episodesId != null ? { episodesId } : {}) })
    .first();
  let data: any = {};
  try {
    data = row?.data ? JSON.parse(row.data) : {};
  } catch {
    data = {};
  }
  // 2A 深度校验（软）：结构化字段非空但 JSON 解析失败 → 告警不阻断（U2 渐进收紧，
  // 防污染数据进子 Agent prompt 的观测；缺失/空值仍硬阻断）
  const missing = dependsOn.filter((key) => {
    const v = data[key];
    if (!v || String(v).trim() === "") return true;
    if (STRUCTURED_KEYS.has(key)) {
      try {
        JSON.parse(String(v));
      } catch {
        console.warn(`[Gate4] 阶段「${stageName}」前置字段 ${key} 为无效 JSON（软校验告警，不阻断）`);
        // 批次0：脏数据进子 Agent prompt 的风险可观测（软校验不阻断，但告警落 trace 供复盘）
        recordTrace({
          projectId,
          agentKey,
          stage: stageName,
          gate: "gate4_orchestrator",
          event: "fail",
          detail: `前置字段 ${key} 为无效 JSON（软校验告警，不阻断）`,
        }).catch(() => {});
      }
    }
    return false;
  });
  if (missing.length > 0) {
    throw new StageDependencyError(stageName, missing);
  }
}
