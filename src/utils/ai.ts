import { generateText, streamText, wrapLanguageModel, stepCountIs, extractReasoningMiddleware } from "ai";
import { devToolsMiddleware } from "@ai-sdk/devtools";
import axios from "axios";
import { transform } from "sucrase";
import { createHash } from "node:crypto";
import u from "@/utils";
import { getSettingValue } from "@/utils/cache";
import appendJsonLine from "@/utils/jsonl";
import { computeCost } from "@/utils/priceTable";

type AiType =
  | "universalAi"
  | "novelAgent"
  | "novelAgent:decisionAgent"
  | "novelAgent:supervisionAgent"
  | "novelAgent:briefAgent"
  | "novelAgent:worldAgent"
  | "novelAgent:charactersAgent"
  | "novelAgent:synopsisAgent"
  | "novelAgent:outlineAgent"
  | "novelAgent:chapterAgent"
  | "novelAgent:stageCheckAgent"
  | "novelAgent:stateExtractor"
  | "novelAgent:chapterAssistant"
  | "novelAgent:midtermCheckAgent"
  | "novelAgent:milestoneCheckAgent";

type FnName = "textRequest" | "imageRequest";

const AiTypeValues: AiType[] = [
  "universalAi",
  "novelAgent",
  "novelAgent:decisionAgent",
  "novelAgent:supervisionAgent",
  "novelAgent:briefAgent",
  "novelAgent:worldAgent",
  "novelAgent:charactersAgent",
  "novelAgent:synopsisAgent",
  "novelAgent:outlineAgent",
  "novelAgent:chapterAgent",
  "novelAgent:stageCheckAgent",
  "novelAgent:stateExtractor",
  "novelAgent:chapterAssistant",
  "novelAgent:midtermCheckAgent",
  "novelAgent:milestoneCheckAgent",
  "universalAi",
];
async function resolveModelName(value: AiType | `${string}:${string}`): Promise<`${string}:${string}`> {
  if (AiTypeValues.includes(value as AiType)) {
    const agentUseMode = await getSettingValue("agentUseMode");

    //正常流程
    //高级配置
    if (agentUseMode == "1") {
      const agentDeployData = await u.db("o_agentDeploy").where("key", value).first();
      if (!agentDeployData?.modelName) throw new Error(`高级配置模式下，未找到对应的模型配置 ${value}`);
      return agentDeployData?.modelName as `${number}:${string}`;
    }
    //简易配置
    if (agentUseMode == "0") {
      const [mainly] = value!.split(/:(.+)/);
      const mainlyData = await u.db("o_agentDeploy").where("key", mainly).first();
      if (!mainlyData?.modelName) throw new Error(`简易配置模式下，未找到部署配置 ${mainly}`);
      return mainlyData.modelName as `${number}:${string}`;
    }

    //未查到agentUseModeVal 维持原判断
    const agentDeployData = await u.db("o_agentDeploy").where("key", value).first();
    let modelName = null;

    if (!agentDeployData?.modelName) {
      const [mainly] = agentDeployData!.key!.split(/:(.+)/);
      const mainlyData = await u.db("o_agentDeploy").where("key", mainly).first();
      if (!mainlyData?.modelName) throw new Error(`未找到部署配置 ${value}`);
      modelName = mainlyData.modelName;
    }
    modelName = agentDeployData?.modelName || modelName;
    return modelName as `${number}:${string}`;
  }
  return value as `${number}:${string}`;
}

async function getModelConfig(value: AiType | `${string}:${string}`) {
  if (AiTypeValues.includes(value as AiType)) {
    const agentUseMode = await getSettingValue("agentUseMode");
    //正常流程
    //高级配置
    if (agentUseMode == "1") {
      const agentDeployData = await u.db("o_agentDeploy").where("key", value).first();
      if (!agentDeployData?.modelName) throw new Error(`高级配置模式下，未找到对应的模型配置 ${value}`);
      return agentDeployData;
    }
    //简易配置
    if (agentUseMode == "0") {
      const [mainly] = value!.split(/:(.+)/);
      const mainlyData = await u.db("o_agentDeploy").where("key", mainly).first();
      if (!mainlyData?.modelName) throw new Error(`简易配置模式下，未找到部署配置 ${value}`);
      return mainlyData;
    }

    //未查到 agentUseModelVal 维持原流程
    const agentDeployData = await u.db("o_agentDeploy").where("key", value).first();

    if (!agentDeployData?.modelName) {
      const [mainly] = agentDeployData!.key!.split(/:(.+)/);
      const mainlyData = await u.db("o_agentDeploy").where("key", mainly).first();
      if (!mainlyData?.modelName) throw new Error(`未找到部署配置 ${value}`);
      return mainlyData;
    }
    return agentDeployData;
  }
  return null;
}

