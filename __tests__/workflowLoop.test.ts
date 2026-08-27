import { describe, it, expect } from "vitest";

/**
 * workflowLoop · runWorkflow 簿记状态机单元测试（纯模块，无 mock）。
 *
 * 锚定重构前 runWorkflow 的行为规格：
 * - 队列合并规则（rebuildQueue）：显式在前、缺口去重、doneKeys 过滤
 * - back / confirm 推进二择一（explicitPending 判定仅看当前之后的队列段）
 * - redo 备注取出即删；空备注不登记
 * - decideConfirm / evalSchemaValid 真值表与原内联表达式逐项等价
 */

import {
  createWfLoop,
  decideConfirm,
  evalSchemaValid,
  hasCheckReport,
} from "@/pipeline/workflowLoop";
import type { StageDef } from "@/pipeline/stageEngine";

const def = (stageKey: string): StageDef => ({ stageKey, name: stageKey.toUpperCase(), dependsOn: [], preloadKeys: [] });
const DEFS = [def("synopsis"), def("outline"), def("chapter")];

describe("createWfLoop · 基础遍历", () => {
  it("init/current/advance：按队列顺序推进，越界为 undefined（循环自然终止）", () => {
    const wf = createWfLoop(DEFS);
    expect(wf.current()?.stageKey).toBe("synopsis");
    wf.advance();
    expect(wf.current()?.stageKey).toBe("outline");
    wf.advance();
    expect(wf.current()?.stageKey).toBe("chapter");
    wf.advance();
    expect(wf.current()).toBeUndefined();
  });

  it("初始队列为空 → current 即 undefined（全部完成无需执行）", () => {
    const wf = createWfLoop([]);
    expect(wf.current()).toBeUndefined();
  });

  it("getState 运行中反映最新簿记（doneKeys/explicitPending/retryCount）", () => {
    const wf = createWfLoop(DEFS);
    wf.markDone("synopsis");
    wf.planRedo("outline", "要求更细");
    expect(wf.getState().doneKeys.has("synopsis")).toBe(true);
    expect(wf.getState().redoNotes.get("outline")).toBe("要求更细");
    expect(wf.getState().retryCount).toBe(1);
  });
});

describe("takeRedoNote · P1-5 针对性返工备注", () => {
  it("取出即删：第二次取同阶段为 undefined（注入一次即失效）", () => {
    const wf = createWfLoop(DEFS);
    wf.planRedo("synopsis", "开头要有悬念");
    expect(wf.takeRedoNote("synopsis")).toBe("开头要有悬念");
    expect(wf.takeRedoNote("synopsis")).toBeUndefined();
  });

  it("空字符串备注不登记（对齐原 if(note) 守卫）；其他阶段互不干扰", () => {
    const wf = createWfLoop(DEFS);
    wf.planRedo("synopsis", "");
    expect(wf.takeRedoNote("synopsis")).toBeUndefined();
    wf.planRedo("outline", "卷结构重排");
    expect(wf.takeRedoNote("synopsis")).toBeUndefined();
    expect(wf.takeRedoNote("outline")).toBe("卷结构重排");
  });
});

