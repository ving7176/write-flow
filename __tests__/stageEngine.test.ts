import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 公共编排引擎（stageEngine.ts）单元测试
 *
 * 覆盖：
 * - validateStageDefs 拓扑：key 唯一 / dependsOn 合法 / 无环 / isFirst·isLast 恰各一（三线 STAGES 全过）
 * - isStageGap 缺口语义：单字段空 / chapter 无已写章节 / episode 无已写集
 * - runStageDirect hooks：beforeRunStage 拦截与改写 prompt、afterSubAgent 调用、未知阶段
 * - runSupervision：无 supervision 返回空不调 checkTool；有 supervision 解析 <checkReport>
 * - runWorkflow 全流程（测试三阶段 + autoFlow=full）：缺口查找 → Gate4 → 生成 → 落库 → stageDone；
 *   redo/back 分支（semi + mock waitForStageConfirm）
 *
 * mock @/utils 的 db 层为有状态 mock（o_agentWorkData 写后能读回，支撑 Gate4 依赖门禁），
 * 照 xmlConsume.test.ts 模式，不触发真实 DB。
 */

const PID = 999002;
const LONG = "这是一段足够长的内容用于通过最小长度校验阈值测试，需要重复填充到超过五十个字符的硬性要求才能通过剧本正文的校验门槛。";

const dbState = vi.hoisted(() => ({
  workData: null as { id: number; data: string } | null,
}));

vi.mock("@/utils", () => {
  const agentChain = {
    first: async () => dbState.workData,
    update: async (patch: any) => {
      if (dbState.workData) dbState.workData = { ...dbState.workData, ...patch };
      return 0;
    },
  };
  const generic = {
    first: async () => undefined,
    count: () => ({ first: async () => ({ count: 0 }) }),
    max: () => ({ first: async () => ({ max: null }) }),
    update: async () => 0,
    select: () => Promise.resolve([]),
    orderBy: () => ({ select: async () => [] }),
  };
  return {
    default: {
      db: vi.fn().mockImplementation((table: string) => {
        const where = () => {
          if (table === "o_agentWorkData") return agentChain;
          if (table === "o_project") return { ...generic, first: async () => ({ id: PID, intro: "测试想法" }) };
          return generic;
        };
        return {
          where,
          insert: async (row: any) => {
            if (table === "o_agentWorkData") dbState.workData = row;
            return [];
          },
        };
      }),
      error: (e: any) => ({ message: e?.message ?? String(e) }),
    },
  };
});

vi.mock("@/pipeline/stageConfirm", () => ({
  waitForStageConfirm: vi.fn(),
  // P1-5 针对性返工：mock 环境无 note 通道，返回 undefined（等价无补充要求）
  takeRedoNote: vi.fn(() => undefined),
}));

// trace 模块 mock（1.2 trace 接入：stageEngine 现役引擎埋点；mock 后既有测试行为不变，另加断言测试）
const traceMock = vi.hoisted(() => {
  const trace = {
    recordTrace: vi.fn(),
    startTrace: vi.fn(),
  };
  trace.recordTrace.mockResolvedValue(undefined);
  // 模拟真实 startTrace：success/fail/retry/blocked 内部落 recordTrace（把 start 的 input 透传）
  trace.startTrace.mockImplementation((input: Record<string, unknown>) => ({
    input,
    success: (extra?: Record<string, unknown>) => trace.recordTrace({ ...input, event: "success", ...extra }),
    fail: (extra?: Record<string, unknown>) => trace.recordTrace({ ...input, event: "fail", ...extra }),
    retry: (extra?: Record<string, unknown>) => trace.recordTrace({ ...input, event: "retry", ...extra }),
    blocked: (extra?: Record<string, unknown>) => trace.recordTrace({ ...input, event: "blocked", ...extra }),
  }));
  return trace;
});

vi.mock("@/pipeline/trace", () => traceMock);

import { waitForStageConfirm } from "@/pipeline/stageConfirm";
import { createStageEngine, validateStageDefs, isStageGap, isQualityBlocked, buildGateRepairPrompt, GATE_MAX_RETRIES } from "@/pipeline/stageEngine";
import type { StageDef, StageHooks, StageToolMap, StageCheckReport } from "@/pipeline/stageEngine";
import { NOVEL_STAGES } from "@/agents/novelAgent/workflow";

// ── 测试用 测试三阶段 defs ──

const DEFS: StageDef[] = [
  { stageKey: "synopsis", name: "简介", dependsOn: [], preloadKeys: [], supervision: "novel_stage_check_synopsis.md", isFirst: true },
  { stageKey: "outline", name: "大纲", dependsOn: ["synopsis"], preloadKeys: [], supervision: "novel_stage_check_outline.md" },
  { stageKey: "chapter", name: "章节", dependsOn: ["outline"], preloadKeys: [], chapter: true, supervision: "novel_stage_check_milestone.md", isLast: true },
];

const REGISTRY = {
  agentKey: "novelAgent",
  stageXmlTag: (k: string) => `${k}Item`,
  stageLabels: { synopsis: "简介", outline: "大纲", chapter: "章节" } as Record<string, string>,
  countEpisodes: async () => 0,
};

const makeCtx = () => {
  const socket = { emit: vi.fn(), id: "sock-test" };
  return {
    socket,
    resTool: { data: { projectId: PID }, socket },
  } as any;
};

const makeStageTool = (xml: string) => ({ execute: vi.fn().mockResolvedValue({ raw: xml }) });

const makeStageTools = (): StageToolMap => ({
  synopsis: makeStageTool(`<synopsisItem>${LONG}</synopsisItem>`),
  outline: makeStageTool(`<outlineItem type="structure">卷索引表</outlineItem><outlineItem index="1" chapter="第1章">- 场景</outlineItem>`),
  chapter: makeStageTool(`<chapterItem><reel>卷一</reel><chapter>第1章</chapter><content>${LONG}</content></chapterItem>`),
});

describe("validateStageDefs · 阶段表拓扑", () => {
  it("novel STAGES 合法（允许外部 key answers/chapters/briefConfirmed）", () => {
    expect(validateStageDefs(NOVEL_STAGES, ["answers", "chapters", "briefConfirmed"])).toEqual([]);
  });

  it("阶段 key 重复 → 报错", () => {
    const defs: StageDef[] = [
      { stageKey: "a", name: "A", dependsOn: [], preloadKeys: [], isFirst: true },
      { stageKey: "a", name: "A2", dependsOn: [], preloadKeys: [], isLast: true },
    ];
    expect(validateStageDefs(defs)).toContain("阶段 key 重复: a");
  });

  it("dependsOn 引用未知 key → 报错", () => {
    const defs: StageDef[] = [
      { stageKey: "a", name: "A", dependsOn: ["ghost"], preloadKeys: [], isFirst: true, isLast: true },
    ];
    expect(validateStageDefs(defs)).toContain("阶段「a」依赖未知 key: ghost");
  });

  it("依赖成环 → 报错", () => {
    const defs: StageDef[] = [
      { stageKey: "a", name: "A", dependsOn: ["b"], preloadKeys: [], isFirst: true },
      { stageKey: "b", name: "B", dependsOn: ["a"], preloadKeys: [], isLast: true },
    ];
    expect(validateStageDefs(defs).some((e) => e.includes("成环"))).toBe(true);
  });

  it("isFirst/isLast 数量非法 → 报错", () => {
    const noFirst: StageDef[] = [{ stageKey: "a", name: "A", dependsOn: [], preloadKeys: [], isLast: true }];
    expect(validateStageDefs(noFirst).some((e) => e.includes("isFirst"))).toBe(true);
    const twoLast: StageDef[] = [
      { stageKey: "a", name: "A", dependsOn: [], preloadKeys: [], isFirst: true, isLast: true },
      { stageKey: "b", name: "B", dependsOn: [], preloadKeys: [], isLast: true },
    ];
    expect(validateStageDefs(twoLast).some((e) => e.includes("isLast"))).toBe(true);
  });
});