async function getVendorTemplateFn(
  fnName: "textRequest",
  modelName: `${string}:${string}`,
): Promise<(think?: boolean, thinkLevel?: 0 | 1 | 2 | 3) => any>;
async function getVendorTemplateFn(fnName: Exclude<FnName, "textRequest">, modelName: `${string}:${string}`): Promise<(input: any) => any>;
async function getVendorTemplateFn(fnName: FnName, modelName: `${string}:${string}`): Promise<any> {
  const [id, name] = modelName.split(/:(.+)/);
  const vendorConfigData = await u.db("o_vendorConfig").where("id", id).first();
  if (!vendorConfigData) throw new Error(`未找到供应商配置 id=${id}`);
  const modelList = await u.vendor.getModelList(id);
  const selectedModel = modelList.find((i: any) => i.modelName == name);
  if (!selectedModel) throw new Error(`未找到模型 ${name} id=${id}`);
  // HP6 读穿缓存：编译产物进程内复用（inputValues/models 每次调用重新 assign，配置变更即时生效）
  const running = u.vendor.getCompiledVendor(id);
  if (running.vendor) {
    Object.assign(running.vendor.inputValues, JSON.parse(vendorConfigData.inputValues ?? "{}"));
    running.vendor.models = modelList;
  }
  const fn = running[fnName];
  if (!fn) throw new Error(`未找到供应商配置中的函数 ${fnName} id=${id}`);
  if (fnName == "textRequest")
    return (think?: boolean, thinkLevel: 0 | 1 | 2 | 3 = 0) => {
      const effectiveThink = think ?? !!selectedModel.think;
      return fn(selectedModel, effectiveThink, thinkLevel);
    };
  else return <T>(input: T) => fn(input, selectedModel);
}

async function withTaskRecord<T>(
  modelKey: AiType | `${string}:${string}`,
  taskClass: string,
  describe: string,
  relatedObjects: string,
  projectId: number,
  fn: (modelName: `${string}:${string}`, think: Boolean, thinkLevel: 0 | 1 | 2 | 3) => Promise<T>,
): Promise<T> {
  const modelName = await resolveModelName(modelKey);
  const [_, model] = modelName.split(/:(.+)/);
  const taskRecord = await u.task(projectId, taskClass, model, { describe: describe, content: relatedObjects });
  try {
    const result = await fn(modelName, false, 0);

    taskRecord(1);
    return result;
  } catch (e) {
    taskRecord(-1, u.error(e).message);
    throw new Error(u.error(e).message);
  }
}

async function urlToBase64(url: string, retries = 3, delay = 1000): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(url, { responseType: "arraybuffer" });
      const base64 = Buffer.from(res.data).toString("base64");
      return `${base64}`;
    } catch (e) {
      if (attempt === retries) throw e;
      // 3A：退避改指数（delay * 2^(attempt-1)）替代现行线性
      await new Promise((resolve) => setTimeout(resolve, delay * Math.pow(2, attempt - 1)));
    }
  }
  throw new Error("urlToBase64 failed");
}
// ── Gate 1 harness 调用网关：健壮性参数 ──
const DEFAULT_MAX_RETRIES = 2; // 指数退避重试次数（SDK 原生，对 429/503/超时生效）
const DEFAULT_TIMEOUT_MS = 90_000; // 单次调用超时 90 秒
const MAX_STEPS_ABSOLUTE = 30; // 绝对步数上限（与 工具数×50 取较小值，防 token 失控）

