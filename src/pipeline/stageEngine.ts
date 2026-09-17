import { z } from "zod";
import { tool, jsonSchema } from "ai";
import type { Socket } from "socket.io";
import u from "@/utils";
import Memory from "@/utils/agent/memory";
import ResTool from "@/socket/resTool";
import { assertStageReady } from "@/pipeline/stageGate";
import { waitForStageConfirm, takeRedoNote } from "@/pipeline/stageConfirm";
import { consumeAgentOutput, ConsumeError } from "@/pipeline/xmlConsume";
import { startTrace, recordTrace } from "@/pipeline/trace";
import { withToolTimeout, ToolExecutionError } from "@/pipeline/toolGuard";
import { consumePendingVolumeDone } from "@/agents/novelAgent/outlinePlan";
import { listCheckReports, saveCheckReport, saveCheckReportPlaceholder } from "@/pipeline/checkReport";
import { createGenericScanProvider, buildNovelScanContext } from "@/pipeline/scanProvider";
import { mergeConstraintRules, buildRuleSet } from "@/pipeline/bannedWordScan";
import { readWorkConstraints } from "@/agents/novelAgent/constraints";
import { createWfLoop, decideConfirm, evalSchemaValid, hasCheckReport } from "@/pipeline/workflowLoop";
import type { ScanIssue } from "@/agents/novelAgent/supervision";
import path from "path";
import fs from "fs";

/** 4B：工具级超时（LLM 调用层 90s，工具含生成+解析给 180s 余量） */
const TOOL_TIMEOUT_MS = 180_000;

/**
 * P1c 质量门禁：单阶段质检重做上限（非章节阶段 C/D 自动重做次数，与章节返工上限一致；
 * 受 chat/stageGenerate 入口的 40 次 AI 调用预算覆盖）。重做后仍不达标 → 强制人工确认点（full 也停）。
 */
export const GATE_MAX_RETRIES = 2;

/**
 * P1c 质量门禁判定（纯函数）：质检 C/D（gradeRank<=2）或 <checkReport> 解析失败 → 拦截；
 * A/B 或无评级（未配置质检/空报告）→ 放行。LLM 评级为软门禁——代码硬红线（Gate2/扫描器）另有机制。
 */
export function isQualityBlocked(checkReport: StageCheckReport): boolean {
  if (checkReport?.parseFailed) return true;
  const r = (checkReport?.rating ?? "").trim().toUpperCase();
  if (!r) return false;
  return r !== "A" && r !== "B";
}

/** P1c 门禁重做 prompt（纯函数）：回灌质检问题，要求按既定 XML 标签重新输出（与 2C/Gate2 重试同措辞风格） */
export function buildGateRepairPrompt(stageName: string, checkReport: StageCheckReport): string {
  const issues = Array.isArray(checkReport.issues) ? checkReport.issues : [];
  const block = issues.length ? `\n上一版质检问题：\n${issues.map((i) => `- ${i}`).join("\n")}` : "";
  return `你上一版「${stageName}」产物质检未达标（评级 ${checkReport.rating ?? "未知"}）${block}。请严格按既定 XML 标签格式重新输出本阶段产物，修复上述问题，只输出标签内容本身，不要附加任何解释或 Markdown 代码块。`;
}

/**
 * 小说创作确定性编排公共引擎。
 *
 * 抽象边界（P4a）：
 * - 各阶段重复的「workflow 循环 / runStageDirect / persistStage / runSupervision /
 *   run_workflow_stage / run_stage_check 工具」收敛于此，差异经 StageSchemaRegistry（schema 适配）
 *   与 StageHooks（chapter 特判/自动立项）参数化
 * - 不抽象 createSubAgent（各阶段子 Agent 工具 + runAgent 差异大，作依赖注入传入）
 * - 公共函数 buildMemPrompt/consumeFullStream/removeAllXmlTags/promptInput/AgentContext/StageCheckReport
 *   原各线逐行相同的副本收敛于此，各线改 import
 *
 * 接入（createSubAgent 内）：
 *   const engine = createStageEngine({ agentKey, defs, registry, hooks });
 *   const run_workflow_stage = engine.makeWorkflowStageTool(ctx, { stageTools });
 *   const run_stage_check = engine.makeStageCheckTool(ctx, { checkAgentKey, name, runSubAgent, preloadWorkData });
 */

// ── 公共类型 ──

export interface AgentContext {
  socket: Socket;
  isolationKey: string;
  text: string;
  /** P2-4 多租户：当前登录用户 id（socket 握手 JWT 身份，配额/审计用） */
  userId?: number;
  /** 交互模式（novel 决策层用；drama/script 未用，字段保留统一类型） */
  mode?: "guide" | "brainless";
  autoFlow?: "manual" | "semi" | "full";
  userMessageTime?: number;
  abortSignal?: AbortSignal;
  resTool: ResTool;
  msg: ReturnType<ResTool["newMessage"]>;
  thinkConfig: {
    think: boolean;
    thinlLevel: 0 | 1 | 2 | 3;
  };
}

export interface StageCheckReport {
  rating?: string;
  highlights?: string[];
  issues?: string[];
  raw?: string;
  /** 缺口⑤：<checkReport> 解析失败标记（调用方据此刻意记 schemaValid=fail，不再误判 pass） */
  parseFailed?: boolean;
}

/** 阶段定义（STAGES 表项）：依赖/预加载/质检/特殊阶段语义集中声明 */
export interface StageDef {
  stageKey: string;
  /** 中文阶段名（日志/错误提示/确认浮层用） */
  name: string;
  /** Gate 4 门禁：执行前必须已落库的工作区 key（直接前置，顺序保证传递性） */
  dependsOn: string[];
  /** 子 Agent 预加载字段（createSubAgent 从此处读取，单一来源） */
  preloadKeys: string[];
  /** 章节阶段：一次一章（缺口判断：工作区 chapters 数组为空） */
  chapter?: boolean;
  /** 剧本阶段：逐集生成（缺口判断：o_script 集数为 0） */
  episode?: boolean;
  /** 数组阶段：工作区数组字段为空 → 缺口（production: deriveAssets→assets、storyboardPanel→storyboard） */
  arrayField?: string;
  /** 单字段阶段的工作区字段名（缺省 = stageKey；production: directorPlan→scriptPlan、storyboardCheck→checkReport） */
  field?: string;
  /** 阶段质检 skill 文件名（data/skills/*_stage_check_*.md）：产出后强制跑轻量自查 */
  supervision?: string;
  /** 全局第一步（确认点无「上一步」按钮；替代历史循环内硬编码 stageKey） */
  isFirst?: boolean;
  /** 全局最后一步 */
  isLast?: boolean;
}

/** 各线 schema 适配层：引擎不 import 具体 schema，经此接口取标签/文案/缺口语义 */
export interface StageSchemaRegistry {
  agentKey: string;
  stageXmlTag: (key: string) => string;
  stageLabels: Record<string, string>;
  /** episode 阶段缺口判断（读 o_script 集数；novel 无此阶段不提供） */
  countEpisodes?: (projectId: number) => Promise<number>;
  /**
   * 阶段落库覆盖（production 用：子 Agent 工具已直写工作区/DB，无 consumeAgentOutput 分支；
   * 三线缺省走 consumeAgentOutput 完整消费链路）
   */
  persistStage?: (projectId: number, stageKey: string, raw: string, def?: StageDef) => Promise<StagePersistResult>;
}

