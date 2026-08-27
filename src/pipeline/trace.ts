import u from "@/utils";

/**
 * 约束网关可观测性：全链路 trace 写入 o_agent_trace 表
 *
 * 在 pipeline 关键节点（阶段开始/成功/重试/失败/门禁拦截）记录：
 * - 耗时、重试次数、schema 校验结果
 * - 触发的网关层（gate1~4）和事件类型
 *
 * 用法：
 *   const t = startTrace({ projectId, agentKey, stage, gate });
 *   ... 执行 ...
 *   t.success({ schemaValid: "pass", durationMs: ... });
 *   // 或 t.fail({ detail: "错误信息" });
 */

export type GateLayer = "gate1_harness" | "gate2_tool" | "gate3_consume" | "gate4_orchestrator";
export type TraceEvent = "start" | "success" | "retry" | "fail" | "blocked";
export type SchemaValid = "pass" | "fail" | "skip";

interface TraceInput {
  projectId: number;
  agentKey: string;
  stage: string;
  gate: GateLayer;
}

interface TraceRecordInput {
  durationMs?: number;
  retryCount?: number;
  schemaValid?: SchemaValid;
  detail?: string;
}

/**
 * 记录一条 trace（低开销，失败不抛错只 console.warn，不影响主流程）
 */
export async function recordTrace(
  input: TraceInput & { event: TraceEvent } & TraceRecordInput,
): Promise<void> {
  try {
    // R1 兜底（主键防冲突）：id 为 int4 列（上限 2^31-1），原 Date.now() % 2147483647 同毫秒并发必撞
    // → 取模基数压到 2e9 再叠 0-999 随机后缀，碰撞概率从必然降到 ~1/1000，且不溢出 int 范围
    const id = (Date.now() % 2000000000) + Math.floor(Math.random() * 1000);
    await u.db("o_agent_trace").insert({
      id,
      projectId: input.projectId,
      agentKey: input.agentKey,
      stage: input.stage,
      gate: input.gate,
      event: input.event,
      durationMs: input.durationMs ?? null,
      retryCount: input.retryCount ?? null,
      schemaValid: input.schemaValid ?? null,
      detail: input.detail ?? null,
      createTime: Date.now(),
    });
  } catch (e: any) {
    // trace 写入失败不影响主流程，只记录警告
    console.warn(`[trace] 写入失败: ${e?.message ?? e}`);
  }
}

/**
 * R1 兜底（TTL 清理）：定期删除过期 trace，防表无限膨胀。
 * 项目无 cron/定时任务框架，用 setInterval 最小实现；保留窗默认 30 天、每天清理一次。
 * 启动即清一次；清理失败不抛（下轮再试）；timer.unref 不阻止进程退出。
 */
export function startTraceCleanup(
  opts: { retentionMs?: number; intervalMs?: number } = {},
): NodeJS.Timeout {
  const retentionMs = opts.retentionMs ?? 30 * 24 * 60 * 60 * 1000;
  const intervalMs = opts.intervalMs ?? 24 * 60 * 60 * 1000;
  const run = async () => {
    try {
      const cutoff = Date.now() - retentionMs;
      const del = await u.db("o_agent_trace").where("createTime", "<", cutoff).delete();
      if (del) console.log(`[trace] TTL 清理 ${del} 条过期 trace（保留 ${retentionMs / (24 * 60 * 60 * 1000)} 天）`);
    } catch (e: any) {
      console.warn(`[trace] TTL 清理失败（下轮再试）: ${e?.message ?? e}`);
    }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  run();
  return timer;
}

/**
 * 开始一个阶段 trace，返回带计时器的记录器
 * 用法：
 *   const t = startTrace({ projectId, agentKey, stage: "简介", gate: "gate4_orchestrator" });
 *   await recordTrace({ ...t.input, event: "start" });
 *   ... 执行 ...
 *   await t.success({ schemaValid: "pass" }); // 自动算耗时
 */
export function startTrace(input: TraceInput) {
  const startTime = Date.now();
  const baseInput = input;

  const success = async (extra?: TraceRecordInput) => {
    await recordTrace({
      ...baseInput,
      event: "success",
      durationMs: Date.now() - startTime,
      ...extra,
    });
  };

  const fail = async (extra?: TraceRecordInput) => {
    await recordTrace({
      ...baseInput,
      event: "fail",
      durationMs: Date.now() - startTime,
      ...extra,
    });
  };

  const retry = async (extra?: TraceRecordInput) => {
    await recordTrace({
      ...baseInput,
      event: "retry",
      ...extra,
    });
  };

  const blocked = async (extra?: TraceRecordInput) => {
    await recordTrace({
      ...baseInput,
      event: "blocked",
      ...extra,
    });
  };

  return { input: baseInput, success, fail, retry, blocked, startTime };
}