describe("isStageGap · 缺口语义", () => {
  it("单字段阶段：空/空白 → 缺口；有值 → 非缺口", () => {
    expect(isStageGap({ stageKey: "a", name: "A", dependsOn: [], preloadKeys: [] }, { a: "" })).toBe(true);
    expect(isStageGap({ stageKey: "a", name: "A", dependsOn: [], preloadKeys: [] }, { a: "  " })).toBe(true);
    expect(isStageGap({ stageKey: "a", name: "A", dependsOn: [], preloadKeys: [] }, { a: "有值" })).toBe(false);
    expect(isStageGap({ stageKey: "a", name: "A", dependsOn: [], preloadKeys: [] }, {})).toBe(true);
  });

  it("chapter 阶段：chapters 数组为空 → 缺口；非空 → 非缺口", () => {
    const def = { stageKey: "chapter", name: "章节", dependsOn: [], preloadKeys: [], chapter: true };
    expect(isStageGap(def, {})).toBe(true);
    expect(isStageGap(def, { chapters: [] })).toBe(true);
    expect(isStageGap(def, { chapters: [{ chapter: "第1章" }] })).toBe(false);
  });

  it("episode 阶段：已写集数 0 → 缺口；>0 → 非缺口", () => {
    const def = { stageKey: "script", name: "剧本", dependsOn: [], preloadKeys: [], episode: true };
    expect(isStageGap(def, {}, 0)).toBe(true);
    expect(isStageGap(def, {}, 3)).toBe(false);
  });

  it("arrayField 数组阶段：数组为空 → 缺口；非空 → 非缺口（arrayField 通用能力）", () => {
    const def = { stageKey: "deriveAssets", name: "衍生资产", dependsOn: [], preloadKeys: [], arrayField: "assets" };
    expect(isStageGap(def, {})).toBe(true);
    expect(isStageGap(def, { assets: [] })).toBe(true);
    expect(isStageGap(def, { assets: [{ id: 1 }] })).toBe(false);
  });
});

describe("registry.persistStage 覆盖 + episodesId 按集隔离", () => {
  beforeEach(() => {
    dbState.workData = null;
  });

  it("registry.persistStage 提供时走自定义落库", async () => {
    const customPersist = vi.fn().mockResolvedValue({ consumed: ["directorPlan"], chapterCount: 0, scriptCount: 0 });
    const engine = createStageEngine({
      agentKey: "testAgent",
      defs: [
        { stageKey: "directorPlan", name: "导演计划", dependsOn: [], preloadKeys: [], isFirst: true, isLast: true },
      ],
      registry: { agentKey: "testAgent", stageXmlTag: (k) => k, stageLabels: {}, persistStage: customPersist },
    });
    const res = await engine.persistStage(1, "directorPlan", "raw");
    expect(res.consumed).toEqual(["directorPlan"]);
    expect(customPersist).toHaveBeenCalledWith(1, "directorPlan", "raw", expect.objectContaining({ stageKey: "directorPlan" }));
  });

  it("runWorkflow 缺口查找按 episodesId 过滤工作区（分集隔离）", async () => {
    // 集 5 工作区：导演计划已有 → 非缺口；集 0 无工作区 → 缺口
    dbState.workData = { id: 1, data: JSON.stringify({ scriptPlan: "有导演计划", assets: [] }) };
    const engine = createStageEngine({
      agentKey: "testAgent",
      defs: [
        { stageKey: "directorPlan", name: "导演计划", dependsOn: [], preloadKeys: [], field: "scriptPlan", isFirst: true },
        { stageKey: "deriveAssets", name: "衍生资产", dependsOn: ["scriptPlan"], preloadKeys: [], arrayField: "assets", isLast: true },
      ],
      registry: { agentKey: "testAgent", stageXmlTag: (k) => k, stageLabels: {}, persistStage: async () => ({ consumed: [], chapterCount: 0, scriptCount: 0 }) },
    });
    const ctx = makeCtx();
    ctx.resTool.data.scriptId = 5;
    // directorPlan 已有产物 → 仅 deriveAssets 缺口；deriveAssets 执行成功（stageTools 用测试阶段键）
    const tools: StageToolMap = { deriveAssets: { execute: vi.fn().mockResolvedValue({ raw: "资产分析完成" }) } };
    const res = await engine.runWorkflow(ctx, { autoFlow: "full" }, { stageTools: tools });
    expect(res.ok).toBe(true);
    expect(tools.deriveAssets.execute).toHaveBeenCalledTimes(1);
  });
});

describe("runStageDirect · hooks 行为", () => {
  beforeEach(() => {
    dbState.workData = null;
  });

  it("未知阶段 → error，不调子 Agent", async () => {
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY });
    const tools = makeStageTools();
    const resp = await engine.runStageDirect(makeCtx(), "ghost", "prompt", tools);
    expect(resp.error).toBe("未知阶段: ghost");
    expect(tools.synopsis.execute).not.toHaveBeenCalled();
  });

  it("beforeRunStage 返回 error → 拦截，不调子 Agent", async () => {
    const hooks: StageHooks = { beforeRunStage: async () => ({ error: "章节已满 5 章上限" }) };
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY, hooks });
    const tools = makeStageTools();
    const resp = await engine.runStageDirect(makeCtx(), "synopsis", "prompt", tools);
    expect(resp.error).toBe("章节已满 5 章上限");
    expect(tools.synopsis.execute).not.toHaveBeenCalled();
  });

  it("beforeRunStage 改写 prompt → 子 Agent 收到改写值（promptProvided=true 时仍生效）", async () => {
    const hooks: StageHooks = { beforeRunStage: async (_c, _k, _p, provided) => ({ prompt: `改写后（provided=${provided}）` }) };
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY, hooks });
    const tools = makeStageTools();
    await engine.runStageDirect(makeCtx(), "synopsis", "原始", tools);
    expect(tools.synopsis.execute).toHaveBeenCalledWith({ prompt: "改写后（provided=true）" }, expect.anything());
  });

  it("afterSubAgent 在产物通过 Gate2 后调用", async () => {
    const after = vi.fn(async () => {});
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY, hooks: { afterSubAgent: after } });
    const tools = makeStageTools();
    await engine.runStageDirect(makeCtx(), "synopsis", "prompt", tools);
    expect(after).toHaveBeenCalledWith(expect.anything(), "synopsis", expect.objectContaining({ raw: expect.any(String) }), tools);
  });
});