/** 各线差异钩子：novel 的 chapter 特判/自动立项、script 的 prompt 装饰 */
export interface StageHooks {
  /**
   * 阶段执行前改写 prompt / 拦截（novel: chapter 5 章上限 + 章名提取；script: 兜底 prompt 追加章节数量）。
   * @param promptProvided prompt 是否由调用方显式传入（false 表示引擎已用项目 intro 兜底）
   */
  beforeRunStage?: (ctx: AgentContext, stageKey: string, prompt: string, promptProvided: boolean) => Promise<{ prompt?: string; error?: string }>;
  /**
   * 子 Agent 产物通过 Gate2 后、返回前（novel: chapter 深度监督审核 + hard 红线自动修复，返回覆盖稿替换原稿）。
   * 返回 error 视为本阶段产物失败（不落库；B2 字数硬闸：全部稿字数未达标 → 拒绝入库标失败可重试）。
   */
  afterSubAgent?: (
    ctx: AgentContext,
    stageKey: string,
    resp: { raw: string; parsed?: unknown },
    stageTools: StageToolMap,
  ) => Promise<{ raw: string; parsed?: unknown; error?: string } | void>;
  /** 阶段落库后（novel: brief 自动立项） */
  onStagePersisted?: (projectId: number, stageKey: string) => Promise<void>;
  /**
   * chapter/episode 阶段重复执行询问（novel: 单次对话连续写多章——shouldRepeatStage 返回 true 则不推进阶段索引，
   * 重跑本阶段生成下一章，配合 beforeRunStage 的 chapterTarget/chapterGenerated 会话计数）。drama/script 不实现则循环行为不变
   */
  shouldRepeatStage?: (ctx: AgentContext, stageKey: string, runCount: number) => Promise<boolean>;
  /**
   * 章节续写指令强制入队（novel C1）：缺口为空（前序阶段全完成）且用户消息是续写指令
   * （「继续写/写第N章」）→ 返回 true，引擎把章节阶段加回执行队列。章节是循环阶段，
   * 已有落库不代表「完成」——静态缺口判定会把它排除，续写指令是用户显式意图。
   */
  shouldForceChapterStage?: (ctx: AgentContext, gaps: StageDef[]) => Promise<boolean>;
}

/** 子 Agent 工具 map（引擎只用 execute；ai SDK tool() 返回值满足该结构——execute 可返回对象/PromiseLike/AsyncIterable；
 * production 线 runAgent 直接返回全文 string，故含 string 分支） */
export type StageToolMap = Record<
  string,
  {
    execute?: (
      input: any,
      options: any,
    ) =>
      | { raw?: unknown; parsed?: unknown; error?: string }
      | PromiseLike<{ raw?: unknown; parsed?: unknown; error?: string }>
      | AsyncIterable<{ raw?: unknown; parsed?: unknown; error?: string }>
      | string
      | PromiseLike<string>
      | AsyncIterable<string>;
  }
>;

/** run_stage_check 内部调用 runAgent 所需入参（makeStageCheckTool 注入用） */
export interface StageCheckRunInput {
  key: `${string}:${string}`;
  prompt: string;
  system: string;
  name: string;
  memoryKey: string;
  messages?: { role: "user" | "assistant" | "system"; content: string }[];
  preloadData?: Record<string, string>;
}

export interface StagePersistResult {
  consumed: string[];
  chapterCount: number;
  scriptCount: number;
  error?: string;
  /** 2C：格式错（产物消费失败，标签缺失/空产物）——可回灌重生成自动重试；其他错误（如 DB 失败）不重试 */
  retryable?: boolean;
}

/**
 * 单阶段执行裁决（executeStageVerdict 返回，自原 runWorkflow 循环体抽出）：
 * error 非空即终局失败（调用方直接终止）；否则带出门禁强停态/质检结果/落库结果供确认分支使用。
 */
interface StageRunVerdict {
  /** 终局失败信息（生成/Gate2 重试耗尽/落库失败；trace.fail 已在 verdict 内记录） */
  error?: string;
  /** 质量门禁强停（LLM 评级 C/D 或硬校验命中；章节返工耗尽标记）——非空时产物未落正式位置 */
  blocked: boolean;
  /** 门禁自动重做次数（区别于用户触发 redo/back 的 retryCount，仅观测） */
  gateRetries: number;
  checkReport: StageCheckReport;
  hardIssues: ScanIssue[];
  /** 达标落库结果；门禁停时为 null，confirm 接受后由 runWorkflow 补落库 */
  persisted: StagePersistResult | null;
  /** 最终稿原文（补落库复用） */
  raw: string;
}

// ── 公共函数（原三线逐行相同的副本，收敛于此）──

export function buildMemPrompt(mem: Awaited<ReturnType<Memory["get"]>>): string {
  let memoryContext = "";
  if (mem.rag.length) {
    memoryContext += `[相关记忆]\n${mem.rag.map((r) => r.content).join("\n")}`;
  }
  if (mem.summaries.length) {
    if (memoryContext) memoryContext += "\n\n";
    memoryContext += `[历史摘要]\n${mem.summaries.map((s, i) => `${i + 1}. ${s.content}`).join("\n")}`;
  }
  if (mem.shortTerm.length) {
    if (memoryContext) memoryContext += "\n\n";
    memoryContext += `[近期对话]\n${mem.shortTerm.map((m) => `${m.role}: ${m.content}`).join("\n")}`;
  }
  return `## Memory\n以下是你对用户的记忆，可作为参考但不要主动提及：\n${memoryContext}`;
}

export async function consumeFullStream(
  fullStream: AsyncIterable<any>,
  initialMsg: ReturnType<ResTool["newMessage"]>,
  syncMsg?: () => ReturnType<ResTool["newMessage"]>,
): Promise<string> {
  let msg = initialMsg;
  let text = msg.text();
  let thinking: ReturnType<typeof msg.thinking> | null = null;
  let thinkTime = 0;
  let fullResponse = "";

  try {
    for await (const chunk of fullStream) {
      if (syncMsg) {
        const newMsg = syncMsg();
        if (newMsg !== msg) {
          msg = newMsg;
          text = msg.text();
        }
      }
      if (chunk.type === "reasoning-start") {
        thinkTime = Date.now();
        thinking = msg.thinking("思考中...");
      } else if (chunk.type === "reasoning-delta") {
        thinking?.append(chunk.text);
      } else if (chunk.type === "reasoning-end") {
        thinkTime = Date.now() - thinkTime;
        thinking?.updateTitle(`思考完毕（${(thinkTime / 1000).toFixed(1)} 秒）`);
        thinking?.complete();
        thinking = null;
      } else if (chunk.type === "text-delta") {
        text.append(chunk.text);
        fullResponse += chunk.text;
      } else if (chunk.type === "error") {
        throw chunk.error;
      }
    }
    text.complete();
    msg.complete();
  } catch (err: any) {
    thinking?.complete();
    const errMsg = err?.message ?? String(err);
    text.append(errMsg);
    text.error();
    msg.error();
    throw err;
  }

  return fullResponse;
}

export function removeAllXmlTags(text: string): string {
  text = text.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?>([\s\S]*?)<\/\1>/g, "");
  text = text.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?\/>/g, "");
  text = text.replace(/<\/?[a-zA-Z][\w-]*(\s+[^>]*)?>/g, "");
  return text.trim();
}

/**
 * 剥 XML 标签但保留标签内内容（与 removeAllXmlTags 的区别：后者把整个标签块含内容替换为空，
 * 用于从流式输出剥离产物标签；此处保留内容，供 P1c 非章节代码硬校验扫描——对齐
 * validateSubAgentOutput 单字段提取语义，否则扫描拿到的会是空文本）。
 */
export function stripTagsKeepContent(text: string): string {
  return text
    .replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?>([\s\S]*?)<\/\1>/g, "$3")
    .replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?\/>/g, "")
    .replace(/<\/?[a-zA-Z][\w-]*(\s+[^>]*)?>/g, "")
    .trim();
}

/** 子 Agent 任务入参 zod schema（监督层/质检层等无枚举阶段参数的工具用） */
export const promptInput = z
  .object({
    prompt: z.string().describe("交给子Agent的任务简约描述，100字以内"),
  })
  .toJSONSchema();

// ── 引擎 ──

