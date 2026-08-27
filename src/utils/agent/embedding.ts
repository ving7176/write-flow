import path from "path";
import db from "@/utils/db";
import { env } from "@huggingface/transformers";

// pgvector 嵌入维度（all-MiniLM-L6-v2 输出 384 维）
const EMBEDDING_DIM = 384;

/**
 * RAG 记忆真实现（批次6b）：本地 ONNX 模型（data/models/all-MiniLM-L6-v2）跑真 embedding，
 * 替换原「零向量占位」（memories.embedding 存了零向量 → pgvector 检索恒等距，语义检索是假的）。
 *
 * 模型加载：
 * - @huggingface/transformers v3：env.localModelPath = data/models（模型 id "all-MiniLM-L6-v2" 对应子目录）
 * - env.allowRemoteModels=false 强制本地推理，零外部网络
 * - 懒加载单例（首次调用初始化，失败降级返回零向量——不阻断记忆写入/检索主流程）
 */

/**
 * 将 embedding 存入 pgvector 列（vector 类型）。
 * 传入 JSON 字符串格式的 embedding 数组，存储为 pgvector vector。
 */
export async function storeEmbedding(
  table: string,
  idField: string,
  idValue: string | number,
  embeddingField: string,
  embedding: number[],
): Promise<void> {
  const vectorStr = `[${embedding.join(",")}]`;
  await db(table)
    .where(idField, idValue)
    .update({ [embeddingField]: vectorStr });
}

/**
 * 向量相似度搜索：在指定表的 embedding 列上做 pgvector 近邻查询。
 * 返回最相似的 limit 条记录。
 */
export async function vectorSearch(
  table: string,
  embedding: number[],
  limit: number = 3,
  where?: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const vectorStr = `[${embedding.join(",")}]`;
  let query = db(table)
    .select("*")
    .whereRaw(`"${getEmbeddingCol(table)}" IS NOT NULL`)
    .orderByRaw(`"${getEmbeddingCol(table)}" <=> ?::vector`, [vectorStr])
    .limit(limit);
  if (where) {
    for (const [k, v] of Object.entries(where)) {
      query = query.where(k, v as string | number | boolean | null);
    }
  }
  return query;
}

/**
 * 获取 embedding 列名（不同表可能不同）。
 */
function getEmbeddingCol(table: string): string {
  return "embedding";
}

// ── 真 embedding（批次6b：本地 ONNX 推理 / api 远程二选一，配置层化见 docs/model-dependencies.md）──

// 配置层驱动（批次6b 配置层化）：本地模型路径/模型 id/远程 api 均从 o_setting 读，见 docs/model-dependencies.md
env.allowRemoteModels = false;

interface EmbeddingConfig {
  provider: "local" | "api";
  modelId: string;
  localPath: string;
  apiUrl: string;
  apiKey: string;
}

let cfgCache: EmbeddingConfig | null = null;

/** 读配置层（o_setting，fixDB 幂等种子）：默认本地模型，api 模式待申请后填 url/key 切换 */
async function readEmbeddingConfig(): Promise<EmbeddingConfig> {
  if (cfgCache) return cfgCache;
  const defaults: EmbeddingConfig = {
    provider: "local",
    modelId: "all-MiniLM-L6-v2",
    localPath: path.join(process.cwd(), "data", "models"),
    apiUrl: "",
    apiKey: "",
  };
  try {
    const rows = (await db("o_setting").whereIn("key", ["embeddingModelId", "embeddingModelPath", "embeddingProvider", "embeddingApiUrl", "embeddingApiKey"]).select("key", "value")) as Array<{ key: string; value?: string | null }>;
    const get = (k: string): string => rows.find((r) => r.key === k)?.value?.trim() ?? "";
    const provider = get("embeddingProvider") === "api" ? "api" : "local";
    cfgCache = {
      provider,
      modelId: get("embeddingModelId") || defaults.modelId,
      localPath: get("embeddingModelPath") || defaults.localPath,
      apiUrl: get("embeddingApiUrl"),
      apiKey: get("embeddingApiKey"),
    };
  } catch {
    cfgCache = defaults;
  }
  return cfgCache;
}