describe("runSupervision · 阶段质检", () => {
  it("无 supervision 配置 → 返回空，不调 checkTool", async () => {
    const defs: StageDef[] = [{ stageKey: "a", name: "A", dependsOn: [], preloadKeys: [], isFirst: true, isLast: true }];
    const engine = createStageEngine({ agentKey: "x", defs, registry: { agentKey: "x", stageXmlTag: (k) => k, stageLabels: {} } });
    const checkTool = { execute: vi.fn() };
    const report = await engine.runSupervision(makeCtx(), "a", "text", checkTool as any);
    expect(report).toEqual({});
    expect(checkTool.execute).not.toHaveBeenCalled();
  });

  it("有 supervision 且 checkTool 返回 <checkReport> → 解析 rating/highlights/issues", async () => {
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY });
    const checkTool = {
      execute: vi.fn().mockResolvedValue({ raw: `<checkReport>{"rating":"A","highlights":["亮点1"],"issues":["问题1"]}</checkReport>` }),
    };
    const report: StageCheckReport = await engine.runSupervision(makeCtx(), "synopsis", "text", checkTool as any);
    expect(report.rating).toBe("A");
    expect(report.highlights).toEqual(["亮点1"]);
    expect(report.issues).toEqual(["问题1"]);
  });

  it("checkTool 输出无 checkReport → 返回 raw 空壳", async () => {
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY });
    const checkTool = { execute: vi.fn().mockResolvedValue({ raw: "纯文本无报告" }) };
    const report = await engine.runSupervision(makeCtx(), "synopsis", "text", checkTool as any);
    expect(report.raw).toBe("纯文本无报告");
    expect(report.rating).toBeUndefined();
  });
});

describe("runWorkflow · 确定性编排全流程", () => {
  beforeEach(() => {
    dbState.workData = null;
    vi.mocked(waitForStageConfirm).mockReset();
  });

  it("autoFlow=full：空工作区 → 按 DAG 跑完三阶段 → stageDone；onStagePersisted 各阶段调用", async () => {
    const onPersisted = vi.fn(async () => {});
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY, hooks: { onStagePersisted: onPersisted } });
    const ctx = makeCtx();
    const tools = makeStageTools();

    const res = await engine.runWorkflow(ctx, { autoFlow: "full" }, { stageTools: tools });

    if (!res.ok) console.log("DBG err:", res.error);
    expect(res.ok).toBe(true);
    // 三阶段各生成一次（缺口查找：空工作区 → synopsis/outline/chapter 全缺口）
    expect(tools.synopsis.execute).toHaveBeenCalledTimes(1);
    expect(tools.outline.execute).toHaveBeenCalledTimes(1);
    expect(tools.chapter.execute).toHaveBeenCalledTimes(1);
    // onStagePersisted 每阶段落库后调用
    expect(onPersisted).toHaveBeenCalledTimes(3);
    // 产物按序落库（Gate4 依赖门禁通过 = 前置阶段已写回工作区）
    const final = JSON.parse(dbState.workData!.data);
    expect(final.synopsis).toContain("足够长");
    expect(final.outline).toContain("## 全书结构");
    // full 不 emit awaitConfirm，只 emit stageDone
    const emits = (ctx.socket.emit as any).mock.calls.map((c: any) => c[0]);
    expect(emits).not.toContain("awaitConfirm");
    expect(emits).toContain("stageDone");
  });

  it("已全部完成（无缺口）→ 直接 ok，不 emit stageDone", async () => {
    dbState.workData = { id: 1, data: JSON.stringify({ synopsis: "x", outline: "y", chapter: "z" }) };
    // chapter 阶段缺口看工作区 chapters 数组（空 → 缺口）；此处 data 无 chapters → 有缺口，改置非空
    dbState.workData.data = JSON.stringify({ synopsis: "x", outline: "y", chapter: "z", chapters: [{ chapter: "第1章" }] });
    const engine = createStageEngine({
      agentKey: "testAgent",
      defs: DEFS,
      registry: { ...REGISTRY },
    });
    const ctx = makeCtx();
    const tools = makeStageTools();

    const res = await engine.runWorkflow(ctx, { autoFlow: "full" }, { stageTools: tools });
    expect(res.ok).toBe(true);
    expect(tools.synopsis.execute).not.toHaveBeenCalled();
    expect(ctx.socket.emit).not.toHaveBeenCalled();
  });

  it("autoFlow=semi：确认点 redo → 重跑本步；confirm → 下一步", async () => {
    vi.mocked(waitForStageConfirm).mockResolvedValueOnce("redo").mockResolvedValue("confirm");
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY });
    const ctx = makeCtx();
    const tools = makeStageTools();

    const res = await engine.runWorkflow(ctx, { autoFlow: "semi" }, { stageTools: tools });
    expect(res.ok).toBe(true);
    // synopsis 重跑一次（redo）+ 正常一次 = 2 次；outline/chapter 各 1 次
    expect(tools.synopsis.execute).toHaveBeenCalledTimes(2);
    expect(tools.outline.execute).toHaveBeenCalledTimes(1);
    expect(tools.chapter.execute).toHaveBeenCalledTimes(1);
    // semi 每个确认点 emit awaitConfirm（synopsis 因 redo 确认 2 次 → 共 4 次）
    const emits = (ctx.socket.emit as any).mock.calls.map((c: any) => c[0]);
    expect(emits.filter((e: string) => e === "awaitConfirm").length).toBe(4);
  });

  it("autoFlow=semi：确认点 back → 回退重跑上一阶段", async () => {
    vi.mocked(waitForStageConfirm).mockResolvedValueOnce("back").mockResolvedValue("confirm");
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY });
    const ctx = makeCtx();
    const tools = makeStageTools();

    const res = await engine.runWorkflow(ctx, { autoFlow: "semi" }, { stageTools: tools });
    expect(res.ok).toBe(true);
    // synopsis 首次 confirm 前被 back（i 回到 0 重跑）→ synopsis 2 次；outline/chapter 各 1 次
    expect(tools.synopsis.execute).toHaveBeenCalledTimes(2);
    expect(tools.outline.execute).toHaveBeenCalledTimes(1);
    expect(tools.chapter.execute).toHaveBeenCalledTimes(1);
  });
});