/**
 * StageDef 拓扑校验（纯函数）：key 唯一 / dependsOn 引用合法 / 无环 / isFirst·isLast 恰各一。
 * @param allowExternalDeps 允许引用的非阶段工作区 key（novel: ["answers","chapters"]；drama/script: 无）
 * @returns 错误列表（空数组 = 合法）
 */
export function validateStageDefs(defs: StageDef[], allowExternalDeps: string[] = []): string[] {
  const errors: string[] = [];
  const keys = defs.map((d) => d.stageKey);

  // key 唯一
  const seen = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) errors.push(`阶段 key 重复: ${k}`);
    seen.add(k);
  }

  // dependsOn 引用合法
  const known = new Set([...allowExternalDeps, ...keys]);
  for (const d of defs) {
    for (const dep of d.dependsOn) {
      if (!known.has(dep)) errors.push(`阶段「${d.stageKey}」依赖未知 key: ${dep}`);
    }
  }

  // 无环（DFS；外部 key 视为叶子）
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (k: string, path: string[]): void => {
    if (visited.has(k)) return;
    if (visiting.has(k)) {
      errors.push(`阶段依赖成环: ${[...path, k].join("→")}`);
      return;
    }
    visiting.add(k);
    const def = defs.find((d) => d.stageKey === k);
    if (def) {
      for (const dep of def.dependsOn) visit(dep, [...path, k]);
    }
    visiting.delete(k);
    visited.add(k);
  };
  for (const k of keys) visit(k, []);

  // isFirst/isLast 恰各一个（确认点「上一步/最后一步」语义依赖唯一性）
  const firsts = defs.filter((d) => d.isFirst);
  if (firsts.length !== 1) errors.push(`isFirst 应有且仅有 1 个，实际 ${firsts.length}`);
  const lasts = defs.filter((d) => d.isLast);
  if (lasts.length !== 1) errors.push(`isLast 应有且仅有 1 个，实际 ${lasts.length}`);

  return errors;
}

/**
 * 阶段缺口判断（纯函数，语义由 StageDef 字段驱动）：
 * - chapter 阶段：工作区 chapters 数组为空 → 缺口
 * - episode 阶段：已写集数（o_script count）为 0 → 缺口
 * - arrayField 数组阶段：工作区数组字段为空 → 缺口（production: assets/storyboard）
 * - 单字段阶段：工作区字段为空 → 缺口
 */
export function isStageGap(def: StageDef, workData: Record<string, any>, episodeCount?: number): boolean {
  if (def.chapter) {
    const chapters = Array.isArray(workData.chapters) ? workData.chapters : [];
    return chapters.length === 0;
  }
  if (def.episode) return (episodeCount ?? 0) === 0;
  if (def.arrayField) {
    const arr = Array.isArray(workData[def.arrayField]) ? workData[def.arrayField] : [];
    return arr.length === 0;
  }
  const field = def.field ?? def.stageKey;
  return !workData[field] || String(workData[field]).trim() === "";
}

export interface StageEngineOptions {
  agentKey: string;
  defs: StageDef[];
  registry: StageSchemaRegistry;
  hooks?: StageHooks;
}