/**
 * 合并外部 abortSignal 与超时 signal：任一触发即中断
 * 外部 signal 为空时仅用超时；外部 signal 存在时两者都监听
 */
function mergeAbortSignals(external: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!external) return timeoutSignal;
  // 任一 signal 触发即 abort
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  external.addEventListener("abort", onAbort, { once: true });
  timeoutSignal.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

/**
 * structured() 降级路径解析：从 LLM 文本输出提取结构化数据并 schema 校验
 * - 优先按 XML 标签提取（xmlFallbackTag 提供时）
 * - 回退到纯 JSON 解析（找第一个 { 到最后一个 }）
 */
export function parseStructuredFallback<T>(text: string, xmlTag: string | undefined, schema: any): { success: true; data: T } | { success: false; error: string } {
  const hasSelectedField = (schema as any)?.shape?.selected || (schema as any)?._def?.shape?.selected;

  // 步骤1：按约定 XML 格式优先解析
  // 从所有同名标签中找内容≥50字符的（跳过思考过程标签），从后往前找
  if (xmlTag) {
    const re = new RegExp(`<${xmlTag}[^>]*>([\\s\\S]*?)<\\/${xmlTag}>`, "g");
    const matches = [...text.matchAll(re)];
    // 从后往前找内容足够长的标签（LLM 可能在前面输出过含思考过程的短标签）
    for (let i = matches.length - 1; i >= 0; i--) {
      const content = matches[i][1].trim();
      if (content.length < 50) continue; // 跳过过短的思考过程标签

      // 尝试 JSON 解析（brief 等结构化 schema 路径）
      if (content.startsWith("{")) {
        try {
          const parsed = JSON.parse(content);
          const validated = (schema as any).safeParse?.(parsed);
          if (validated?.success) {
            return { success: true, data: validated.data as T };
          }
          // JSON 有 selected 字段直接用
          if (parsed.selected && typeof parsed.selected === "string") {
            return { success: true, data: { selected: parsed.selected } as unknown as T };
          }
        } catch {
          // JSON 解析失败，继续尝试作为 Markdown
        }
      }

      // 非 JSON 或 JSON 解析失败：把标签内容作为 selected（Markdown 降级）
      if (hasSelectedField) {
        return { success: true, data: { selected: content } as unknown as T };
      }
      break; // 非 selected schema 不走 Markdown 降级
    }
  }

  // 步骤2：纯 JSON 兜底（无 XML 标签或标签全过短）
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const jsonStr = text.slice(start, end + 1);
    try {
      const parsed = JSON.parse(jsonStr);
      const validated = (schema as any).safeParse?.(parsed);
      if (validated?.success) {
        return { success: true, data: validated.data as T };
      }
      if (parsed.selected && typeof parsed.selected === "string") {
        return { success: true, data: { selected: parsed.selected } as unknown as T };
      }
    } catch {
      // JSON 解析失败
    }
  }

  // 步骤3：全文兜底（所有解析都失败，把全文作为 selected）
  if (hasSelectedField) {
    // 取全文去掉开头的思考过程（找第一个标签或第一个 ### 标题之后的内容）
    let productText = text;
    // 如果全文里有 ### 标题，从第一个 ### 开始取（跳过前面的思考引导语）
    const headingIdx = text.indexOf("###");
    if (headingIdx > 0) {
      productText = text.slice(headingIdx).trim();
    }
    return { success: true, data: { selected: productText } as unknown as T };
  }

  return { success: false, error: `无法从输出提取产物（xmlTag=${xmlTag ?? "无"}，输出前100字: ${text.slice(0, 100)})` };
}

/** 任务结束回调（u.task 的 done）：成功 done(1, undefined, usage)，失败 done(-1, reason) */
export type AiTaskRecord = (
  state: 1 | -1,
  reason?: string,
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cost?: number },
) => Promise<void>;

/** SDK usage 归一化：AI SDK 各供应商 usage 字段一致（promptTokens/completionTokens/totalTokens），容错非数字值 */
export function toTokenUsage(usage: unknown): { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const result = {
    promptTokens: num(u.promptTokens),
    completionTokens: num(u.completionTokens),
    totalTokens: num(u.totalTokens),
  };
  return result.promptTokens == null && result.completionTokens == null && result.totalTokens == null ? undefined : result;
}