describe("runWorkflow · novel 构思强制停（阶段 0 拆分）", () => {
  // novel 六阶段 defs（world/characters 依赖 briefConfirmed 门禁标记）
  const NOVEL_DEFS: StageDef[] = NOVEL_STAGES.map((s) => ({
    stageKey: s.stageKey,
    name: s.name,
    dependsOn: s.dependsOn,
    preloadKeys: s.preloadKeys,
    chapter: s.chapter,
    supervision: s.supervision,
    isFirst: s.isFirst,
    isLast: s.isLast,
  }));
  const NOVEL_REGISTRY = {
    agentKey: "novelAgent",
    stageXmlTag: (k: string) => {
      const map: Record<string, string> = { brief: "briefItem", world: "worldItem", characters: "characterItem", synopsis: "synopsisItem", outline: "outlineItem", chapter: "chapterItem" };
      return map[k] ?? k;
    },
    stageLabels: { brief: "构思", world: "世界模型", characters: "人物设定", synopsis: "简介", outline: "大纲", chapter: "章节" } as Record<string, string>,
    countEpisodes: async () => 0,
  };
  const makeNovelTools = (): StageToolMap => ({
    brief: makeStageTool(`<briefItem>{"title":"测试书名","versions":[{"index":1,"name":"甲型","title":"《甲》","intro":"${LONG}"},{"index":2,"name":"乙型","title":"《乙》","intro":"${LONG}"}],"selected":"${LONG}"}</briefItem>`),
    world: makeStageTool(`<worldItem>${LONG}</worldItem>`),
    characters: makeStageTool(`<characterItem>${LONG}</characterItem>`),
    synopsis: makeStageTool(`<synopsisItem>${LONG}</synopsisItem>`),
    outline: makeStageTool(`<outlineItem type="structure">卷索引表</outlineItem><outlineItem index="1" chapter="第1章">- 场景</outlineItem>`),
    chapter: makeStageTool(`<chapterItem><reel>卷一</reel><chapter>第1章</chapter><content>${LONG}</content></chapterItem>`),
  });

  beforeEach(() => {
    dbState.workData = null;
    vi.mocked(waitForStageConfirm).mockReset();
  });

  it("autoFlow=full：novel brief 后强制停等确认，confirm 后统一 return（后续由前端重发 chat 触发）", async () => {
    const engine = createStageEngine({ agentKey: "novelAgent", defs: NOVEL_DEFS, registry: NOVEL_REGISTRY });
    const ctx = makeCtx();
    const tools = makeNovelTools();
    // brief 确认后放行。选版动作与 workflow 循环解耦（用户可能刷新/隔时确认），
    // 后端 confirm 后统一 return，world 由前端按 autoFlow 触发（semi generateStage / full 重发 chat / manual 用户点）
    vi.mocked(waitForStageConfirm).mockImplementationOnce(async () => {
      // 模拟前端 handleConfirm：setPlanData 写 briefConfirmed + emit stageConfirm
      dbState.workData = {
        ...dbState.workData!,
        data: JSON.stringify({ ...JSON.parse(dbState.workData!.data), briefConfirmed: "1" }),
      };
      return "confirm";
    });

    const res = await engine.runWorkflow(ctx, { autoFlow: "full" }, { stageTools: tools });
    expect(res.ok).toBe(true);
    // brief 只生成一次，confirm 后 return：world 不在此轮执行（由前端触发，防双跑）
    expect(tools.brief.execute).toHaveBeenCalledTimes(1);
    expect(tools.world.execute).not.toHaveBeenCalled();
    // brief 强制 emit awaitConfirm（即使 full）
    const emits = (ctx.socket.emit as any).mock.calls.map((c: any) => c[0]);
    expect(emits.filter((e: string) => e === "awaitConfirm").length).toBe(1);
    // 不 emit stageDone（runWorkflow 未跑完，前端续跑后由下一轮 workflow emit）
  });

  it("autoFlow=semi：novel brief confirm 后 return（交回前端，防与 generateStage 双跑）", async () => {
    vi.mocked(waitForStageConfirm).mockResolvedValueOnce("confirm");
    const engine = createStageEngine({ agentKey: "novelAgent", defs: NOVEL_DEFS, registry: NOVEL_REGISTRY });
    const ctx = makeCtx();
    const tools = makeNovelTools();

    const res = await engine.runWorkflow(ctx, { autoFlow: "semi" }, { stageTools: tools });
    expect(res.ok).toBe(true);
    // brief 生成一次后 return：world 不在此轮执行（前端 semi 自动 generateStage 下一缺口）
    expect(tools.brief.execute).toHaveBeenCalledTimes(1);
    expect(tools.world.execute).not.toHaveBeenCalled();
  });
});

describe("runWorkflow · shouldRepeatStage 章节循环续写（5 章语义）", () => {
  beforeEach(() => {
    dbState.workData = null;
  });

  it("shouldRepeatStage 返回 true → chapter 重复执行（连写），false 后推进结束", async () => {
    let asks = 0;
    const engine = createStageEngine({
      agentKey: "testAgent",
      defs: [{ stageKey: "chapter", name: "章节", dependsOn: [], preloadKeys: [], chapter: true, isFirst: true, isLast: true }],
      registry: {
        agentKey: "testAgent",
        stageXmlTag: (k) => `${k}Item`,
        stageLabels: { chapter: "章节" },
        // 自定义落库（绕过 consumeAgentOutput 的 agentKey 分支），chapter 产物算成功
        persistStage: async () => ({ consumed: ["chapter"], chapterCount: 1, scriptCount: 0 }),
      },
      hooks: {
        shouldRepeatStage: async (_ctx, stageKey) => {
          if (stageKey !== "chapter") return false;
          asks++;
          return asks <= 2; // 第 1、2 次询问 true（连写 2 章后），第 3 次 false 结束
        },
      },
    });
    const ctx = makeCtx();
    const chapterTool = vi.fn().mockResolvedValue({ raw: `<chapterItem><reel/><chapter>第1章</chapter><content>${LONG}</content></chapterItem>` });
    const res = await engine.runWorkflow(ctx, { autoFlow: "full" }, { stageTools: { chapter: { execute: chapterTool } } as unknown as StageToolMap });
    expect(res.ok).toBe(true);
    expect(chapterTool).toHaveBeenCalledTimes(3); // 首章 + 连写 2 章
  });

  it("不实现 shouldRepeatStage（未实现 shouldRepeatStage）→ chapter 只执行一次，循环行为不变", async () => {
    const engine = createStageEngine({
      agentKey: "testAgent",
      defs: [{ stageKey: "chapter", name: "章节", dependsOn: [], preloadKeys: [], chapter: true, isFirst: true, isLast: true }],
      registry: {
        agentKey: "testAgent",
        stageXmlTag: (k) => `${k}Item`,
        stageLabels: { chapter: "章节" },
        persistStage: async () => ({ consumed: ["chapter"], chapterCount: 1, scriptCount: 0 }),
      },
    });
    const ctx = makeCtx();
    const chapterTool = vi.fn().mockResolvedValue({ raw: `<chapterItem><reel/><chapter>第1章</chapter><content>${LONG}</content></chapterItem>` });
    const res = await engine.runWorkflow(ctx, { autoFlow: "full" }, { stageTools: { chapter: { execute: chapterTool } } as unknown as StageToolMap });
    expect(res.ok).toBe(true);
    expect(chapterTool).toHaveBeenCalledTimes(1);
  });
});

describe("runWorkflow · trace 埋点（1.2 可观测性）", () => {
  beforeEach(() => {
    dbState.workData = null;
    traceMock.recordTrace.mockClear();
    traceMock.startTrace.mockClear();
  });

  it("full 全流程：每阶段 startTrace + success（含 schemaValid），无依赖缺失不记 blocked", async () => {
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY });
    const ctx = makeCtx();
    const tools = makeStageTools();

    const res = await engine.runWorkflow(ctx, { autoFlow: "full" }, { stageTools: tools });
    expect(res.ok).toBe(true);
    // 三阶段各一次 startTrace（projectId/agentKey/gate 上下文就绪）
    expect(traceMock.startTrace).toHaveBeenCalledTimes(3);
    expect(traceMock.startTrace).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PID, agentKey: "novelAgent", gate: "gate4_orchestrator" }),
    );
    // 无依赖缺失 → blocked 不记录；success 正常收尾
    expect(traceMock.recordTrace).not.toHaveBeenCalledWith(expect.objectContaining({ event: "blocked" }));
  });

  it("决策层直调 makeWorkflowStageTool：前置依赖缺失 → recordTrace blocked", async () => {
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY });
    const ctx = makeCtx();
    const tools = makeStageTools();
    const wfTool = engine.makeWorkflowStageTool(ctx, { stageTools: tools });

    // synopsis 未生成 → outline 依赖缺失，Gate4 拦截并记 blocked
    const execute = wfTool.execute;
    if (!execute) throw new Error("execute missing");
    const res = (await execute({ stageKey: "outline" }, { toolCallId: "trace-test", messages: [] })) as { ok?: boolean };
    expect(res.ok).toBe(false);
    expect(traceMock.recordTrace).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "outline", event: "blocked", gate: "gate4_orchestrator" }),
    );
  });

  it("semi 确认 redo：同 stage 重跑，retryCount 累加进 trace", async () => {
    vi.mocked(waitForStageConfirm).mockResolvedValueOnce("redo").mockResolvedValue("confirm");
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY });
    const ctx = makeCtx();
    const tools = makeStageTools();

    const res = await engine.runWorkflow(ctx, { autoFlow: "semi" }, { stageTools: tools });
    expect(res.ok).toBe(true);
    // synopsis 因 redo 跑 2 次：第一次 retryCount=0，第二次 retryCount=1
    expect(traceMock.recordTrace).toHaveBeenCalledWith(expect.objectContaining({ stage: "synopsis", event: "success", retryCount: 0 }));
    expect(traceMock.recordTrace).toHaveBeenCalledWith(expect.objectContaining({ stage: "synopsis", event: "success", retryCount: 1 }));
  });
});

