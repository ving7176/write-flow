import type { SchemaValid } from "@/pipeline/trace";
import type { StageCheckReport, StageDef } from "@/pipeline/stageEngine";

/**
 * runWorkflow 簿记状态机（纯逻辑，零 IO）。
 *
 * 目标（重构 P1）：把 runWorkflow 循环体内的可变簿记——队列 / 游标 / 已完成集合 /
 * 返工备注 / 显式重跑链 / 重跑计数——收敛为唯一状态对象 WfState，只能经本文件的
 * 命名转移函数变更；stageEngine.runWorkflow 本体退化为 IO 编排器
 * （assertStageReady 门禁 / 子 Agent 生成 / 落库 / socket 事件 / 确认等待）。
 *
 * 行为锚点（重构自 stageEngine.runWorkflow，语义逐条对应）：
 * - planBack        ← back 分支（原 :876-884）：显式链在前 + 缺口重算过滤在后，游标归零
 * - advanceAfterConfirm ← confirm 后推进二择一（原 :905-913）：显式链尚有未执行项 → 游标前移；
 *                     否则按缺口重建队列（过滤 doneKeys），队列为空返回 "empty"
 * - markDone        ← 原 doneStageKeys.add（批次0 过滤依据）
 * - takeRedoNote    ← 原 stageRedoNotes.get+delete（P1-5 针对性返工备注，注入一次即清除）
 * - bumpRetry       ← 用户触发 redo/back 的重跑计数（仅 trace 观测；门禁自动重做不计入）
 *
 * 本文件禁止引入任何 IO 依赖（db/socket/fs），保证决策可同步单测。
 */

/** 循环运行时簿记（旧 runWorkflow 六个局部变量的单一载体） */
export interface WfState {
  /** 当前执行队列 */
  queue: StageDef[];
  /** 队列游标 */
  cursor: number;
  /** 本轮已成功落库的阶段 key（缺口重算时的去重过滤；显式 redo/back 强制重跑不受过滤） */
  doneKeys: Set<string>;
  /** 用户 redo 补充要求（按 stageKey；取出即删） */
  redoNotes: Map<string, string>;
  /** back 显式重跑链中尚未执行的阶段 key（confirm 推进时判「队列内还有显式项」用） */
  explicitPending: Set<string>;
  /** 用户触发 redo/back 的重跑次数（trace.retryCount 观测口径） */
  retryCount: number;
}

/** 确认后推进的两种去向："advanced" = 队列已有下一步；"empty" = 缺口重算为空，收尾 */
export type AdvanceOutcome = "advanced" | "empty";

export interface WfLoop {
  /** 只读快照（测试断言入口；业务代码不应直接改写字段） */
  getState(): Readonly<WfState>;
  /** 当前待执行阶段（游标越界 = undefined，循环自然终止） */
  current(): StageDef | undefined;
  /** 普通推进：游标 +1 */
  advance(): void;
  /** 成功落库登记（缺口语义见 WfState.doneKeys） */
  markDone(stageKey: string): void;
  /**
   * redo 转移（原子）：用户重跑计数 +1，并登记补充要求（空值不登记，对齐原 `if (note)` 守卫）。
   * 游标不动，下一轮原地重跑当前阶段。
   */
  planRedo(stageKey: string, note?: string): void;
  /** 取出并清除某阶段的返工备注（P1-5：注入重跑 prompt 后即失效） */
  takeRedoNote(stageKey: string): string | undefined;
  /**
   * back 转移（原子）：用户重跑计数 +1，队列重建为「显式重跑链在前 + 缺口重算（过滤已落库）
   * 在后」，游标归零。rebuiltGaps 必须由调用方先行收集（IO 与转移分离，保持本函数纯）。
   */
  planBack(explicit: StageDef[], rebuiltGaps: StageDef[]): void;
  /**
   * confirm 后推进二择一：显式链中仍有排在当前之后的未执行项 → 游标 +1（保留其后的显式链）；
   * 否则按缺口重建队列（过滤 doneKeys）、清空显式链、游标归零。重建结果为空 → "empty"（收尾）。
   * gaps 同样由调用方先行收集。
   */
  advanceAfterConfirm(rebuiltGaps: StageDef[]): AdvanceOutcome;
}

function createInitialState(initialQueue: StageDef[]): WfState {
  return {
    queue: [...initialQueue],
    cursor: 0,
    doneKeys: new Set(),
    redoNotes: new Map(),
    explicitPending: new Set(),
    retryCount: 0,
  };
}

/**
 * 队列合并规则（与原 rebuildQueue 一致）：显式项在前；缺口按序追加，跳过与显式项重复、
 * 以及本轮已落库（doneKeys）的阶段——显式强制重跑不受 doneKeys 过滤。
 */