describe("planBack · 回退转移（批次0 行为锚点）", () => {
  it("idx>0：显式链 [上一阶段, 本阶段] 在前，剩余缺口接后；游标归零；retryCount+1", async () => {
    // 模拟 synopsis/outline 已完成、确认 outline 时 back：显式 [synopsis, outline]，缺口剩 chapter
    const wf = createWfLoop([DEFS[1], DEFS[2]]); // 当前在 outline
    wf.markDone("synopsis"); // 已在本轮落库
    wf.planBack([DEFS[0], DEFS[1]], [DEFS[2]]);
    expect(wf.getState().retryCount).toBe(1);
    expect(wf.getState().cursor).toBe(0);
    expect(wf.getState().queue.map((s) => s.stageKey)).toEqual(["synopsis", "outline", "chapter"]);
    expect([...wf.getState().explicitPending]).toEqual(["synopsis", "outline"]);
  });

  it("idx=0：显式链仅 [本阶段]；doneKeys 过滤不误伤显式重跑（强制重跑优先于去重过滤）", () => {
    const wf = createWfLoop(DEFS);
    wf.markDone("synopsis");
    wf.planBack([DEFS[0]], [DEFS[0], DEFS[1], DEFS[2]]);
    // synopsis 虽已 doneKeys 登记，但它是显式重跑项必须保留；gap 中的重复项被去重
    expect(wf.getState().queue.map((s) => s.stageKey)).toEqual(["synopsis", "outline", "chapter"]);
  });

  it("缺口中已落库且非显式的阶段被过滤（防重复生成）", () => {
    const wf = createWfLoop([DEFS[1]]);
    wf.markDone("synopsis");
    wf.planBack([DEFS[1]], [...DEFS]); // back 到首阶段，缺口含已完成 synopsis
    // 显式=[outline]；gaps 中 synopsis 被 doneKeys 过滤、outline 与显式项去重跳过、chapter 追加
    expect(wf.getState().queue.map((s) => s.stageKey)).toEqual(["outline", "chapter"]);
  });
});

describe("advanceAfterConfirm · confirm 后推进二择一", () => {
  it("显式链尚有位于当前的后续项 → 仅游标 +1，队列保持不动", () => {
    // back 场景续：队列 [synopsis, outline, chapter]，explicit={synopsis,outline}
    const wf = createWfLoop([]);
    wf.planBack([DEFS[0], DEFS[1]], []);
    wf.markDone("synopsis"); // synopsis 执行完并 confirm（当前游标仍指 synopsis）
    const out = wf.advanceAfterConfirm([]); // outline 在其身后且属显式链 → 游标推进
    expect(out).toBe("advanced");
    expect(wf.current()?.stageKey).toBe("outline");
    // 显式链未清空，outline confirm 后继续走同一判定
    expect(wf.getState().explicitPending.size).toBe(2);
  });

  it("无显式链的普通推进 → 按缺口重建队列（过滤 doneKeys），清空 explicitPending，游标归零", () => {
    const wf = createWfLoop([DEFS[0]]);
    wf.markDone("synopsis");
    wf.advanceAfterConfirm([DEFS[1], DEFS[2]]);
    expect(wf.getState().cursor).toBe(0);
    expect(wf.getState().queue.map((s) => s.stageKey)).toEqual(["outline", "chapter"]);
    expect(wf.current()?.stageKey).toBe("outline");
  });

  it("重建结果为空 → 'empty'（收尾，runWorkflow 发 stageDone 后退出）", () => {
    const wf = createWfLoop([DEFS[0]]);
    wf.markDone("synopsis");
    const out = wf.advanceAfterConfirm([DEFS[0]]); // 唯一缺口已被本轮落库
    expect(out).toBe("empty");
    expect(wf.current()).toBeUndefined();
  });

  it("显式判定只看当前之后（已完成的前段显式项不算 ahead）——对齐原 queue.slice(i+1)", () => {
    const wf = createWfLoop([]);
    wf.planBack([DEFS[0], DEFS[1]], [DEFS[2]]);
    // 执行完 synopsis 后 confirm：outline 在其身后且属显式链 → 游标推进（不走重建）
    expect(wf.advanceAfterConfirm([])).toBe("advanced");
    expect(wf.current()?.stageKey).toBe("outline");
    // 执行完 outline 后 confirm：身后仅剩非显式的 chapter → 走重建分支，队列=[chapter]、清空显式链
    expect(wf.advanceAfterConfirm([DEFS[2]])).toBe("advanced");
    expect(wf.current()?.stageKey).toBe("chapter");
    expect(wf.getState().explicitPending.size).toBe(0);
  });
});