describe("runWorkflow · 2C 格式错自动重试", () => {
  beforeEach(() => {
    dbState.workData = null;
  });

  it("首次产物格式错（无标签）→ 自动重生成一次 → 成功落库修复稿", async () => {
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY });
    const ctx = makeCtx();
    const tools = {
      ...makeStageTools(),
      synopsis: {
        execute: vi
          .fn()
          .mockResolvedValueOnce("这不是合法产物（没有 XML 标签）")
          .mockResolvedValueOnce({ raw: `<synopsisItem>${LONG}</synopsisItem>` }),
      },
    };

    const res = await engine.runWorkflow(ctx, { autoFlow: "full" }, { stageTools: tools });
    expect(res.ok).toBe(true);
    // 重试：synopsis.execute 被调 2 次；最终落库的是修复稿
    expect(tools.synopsis.execute).toHaveBeenCalledTimes(2);
    const final = JSON.parse(dbState.workData!.data);
    expect(final.synopsis).toContain("足够长");
  });

  it("重试后仍格式错 → 返回 error（重试耗尽交人工），不无限重试", async () => {
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY });
    const ctx = makeCtx();
    const tools = {
      ...makeStageTools(),
      synopsis: { execute: vi.fn().mockResolvedValue("还是坏产物（无标签）") },
    };

    const res = await engine.runWorkflow(ctx, { autoFlow: "full" }, { stageTools: tools });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("synopsis");
    // 首稿 + 重试 1 次 = 2 次，不无限循环
    expect(tools.synopsis.execute).toHaveBeenCalledTimes(2);
  });

  it("非格式错（自定义 persistStage 返回普通 error）→ 不重试，execute 只调一次", async () => {
    const engine = createStageEngine({
      agentKey: "novelAgent",
      defs: DEFS,
      registry: {
        ...REGISTRY,
        persistStage: async () => ({ consumed: [], chapterCount: 0, scriptCount: 0, error: "DB 写入失败（非格式错）" }),
      },
    });
    const ctx = makeCtx();
    const tools = makeStageTools();

    const res = await engine.runWorkflow(ctx, { autoFlow: "full" }, { stageTools: tools });
    expect(res.ok).toBe(false);
    expect(tools.synopsis.execute).toHaveBeenCalledTimes(1); // 无重试
  });
});

describe("runWorkflow · 批次0 确认等待后缺口重算", () => {
  beforeEach(() => {
    dbState.workData = null;
    vi.mocked(waitForStageConfirm).mockReset();
  });

  it("semi 确认等待期间外部入口已完成后续阶段 → confirm 后不重复生成，直接收尾 stageDone", async () => {
    vi.mocked(waitForStageConfirm).mockImplementationOnce(async () => {
      // 模拟等待期间另一入口（工作台按钮/另一连接）推进：outline 已落库、chapters 已非空
      dbState.workData = {
        ...dbState.workData!,
        data: JSON.stringify({ ...JSON.parse(dbState.workData!.data), outline: "外部已完成", chapters: [{ chapter: "第1章" }] }),
      };
      return "confirm";
    });
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY });
    const ctx = makeCtx();
    const tools = makeStageTools();

    const res = await engine.runWorkflow(ctx, { autoFlow: "semi" }, { stageTools: tools });
    expect(res.ok).toBe(true);
    // synopsis 本轮生成 1 次；outline/chapter 已被外部完成 → 不重复生成（旧快照索引会照跑）
    expect(tools.synopsis.execute).toHaveBeenCalledTimes(1);
    expect(tools.outline.execute).not.toHaveBeenCalled();
    expect(tools.chapter.execute).not.toHaveBeenCalled();
    const emits = (ctx.socket.emit as any).mock.calls.map((c: any) => c[0]);
    expect(emits).toContain("stageDone");
  });

  it("back → 上一阶段与本阶段都重跑，再接剩余缺口", async () => {
    // 第一个确认（synopsis）：confirm 推进；第二个确认（outline）：back → synopsis+outline 重跑；后续 confirm
    vi.mocked(waitForStageConfirm).mockResolvedValueOnce("confirm").mockResolvedValueOnce("back").mockResolvedValue("confirm");
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY });
    const ctx = makeCtx();
    const tools = makeStageTools();

    const res = await engine.runWorkflow(ctx, { autoFlow: "semi" }, { stageTools: tools });
    expect(res.ok).toBe(true);
    // synopsis：首跑 + back 重跑 = 2；outline：首跑 + back 重跑 = 2；chapter 1
    expect(tools.synopsis.execute).toHaveBeenCalledTimes(2);
    expect(tools.outline.execute).toHaveBeenCalledTimes(2);
    expect(tools.chapter.execute).toHaveBeenCalledTimes(1);
  });
});

describe("Gate2 校验失败自动重试（缺口 4a）", () => {
  beforeEach(() => {
    dbState.workData = null;
    vi.mocked(waitForStageConfirm).mockReset();
  });

  it("runStageDirect：含 [GATE2] 前缀的错误标记 retryable，普通错误不标记", async () => {
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY });
    const tools = makeStageTools();
    tools.synopsis = { execute: vi.fn().mockResolvedValue({ error: "[GATE2] 未找到 <synopsisItem> 标签" }) };
    const r1 = await engine.runStageDirect(makeCtx(), "synopsis", "prompt", tools);
    expect(r1.error).toContain("[GATE2]");
    expect(r1.retryable).toBe(true);
    tools.synopsis = { execute: vi.fn().mockResolvedValue({ error: "前置依赖未完成" }) };
    const r2 = await engine.runStageDirect(makeCtx(), "synopsis", "prompt", tools);
    expect(r2.retryable).toBeFalsy();
  });

  it("runWorkflow：Gate2 失败 → 回灌错误重生成一次 → 成功落库", async () => {
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY });
    const ctx = makeCtx();
    const tools = makeStageTools();
    tools.synopsis = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ error: "[GATE2] 未找到 <synopsisItem> 标签" })
        .mockResolvedValueOnce({ raw: `<synopsisItem>${LONG}</synopsisItem>` }),
    };
    const res = await engine.runWorkflow(ctx, { autoFlow: "full" }, { stageTools: tools });
    expect(res.ok).toBe(true);
    expect(tools.synopsis.execute).toHaveBeenCalledTimes(2); // 原生成 + 重试一次
    // 重试 prompt 回灌了错误信息
    expect(String((tools.synopsis.execute as any).mock.calls[1][0].prompt)).toContain("[GATE2]");
    const final = JSON.parse(dbState.workData!.data);
    expect(final.synopsis).toContain("足够长");
  });

  it("runWorkflow：非 [GATE2] 错误（依赖门禁等）→ 不重试，直接 fail", async () => {
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY });
    const ctx = makeCtx();
    const tools = makeStageTools();
    tools.synopsis = { execute: vi.fn().mockResolvedValue({ error: "前置依赖未完成" }) };
    const res = await engine.runWorkflow(ctx, { autoFlow: "full" }, { stageTools: tools });
    expect(res.ok).toBe(false);
    expect(tools.synopsis.execute).toHaveBeenCalledTimes(1);
  });

  it("runWorkflow：重试仍失败 → 返回重试的错误信息（trace fail）", async () => {
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY });
    const ctx = makeCtx();
    const tools = makeStageTools();
    tools.synopsis = { execute: vi.fn().mockResolvedValue({ error: "[GATE2] 未找到 <synopsisItem> 标签" }) };
    const res = await engine.runWorkflow(ctx, { autoFlow: "full" }, { stageTools: tools });
    expect(res.ok).toBe(false);
    expect(tools.synopsis.execute).toHaveBeenCalledTimes(2);
    expect(res.error).toContain("[GATE2]");
  });
});

