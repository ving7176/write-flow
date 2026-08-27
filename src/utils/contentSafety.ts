import u from "@/utils";
import fs from "fs";
import path from "path";
import { getSettingValue } from "@/utils/cache";

/**
 * 内容安全（P3-1 合规骨架 + 批次4 本地词库落地）：
 * - 第一层（批次4，零外部依赖，恒生效）：本地敏感词库 data/safetyLexicon.json 的 block 级词表——
 *   命中即拦截（章节跳过落库 / 导出 fail-closed 拒绝），词库可在 data/safetyLexicon.json 维护
 * - 第二层（渠道）：o_setting key=`contentSafetyChannel` 非空启用；第三方渠道（阿里云内容安全/腾讯云 TMS）
 *   实现仍待密钥确认（TODO），配置后当前按 fail-open 放行 + warn
 * - recordAudit：命中/未审记录写 o_content_audit（审核留痕，供人工复核/申诉）
 *
 * 设计约束：
 * - 本地词库命中属硬拦截（跨题材不误伤：词表只收「任何题材都不该出现」的硬违禁类别词，
 *   不收「打斗/暴力情节」类软词——玄幻打斗不会被误杀）
 * - 渠道调用失败按 fail-open（放行 + console.warn），避免第三方抖动阻断创作
 * - 渠道未配置时 textModerate 返回 unscreened=true（生成链路标「机器未审」，导出链路留痕可查）
 */

export interface AuditResult {
  pass: boolean;
  label?: string;
  score?: number;
  detail?: string;
  /** 渠道未配置（仅本地词库过审）时 true——生成标「机器未审」 */
  unscreened?: boolean;
}

const CHANNEL_KEY = "contentSafetyChannel";

/** 渠道是否启用（o_setting 配置非空） */
export async function isContentSafetyEnabled(): Promise<boolean> {
  try {
    const v = await getSettingValue(CHANNEL_KEY);
    return typeof v === "string" && v.trim().length > 0;
  } catch {
    return false;
  }
}

let lexiconCache: { block: string[] } | null = null;

/** 读本地敏感词库（缓存；文件缺失/损坏降级空词表不阻断——词库是可维护配置，不是硬依赖） */
function loadLexicon(): { block: string[] } {
  if (lexiconCache) return lexiconCache;
  try {
    const raw = fs.readFileSync(path.join(u.getPath("data"), "safetyLexicon.json"), "utf-8");
    const parsed = JSON.parse(raw);
    lexiconCache = { block: Array.isArray(parsed?.block) ? parsed.block.filter((w: unknown): w is string => typeof w === "string" && w.length > 0) : [] };
  } catch {
    lexiconCache = { block: [] };
  }
  return lexiconCache;
}

/** 本地词库命中检查（block 级硬拦截；返回命中的词，未命中返回空数组） */
export function scanLocalLexicon(text: string): string[] {
  if (!text) return [];
  const { block } = loadLexicon();
  if (!block.length) return [];
  return block.filter((w) => text.includes(w));
}

/**
 * 文本审核（批次4）：本地词库恒生效（block 命中即 fail）；渠道启用时再走第三方（实现待密钥确认，当前 fail-open）。
 */
export async function textModerate(text: string): Promise<AuditResult> {
  if (!text || !text.trim()) return { pass: true };
  // 第一层：本地词库（恒生效，无需渠道开关）
  const hits = scanLocalLexicon(text);
  if (hits.length) {
    return { pass: false, label: "block-lexicon", score: 100, detail: `本地词库命中：${hits.join("、")}` };
  }
  // 第二层：第三方渠道（未配置 → 返回 unscreened 标记「机器未审」）
  if (!(await isContentSafetyEnabled())) return { pass: true, unscreened: true };
  try {
    // TODO(P3-1 渠道确认)：接入阿里云内容安全 / 腾讯云 TMS，返回 {pass,label,score}
    // 【挂起状态】本地词库层恒生效；第三方渠道实现待接入，当前 fail-open 放行 + machine-unscreened 留痕。
    // 【触发条件】接入前置 = 配置 contentSafetyChannel 密钥 + 确认按量计费报价，接入后此处替换为 SDK 调用。
    // 示例：const r = await aliyunTextModeration(text); return { pass: r.suggestion === "pass", label: r.label, score: r.score };
    console.warn("[contentSafety] 渠道未接入（contentSafetyChannel 已配置但实现待确认），当前放行");
    return { pass: true, unscreened: true };
  } catch (e) {
    console.warn(`[contentSafety] 审核调用失败（放行）: ${e instanceof Error ? e.message : String(e)}`);
    return { pass: true, unscreened: true };
  }
}

/** 审核留痕（仅渠道启用时调用；失败不阻断主流程） */
export async function recordAudit(input: {
  projectId: number;
  sourceType: "chapter" | "input";
  sourceKey: string;
  contentSnapshot: string;
  result: string;
  label?: string;
  score?: number;
  handler?: "system" | "manual";
}): Promise<void> {
  try {
    const id = (Date.now() % 2000000000) + Math.floor(Math.random() * 1000);
    await u.db("o_content_audit").insert({
      id,
      projectId: input.projectId,
      sourceType: input.sourceType,
      sourceKey: input.sourceKey,
      contentSnapshot: input.contentSnapshot,
      result: input.result,
      label: input.label ?? null,
      score: input.score ?? null,
      handler: input.handler ?? "system",
      createTime: Date.now(),
    });
  } catch (e) {
    console.warn(`[contentSafety] 留痕失败（不阻断）: ${e instanceof Error ? e.message : String(e)}`);
  }
}
