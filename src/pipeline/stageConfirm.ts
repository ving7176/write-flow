import type { Socket } from "socket.io";

/**
 * 人工确认状态机（semi/manual 确认点，novel 线使用）。
 *
 * 用法：workflow 每阶段产出+质检后 emit `awaitConfirm`（socket 事件），然后
 * `waitForStageConfirm(ctx, stageKey)` 代码级等待；socket 路由收到 `stageConfirm`
 * 事件时调 `resolveStageConfirm(socketId, stageKey, action)`；连接断开时调
 * `clearStageConfirms(socketId)` 统一 abort。
 *
 * 隔离键 = `${socketId}:${stageKey}`（多连接/多项目并发不串扰）。
 *
 * 批次0 加固：
 * - 超时不再静默 abort（原 30 分钟无操作直接杀掉整条 workflow，长思考会话被误杀）——
 *   改为 emit `confirmTimeout` 通知前端（可提示用户恢复），继续等待；
 *   真正中止只发生在 socket 断开（clearStageConfirms）或新指令接管（abortPendingConfirms）
 * - 同 socket 同阶段二次等待（双开 workflow）→ 后来者立即 abort，不再覆盖前者 resolver
 *   （原覆盖会把前者挂死到 30 分钟超时）
 */

export type StageConfirmAction = "confirm" | "redo" | "back" | "abort";

/** 待确认 Promise 表：key = `${socketId}:${stageKey}` */
const pendingConfirmResolvers = new Map<string, (action: StageConfirmAction) => void>();
/** P1-5 针对性返工：redo 附带的用户补充要求（key 同上；stageEngine 取出即删，回灌重跑 prompt） */
const redoNotes = new Map<string, string>();

function confirmKey(socketId: string, stageKey: string): string {
  return `${socketId}:${stageKey}`;
}

/** 是否存在等待中的确认（同 socket 同阶段） */
export function hasPendingConfirm(socketId: string, stageKey: string): boolean {
  return pendingConfirmResolvers.has(confirmKey(socketId, stageKey));
}

/**
 * 代码级等待用户确认（semi/manual 的确认点）。
 * - 30 分钟无操作 emit `confirmTimeout`（前端可提示恢复），不中止；继续等待
 * - socket 断开时由 clearStageConfirms 统一 abort
 * - 同 socket 同阶段已有等待中的确认（重复触发 workflow）→ 立即 abort 后来者
 */
export function waitForStageConfirm(ctx: { socket: Pick<Socket, "id"> & { emit?: (event: string, payload: unknown) => void } }, stageKey: string): Promise<StageConfirmAction> {
  const key = confirmKey(ctx.socket.id, stageKey);
  if (pendingConfirmResolvers.has(key)) return Promise.resolve("abort");
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // 超时只通知不中止：前端提示「确认等待已超时」，用户仍可 stageConfirm 恢复
      try {
        ctx.socket.emit?.("confirmTimeout", { stageKey });
      } catch {
        /* emit 失败（headless mock socket）忽略 */
      }
    }, 30 * 60 * 1000);
    pendingConfirmResolvers.set(key, (action) => {
      clearTimeout(timer);
      resolve(action);
    });
  });
}

/** socket 路由 stageConfirm 事件回调：resolve 对应 stageKey 的等待 */
export function resolveStageConfirm(socketId: string, stageKey: string, action: StageConfirmAction, note?: string): void {
  const key = confirmKey(socketId, stageKey);
  if (action === "redo" && note?.trim()) redoNotes.set(key, note.trim());
  pendingConfirmResolvers.get(key)?.(action);
  pendingConfirmResolvers.delete(key);
}

/** P1-5：取出 redo 补充要求（取出即删；无则 undefined） */
export function takeRedoNote(socketId: string, stageKey: string): string | undefined {
  const key = confirmKey(socketId, stageKey);
  const note = redoNotes.get(key);
  redoNotes.delete(key);
  return note;
}

/** 中止该连接所有等待中的确认（新 chat/stageGenerate 接管时调用；返回中止数量） */
export function abortPendingConfirms(socketId: string): number {
  let n = 0;
  for (const [key, resolve] of pendingConfirmResolvers) {
    if (key.startsWith(`${socketId}:`)) {
      resolve("abort");
      pendingConfirmResolvers.delete(key);
      n++;
    }
  }
  return n;
}

/** socket 断开时清理该连接所有待确认（按 abort 处理，中止 workflow） */
export function clearStageConfirms(socketId: string): void {
  abortPendingConfirms(socketId);
}

/** 测试辅助：清空全部待确认状态 */
export function resetStageConfirmsForTest(): void {
  pendingConfirmResolvers.clear();
}