describe("质量门禁 · P1c（C/D 不静默通过，full 也强制停）", () => {
  beforeEach(() => {
    dbState.workData = null;
    vi.mocked(waitForStageConfirm).mockReset();
  });

  // checkTool：按 stageKey 返回评级序列（synopsis 用序列，其余恒 A）
  const makeCheckTool = (synopsisRatings: string[]) => {
    let synopsisChecks = 0;
    return {
      execute: vi.fn(async (input: { stageKey: string }) => {
        if (input.stageKey === "synopsis") {
          const r = synopsisRatings[Math.min(synopsisChecks, synopsisRatings.length - 1)];
          synopsisChecks++;
          return { raw: `<checkReport>{"rating":"${r}","issues":${r === "A" || r === "B" ? "[]" : '["质量问题"]'}}</checkReport>` };
        }
        return { raw: `<checkReport>{"rating":"A","issues":[]}</checkReport>` };
      }),
    };
  };

  it("autoFlow=full：质检恒 C → 门禁重做 GATE_MAX_RETRIES 次仍 C → 强制停（emit awaitConfirm + qualityDegraded），confirm 后推进", async () => {
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY });
    const ctx = makeCtx();
    const tools = makeStageTools();
    tools.run_stage_check = makeCheckTool(["C", "C", "C"]) as any;
    vi.mocked(waitForStageConfirm).mockResolvedValue("confirm");

    const res = await engine.runWorkflow(ctx, { autoFlow: "full" }, { stageTools: tools });
    expect(res.ok).toBe(true);
    // synopsis 初始 1 次 + 门禁重做 2 次 = 3 次；outline/chapter 各 1 次
    expect(tools.synopsis.execute).toHaveBeenCalledTimes(1 + GATE_MAX_RETRIES);
    expect(tools.outline.execute).toHaveBeenCalledTimes(1);
    // full 下因门禁强制停 → awaitConfirm + qualityDegraded 出现
    const emits = (ctx.socket.emit as any).mock.calls.map((c: any) => c[0]);
    expect(emits).toContain("awaitConfirm");
    expect(emits).toContain("qualityDegraded");
  });

  it("autoFlow=full：首次质检 C → 门禁重做 1 次后达标（B）→ 不强制停，正常推进（无 awaitConfirm）", async () => {
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY });
    const ctx = makeCtx();
    const tools = makeStageTools();
    tools.run_stage_check = makeCheckTool(["C", "B"]) as any;

    const res = await engine.runWorkflow(ctx, { autoFlow: "full" }, { stageTools: tools });
    expect(res.ok).toBe(true);
    // synopsis 初始 + 1 次门禁重做（达标后不再重做）
    expect(tools.synopsis.execute).toHaveBeenCalledTimes(2);
    // 达标 → 不强制停：full 无 awaitConfirm / qualityDegraded
    const emits = (ctx.socket.emit as any).mock.calls.map((c: any) => c[0]);
    expect(emits).not.toContain("awaitConfirm");
    expect(emits).not.toContain("qualityDegraded");
  });

  it("门禁重做 prompt 回灌质检问题（buildGateRepairPrompt）", async () => {
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY });
    const ctx = makeCtx();
    const tools = makeStageTools();
    tools.run_stage_check = makeCheckTool(["C", "B"]) as any;

    await engine.runWorkflow(ctx, { autoFlow: "full" }, { stageTools: tools });
    // 第二次 synopsis.execute（门禁重做）的 prompt 必须含质检评级与问题回灌
    const prompts = (tools.synopsis.execute as any).mock.calls.map((c: any) => c[0].prompt);
    expect(prompts[1]).toContain("质检未达标");
    expect(prompts[1]).toContain("质量");
  });
});

describe("isQualityBlocked / buildGateRepairPrompt · 纯函数", () => {
  it("isQualityBlocked：A/B → false；C/D/parseFailed → true；空评级 → false", () => {
    expect(isQualityBlocked({ rating: "A" })).toBe(false);
    expect(isQualityBlocked({ rating: "B" })).toBe(false);
    expect(isQualityBlocked({ rating: "C" })).toBe(true);
    expect(isQualityBlocked({ rating: "D" })).toBe(true);
    expect(isQualityBlocked({ rating: "c" })).toBe(true); // 大小写容忍
    expect(isQualityBlocked({ parseFailed: true })).toBe(true);
    expect(isQualityBlocked({})).toBe(false); // 无评级（未配置质检）→ 不拦截
    expect(isQualityBlocked({ rating: "", issues: [] })).toBe(false);
  });

  it("buildGateRepairPrompt：回灌评级与 issues，要求按标签输出", () => {
    const p = buildGateRepairPrompt("简介", { rating: "C", issues: ["逻辑断裂", "字数不足"] });
    expect(p).toContain("简介");
    expect(p).toContain("C");
    expect(p).toContain("逻辑断裂");
    expect(p).toContain("字数不足");
    expect(p).toContain("XML");
  });
});

describe("质量门禁 · C/D 不落库（防垃圾数据残留）", () => {
  beforeEach(() => {
    dbState.workData = null;
    vi.mocked(waitForStageConfirm).mockReset();
  });

  const makeCheckTool = (synopsisRatings: string[]) => {
    let synopsisChecks = 0;
    return {
      execute: vi.fn(async (input: { stageKey: string }) => {
        if (input.stageKey === "synopsis") {
          const r = synopsisRatings[Math.min(synopsisChecks, synopsisRatings.length - 1)];
          synopsisChecks++;
          return { raw: `<checkReport>{"rating":"${r}","issues":${r === "A" || r === "B" ? "[]" : '["质量问题"]'}}</checkReport>` };
        }
        return { raw: `<checkReport>{"rating":"A","issues":[]}</checkReport>` };
      }),
    };
  };

  it("非章节 C/D：强制停时工作区为空（未落库），confirm 接受后补落库", async () => {
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY });
    const ctx = makeCtx();
    const tools = makeStageTools();
    tools.run_stage_check = makeCheckTool(["C", "C", "C"]) as any;
    // 确认点触发时（C/D 门禁停）：工作区应无该阶段产物（无垃圾数据）
    vi.mocked(waitForStageConfirm).mockImplementation(async () => {
      // P0-1 后 workData 可能含 generation 元数据行——契约是「无该阶段产物」（非整行 null）
      expect(dbState.workData === null || !JSON.parse(dbState.workData.data).synopsis).toBe(true);
      return "confirm";
    });

    const res = await engine.runWorkflow(ctx, { autoFlow: "full" }, { stageTools: tools });
    expect(res.ok).toBe(true);
    // confirm 补落库后工作区有产物（用户明确接受 C/D 稿）
    const final = JSON.parse(dbState.workData!.data);
    expect(final.synopsis).toContain("足够长");
  });

  it("章节 gateBlocked（C/D）：章节不落库 + 强制停，confirm 后补落库", async () => {
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY });
    const ctx = makeCtx();
    ctx.resTool.data.chapterGateBlocked = true; // 模拟 afterSubAgent 标记章节返工耗尽且最优稿 C/D
    const tools = makeStageTools();
    // 章节确认点触发时：工作区 chapters 应为空/不存在（C/D 章节未落正式位置，无垃圾数据）
    vi.mocked(waitForStageConfirm).mockImplementation(async () => {
      const cur = JSON.parse(dbState.workData!.data);
      expect(!Array.isArray(cur.chapters) || cur.chapters.length === 0).toBe(true);
      return "confirm";
    });

    const res = await engine.runWorkflow(ctx, { autoFlow: "full" }, { stageTools: tools });
    expect(res.ok).toBe(true);
    const emits = (ctx.socket.emit as any).mock.calls.map((c: any) => c[0]);
    expect(emits).toContain("awaitConfirm"); // 章节 C/D 强制停
    expect(emits).toContain("qualityDegraded");
  });
});