class AiText {
  private AiType: AiType | `${string}:${string}`;
  private think?: boolean;
  private thinkLevel: 0 | 1 | 2 | 3;
  /** P0-2 计量：u.task 的 done，调用结束时回写 token 用量到 o_tasks；不传则不记录（兼容现有调用方） */
  private taskRecord?: AiTaskRecord;
  constructor(AiType: AiType | `${string}:${string}`, think?: boolean, thinkLevel: 0 | 1 | 2 | 3 = 0, taskRecord?: AiTaskRecord) {
    this.AiType = AiType;
    this.think = think;
    this.thinkLevel = thinkLevel;
    this.taskRecord = taskRecord;
  }
  private async resolveModel(middleware?: any | any[], modelNameOverride?: `${string}:${string}`) {
    const switchAiDevTool = await getSettingValue("switchAiDevTool");
    const modelName = modelNameOverride ?? (await resolveModelName(this.AiType));
    const sdkFn = await getVendorTemplateFn("textRequest", modelName);
    const baseModel = await sdkFn(this.think, this.thinkLevel);
    const mws = [
      ...(switchAiDevTool === "1" ? [devToolsMiddleware()] : []),
      ...(middleware ? (Array.isArray(middleware) ? middleware : [middleware]) : []),
    ];
    return mws.length > 0 ? wrapLanguageModel({ model: baseModel, middleware: mws.length === 1 ? mws[0] : mws }) : baseModel;
  }

  /**
   * 3A：读 failover 备用模型（o_setting.textFallbackModel）。三种取值：
   * - "vendor:model"：写死的备用（存量兼容）
   * - "auto"：动态解析——同 vendor 名册内与主模型不同名、非 disabled 的第一档（名册刷新后自动跟随，
   *   防写死名被 API 名册淘汰后 failover 整体失效——2026-10-14 实证 v4.1-flash 过期 400）
   * - 空/未配置：不启用 failover。主模型调用失败时切换备用重跑一次（U3 兜底：备用也失败才抛双错误）。
   */
  private async getFallbackModelName(): Promise<`${string}:${string}` | null> {
    try {
      const v = await getSettingValue("textFallbackModel");
      const raw = v?.trim() ?? "";
      if (!raw) return null;
      if (raw !== "auto") return raw as `${string}:${string}`;
      const [vendorId] = this.AiType.split(/:(.+)/);
      const list = (await u.vendor.getModelList(vendorId)) as Array<{ modelName?: string }>;
      const primary = await resolveModelName(this.AiType);
      const primaryName = String(primary).split(/:(.+)/)[1];
      const candidates = list.map((m) => m.modelName).filter((n): n is string => !!n && n !== primaryName);
      // 优先选「远端名册 ∩ 模板清单」的 flash 档——模板清单可能挂着已被 API 淘汰的旧名（v4.1-flash 实证），
      // 直接从模板选会 400；远端名册拉取失败时回退模板清单逻辑（行为同前）
      let pool = candidates;
      try {
        const { fetchRemoteRoster } = await import("@/utils/modelRoster");
        const remote = await fetchRemoteRoster(vendorId);
        if (remote) {
          const inRoster = candidates.filter((n) => remote.has(n));
          if (inRoster.length) pool = inRoster;
        }
      } catch { /* 名册拉取失败 → 回退模板清单 */ }
      const alt = pool.find((n) => /flash/i.test(n)) ?? pool[0];
      return alt ? (`${vendorId}:${alt}` as `${string}:${string}`) : null;
    } catch {
      return null;
    }
  }

