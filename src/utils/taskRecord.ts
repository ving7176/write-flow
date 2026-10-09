import u from "@/utils";
import { computeCost } from "@/utils/priceTable";

const taskStateMap = {
  "0": "进行中",
  "1": "已完成",
  "-1": "生成失败",
};

/** token 用量（P0-2 计量：AiText 调用结束时回写 o_tasks；promptHash 为 WP2 可追溯的 prompt 指纹） */
export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cost?: number;
  promptHash?: string;
}

/**
 * 记录任务并返回结束函数
 * @param projectId  项目 ID
 * @param taskClass  任务分类
 * @param modelName   模型名称
 * @param opts       可选项：关联对象、任务描
 */
export default async function taskRecord(
  projectId: number,
  taskClass: string,
  modelName: string,
  opts: {
    describe?: string;
    content?: any;
  } = {},
) {
  const { content, describe = "" } = opts;

  let opteorContent: string | undefined;
  if (content === undefined || content === null) {
    opteorContent = undefined;
  } else if (typeof content === "string") {
    opteorContent = content;
  } else if (typeof content === "function") {
    throw new Error("不支持的类型");
  } else {
    try {
      opteorContent = JSON.stringify(content);
    } catch (e) {
      opteorContent = content.toString();
    }
  }

  // 该表 id 非自增，pg 下 insert 返回 Result 对象（不可解构），需显式赋值
  const id = Date.now() % 2147483647;
  await u.db("o_tasks").insert({
    id,
    projectId,
    taskClass,
    relatedObjects: opteorContent,
    model: modelName,
    describe,
    state: taskStateMap[0],
    startTime: Date.now(),
  });

  /** 任务成功时调用 done(1)，失败时调用 done(-1, '原因')；有 usage 时回写 token 计量（P0-2） */
  return async function done(state: 1 | -1, reason?: string, usage?: TokenUsage) {
    const patch: Record<string, unknown> = {
      state: taskStateMap[state],
      reason: state === -1 ? (reason ?? "") : null,
    };
    if (usage) {
      patch.promptTokens = usage.promptTokens ?? null;
      patch.completionTokens = usage.completionTokens ?? null;
      patch.totalTokens = usage.totalTokens ?? null;
      // WP6 成本结算：调用方未给 cost 时按价表结算（未登记价目的模型保持 NULL，不估算）
      patch.cost = usage.cost ?? computeCost(modelName, usage.promptTokens, usage.completionTokens) ?? null;
      patch.promptHash = usage.promptHash ?? null;
    }
    await u.db("o_tasks")
      .where("id", id)
      .update(patch);
  };
}