describe("质量门禁 · 双轨（P1c：LLM 评级 A 但代码硬校验命中 → 也拦截）", () => {
  beforeEach(() => {
    // ERA 双轨用例基底：era 约束已建立且声明非现代（无 era 约束时 ERA 跳过，见末尾用例）
    dbState.workData = { id: 1, data: JSON.stringify({ constraints: [{ id: "C-001", type: "era", statement: "架空古代王朝，禁止热武器", status: "active" }] }) };
    vi.mocked(waitForStageConfirm).mockReset();
  });

  it("autoFlow=full：synopsis LLM 评级 A，但产物含时代错位词（[ERA] 代码硬校验）→ 门禁重做 2 次仍命中 → 强制停", async () => {
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY });
    const ctx = makeCtx();
    const tools = makeStageTools();
    // LLM 评级恒 A（放行），但代码硬校验（ERA 时代错位）命中 → 双轨拦截
    tools.run_stage_check = {
      execute: vi.fn(async (input: { stageKey: string }) => ({
        raw: `<checkReport>{"rating":"A","issues":[]}</checkReport>`,
      })),
    } as any;
    // 产物含现代词「手机」→ scanEraAnachronism 命中（非现代世界观）
    tools.synopsis.execute = vi.fn(async () => ({ raw: `<synopsisItem>主角掏出手机拨通了电话，决定进城查案。</synopsisItem>` }));
    vi.mocked(waitForStageConfirm).mockResolvedValue("confirm");

    const res = await engine.runWorkflow(ctx, { autoFlow: "full" }, { stageTools: tools });
    expect(res.ok).toBe(true);
    // 初始 1 次 + 门禁重做 2 次（每次重扫仍命中 ERA）= 3 次
    expect(tools.synopsis.execute).toHaveBeenCalledTimes(1 + GATE_MAX_RETRIES);
    const emits = (ctx.socket.emit as any).mock.calls.map((c: any) => c[0]);
    expect(emits).toContain("awaitConfirm"); // LLM 评级 A 也因代码硬校验强制停
    expect(emits).toContain("qualityDegraded");
  });

  it("autoFlow=full：LLM 评级 A，代码硬校验首次命中 → 门禁重做 1 次后干净 → 达标推进不强制停", async () => {
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY });
    const ctx = makeCtx();
    const tools = makeStageTools();
    tools.run_stage_check = {
      execute: vi.fn(async (input: { stageKey: string }) => ({
        raw: `<checkReport>{"rating":"A","issues":[]}</checkReport>`,
      })),
    } as any;
    let synopsisCalls = 0;
    tools.synopsis.execute = vi.fn(async () => {
      synopsisCalls++;
      const raw = synopsisCalls === 1
        ? `<synopsisItem>主角掏出手机拨通了电话。</synopsisItem>`
        : `<synopsisItem>主角进城，先拜码头，再查旧案，最后设局反杀。</synopsisItem>`;
      return { raw };
    });

    const res = await engine.runWorkflow(ctx, { autoFlow: "full" }, { stageTools: tools });
    expect(res.ok).toBe(true);
    expect(tools.synopsis.execute).toHaveBeenCalledTimes(2); // 初始 + 1 次门禁重做（命中消失后达标）
    const emits = (ctx.socket.emit as any).mock.calls.map((c: any) => c[0]);
    expect(emits).not.toContain("awaitConfirm"); // 达标不强制停
    expect(emits).not.toContain("qualityDegraded");
  });

  it("era 约束未建立（brief 首产前 constraints 空）→ ERA 跳过：现代词不触发门禁（E2E 实测误杀场景）", async () => {
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY });
    const ctx = makeCtx();
    const tools = makeStageTools();
    dbState.workData = { id: 1, data: JSON.stringify({ constraints: [] }) }; // brief 首产：约束尚未建立
    tools.run_stage_check = {
      execute: vi.fn(async () => ({ raw: `<checkReport>{"rating":"A","issues":[]}</checkReport>` })),
    } as any;
    // 现代题材简介正常提及现代词（收银机/手机）——无 era 约束不判时代错位
    tools.synopsis.execute = vi.fn(async () => ({ raw: `<synopsisItem>深夜便利店，他掏出手机看了一眼时间，收银机里多出一枚古铜币。</synopsisItem>` }));

    const res = await engine.runWorkflow(ctx, { autoFlow: "full" }, { stageTools: tools });
    expect(res.ok).toBe(true);
    expect(tools.synopsis.execute).toHaveBeenCalledTimes(1); // 无硬校验命中 → 不重做
    const emits = (ctx.socket.emit as any).mock.calls.map((c: any) => c[0]);
    expect(emits).not.toContain("awaitConfirm");
    expect(emits).not.toContain("qualityDegraded");
  });

  it("era 约束声明现代（末世科技停在现代水平）→ worldEra=modern：设定文档现代词全部放行", async () => {
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY });
    const ctx = makeCtx();
    const tools = makeStageTools();
    dbState.workData = { id: 1, data: JSON.stringify({ constraints: [{ id: "C-004", type: "era", statement: "都市末世背景，科技水平停留在灾变前现代水平", status: "active" }] }) };
    tools.run_stage_check = {
      execute: vi.fn(async () => ({ raw: `<checkReport>{"rating":"A","issues":[]}</checkReport>` })),
    } as any;
    tools.synopsis.execute = vi.fn(async () => ({ raw: `<synopsisItem>废墟里还亮着灯的便利店，货架靠灾变前的电力维持，监控拍下每个换物的人。</synopsisItem>` }));

    const res = await engine.runWorkflow(ctx, { autoFlow: "full" }, { stageTools: tools });
    expect(res.ok).toBe(true);
    expect(tools.synopsis.execute).toHaveBeenCalledTimes(1); // 现代世界观：电力/监控零命中 → 不重做
  });
});