  /** 组装 generateText/streamText 入参（主/备用模型共用同一份 options 组装逻辑）。
   *  input.timeoutMs（分场景超时）：覆盖默认 90s 硬超时（大输出场景如 3000 字章节生成 90s 必截断，
   *  E2E 实测半截稿过闸）；该参数为本地约定，剥离后不下发 SDK。 */
  private async buildTextOptions(
    input: Record<string, unknown>,
    modelName: `${string}:${string}`,
    opts: { stream: boolean },
  ): Promise<Record<string, unknown>> {
    const { timeoutMs, ...rest } = input;
    const config = await getModelConfig(this.AiType);
    return {
      ...(typeof rest.tools === "object" && rest.tools !== null
        ? { stopWhen: stepCountIs(Math.min(Object.keys(rest.tools).length * 50, MAX_STEPS_ABSOLUTE)) }
        : {}),
      ...rest,
      model: await this.resolveModel(opts.stream ? extractReasoningMiddleware({ tagName: "reasoning_content", separator: "\n" }) : undefined, modelName),
      ...(config?.temperature && { temperature: config.temperature }),
      ...(config?.maxOutputTokens && { maxOutputTokens: config.maxOutputTokens }),
      maxRetries: rest.maxRetries ?? DEFAULT_MAX_RETRIES,
      abortSignal: mergeAbortSignals(rest.abortSignal as AbortSignal | undefined, typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS),
    };
  }

  /** 主调用 + failover 重试（3A）：主模型抛错且配置了备用模型时切换重跑一次 */
  private async withFailover<T>(primary: (modelName: `${string}:${string}`) => Promise<T>): Promise<T> {
    try {
      return await primary(await resolveModelName(this.AiType));
    } catch (err) {
      const fallback = await this.getFallbackModelName();
      if (!fallback) throw err;
      console.warn(`[ai] 主模型 ${this.AiType} 调用失败，切换备用 ${fallback}: ${u.error(err).message}`);
      try {
        return await primary(fallback);
      } catch (err2) {
        throw new Error(`主模型失败: ${u.error(err).message}；备用 ${fallback} 也失败: ${u.error(err2).message}`);
      }
    }
  }

  /**
   * 4B 结构化日志：统一 JSON 格式（event:"aiCall"）——console 走 logger 劫持写 app.log，
   * 同时 JSONL 直写 data/logs/ai-call.jsonl（logger 未启用也可 jq 检索对账，WP2 可追溯）。
   * 记录 agentKey/status/延迟/prompt 指纹/token（invoke 有 usage 时）。
   */
  private logAiCall(status: "ok" | "fail", startMs: number, extra: Record<string, unknown> = {}) {
    const record = { event: "aiCall", agentKey: this.AiType, status, durationMs: Date.now() - startMs, ...extra, ts: Date.now() };
    appendJsonLine("ai-call.jsonl", record);
    console.log(JSON.stringify(record));
  }

  async invoke(input: Omit<Parameters<typeof generateText>[0], "model">) {
    const startMs = Date.now();
    const promptTag = promptHashOf((input as Record<string, unknown>).prompt);
    let usedModel: `${string}:${string}` | null = null;
    try {
      const res = await this.withFailover(async (modelName) => {
        usedModel = modelName;
        return generateText((await this.buildTextOptions(input as Record<string, unknown>, modelName, { stream: false })) as Parameters<typeof generateText>[0]);
      });
      const usage = toTokenUsage((res as { usage?: unknown })?.usage);
      const cost = settleCost(usedModel, usage);
      this.logAiCall("ok", startMs, { ...promptTag, ...(usage?.totalTokens != null ? { tokens: usage.totalTokens } : {}), ...(cost != null ? { cost } : {}) });
      if (this.taskRecord) await this.taskRecord(1, undefined, { ...usage, ...(cost != null ? { cost } : {}), ...promptTag });
      return res;
    } catch (e) {
      this.logAiCall("fail", startMs, { error: u.error(e).message, ...promptTag });
      if (this.taskRecord) await this.taskRecord(-1, u.error(e).message);
      throw e;
    }
  }
  async stream(input: Omit<Parameters<typeof streamText>[0], "model">) {
    const startMs = Date.now();
    const promptTag = promptHashOf((input as Record<string, unknown>).prompt);
    let usedModel: `${string}:${string}` | null = null;
    try {
      const res = await this.withFailover(async (modelName) => {
        usedModel = modelName;
        return streamText((await this.buildTextOptions(input as Record<string, unknown>, modelName, { stream: true })) as Parameters<typeof streamText>[0]);
      });
      this.logAiCall("ok", startMs, promptTag);
      // streamText 的 usage 是 Promise，流被消费完才 resolve；失败/中断静默（不阻断主流程）
      const tr = this.taskRecord;
      if (tr) {
        const usagePromise = (res as { usage?: PromiseLike<unknown> }).usage;
        if (usagePromise) {
          Promise.resolve(usagePromise)
            .then((rawUsage) => {
              const usage = toTokenUsage(rawUsage);
              const cost = settleCost(usedModel, usage);
              return tr(1, undefined, { ...usage, ...(cost != null ? { cost } : {}), ...promptTag });
            })
            .catch(() => {});
        }
      }
      return res;
    } catch (e) {
      this.logAiCall("fail", startMs, { error: u.error(e).message, ...promptTag });
      if (this.taskRecord) await this.taskRecord(-1, u.error(e).message);
      throw e;
    }
  }
}