let extractorPromise: Promise<unknown> | null = null;

/** 懒加载本地特征抽取器（transformers.js feature-extraction；失败降级 null） */
function getExtractor(): Promise<unknown> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const cfg = await readEmbeddingConfig();
      if (cfg.provider === "api") return null; // api 模式不走本地模型
      env.localModelPath = path.join(cfg.localPath, path.sep);
      env.allowRemoteModels = false;
      // 2026-08-14 实测：必须传「模型目录绝对路径」——传模型 id 会被 transformers.js 当 hub id 走远程 fetch
      // （allowRemoteModels=false 下也尝试网络，最终 fetch failed 降级零向量）；绝对路径 196ms 加载成功
      const modelPath = path.join(cfg.localPath, cfg.modelId);
      const { pipeline } = await import("@huggingface/transformers");
      return await pipeline("feature-extraction", modelPath, { dtype: "fp16" });
    })().catch((e) => {
      console.warn("[embedding] 本地 embedding 模型加载失败（降级零向量，语义检索不可用）:", e instanceof Error ? e.message : String(e));
      return null;
    });
  }
  return extractorPromise;
}

/** 远程 api 模式向量化（约定见 docs/model-dependencies.md；未配 url/key 返回 null 降级） */
async function embedByApi(cfg: EmbeddingConfig, text: string): Promise<number[] | null> {
  if (!cfg.apiUrl) return null;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const res = await fetch(cfg.apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: cfg.modelId, input: text.slice(0, 2000) }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`embedding api ${res.status}`);
  const json = (await res.json()) as { embedding?: number[]; data?: Array<{ embedding: number[] }> };
  const vec = json.embedding ?? json.data?.[0]?.embedding;
  return Array.isArray(vec) && vec.length >= EMBEDDING_DIM ? vec.slice(0, EMBEDDING_DIM).map(Number) : null;
}

type ExtractOutput =
  | { data?: Float32Array | number[]; dims?: number[] }
  | Array<Array<number> | number[]>;

/** 计算 embedding（配置层驱动：local=本地 ONNX / api=远程；失败/未配置降级零向量，不阻断主流程） */
export async function getEmbedding(text: string): Promise<number[]> {
  try {
    const cfg = await readEmbeddingConfig();
    if (cfg.provider === "api") {
      const v = await embedByApi(cfg, text);
      if (v) return v;
      throw new Error("embedding api 未配置或返回异常");
    }
    const extractor = await getExtractor();
    if (!extractor) return new Array(EMBEDDING_DIM).fill(0);
    const output = (await (extractor as (input: string, opts?: Record<string, unknown>) => Promise<ExtractOutput>)((text ?? "").slice(0, 2000), {
      pooling: "mean",
    })) as ExtractOutput;
    // 形态 1：{data: Float32Array(384), dims:[1,384]}（pooled）
    if (output && typeof output === "object" && !Array.isArray(output) && "data" in output) {
      const data = Array.from((output.data as Float32Array | number[]) ?? []);
      if (data.length >= EMBEDDING_DIM) return data.slice(0, EMBEDDING_DIM).map(Number);
    }
    // 形态 2：嵌套数组 [[...384]]
    if (Array.isArray(output) && Array.isArray(output[0])) {
      const flat = output.flat().map(Number);
      if (flat.length >= EMBEDDING_DIM) return flat.slice(0, EMBEDDING_DIM);
    }
    return new Array(EMBEDDING_DIM).fill(0);
  } catch (e) {
    console.warn("[embedding] 向量化失败（降级零向量）:", e instanceof Error ? e.message : String(e));
    return new Array(EMBEDDING_DIM).fill(0);
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  return a.reduce((dot, v, i) => dot + v * b[i], 0);
}

export function disposeEmbedding(): void {
  extractorPromise = null;
}
