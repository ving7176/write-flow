/**
 * 执行层工具统一防护（4B）：工具级超时 + 统一异常码。
 *
 * 背景：原工具 execute 无工具级超时（超时只在 LLM 调用层 ai.ts），出错是裸 Error 或
 * {error} 鸭子类型，无统一错误码可审计。这里提供 withToolTimeout 包装 +
 * ToolExecutionError 携带 errorCode，供 stageEngine 统一转成 [CODE] 前缀的错误信息。
 *
 * HP3 正交结果上报（harness defensive「正交结果独立上报」）：超时≠终止——Promise.race
 * 不取消底层 execute，超时后原工具继续跑完且副作用照常落库。TIMEOUT 错误信息显式声明
 * 该事实；底层在超时后才 settle 的「迟到副作用」独立落 JSONL 留痕（tool-timeout.jsonl）。
 */

import appendJsonLine from "@/utils/jsonl";

/** 统一工具错误码 */
export const TOOL_ERROR_CODES = {
  /** 工具执行超时（withToolTimeout 触发；底层未取消，副作用可能仍落地） */
  TIMEOUT: "TIMEOUT",
  /** 工具执行抛异常（业务/网络等） */
  EXECUTION: "EXECUTION",
} as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[keyof typeof TOOL_ERROR_CODES];

export class ToolExecutionError extends Error {
  readonly code: ToolErrorCode;
  constructor(code: ToolErrorCode, message: string) {
    super(message);
    this.name = "ToolExecutionError";
    this.code = code;
  }
}

/** 迟到副作用留痕（独立于超时事实本身；正交上报） */
function reportLateEffect(timeoutMs: number, settledAt: number): void {
  appendJsonLine("tool-timeout.jsonl", {
    src: "toolGuard",
    level: "warn",
    msg: "TIMEOUT_LATE_EFFECT：底层执行在超时判定后 settle，副作用可能已落地",
    timeoutMs,
    lateByMs: Date.now() - settledAt,
  });
  console.warn(`[toolGuard] TIMEOUT 迟到副作用：底层执行在超时后 settle（副作用可能已落地），已留痕 tool-timeout.jsonl`);
}

/**
 * 给工具 execute 包超时（Promise.race）：超时 reject ToolExecutionError(TIMEOUT)；
 * 正常/异常路径都清理定时器。入参原样透传，返回统一 Promise（调用方按需窄化——
 * ai SDK 工具 execute 返回 Promise|AsyncIterable 联合，这里不承诺具体形态）。
 * 底层 promise 被 catch 兜底防 unhandled rejection；非 thenable 返回值（如同步
 * AsyncIterable）不参与迟到检测（settle 语义不适用）。
 */
export function withToolTimeout<TArgs>(
  execute: (input: TArgs, opts: unknown) => unknown,
  timeoutMs: number,
): (input: TArgs, opts: unknown) => Promise<unknown> {
  return async (input, opts) => {
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new ToolExecutionError("TIMEOUT", `工具执行超时（${timeoutMs}ms；底层执行未取消，副作用可能仍会落地）`));
      }, timeoutMs);
    });
    const settledAt = Date.now();
    const underlying = Promise.resolve(execute(input, opts)) as Promise<unknown>;
    if (typeof (underlying as { then?: unknown }).then === "function") {
      void underlying.then(
        () => {
          if (timedOut) reportLateEffect(timeoutMs, settledAt);
        },
        () => {
          if (timedOut) reportLateEffect(timeoutMs, settledAt);
        },
      );
    }
    try {
      return await Promise.race([underlying, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