/** prompt 指纹（WP2 可追溯）：sha256 前 12 位，回答「这次调用喂了什么」；非字符串 prompt（多消息体）不打指纹 */
export function promptHashOf(prompt: unknown): { promptHash?: string } {
  if (typeof prompt !== "string" || !prompt) return {};
  return { promptHash: createHash("sha256").update(prompt).digest("hex").slice(0, 12) };
}

/**
 * 成本结算（WP6 收口修正）：按**实际解析出的模型名**（"vendorId:modelName"）查价表——
 * o_tasks.model 存的是 agent key（如 novelAgent:chapterAgent），按它查价永远落空；
 * 故在 AiText 层捕获 failover 后的真实模型名，价目未登记时返回 undefined（cost 保持 NULL 不估算）。
 */
function settleCost(model: `${string}:${string}` | null | undefined, usage: { promptTokens?: number; completionTokens?: number } | undefined): number | undefined {
  if (!model || !usage) return undefined;
  return computeCost(model, usage.promptTokens, usage.completionTokens);
}

function referenceList2imageBase642(id: string, input: any) {
  const version = u.vendor.getVendor(id).version;
  if (!version || isNaN(parseFloat(version)) || parseFloat(version) < 2.0) {
    // 无参考图（如纯文生图、TTS）时跳过转换，避免 undefined.map 崩溃
    if (!input.referenceList) return input;
    input.imageBase64 = input.referenceList.map((item: any) => item.base64);
    return input;
  }
  return input;
}

export type ReferenceList = { type: "image"; base64: string };

interface ImageConfig {
  prompt: string;
  referenceList?: Extract<ReferenceList, { type: "image" }>[];
  size: "1K" | "2K" | "4K";
  aspectRatio: `${number}:${number}`;
}

interface TaskRecord {
  taskClass: string; // 任务分类
  describe: string; // 任务描述
  relatedObjects: string; // 相关对象信息，便于后续分析和追踪
  projectId: number; // 项目ID
}

class AiImage {
  private key: `${string}:${string}`;
  private result: string = "";
  constructor(key: `${string}:${string}`) {
    this.key = key;
  }
  async run(input: ImageConfig, taskRecord?: TaskRecord) {
    const modelName = await resolveModelName(this.key);
    const exec = async (mn: `${string}:${string}`) => {
      const fn = await getVendorTemplateFn("imageRequest", mn);
      await referenceList2imageBase642(mn.split(/:(.+)/)[0], input);
      this.result = await fn(input);
      if (this.result.startsWith("http")) this.result = await urlToBase64(this.result);
      return this;
    };
    if (taskRecord) {
      await withTaskRecord(this.key, taskRecord.taskClass, taskRecord.describe, taskRecord.relatedObjects, taskRecord.projectId, exec);
      return this;
    }
    await exec(modelName);
    return this;
  }
  async save(path: string) {
    await u.oss.writeFile(path, this.result);
    return this;
  }
}

export default {
  Text: (AiType: AiType | `${string}:${string}`, think?: boolean, thinkLevel?: 0 | 1 | 2 | 3, taskRecord?: AiTaskRecord) =>
    new AiText(AiType, think, thinkLevel, taskRecord),
  Image: (key: `${string}:${string}`) => new AiImage(key),
};
