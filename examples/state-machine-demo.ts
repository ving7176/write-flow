/**
 * 零依赖运行示例：创作工作流状态机（workflowLoop）+ 确认决策（decideConfirm）。
 * 不需要数据库与 API Key，直接 `npx tsx examples/state-machine-demo.ts` 即可看到
 * 「缺口入队 → 达标推进 → 质量门禁强停 → redo 返工备注 → back 回退链 → 收尾」的完整状态流转。
 */
import { createWfLoop, decideConfirm, evalSchemaValid } from "@/pipeline/workflowLoop";
import type { StageDef } from "@/pipeline/stageEngine";

const STAGES: StageDef[] = [
  { stageKey: "synopsis", name: "梗概", dependsOn: [], preloadKeys: [] },
  { stageKey: "outline", name: "大纲", dependsOn: ["synopsis"], preloadKeys: [] },
  { stageKey: "chapter", name: "章节", dependsOn: ["outline"], preloadKeys: [], chapter: true },
];

const log = (step: string, detail = "") => console.log(`${step.padEnd(46, "─")} ${detail}`);

// ── 剧情一：三条全部达标，逐段直驱式推进 ──
const wf = createWfLoop(STAGES);
log("[1] 冷启动", `queue=${STAGES.map((s) => s.stageKey).join(" → ")}`);
wf.markDone("synopsis");
const afterSynopsis = decideConfirm({ autoFlow: "manual", autoPassOk: false, briefMustConfirm: false, gateBlocked: false, hardIssueCount: 0, rating: "A" });
log("[2] synopsis 达标(A)·manual 待确认", `need=${afterSynopsis.need} canAutoPass=${afterSynopsis.canAutoPass}`);
wf.advance();
log("[3] 推进至大纲", `current=${wf.current()?.stageKey}`);

// ── 剧情二：质量门禁强停 → 用户 redo 附带返工要求 ──
const blocked = decideConfirm({ autoFlow: "full", autoPassOk: false, briefMustConfirm: false, gateBlocked: true, hardIssueCount: 2, rating: "C" });
log("[4] outline 评级C+硬校验2项(full 也停)", `need=${blocked.need}`);
wf.planRedo("outline", "控制争议冲突比例，保留反转钩子");
wf.markDone("outline");
log("[5] redo 后重做并达标入库", `redoNote=${wf.takeRedoNote("outline") ?? "-"} retryCount=${wf.getState().retryCount}`);

// ── 剧情三：章节确认后回退链（back 重建队列，显式项优先于 doneKeys 过滤）──
wf.advance(); // 进入 chapter
wf.planBack([STAGES[1], STAGES[2]], []);
log("[6] 章节处用户回退一步", `rebuild=${wf.getState().queue.map((s) => s.stageKey).join(" → ")} explicit=[${[...wf.getState().explicitPending]}]`);

// ── schemaValid 推导口径速览 ──
for (const [label, report] of [["评级B无问题", { rating: "B" }], ["解析失败", { parseFailed: true }], ["空报告(未配置质检)", {}]] as const) {
  log(`[7] trace.schemaValid · ${label}`, evalSchemaValid(report));
}
if (wf.current() === undefined) log("EOF", "");