function mergeQueue(explicit: StageDef[], gaps: StageDef[], doneKeys: ReadonlySet<string>): StageDef[] {
  const queue = [...explicit];
  for (const g of gaps) {
    if (!queue.some((q) => q.stageKey === g.stageKey) && !doneKeys.has(g.stageKey)) queue.push(g);
  }
  return queue;
}

export function createWfLoop(initialQueue: StageDef[]): WfLoop {
  const s = createInitialState(initialQueue);

  return {
    getState: () => s,
    current: () => s.queue[s.cursor],
    advance: () => {
      s.cursor++;
    },
    markDone: (stageKey) => {
      s.doneKeys.add(stageKey);
    },
    planRedo: (stageKey, note) => {
      s.retryCount++;
      if (note) s.redoNotes.set(stageKey, note);
    },
    takeRedoNote: (stageKey) => {
      const note = s.redoNotes.get(stageKey);
      s.redoNotes.delete(stageKey);
      return note;
    },
    planBack: (explicit, rebuiltGaps) => {
      s.retryCount++;
      s.queue = mergeQueue(explicit, rebuiltGaps, s.doneKeys);
      s.explicitPending = new Set(explicit.map((st) => st.stageKey));
      s.cursor = 0;
    },
    advanceAfterConfirm: (rebuiltGaps) => {
      // 对齐原判定：只看「当前之后」的队列段里是否还有显式重跑项
      const hasExplicitAhead = [...s.explicitPending].some((k) =>
        s.queue.slice(s.cursor + 1).some((st) => st.stageKey === k),
      );
      if (hasExplicitAhead) {
        s.cursor++;
        return "advanced";
      }
      s.queue = mergeQueue([], rebuiltGaps, s.doneKeys);
      s.explicitPending = new Set();
      s.cursor = 0;
      return s.queue.length === 0 ? "empty" : "advanced";
    },
  };
}

// ── 无状态决策函数 ──

/** 是否需要人工确认（原 :834-841 四因子内联表达展开为命名函数） */
export interface ConfirmDecisionInput {
  autoFlow: "manual" | "semi" | "full";
  /** 确认减负开关（用户设置，配合 semi 档生效） */
  autoPassOk: boolean;
  /** novel brief 选版强制停（所有 autoFlow） */
  briefMustConfirm: boolean;
  /** 质量门禁强停（LLM 评级 C/D 或硬校验命中；章节返工耗尽） */
  gateBlocked: boolean;
  /** 代码硬校验命中数 */
  hardIssueCount: number;
  /** LLM 评级（空 = 未配置质检） */
  rating?: string;
}

export interface ConfirmDecision {
  /** 进入人工确认分支（awaitConfirm + 代码级等待） */
  need: boolean;
  /** 确认减负命中（need 必为 false，附带前端 auto-passed 进度事件的展示评级） */
  canAutoPass: boolean;
}

/**
 * 三因子合取：briefMustConfirm / gateBlocked / 「非 full 且不可自动通过」任一成立即停；
 * full 档天然跳过普通确认点（质量底线由 gateBlocked 单独兜住）。
 */
export function decideConfirm(input: ConfirmDecisionInput): ConfirmDecision {
  const canAutoPass =
    !!input.autoPassOk &&
    input.autoFlow === "semi" &&
    !input.briefMustConfirm &&
    !input.gateBlocked &&
    input.hardIssueCount === 0 &&
    (input.rating === "A" || input.rating === "B");
  const need = input.briefMustConfirm || input.gateBlocked || (input.autoFlow !== "full" && !canAutoPass);
  return { need, canAutoPass };
}

/**
 * 是否携带有效质检内容（rating/raw/issues 任一非空）——schemaValid 推导与
 * 「chapter 浮层报告回填」判定共用同一判据（重构 R3：原先 `!confirmReport` 以对象真值
 * 作判据恒 false，导致章节确认浮层永远拿不到审稿意见回填）。
 */
export function hasCheckReport(checkReport: StageCheckReport | undefined): boolean {
  return (
    !!checkReport?.rating ||
    !!checkReport?.raw ||
    (Array.isArray(checkReport?.issues) && checkReport.issues.length > 0)
  );
}

/**
 * trace schemaValid 推导（原 stageEngine :813-820）：
 * 解析失败 → fail（防假阳性）；无质检配置/质检空输出 → skip；有未清 issues → fail；否则 pass。
 */
export function evalSchemaValid(checkReport: StageCheckReport | undefined): SchemaValid {
  return checkReport?.parseFailed
    ? "fail"
    : !hasCheckReport(checkReport)
      ? "skip"
      : Array.isArray(checkReport?.issues) && checkReport.issues.length > 0
        ? "fail"
        : "pass";
}
