import { z } from "zod";

/**
 * 小说七阶段产物 Schema SSOT（单一事实来源）
 *
 * 约定（消除 prompt/解析/落库三处双写）：
 * - schema 字段名 = 工作区 key（brief/world/characters/synopsis/outline）
 * - XML 标签名 = `${key}Item`（固定派生关系，见 stageXmlTag）
 * - 格式说明由 renderXmlFormatHint(key) 从 schema 派生，替代各处硬编码 formatPrompt
 *
 * 改格式只改本文件一处，prompt/解析/落库三层自动同步。
 */

// ── 各阶段产物 schema ──

/** 简介产物：整段 Markdown（版本总览 + 3 版简介，每版含书名/简介/卖点/标签） */
export const briefSchema = z.object({
  brief: z.string().min(10, "简介内容过短，可能生成异常").describe("3 版简介内容"),
});

/**
 * 简介产物（JSON 形态：{title, versions[], selected}，前端选版数据源）结构约束。
 * 历史缺陷：xmlConsume 里「以 { 开头即跳过校验」——畸形 JSON 直接落库并触发自动立项。
 */
export const briefJsonSchema = z.object({
  title: z.string().min(1).optional().describe("定档书名（可缺省，取第一版书名）"),
  versions: z
    .array(
      z.object({
        index: z.union([z.number(), z.string()]).optional(),
        name: z.string().optional().describe("方案名（如「认知差立威型」）"),
        title: z.string().min(1, "版本书名不能为空"),
        intro: z.string().min(10, "版本简介过短，可能生成异常"),
        sellingPoint: z.string().optional(),
        tags: z.array(z.string()).optional(),
      }),
    )
    .min(2, "简介版本数不足（3 版选 1，至少 2 版）"),
  selected: z.string().optional().describe("确认版全文（用户选版后回写）"),
});

/** 校验 brief JSON 形态产物（JSON.parse + zod；解析/校验失败均返回 success:false + 可读 message） */
export function validateBriefJsonOutput(
  rawText: string,
): { success: true; data: z.infer<typeof briefJsonSchema> } | { success: false; message: string } {
  let obj: unknown;
  try {
    obj = JSON.parse(rawText);
  } catch (e) {
    return { success: false, message: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` };
  }
  const parsed = briefJsonSchema.safeParse(obj);
  if (parsed.success) return { success: true, data: parsed.data };
  return { success: false, message: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
}

/** 世界模型产物：整段 Markdown（宏观框架/底层规则/限制约束） */
export const worldSchema = z.object({
  world: z.string().min(10, "世界设定过短，可能生成异常").describe("世界设定全文"),
});

/** 人物设定产物：整段 Markdown（主角档案+配角+关系网+成长弧线+小传，内含多个 <role> 子节点） */
export const charactersSchema = z.object({
  characters: z.string().min(10, "人物设定过短，可能生成异常").describe("人物设定全文（内含多个<role>子节点）"),
});

/** 故事梗概产物：整段 Markdown（三幕脉络+核心矛盾+300字梗概+自查备注）；阶段名「小说简介」 */
export const synopsisSchema = z.object({
  synopsis: z.string().min(10, "故事梗概过短，可能生成异常").describe("小说简介全文（三幕脉络+核心矛盾+300字梗概）"),
});

/** 大纲产物：整段 Markdown（structure 条目 + 逐章条目全量拼接） */
export const outlineSchema = z.object({
  outline: z.string().min(10, "大纲内容过短，可能生成异常").describe("小说大纲内容"),
});

/** 章节产物：结构化三字段（reel/chapter/content），单章 */
export const chapterSchema = z.object({
  reel: z.string().optional().describe("卷号"),
  chapter: z.string().min(1, "章名不能为空"),
  content: z.string().min(50, "章节正文过短，可能生成异常"),
});

// ── 阶段映射表 ──

/** 阶段 key（= 工作区 key = NovelPlanData 字段名） */
export type NovelStageKey = "brief" | "world" | "characters" | "synopsis" | "outline" | "chapter";

/** 单字段阶段 schema（产物落工作区为单字符串字段） */
const singleFieldStages = {
  brief: briefSchema,
  world: worldSchema,
  characters: charactersSchema,
  synopsis: synopsisSchema,
  outline: outlineSchema,
} as const;

/** 章节阶段单独处理（结构化三字段，落 o_novel 表），schema 见 chapterSchema */

/**
 * 阶段 key → XML 标签名（显式映射，非简单派生）
 *
 * 特例：characters 工作区字段是复数，但 XML 标签是单数 characterItem（单个角色条目）
 * 其余阶段 key + "Item" 即标签名
 */
const STAGE_TAG_MAP: Record<NovelStageKey, string> = {
  brief: "briefItem",
  world: "worldItem",
  characters: "characterItem",
  synopsis: "synopsisItem",
  outline: "outlineItem",
  chapter: "chapterItem",
};

/** 导出供变更门禁脚本校验（scripts/check_skill_tags.ts） */
export { STAGE_TAG_MAP };

/** 阶段 → 工作区字段 label（供日志/错误信息使用；命名已按业务调整：brief=构思，synopsis=小说简介） */
export const stageLabels: Record<NovelStageKey, string> = {
  brief: "构思",
  world: "世界模型",
  characters: "人物设定",
  synopsis: "简介",
  outline: "大纲",
  chapter: "章节",
};

/**
 * 阶段 key → XML 标签名
 */
export function stageXmlTag(key: NovelStageKey): string {
  return STAGE_TAG_MAP[key];
}

/**
 * 从 schema 派生 XML 格式说明字符串（替代各处硬编码 formatPrompt）
 *
 * 单字段阶段：`<${key}Item>${字段描述}</${key}Item>`
 * chapter 阶段：固定三字段结构说明
 */
export function renderXmlFormatHint(key: NovelStageKey): string {
  if (key === "chapter") {
    return "\n你必须使用如下XML格式写入工作区：\n<chapterItem>章节内容</chapterItem>";
  }
  const schema = singleFieldStages[key as Exclude<NovelStageKey, "chapter">];
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  const fieldName = Object.keys(shape)[0];
  const desc = shape[fieldName]?.description ?? `${stageLabels[key]}全文`;
  return `\n你必须使用如下XML格式写入工作区：\n<${stageXmlTag(key)}>${desc}</${stageXmlTag(key)}>`;
}

/**
 * 校验单字段阶段产物（brief/world/characters/synopsis/outline）
 * @returns { success, data?, error? }
 */
export function validateStageOutput(key: Exclude<NovelStageKey, "chapter">, rawText: string) {
  const schema = singleFieldStages[key];
  return schema.safeParse({ [key]: rawText });
}

/**
 * 校验章节产物（结构化三字段）
 */
export function validateChapterOutput(reel: string, chapter: string, content: string) {
  return chapterSchema.safeParse({ reel, chapter, content });
}

/** 所有单字段阶段的 key 列表（供 consumeAgentOutput 遍历） */
export const singleFieldStageKeys = Object.keys(singleFieldStages) as Array<Exclude<NovelStageKey, "chapter">>;
