/**
 * 执行层工具统一防护（4B）：工具级超时 + 统一异常码。
 *
 * 背景：原工具 execute 无工具级超时（超时只在 LLM 调用层 ai.ts），出错是裸 Error 或
 * {error} 鸭子类型，无统一错误码可审计。这里提供 withToolTimeout 包装 +
 * ToolExecutionError 携带 errorCode，供 stageEngine 统一转成 [CODE] 前缀的错误信息。
 */

/** 统一工具错误码 */
export const TOOL_ERROR_CODES = {
  /** 工具执行超时（withToolTimeout 触发） */
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

/**
 * 给工具 execute 包超时（Promise.race）：超时 reject ToolExecutionError(TIMEOUT)；
 * 正常/异常路径都清理定时器。入参原样透传，返回统一 Promise（调用方按需窄化——
 * ai SDK 工具 execute 返回 Promise|AsyncIterable 联合，这里不承诺具体形态）。
 */
export function withToolTimeout<TArgs>(
  execute: (input: TArgs, opts: unknown) => unknown,
  timeoutMs: number,
): (input: TArgs, opts: unknown) => Promise<unknown> {
  return async (input, opts) => {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ToolExecutionError("TIMEOUT", `工具执行超时（${timeoutMs}ms）`)), timeoutMs);
    });
    try {
      return await Promise.race([Promise.resolve(execute(input, opts)), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