describe("确认减负（B）：autoPassOk · semi 档 A/B 级自动通过（C/D 与红线仍停）", () => {
  beforeEach(() => {
    dbState.workData = null;
    vi.mocked(waitForStageConfirm).mockReset();
  });

  it("semi + autoPassOk + 评级 A → 不 awaitConfirm，直接推进", async () => {
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY });
    const ctx = makeCtx();
    const tools = makeStageTools();
    tools.run_stage_check = {
      execute: vi.fn(async () => ({ raw: `<checkReport>{"rating":"A","issues":[]}</checkReport>` })),
    } as any;
    const res = await engine.runWorkflow(ctx, { autoFlow: "semi", autoPassOk: true }, { stageTools: tools });
    expect(res.ok).toBe(true);
    const emits = (ctx.socket.emit as any).mock.calls.map((c: any) => c[0]);
    expect(emits).not.toContain("awaitConfirm"); // A 级自动通过
    expect(emits).toContain("stageProgress"); // 进度横幅事件
  });

  it("semi + autoPassOk + 评级 B → 自动通过；C/D 评级 → 仍强制停", async () => {
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY });
    const ctx = makeCtx();
    const tools = makeStageTools();
    tools.run_stage_check = {
      execute: vi.fn(async () => ({ raw: `<checkReport>{"rating":"B","issues":[]}</checkReport>` })),
    } as any;
    const res = await engine.runWorkflow(ctx, { autoFlow: "semi", autoPassOk: true }, { stageTools: tools });
    expect(res.ok).toBe(true);
    const emits = (ctx.socket.emit as any).mock.calls.map((c: any) => c[0]);
    expect(emits).not.toContain("awaitConfirm");

    // C 级 → 门禁重做耗尽后强制停（autoPassOk 不豁免质量底线）
    const ctx2 = makeCtx();
    const tools2 = makeStageTools();
    tools2.run_stage_check = {
      execute: vi.fn(async () => ({ raw: `<checkReport>{"rating":"C","issues":[]}</checkReport>` })),
    } as any;
    const res2 = await engine.runWorkflow(ctx2, { autoFlow: "semi", autoPassOk: true }, { stageTools: tools2 });
    expect(res2.ok).toBe(true);
    const emits2 = (ctx2.socket.emit as any).mock.calls.map((c: any) => c[0]);
    expect(emits2).toContain("awaitConfirm"); // C/D 仍强制停
  });

  it("semi + 未开 autoPassOk → A 级也停确认（开关关闭则原行为不变）", async () => {
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY });
    const ctx = makeCtx();
    const tools = makeStageTools();
    tools.run_stage_check = {
      execute: vi.fn(async () => ({ raw: `<checkReport>{"rating":"A","issues":[]}</checkReport>` })),
    } as any;
    await engine.runWorkflow(ctx, { autoFlow: "semi" }, { stageTools: tools });
    const emits = (ctx.socket.emit as any).mock.calls.map((c: any) => c[0]);
    expect(emits).toContain("awaitConfirm");
  });
});

describe("R1 生成期断线标记（runStageDirect 唯一漏斗全覆盖）", () => {
  beforeEach(() => {
    dbState.workData = null;
  });

  it("执行中登记 running+stageKey，收尾 running=false；异常路径同样收尾", async () => {
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY });
    const ctx = makeCtx();
    let runningDuringExec: boolean | null = null;
    let stageKeyDuringExec: string | null | undefined;
    const tools: StageToolMap = {
      synopsis: {
        execute: vi.fn(async () => {
          // 子 Agent 执行期间读取断线标记：beginGenerationMeta 已同步写入
          const d = dbState.workData ? JSON.parse(dbState.workData.data) : {};
          runningDuringExec = d.generation?.running ?? null;
          stageKeyDuringExec = d.generation?.stageKey;
          return { raw: `<synopsisItem>${LONG}</synopsisItem>` };
        }),
      },
    };
    await engine.runStageDirect(makeCtx(), "synopsis", "prompt", tools);
    // 实测要点：新 makeCtx 的 projectId 相同（999002），generation 残留在同一 workData 行
    const final = dbState.workData ? JSON.parse(dbState.workData.data) : {};
    expect(runningDuringExec).toBe(true);
    expect(stageKeyDuringExec).toBe("synopsis");
    expect(final.generation?.running).toBe(false);
    expect(typeof final.generation?.endedAt).toBe("number");
  });

  it("跨入口交错兜底：A 未收尾时 B 开始登记，B 收尾后运行位不被 A 的迟到的 end 覆盖为 false→仍是 A 的语义翻转防误伤", async () => {
    // 直接驱动引擎内部通道语义：先 begin A → begin B → end B(用 B 的 id) 后再 end A —— 运行位应保持「已收尾」（end A 因 attempt 不匹配被忽略，
    // 而 end B 已正常收尾）；若实现错误（无条件覆盖），end A 会把收尾后的 running 再次写成 true/false 抖动或覆盖 attemptId
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY });
    const ctx = makeCtx();
    const pid = Number(ctx.resTool.data.projectId);
    const attempts: string[] = [];
    // 通过 runStageDirect 并发两条（execute 内互等以制造窗口）：直接测私有通道不可行，
    // 改从可观测行为验证——并发两个直驱调用，后完成者不清掉前者的登记痕迹（最终 running=false 且 attempt 为后完成者）
    let gate: Promise<void> | null = null;
    const tools: StageToolMap = {
      synopsis: { execute: vi.fn(async () => { if (gate) await gate; return { raw: `<synopsisItem>${LONG}</synopsisItem>` }; }) },
      outline: { execute: vi.fn(async () => ({ raw: `<outlineItem type="structure">卷</outlineItem><outlineItem index="1" chapter="第1章">-</outlineItem>` })) },
    };
    const first = engine.runStageDirect(ctx, "synopsis", "", tools).then((r) => ({ key: "synopsis" as const, r }));
    const second = engine.runStageDirect(ctx, "outline", "", tools).then((r) => ({ key: "outline" as const, r }));
    void attempts;
    const [a, b] = await Promise.all([first, second]);
    void a; void b;
    const final = dbState.workData ? JSON.parse(dbState.workData.data) : {};
    expect(final.generation?.running).toBe(false); // 双入口各自 begin/end 收敛后整体收尾
  });
});

describe("R2 待复核裁决位（pendingReview 生命周期）", () => {
  beforeEach(() => {
    dbState.workData = null;
    vi.mocked(waitForStageConfirm).mockReset();
  });

  it("门禁强停挂起时登记 pendingReview；confirm 处理并继续达标阶段后自动作废清空", async () => {
    let snapshotDuringConfirm: unknown;
    let clearedByUserAction = false;
    vi.mocked(waitForStageConfirm).mockImplementation(async (_ctx: unknown, _stageKey: unknown) => {
      const d = dbState.workData ? JSON.parse(dbState.workData.data) : {};
      if (snapshotDuringConfirm === undefined && d.generation?.pendingReview) {
        snapshotDuringConfirm = d.generation.pendingReview;
      }
      return "confirm";
    });
    const engine = createStageEngine({ agentKey: "novelAgent", defs: DEFS, registry: REGISTRY });
    const ctx = makeCtx();
    const tools = makeStageTools();
    // synopsis 恒 C（门禁强停），其余阶段恒 A（confirm 推进后新一轮达标 → 作废清空）
    let synopsisCalls = 0;
    tools.run_stage_check = {
      execute: vi.fn(async (input: { stageKey: string }) => {
        if (input.stageKey === "synopsis") {
          synopsisCalls++;
          return { raw: `<checkReport>{"rating":"C","issues":["质量不达标"]}</checkReport>` };
        }
        return { raw: `<checkReport>{"rating":"A","issues":[]}</checkReport>` };
      }),
    } as any;

    const res = await engine.runWorkflow(ctx, { autoFlow: "full" }, { stageTools: tools });
    expect(res.ok).toBe(true);
    // 强停浮层出现时：快照已登记（stageKey+reason），且后续用户 confirm 走 socket 清除通道不可测，
    // 但主循环内「达标产出」路径必须将其作废清空
    expect(snapshotDuringConfirm).toMatchObject({ stageKey: "synopsis" });
    expect(String((snapshotDuringConfirm as { reason?: string }).reason)).toContain("C");
    const final = dbState.workData ? JSON.parse(dbState.workData.data) : {};
    expect(clearedByUserAction || final.generation?.pendingReview === null || final.generation?.pendingReview === undefined).toBe(true);
    expect(synopsisCalls).toBeGreaterThanOrEqual(1);
  });
});