describe("hasCheckReport · 有效质检判据（R3 回填修复共用）", () => {
  it("空对象/undefined → false（chapter 浮层回填触发条件）；任一字段非空 → true", () => {
    expect(hasCheckReport(undefined)).toBe(false);
    expect(hasCheckReport({})).toBe(false);
    expect(hasCheckReport({ issues: [] })).toBe(false);
    expect(hasCheckReport({ rating: "B" })).toBe(true);
    expect(hasCheckReport({ raw: "<checkReport/>" })).toBe(true);
    expect(hasCheckReport({ issues: ["问题"] })).toBe(true);
  });

  it("与 evalSchemaValid 的 skip 分支同源：无有效质检 ⇔ skip", () => {
    const samples: (Parameters<typeof hasCheckReport>[0])[] = [undefined, {}, { issues: [] }, { rating: "A" }];
    for (const r of samples) {
      expect((evalSchemaValid(r) === "skip") === !hasCheckReport(r)).toBe(true);
    }
  });
});

describe("decideConfirm · 四因子真值表（原 :834-841 内联表达式等价性）", () => {
  const base = { autoPassOk: false, briefMustConfirm: false, gateBlocked: false, hardIssueCount: 0, rating: undefined };

  it("full：普通达标 → 不停（full 天然跳过普通确认点）", () => {
    expect(decideConfirm({ ...base, autoFlow: "full" })).toEqual({ need: false, canAutoPass: false });
  });

  it("manual：任何情况都停（非 full 且不可自动通过）", () => {
    expect(
      decideConfirm({ ...base, autoFlow: "manual", autoPassOk: true, rating: "A" }),
    ).toEqual({ need: true, canAutoPass: false });
  });

  it("semi 关闭 autoPassOk → A 级也停；开启 + A/B 且干净 → 自动通过", () => {
    expect(decideConfirm({ ...base, autoFlow: "semi", rating: "A" }).need).toBe(true);
    expect(
      decideConfirm({ ...base, autoFlow: "semi", autoPassOk: true, rating: "A" }),
    ).toEqual({ need: false, canAutoPass: true });
    expect(
      decideConfirm({ ...base, autoFlow: "semi", autoPassOk: true, rating: "B" }),
    ).toEqual({ need: false, canAutoPass: true });
  });

  it("自动通过的四道闸任一命中即失效：brief / 门禁 / 硬校验 / 非 semi", () => {
    const semi = { ...base, autoFlow: "semi" as const, autoPassOk: true, rating: "A" };
    expect(decideConfirm({ ...semi, briefMustConfirm: true })).toEqual({ need: true, canAutoPass: false });
    expect(decideConfirm({ ...semi, gateBlocked: true })).toEqual({ need: true, canAutoPass: false });
    expect(decideConfirm({ ...semi, hardIssueCount: 1 })).toEqual({ need: true, canAutoPass: false });
  });

  it("gateBlocked 对 full 也强制停（质量底线不降）；briefMustConfirm 对所有档位生效", () => {
    expect(decideConfirm({ ...base, autoFlow: "full", gateBlocked: true }).need).toBe(true);
    expect(decideConfirm({ ...base, autoFlow: "manual", briefMustConfirm: true }).need).toBe(true);
    expect(decideConfirm({ ...base, autoFlow: "full", briefMustConfirm: true }).need).toBe(true);
  });

  it("评级小写 c 不算 B（严格等值，保留原比较语义）；C/D 由门禁拦截而非减负判定", () => {
    expect(decideConfirm({ ...base, autoFlow: "semi", autoPassOk: true, rating: "b" }).canAutoPass).toBe(false);
  });
});

describe("evalSchemaValid · trace 推导等价性（原 :813-820）", () => {
  it("解析失败优先 fail（防假阳性）", () => {
    expect(evalSchemaValid({ parseFailed: true, rating: "A" })).toBe("fail");
  });

  it("无质检配置/空报告 → skip", () => {
    expect(evalSchemaValid(undefined)).toBe("skip");
    expect(evalSchemaValid({})).toBe("skip");
    expect(evalSchemaValid({ issues: [] })).toBe("skip");
  });

  it("有报告且带未清 issues → fail；干净 A/B 或仅 raw（无 issues）→ pass", () => {
    expect(evalSchemaValid({ rating: "B" })).toBe("pass");
    expect(evalSchemaValid({ rating: "C", issues: ["逻辑断裂"] })).toBe("fail");
    expect(evalSchemaValid({ raw: "<checkReport>原文</checkReport>" })).toBe("pass");
  });
});