export function createStageEngine({ agentKey, defs, registry, hooks }: StageEngineOptions) {
  /** 读本线工作区（o_agentWorkData key=agentKey；production 按 episodesId=scriptId 过滤） */
  async function getWorkData(projectId: number, scriptId?: number): Promise<Record<string, any>> {
    const row = await u.db("o_agentWorkData").where({ projectId, key: agentKey, ...(scriptId != null ? { episodesId: scriptId } : {}) }).first();    try {
      return row?.data ? JSON.parse(row.data) : {};
    } catch {
      return {};
    }
  }

  // ── P0 断线恢复元数据通道（generation）：实例级串行队列 + attemptId 运行位 ──
  // 自 runWorkflow 私有闭包提升为引擎级共享：单步直驱 / 主循环 / 决策层工具三入口均经
  // begin/end 登记，日常交互也有断线标记（E2E 实测缺口①修复）。队列保证同一时刻仅一个
  // 写者读改写 workData JSON（沿用原防 void 并发写约束）；attemptId 让「A 的收尾」不会
  // 覆盖「B 已开始的运行位」（跨入口并发交错兜底：end 仅当运行位仍属自己才生效）。
  let genMetaQueue: Promise<void> = Promise.resolve();
  type GenPatch = Record<string, unknown>;
  function queueGenerationMeta(pid: number, mutate: (gen: GenPatch) => GenPatch): Promise<void> {
    genMetaQueue = genMetaQueue.then(async () => {
      try {
        const row = await u.db("o_agentWorkData").where({ projectId: pid, key: agentKey }).first();
        const data = row ? JSON.parse(row.data ?? "{}") : {};
        data.generation = mutate((data.generation as GenPatch) ?? {});
        if (row) await u.db("o_agentWorkData").where({ id: row.id }).update({ data: JSON.stringify(data) });
        else await u.db("o_agentWorkData").insert({ projectId: pid, key: agentKey, data: JSON.stringify(data) });
      } catch {
        /* 元数据失败不阻断生成主链路 */
      }
    });
    return genMetaQueue;
  }
  /** 开始一次生成尝试：登记运行位（写完成即 resolve），返回 attemptId 供收尾判定 */
  function beginGenerationMeta(pid: number, stageKey: string | null): Promise<string> {
    const attemptId = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    return queueGenerationMeta(pid, () => ({ running: true, startedAt: Date.now(), stageKey, endedAt: null, attemptId })).then(() => attemptId);
  }
  /** 结束一次生成尝试（幂等防交错）：仅当运行位仍是自己的 attempt 才写收尾 */
  function endGenerationMeta(pid: number, attemptId: string): Promise<void> {
    return queueGenerationMeta(pid, (gen) =>
      typeof gen.attemptId === "string" && gen.attemptId !== attemptId
        ? gen
        : { running: false, stageKey: (gen.stageKey as string | null) ?? null, endedAt: Date.now() },
    ).then(() => undefined);
  }

  // ── R2 待复核裁决位（generation.pendingReview）：门禁强停挂起时的持久化快照，
  // getPlanData 透传给前端做浮层恢复/警示角标；用户动作或同阶段产出达标后清除。──
  interface PendingReview {
    stageKey: string;
    stageName: string;
    rating?: string;
    reason?: string;
    blockedAt: number;
  }
  function markPendingReview(pid: number, review: Omit<PendingReview, "blockedAt">): Promise<void> {
    return queueGenerationMeta(pid, () => ({ pendingReview: { ...review, blockedAt: Date.now() } })).then(() => undefined);
  }
  function clearPendingReview(pid: number): Promise<void> {
    return queueGenerationMeta(pid, () => ({ pendingReview: null })).then(() => undefined);
  }
  /** B2 think 升级计数：同章字数拒收累计（队列内读改写，避免与 pendingReview/运行位互相覆盖——直写事故实测） */
  function bumpWordRetry(pid: number, chapterIndex: number): Promise<number> {
    return queueGenerationMeta(pid, (gen) => {
      const prev = gen.wordRetry as { chapterIndex?: number; count?: number } | undefined;
      const count = prev && prev.chapterIndex === chapterIndex ? (prev.count ?? 0) + 1 : 1;
      gen.wordRetry = { chapterIndex, count };
      return { ...gen, wordRetry: gen.wordRetry };
    }).then(() => {
      // 队列外重读拿最终 count（队列串行，此时必为最新）
      return getWorkData(pid).then((data) => {
        const wr = (data.generation as { wordRetry?: { count?: number } } | undefined)?.wordRetry;
        return wr?.count ?? 1;
      });
    });
  }
  function clearWordRetry(pid: number): Promise<void> {
    return queueGenerationMeta(pid, (gen) => ({ ...gen, wordRetry: null })).then(() => undefined);
  }

  /**
   * 缺口查找：单字段阶段空 → 缺口；chapter 阶段无已写章节 → 缺口；episode 阶段无已写集 → 缺口；
   * arrayField 数组阶段数组为空 → 缺口。语义由 StageDef 字段驱动（引擎不感知具体 stageKey）。
   */
  async function collectGapStages(ctx: AgentContext): Promise<StageDef[]> {
    const projectId = Number(ctx.resTool.data.projectId);
    const scriptId = ctx.resTool.data.scriptId != null ? Number(ctx.resTool.data.scriptId) : undefined;
    const data = await getWorkData(projectId, scriptId);
    const gaps: StageDef[] = [];
    for (const def of defs) {
      if (def.chapter || def.episode) {
        const episodeCount = def.episode && registry.countEpisodes ? await registry.countEpisodes(projectId) : undefined;
        if (isStageGap(def, data, episodeCount)) gaps.push(def);
      } else if (isStageGap(def, data)) {
        gaps.push(def);
      }
    }
    return gaps;
  }

  /**
   * 直接驱动子 Agent 生成指定阶段产物（工作台按钮 + run_workflow_stage 用）。
   * - 复用 createSubAgent 阶段工具：流式经 resTool socket 推前端
   * - hooks.beforeRunStage 拦截/改写 prompt（novel chapter 特判、script 章节数量）
   * - hooks.afterSubAgent 在产物通过 Gate2 后、返回前执行（novel chapter 深度监督）
   */
  async function runStageDirect(
    ctx: AgentContext,
    stageKey: string,
    prompt: string,
    stageTools: StageToolMap,
  ): Promise<{ raw: string; parsed?: unknown; error?: string; retryable?: boolean }> {
    // Gate4 前置依赖门禁（工作台单阶段直驱也强制校验，防绕过前端按钮直接 emit stageGenerate）：
    // runWorkflow 循环内已先跑过 assertStageReady（幂等）；此处兜底直接驱动路径（stageGenerate 按钮）。
    // novel 线 world/characters 依赖 briefConfirmed（用户选版确认），未选版直驱会被拦下报错。
    const def = defs.find((s) => s.stageKey === stageKey);
    if (def && def.dependsOn && def.dependsOn.length > 0) {
      const scriptId = ctx.resTool.data.scriptId != null ? Number(ctx.resTool.data.scriptId) : undefined;
      try {
        await assertStageReady(Number(ctx.resTool.data.projectId), agentKey, stageKey, def.dependsOn, scriptId);
      } catch (e) {
        return { raw: "", error: e instanceof Error ? e.message : String(e) };
      }
    }
    // 前端按钮不传 prompt：以项目想法（intro）兜底，子 Agent 有创作上下文（已有产物经 preloadData 注入）
    const promptProvided = !!prompt?.trim();
    if (!promptProvided) {
      const project = await u.db("o_project").where("id", ctx.resTool.data.projectId).first();
      prompt = `用户想法：${project?.intro ?? "无"}。请执行「${registry.stageLabels[stageKey] ?? stageKey}」生成，产物严格按格式要求输出。`;
    }
    if (hooks?.beforeRunStage) {
      const pre = await hooks.beforeRunStage(ctx, stageKey, prompt, promptProvided);
      if (pre?.error) return { raw: "", error: pre.error };
      if (pre?.prompt) prompt = pre.prompt;
    }
    const subAgent = stageTools[stageKey];
    if (!subAgent?.execute) {
      return { raw: "", error: `未知阶段: ${stageKey}` };
    }
    // 子 Agent execute 返回兼容：{raw, parsed?, error?} 对象或纯 string（production 线 runAgent 返回全文）
    // 4B：工具级超时包装（统一异常码——超时 → [TIMEOUT]，其他异常 → [EXECUTION]）
    // R1：生成期断线标记——runStageDirect 是三条入口的唯一漏斗，此处 begin/end 全覆盖
    const pid = Number(ctx.resTool.data.projectId);
    const attemptId = await beginGenerationMeta(pid, stageKey);
    try {
      let resp: unknown;
      try {
        resp = await withToolTimeout(subAgent.execute, TOOL_TIMEOUT_MS)(
          { prompt },
          { toolCallId: `stage-${stageKey}`, messages: [] },
        );
      } catch (e) {
        const code = e instanceof ToolExecutionError ? e.code : "EXECUTION";
        return { raw: "", error: `[${code}] ${e instanceof Error ? e.message : String(e)}` };
      }
      let respObj = (typeof resp === "string" ? { raw: resp } : resp ?? {}) as { raw?: unknown; parsed?: unknown; error?: string };
      let raw = typeof respObj.raw === "string" ? respObj.raw : "";
      if (respObj.error) return { raw, error: respObj.error, retryable: respObj.error.startsWith("[GATE2]") };
      // afterSubAgent 可返回覆盖稿（novel chapter 自动修复闭环：hard 红线重生成后的最优稿替换原稿，
      // 落库发生在 runStageDirect 返回之后，保证最终落库的始终是修复后的版本）
      const afterResp = await hooks?.afterSubAgent?.(ctx, stageKey, { raw, parsed: respObj.parsed }, stageTools);
      // B2 字数硬闸消费端：afterSubAgent 返回 error → 本阶段失败不落库（retryable，工作流层标错中断连写并告警）
      if (afterResp && (afterResp as { error?: string }).error) {
        return { raw: "", error: String((afterResp as { error?: string }).error), retryable: true };
      }
      if (afterResp && typeof afterResp.raw === "string" && afterResp.raw) {
        raw = afterResp.raw;
        respObj = { raw: afterResp.raw, parsed: afterResp.parsed };
      }
      return { raw, parsed: respObj.parsed };
    } finally {
      await endGenerationMeta(pid, attemptId);
    }
  }

  /**
   * 直接驱动产物落库（工作台单阶段生成用）：
   * - registry.persistStage 提供时走自定义落库（production：子 Agent 工具已直写工作区/DB，此处轻量校验）
   * - 缺省复用 consumeAgentOutput 完整消费链路（标签提取/JSON 解析/schema 校验/落库/章节或剧本同步）
   * 阶段消费校验：chapter 阶段看 chapterItem 计数、episode 阶段看 scriptItem 计数、单字段看 consumed。
   */
  async function persistStage(projectId: number, stageKey: string, fullResponse: string): Promise<StagePersistResult> {
    const def = defs.find((s) => s.stageKey === stageKey);
    if (registry.persistStage) {
      return registry.persistStage(projectId, stageKey, fullResponse, def);
    }
    try {
      const res = await consumeAgentOutput(agentKey, projectId, fullResponse);
      if (def?.chapter) {
        if (res.chapters === 0) {
          return { ...res, chapterCount: res.chapters, scriptCount: 0, error: "章节产物消费失败：未解析到有效 <chapterItem>（产物为空或格式错误）", retryable: true };
        }
      } else if (def?.episode) {
        if (res.chapters === 0) {
          return { ...res, chapterCount: res.chapters, scriptCount: 0, error: "剧本产物消费失败：未解析到有效 <scriptItem>（产物为空或格式错误）", retryable: true };
        }
      } else if (!res.consumed.includes(stageKey)) {
        return {
          ...res,
          chapterCount: res.chapters,
          scriptCount: 0,
          error: `阶段「${def?.name ?? stageKey}」产物消费失败：未解析到 <${registry.stageXmlTag(stageKey)}> 标签（产物为空或格式错误）`,
          retryable: true,
        };
      }
      return { consumed: res.consumed, chapterCount: res.chapters, scriptCount: 0 };
    } catch (e) {
      // 2C：ConsumeError（有输出但标签全缺失）→ 可重试；其他异常（DB 失败等）不重试
      const retryable = e instanceof ConsumeError;
      return { consumed: [], chapterCount: 0, scriptCount: 0, error: e instanceof Error ? e.message : String(e), retryable };
    }
  }

  /**
   * 2C：格式错自动重试（U5 兜底：只对 ConsumeError/标签缺失重试，空输出与其他错误不重试）。
   * persistStage 返回 retryable=true 时，回灌具体错误（缺哪个标签）给子 Agent 重生成一次；
   * 重生成仍失败 → 保留错误交人工 redo。成功则返回修复稿，落库的始终是最新可解析产物。
   */
  async function persistWithRetryOnConsumeError(
    projectId: number,
    stageKey: string,
    raw: string,
    deps: { stageTools: StageToolMap },
  ): Promise<{ persisted: StagePersistResult; raw: string }> {
    const persisted = await persistStage(projectId, stageKey, raw);
    if (!persisted.error || !persisted.retryable) return { persisted, raw };
    const stageTool = deps.stageTools[stageKey];
    if (!stageTool?.execute) return { persisted, raw };
    try {
      const retryResp = (await stageTool.execute(
        {
          prompt: `你上一次输出的产物解析失败（格式错误）：${persisted.error}。请严格按既定 XML 标签格式重新输出本阶段产物，只输出标签内容本身，不要附加任何解释或 Markdown 代码块。`,
        },
        { toolCallId: `stage-${stageKey}-consume-retry`, messages: [] },
      )) as unknown;
      const retryRaw = typeof retryResp === "string" ? retryResp : (retryResp as { raw?: unknown })?.raw;
      const retryStr = typeof retryRaw === "string" ? retryRaw : "";
      if (!retryStr) return { persisted, raw }; // 重生成无效（空）→ 保留原错误
      const persisted2 = await persistStage(projectId, stageKey, retryStr);
      if (!persisted2.error) console.warn(`[${agentKey}] 阶段「${stageKey}」格式错自动重试成功（一次）`);
      return { persisted: persisted2, raw: retryStr };
    } catch (e) {
      return { persisted, raw }; // 重生成异常 → 保留原错误
    }
  }

  /**
   * Gate2 校验失败自动重试（缺口 4a：原 runStageDirect 的 Gate2 错误直接 fail workflow，
   * 与消费阶段 2C「格式错重试一次」行为不一致）。仅 retryable（[GATE2] 标记）错误重试一次；
   * 前置依赖/未知阶段/工具异常不重试。重试仍失败 → 返回重试的错误信息（trace 记 fail）。
   */
  async function runStageWithGate2Retry(
    ctx: AgentContext,
    stageKey: string,
    prompt: string,
    deps: { stageTools: StageToolMap },
  ): Promise<{ raw: string; parsed?: unknown; error?: string }> {
    const first = await runStageDirect(ctx, stageKey, prompt, deps.stageTools);
    if (!first.error || !first.retryable) return first;
    const retry = await runStageDirect(
      ctx,
      stageKey,
      `你上一次输出的产物未通过格式校验：${first.error}\n请严格按既定 XML 标签格式重新输出本阶段产物，只输出标签内容本身，不要附加解释或 Markdown 代码块。`,
      deps.stageTools,
    );
    if (!retry.error) console.warn(`[${agentKey}] 阶段「${stageKey}」Gate2 校验失败自动重试成功（一次）`);
    return retry;
  }

  /**
   * 阶段质检：产出后强制跑轻量自查（defs.supervision 配置的 skill）。
   * - 无 supervision 配置（如 novel chapter 走 runStageDirect 内 20 项监督）返回空
   * - 质检失败不阻断流程（记录日志，确认点仍展示但无质检报告）
   */
  async function runSupervision(ctx: AgentContext, stageKey: string, productText: string, checkTool?: StageToolMap[string]): Promise<StageCheckReport> {
    const def = defs.find((s) => s.stageKey === stageKey);
    if (!def?.supervision || !checkTool?.execute) return {};
    try {
      const resp = (await checkTool.execute(
        { stageKey, prompt: `请质检刚生成的「${def.name}」：\n${productText.slice(0, 3000)}` },
        { toolCallId: `stage-${stageKey}-check`, messages: [] },
      )) as { raw?: unknown } | undefined;
      const raw = typeof resp?.raw === "string" ? resp.raw : "";
      const m = raw.match(/<checkReport>([\s\S]*?)<\/checkReport>/);
      if (m) {
        try {
          const parsed = JSON.parse(m[1]);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("checkReport 内容非 JSON 对象");
          // 批次2：阶段质检报告落 o_check_report（报告中心数据源；落库失败不阻断）
          try {
            await saveCheckReport({
              projectId: Number(ctx.resTool.data.projectId),
              reportType: "stage",
              stageKey,
              rating: typeof parsed.rating === "string" ? parsed.rating : undefined,
              summary: Array.isArray(parsed.highlights) ? parsed.highlights.join("；") : undefined,
              issues: Array.isArray(parsed.issues) ? parsed.issues.map((i: unknown) => ({ text: String(i) })) : undefined,
              metrics: parsed.metrics ?? undefined,
              detailMd: raw,
            });
          } catch {
            /* 报告落库失败不阻断质检展示 */
          }
          return {
            rating: parsed.rating,
            highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [],
            issues: Array.isArray(parsed.issues) ? parsed.issues : [],
            raw,
          };
        } catch (e) {
          // 缺口⑤：解析失败原只静默返回 raw，且被调用方推导为 schemaValid=pass（假阳性）。
          // 改为：标记 parseFailed（调用方记 fail）+ 占位报告落表（报告中心可查，原文留档）。
          const reason = u.error(e).message;
          console.warn(`[${agentKey}] 阶段质检 <checkReport> 解析失败（stage=${stageKey}）:`, reason);
          await saveCheckReportPlaceholder({
            projectId: Number(ctx.resTool.data.projectId),
            reportType: "stage",
            stageKey,
            detailMd: raw,
            reason,
          });
          return { raw, parseFailed: true };
        }
      }
      return { raw };
    } catch (e) {
      // 审计遗留：阶段质检失败原只 console.warn 静默——补落 trace（gate3_consume fail），事后可复盘质检降级频率
      const msg = u.error(e).message;
      console.warn(`[${agentKey}] 阶段质检失败（不阻断）:`, msg);
      await recordTrace({
        projectId: Number(ctx.resTool.data.projectId),
        agentKey,
        stage: stageKey,
        gate: "gate3_consume",
        event: "fail",
        detail: `阶段质检失败: ${msg}`,
      });
      return {};
    }
  }

  /**
   * 单阶段执行流水线（自 runWorkflow 循环体抽出，重构 P1 纯搬移）：
   * Gate4 后的进度事件 → Gate2 重试生成 → 质检 + 代码硬校验 → 门禁重做（≤GATE_MAX_RETRIES）→
   * 强停告警 / 达标落库（doneKeys 经 markDone 回调写入 WfLoop，保持原登记位置）→ trace 收尾。
   * 除返回裁决外全为副作用；error 返回即终局失败（trace.fail 已在内部记录）。
   */
  async function executeStageVerdict(
    ctx: AgentContext,
    stage: StageDef,
    promptBase: string,
    opts: { autoFlow: "manual" | "semi" | "full"; autoPassOk?: boolean },
    retryCount: number,
    deps: { stageTools: StageToolMap; markDone: (stageKey: string) => void },
  ): Promise<StageRunVerdict> {
    const projectId = Number(ctx.resTool.data.projectId);
    // P1c 双轨：非章节阶段代码硬校验（确定性规则，不依赖 LLM 评级）。
    // 读项目约束合并禁忌词 → 对去标签后的产物文本跑通用扫描；约束/扫描失败降级为空不阻断。
    const scanStageHardIssues = async (stage: StageDef, raw: string): Promise<ScanIssue[]> => {
      if (stage.chapter) return [];
      try {
        const constraints = await readWorkConstraints(projectId);
        // 治本2b：扫描上下文唯一组装点（era/transport/禁忌词）——与章节路径同一工厂，杜绝双份样板漏改
        const { bannedRules, worldEra, transportExemption } = buildNovelScanContext(constraints);
        const scan = createGenericScanProvider({ bannedRules, ...(worldEra ? { worldEra } : {}), ...(transportExemption ? { transportExemption } : {}) });
        return scan(stripTagsKeepContent(raw));
      } catch (e) {
        console.warn(`[${agentKey}] 阶段「${stage.name}」代码硬校验失败（降级不阻断）:`, e instanceof Error ? e.message : String(e));
        return [];
      }
    };
    const trace = startTrace({ projectId, agentKey, stage: stage.stageKey, gate: "gate4_orchestrator" });
    // 进度透明（A）：阶段开始/质检/门禁重做全程推 stageProgress，前端聊天区实时呈现
    ctx.resTool.socket.emit("stageProgress", { stageKey: stage.stageKey, stageName: stage.name, phase: "generating" });
    // 缺口 4a：Gate2 校验失败自动重试一次（与消费阶段 2C 一致）
    let resp = await runStageWithGate2Retry(ctx, stage.stageKey, promptBase, deps);
    if (resp.error) {
      await trace.fail({ detail: resp.error, retryCount });
      return { error: resp.error, blocked: false, gateRetries: 0, checkReport: {}, hardIssues: [], persisted: null, raw: "" };
    }
    // 阶段质检（轻量自查；无 supervision 配置的阶段返回空）
    ctx.resTool.socket.emit("stageProgress", { stageKey: stage.stageKey, stageName: stage.name, phase: "checking" });
    let checkReport = await runSupervision(ctx, stage.stageKey, resp.raw, deps.stageTools.run_stage_check);
    // P1c 双轨：非章节阶段跑代码硬校验（确定性规则 BANNED/REPEAT/ERA，不依赖 LLM 评级）——
    // LLM 评级可能误判（A/B 放行差稿 / C/D 卡住好稿），确定性硬指标命中任一即拦截
    let hardScanIssues = await scanStageHardIssues(stage, resp.raw);
    // 代码硬校验命中并入质检报告 issues（前端确认浮层展示依据 + 门禁重做 prompt 回灌）
    if (hardScanIssues.length) {
      checkReport = { ...checkReport, issues: [...(checkReport?.issues ?? []), ...hardScanIssues.map((s) => s.text)] };
    }
    // P1c 质量门禁：LLM 评级 C/D（或解析失败）或代码硬校验命中任一 → 不落正式位置——非章节阶段自动门禁重做
    // （≤GATE_MAX_RETRIES 次，回灌质检问题）；章节阶段已走返工闭环，由 afterSubAgent 的
    // chapterGateBlocked 标记（返工耗尽且最优稿 C/D）决定是否门禁。
    // 落库推迟到「质检达标后」，C/D 稿在门禁重做/强制停期间不写工作区/正式章节，杜绝垃圾数据残留
    let gateBlocked = stage.chapter ? !!ctx.resTool.data.chapterGateBlocked : isQualityBlocked(checkReport) || hardScanIssues.length > 0;
    let gateRetry = 0;
    while (gateBlocked && !stage.chapter && gateRetry < GATE_MAX_RETRIES) {
      gateRetry++;
      console.warn(`[${agentKey}] 阶段「${stage.name}」质检未达标（评级 ${checkReport?.rating ?? "解析失败"}${hardScanIssues.length ? ` + 代码硬校验 ${hardScanIssues.length} 项` : ""}），门禁重做第 ${gateRetry} 次`);
      ctx.resTool.socket.emit("stageProgress", {
        stageKey: stage.stageKey,
        stageName: stage.name,
        phase: "gate-retry",
        attempt: gateRetry,
        maxRetries: GATE_MAX_RETRIES,
        rating: checkReport?.rating ?? "解析失败",
        hardCount: hardScanIssues.length,
      });
      const repairResp = await runStageWithGate2Retry(ctx, stage.stageKey, buildGateRepairPrompt(stage.name, checkReport), deps);
      if (repairResp.error) {
        console.warn(`[${agentKey}] 阶段「${stage.name}」门禁重做失败:`, repairResp.error);
        break;
      }
      resp = repairResp;
      checkReport = await runSupervision(ctx, stage.stageKey, resp.raw, deps.stageTools.run_stage_check);
      hardScanIssues = await scanStageHardIssues(stage, resp.raw);
      if (hardScanIssues.length) {
        checkReport = { ...checkReport, issues: [...(checkReport?.issues ?? []), ...hardScanIssues.map((s) => s.text)] };
      }
      gateBlocked = isQualityBlocked(checkReport) || hardScanIssues.length > 0;
    }
    // 门禁重做后仍不达标 → 显式降级告警（前端标红）+ trace；达标则正常推进
    if (gateBlocked) {
      const gateReason = `阶段「${stage.name}」质检未达标（${stage.chapter ? "返工耗尽" : `门禁重做 ${gateRetry} 次后仍 ${checkReport?.rating ?? "评级缺失"}${hardScanIssues.length ? ` + 代码硬校验 ${hardScanIssues.length} 项` : ""}`}）`;
      ctx.resTool.socket.emit("qualityDegraded", { stageKey: stage.stageKey, reason: gateReason });
      await recordTrace({ projectId, agentKey, stage: stage.stageKey, gate: "gate3_consume", event: "fail", detail: `质量门禁: ${gateReason}` });
    }
    // 落库（P1c：仅在质检达标后落正式位置；C/D 门禁稿暂不落库，确认点 confirm 接受时才补落库）。
    // 2C：格式错自动重试一次（回灌错误重生成，成功则用修复稿继续）
    let persisted: StagePersistResult | null = null;
    if (!gateBlocked) {
      const persistRes = await persistWithRetryOnConsumeError(projectId, stage.stageKey, resp.raw, deps);
      persisted = persistRes.persisted;
      if (persisted.error) {
        await trace.fail({ detail: persisted.error, retryCount });
        return { error: persisted.error, blocked: false, gateRetries: gateRetry, checkReport, hardIssues: hardScanIssues, persisted, raw: resp.raw };
      }
      deps.markDone(stage.stageKey);
      // 落库后钩子（novel: brief 自动立项，置 active + 回写简介/书名）
      await hooks?.onStagePersisted?.(projectId, stage.stageKey);
      // 批次1：取走待发「卷已写完」事件并 emit（章节落库时 xmlConsume 经工作区标志中转；novel 线专属，其他线空操作）
      try {
        if (agentKey === "novelAgent") await consumePendingVolumeDone(ctx.resTool.socket, projectId);
      } catch {
        /* 事件中转失败不阻断流程（前端有手动「细化下一卷」入口兜底） */
      }
    }
    // trace schemaValid 推导：解析失败 → fail（不再被误判 pass）；无质检配置/质检空 → skip；有 issues → fail；否则 pass
    const schemaValid = evalSchemaValid(checkReport);
    await trace.success({ schemaValid, retryCount, detail: `阶段「${stage.name}」完成${gateBlocked ? `（质量门禁停：${checkReport?.rating ?? "评级缺失"}）` : ""}` });
    return { blocked: gateBlocked, gateRetries: gateRetry, checkReport, hardIssues: hardScanIssues, persisted, raw: resp.raw };
  }

  /**
   * 确定性 workflow（人在回路逐步可控；autoFlow=full 全自动直驱）：
   * 缺口查找 → 逐阶段 Gate4 门禁 → 子 Agent 生成 → 落库 → 质检 →
   * emit awaitConfirm →（semi/manual）代码级等待用户确认（confirm/redo/back/abort）。
   *
   * 重构 P1：循环簿记（队列/游标/doneKeys/redo 备注/显式链/重跑计数）收敛进 WfLoop
   * （@/pipeline/workflowLoop，纯转移、零 IO、可单测）；阶段执行副作用收敛进 executeStageVerdict；
   * 本函数只剩 IO 编排与确认交互。缺口重算（IO）先行收集、planBack/advanceAfterConfirm 纯消费——
   * 批次0（等待期外部推进防重复生成）与 P1-5（redo 备注一次性回灌）语义内聚在转移函数里。
   */
  async function runWorkflow(
    ctx: AgentContext,
    opts: { autoFlow: "manual" | "semi" | "full"; prompt?: string; autoPassOk?: boolean },
    deps: { stageTools: StageToolMap },
  ): Promise<{ ok: boolean; error?: string }> {
    const projectId = Number(ctx.resTool.data.projectId);
    // P0-1/R1 断线恢复：整轮运行位经实例级通道登记（单步直驱各有自己的 attempt 位）；
    // 只写开始/结束两点且同步 await（时序确定）：开始写入在主链路任何落库前、结束写入在
    // finally（全部落库后）——中途不写（stageKey 实时性由 stageProgress 事件承担），
    // 规避读改写覆盖阶段产物的竞态（测试实证：void 并发写会覆盖同窗口内的落库并跨任务泄漏）
    const runAttempt = await beginGenerationMeta(projectId, null);
    try {
      let stages = await collectGapStages(ctx);
      // 章节续写指令（C1）：无前序缺口时续写指令把章节阶段加回队列（静态缺口判定视已有落库为完成，
      // 但章节是循环阶段——用户「继续写」是显式续写意图，由 beforeRunStage 的 chapterTarget 驱动）
      if (hooks?.shouldForceChapterStage && stages.length === 0 && (await hooks.shouldForceChapterStage(ctx, stages))) {
        const chapterDef = defs.find((d) => d.chapter);
        if (chapterDef) stages = [chapterDef];
      }
      if (stages.length === 0) return { ok: true }; // 全部完成，无需执行

      // 簿记进入 WfLoop（唯一可变状态；转移函数行为规格见 workflowLoop.ts 锚点注释）
      const wf = createWfLoop(stages);
      for (;;) {
        const stage = wf.current();
        if (!stage) break;
        // isFirst/isLast 从 STAGES 表读（续跑场景从中间缺口开始时，上一步仍可回退；stageGenerate 路径同口径）
        const isFirst = !!stage.isFirst;
        const isLast = !!stage.isLast;

        // Gate4 前置依赖门禁（每阶段实时读工作区，前序阶段产物落库后自然通过；
        // production 按 episodesId=scriptId 过滤工作区行）
        const scriptId = ctx.resTool.data.scriptId != null ? Number(ctx.resTool.data.scriptId) : undefined;
        try {
          await assertStageReady(projectId, agentKey, stage.stageKey, stage.dependsOn, scriptId);
        } catch (e) {
          await recordTrace({ projectId, agentKey, stage: stage.stageKey, gate: "gate4_orchestrator", event: "blocked", detail: e instanceof Error ? e.message : String(e) });
          throw e;
        }
        // P1-5 针对性返工：redo 补充要求回灌重跑 prompt（取出即删，注入一次即失效）
        const redoNote = wf.takeRedoNote(stage.stageKey);
        const stagePrompt = [opts.prompt ?? "", redoNote ? `用户补充要求（返工时必须优先满足）：${redoNote}` : ""].filter(Boolean).join("\n\n");
        const v = await executeStageVerdict(ctx, stage, stagePrompt, opts, wf.getState().retryCount, {
          stageTools: deps.stageTools,
          markDone: (key: string) => wf.markDone(key),
        });
        if (v.error) return { ok: false, error: `阶段「${stage.name}」：${v.error}` };

        // 人工确认点判定（decideConfirm 纯函数）：
        // - novel 的 brief（构思）：无条件强制停（所有 autoFlow）——3 版简介必须用户选版确认方向，禁止蒙第一版
        //   连跑 world/characters（历史 bug：阶段 0 连跑三件套）。选版由前端 handleConfirm 完成
        //   （回写 brief.selected + briefConfirmed + 立项 + emit stageConfirm 放行）。
        //   放行后统一 return（所有 autoFlow）——选版动作与 workflow 循环解耦（用户可能刷新/隔时确认），
        //   不依赖后端挂起续跑；后续阶段由前端按 autoFlow 触发：semi→emitStageConfirm 自动 generateStage、
        //   full→前端确认后重发 chat 触发 runWorkflow 从缺口全自动、manual→用户点生成按钮
        // - 其他阶段：full 跳过（全自动直驱）；semi/manual 代码级等待 stageConfirm 事件。
        //   P1c 质量门禁：gateBlocked（C/D 或章节返工耗尽）时 full 也强制停——不达标产物必须人工 redo/接受/回退
        //   确认减负（B）：autoPassOk（用户开关）+ semi 档 + 评级 A/B + 无硬校验命中 → 跳过确认点直接推进；
        //   gateBlocked/brief 强制停不受影响（质量底线不降）
        const briefMustConfirm = agentKey === "novelAgent" && stage.stageKey === "brief";
        const decision = decideConfirm({
          autoFlow: opts.autoFlow,
          autoPassOk: !!opts.autoPassOk,
          briefMustConfirm,
          gateBlocked: v.blocked,
          hardIssueCount: v.hardIssues.length,
          rating: v.checkReport.rating,
        });
        // R2 待复核裁决位登记/作废：新一轮产出达标 → 旧裁决作废；仍强停且需人工 → 持久化快照
        //（刷新后 getPlanData 透传，前端重建警示与浮层）；正常 brief 选版停不属于质量问题不登记
        if (v.blocked && decision.need) {
          await markPendingReview(projectId, {
            stageKey: stage.stageKey,
            stageName: stage.name,
            rating: v.checkReport.rating,
            reason: `评级 ${v.checkReport?.rating ?? "缺失"}${v.hardIssues.length ? ` + 代码硬校验 ${v.hardIssues.length} 项` : ""}`,
          });
        } else if (!v.blocked) {
          await clearPendingReview(projectId);
        }
        if (decision.canAutoPass) {
          ctx.resTool.socket.emit("stageProgress", { stageKey: stage.stageKey, stageName: stage.name, phase: "auto-passed", rating: v.checkReport.rating });
        }
        if (!decision.need) {
          // full 直驱 / semi·manual 自动通过共用出口。章节循环续写（novel 单次对话连续写多章，full 无
          // 确认点路径）：hook 返回 true 则不推进游标，重跑本阶段生成下一章（semi/manual 每章确认后的续写
          // 在下方确认分支内处理）
          if (stage.chapter && hooks?.shouldRepeatStage && (await hooks.shouldRepeatStage(ctx, stage.stageKey, 0))) continue;
          wf.advance();
          continue;
        }

        // —— 人工确认分支（普通确认 / brief 选版 / 质量门禁强停）——
        // UI 遗留A：章节 gateBlocked 停时 runSupervision 为空（深度监督走 afterSubAgent 落
        // o_check_report）——浮层带最近 chapter 报告，用户停在确认点能看到审稿意见而非空白
        let confirmReport = v.checkReport;
        if (stage.chapter && !hasCheckReport(confirmReport)) {
          try {
            const rows = await listCheckReports(projectId, { reportType: "chapter", limit: 1 });
            const r = rows[0] as { rating?: string; summary?: string; issues?: Array<{ text?: string }> } | undefined;
            if (r?.rating) {
              confirmReport = {
                rating: r.rating,
                summary: r.summary ?? "",
                ...(Array.isArray(r.issues) ? { issues: r.issues.filter((i) => i?.text).map((i) => String(i.text)) } : {}),
              } as typeof v.checkReport;
            }
          } catch {
            /* 报告回填失败不阻断确认流程 */
          }
        }
        ctx.resTool.socket.emit("awaitConfirm", {
          stageKey: stage.stageKey,
          stageName: stage.name,
          checkReport: confirmReport,
          isFirst,
          isLast,
        });
        const action = await waitForStageConfirm(ctx, stage.stageKey);
        if (action === "abort") return { ok: false, error: "流程已中止（连接断开或被新指令接管）" };
        if (action === "redo") {
          // P1-5 针对性返工：socket 层备注转入状态机（planRedo 原子完成计数 + 登记），原地重跑本步
          const note = takeRedoNote(ctx.socket.id, stage.stageKey);
          wf.planRedo(stage.stageKey, note);
          continue;
        }
        if (action === "back") {
          // 回退上一阶段（defs 序）重跑：上一阶段 + 本阶段都显式重跑，再接剩余缺口；
          // 缺口重算（IO）先行，planBack 纯消费（批次0 防索引漂移语义内聚于转移函数）
          const idx = defs.findIndex((d) => d.stageKey === stage.stageKey);
          const explicit = idx > 0 ? [defs[idx - 1], stage] : [stage];
          wf.planBack(explicit, await collectGapStages(ctx));
          continue;
        }
        // confirm：P1c 门禁稿接受 → 补落库（C/D 此前未落正式位置，避免垃圾数据残留；落库失败尽力记录不阻断）
        if (v.blocked && !v.persisted) {
          const gatePersist = await persistWithRetryOnConsumeError(projectId, stage.stageKey, v.raw, deps);
          if (gatePersist.persisted.error) {
            console.warn(`[${agentKey}] 阶段「${stage.name}」确认补落库失败:`, gatePersist.persisted.error);
          } else {
            wf.markDone(stage.stageKey);
            await hooks?.onStagePersisted?.(projectId, stage.stageKey);
          }
        }
        // confirm：novel brief 为终止点，统一 return 交回前端续跑（防双跑：前端 semi 会 generateStage、
        // full 会重发 chat，后端若继续推进会与之双跑）
        if (briefMustConfirm) return { ok: true };
        // 章节循环续写（novel 单次对话连续写多章）：确认后未达目标继续生成下一章（不推进游标）
        if (stage.chapter && hooks?.shouldRepeatStage && (await hooks.shouldRepeatStage(ctx, stage.stageKey, 0))) continue;
        // 普通推进：back 队列内还有未执行的显式重跑项 → 按队列推进；否则重算剩余缺口
        // （等待期间外部已推进的阶段不再重复），重算为空则收尾
        const gaps = await collectGapStages(ctx);
        if (wf.advanceAfterConfirm(gaps) === "empty") break;
      }
      // 全部完成：通知前端刷新对齐（stageDone 触发 refreshPlanData + 状态复位）
      ctx.resTool.socket.emit("stageDone", { stageKey: "workflow", ok: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: u.error(e).message };
    } finally {
      await endGenerationMeta(projectId, runAttempt);
    }
  }

  /**
   * run_workflow_stage 工具工厂（决策层唯一执行入口）：
   * 收敛为单工具：LLM 只能请求「执行某阶段」，阶段内部（依赖门禁/子 Agent 调用/落库）由代码保证。
   */
  function makeWorkflowStageTool(ctx: AgentContext, deps: { stageTools: StageToolMap }) {
    const stageKeys = defs.map((s) => s.stageKey);
    return tool({
      description: `执行小说创作阶段（确定性工作流）：按依赖链校验前置后生成对应阶段产物并自动落库。stageKey 可选：${stageKeys
        .map((k) => `${k}(${registry.stageLabels[k] ?? k})`)
        .join("/")}。完成后返回 {ok, consumed, chapters, scripts, summary}（summary 为产物摘要，可据此做完整性检查与质量小结）。不要重复调用已完成的阶段；需要推进创作时按依赖顺序请求下一阶段。`,
      inputSchema: jsonSchema<{ stageKey: string; prompt?: string }>(
        z
          .object({
            stageKey: z.enum(stageKeys as [string, ...string[]]).describe("要执行的阶段 key"),
            prompt: z.string().optional().describe("可选：给子 Agent 的指令（缺省用项目想法）"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ stageKey, prompt }: { stageKey: string; prompt?: string }) => {
        const projectId = Number(ctx.resTool.data.projectId);
        const def = defs.find((s) => s.stageKey === stageKey);
        if (!def) return { ok: false, error: `未知阶段: ${stageKey}` };
        // Gate4 前置依赖门禁：缺失直接返回错误（不抛，决策层据此提示用户先完成前置阶段）
        try {
          await assertStageReady(projectId, agentKey, stageKey, def.dependsOn);
        } catch (e) {
          await recordTrace({ projectId, agentKey, stage: stageKey, gate: "gate4_orchestrator", event: "blocked", detail: e instanceof Error ? e.message : String(e) });
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        // 缺口 4a：Gate2 校验失败自动重试一次（与消费阶段 2C 一致）
        const resp = await runStageWithGate2Retry(ctx, def.stageKey, prompt ?? "", deps);
        if (resp.error) return { ok: false, error: resp.error };
        // 2C：格式错自动重试（复用 runWorkflow 同一条重试路径）
        const persistRes = await persistWithRetryOnConsumeError(projectId, def.stageKey, resp.raw, deps);
        const persisted = persistRes.persisted;
        if (persisted.error) return { ok: false, error: persisted.error };
        // 返回产物摘要（截断）：决策层据此做完整性检查 + 一句话质量小结（semi/manual 确认点交互）
        // 结构化数据标签（constraints 等纯机器 JSON）整块剔除——只留叙述性文本，避免决策层把裸 JSON 复述给用户
        const narrativeOnly = persistRes.raw
          .replace(/<(constraints|events|subplots)>[\s\S]*?<\/\1>/g, "")
          .replace(/<[^>]+>/g, "")
          .replace(/\n{2,}/g, "\n")
          .trim();
        const summary = narrativeOnly.slice(0, 600);
        return { ok: true, consumed: persisted.consumed, chapters: persisted.chapterCount, scripts: persisted.scriptCount, summary };
      },
    });
  }

  /** run_stage_check 工具工厂（阶段质检：轻量自查，输出 <checkReport> 分级报告；只查不改） */
  function makeStageCheckTool(
    ctx: AgentContext,
    deps: { checkAgentKey: `${string}:${string}`; name: string; runSubAgent: (input: StageCheckRunInput) => Promise<{ raw: string }>; preloadWorkData: (keys: string[]) => Promise<Record<string, string>> },
  ) {
    const stageKeys = defs.map((s) => s.stageKey);
    return tool({
      description: "运行阶段质检 subAgent（轻量自查，输出 <checkReport> 分级报告 {rating, highlights, issues}）。内部按阶段加载质检 skill 并预加载前置产物",
      inputSchema: jsonSchema<{ stageKey: string; prompt: string }>(
        z
          .object({
            stageKey: z.enum(stageKeys as [string, ...string[]]).describe("要质检的阶段 key"),
            prompt: z.string().describe("质检指令（含本阶段产物）"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ stageKey, prompt }: { stageKey: string; prompt: string }) => {
        const def = defs.find((s) => s.stageKey === stageKey);
        if (!def?.supervision) return { raw: "" };
        const skill = path.join(u.getPath("skills"), def.supervision);
        const systemPrompt = await fs.promises.readFile(skill, "utf-8");
        // 预加载前置产物（质检上下文：本阶段产物 + 前置阶段）
        const preloadData = await deps.preloadWorkData(def.preloadKeys);
        return deps.runSubAgent({
          key: deps.checkAgentKey,
          prompt,
          system: systemPrompt,
          name: deps.name,
          memoryKey: "assistant:stageCheck",
          messages: [{ role: "user", content: prompt }],
          preloadData,
        });
      },
    });
  }

  return { runWorkflow, runStageDirect, persistStage, runSupervision, makeWorkflowStageTool, makeStageCheckTool, getWorkData, genMeta: { markPendingReview, clearPendingReview, bumpWordRetry, clearWordRetry } };
}
