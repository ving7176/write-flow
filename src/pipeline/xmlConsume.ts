import u from "@/utils";
import { singleFieldStageKeys, stageXmlTag, validateStageOutput, validateBriefJsonOutput } from "@/pipeline/schemas/novel";
import { parseConstraintsXml, mergeConstraints, type NovelConstraint } from "@/agents/novelAgent/constraints";
import { chapterKey } from "@/utils/chapterKey";
import { snapshotChapter } from "@/pipeline/chapterVersion";
import { textModerate, recordAudit } from "@/utils/contentSafety";
import { parseOutlineForeshadows } from "@/agents/novelAgent/foreshadowParse";
import { mergeOutlineMarkdown, hasParseableChapterHeading, syncOutlineStructure, markChapterWrittenLight, recomputeVolumeStatus, notePendingVolumeDone } from "@/agents/novelAgent/outlinePlan";
import { nextChapterNo } from "@/agents/novelAgent/workflow";
import { recordTrace } from "@/pipeline/trace";

/**
 * 产物消费网关错误：xmlConsume 收到非空输出但无法解析出任何已知标签时抛出。
 * 区分两种失败：
 * - 空输出（agent 无产出）：返回空结果，不抛错（pipeline 据此判断阶段是否产出）
 * - 格式错（有输出但标签全缺失）：抛 ConsumeError，禁止静默落空数据
 */
export class ConsumeError extends Error {
  readonly agentKey: string;
  readonly stage: string;
  constructor(agentKey: string, stage: string, message?: string) {
    super(message ?? `[${agentKey}] 产物消费失败：期望阶段 ${stage} 的 XML 标签全部缺失，输出可能格式错误`);
    this.name = "ConsumeError";
    this.agentKey = agentKey;
    this.stage = stage;
  }
}

/** 提取 XML 标签内容（支持同名多标签，返回数组） */
export function extractXmlTags(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[1].trim());
  }
  return results;
}

/** 大纲条目（保留 type/index/chapter 属性，供落库重建标题） */
export interface OutlineEntry {
  type?: string;
  index?: string;
  chapter?: string;
  content: string;
}

/**
 * 提取 outlineItem 并保留属性（type="structure" / index / chapter）。
 * 与 extractXmlTags 不同：后者只取标签内文本、丢弃属性，导致落库后前端
 * 无法按「## 全书结构 / ## 第N章」切分（历史缺陷：大纲 3 菜单展示断裂）。
 */
export function extractOutlineEntries(xml: string): OutlineEntry[] {
  const re = /<outlineItem([^>]*)>([\s\S]*?)<\/outlineItem>/g;
  const results: OutlineEntry[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1] ?? "";
    results.push({
      type: attrs.match(/type="([^"]*)"/)?.[1],
      index: attrs.match(/index="([^"]*)"/)?.[1],
      chapter: attrs.match(/chapter="([^"]*)"/)?.[1],
      content: m[2].trim(),
    });
  }
  return results;
}

/**
 * 大纲条目 → 带 ## 标题的 Markdown（与前端 splitOutline/joinOutline 契约一致）。
 * - structure 条目 → `## 全书结构`
 * - 逐章条目 → `## 第N章 · 章名`（优先 chapter，其次 index）
 * - 无属性条目按内容特征归类：含卷索引表/伏笔清单/foreshadows → 结构条目；
 *   含「第N章」特征 → 逐章；无法归类 → 原样保留（由 check 机制拦截）
 */
export function rebuildOutlineMarkdown(entries: OutlineEntry[]): string {
  return entries
    .map((it) => {
      const content = it.content.trim();
      const looksStructure =
        it.type === "structure" ||
        /卷索引表|foreshadows|伏笔清单/i.test(content) ||
        /卷索引表|foreshadows/i.test(it.chapter ?? "");
      if (looksStructure) return `## 全书结构\n${content}`;
      const title = it.chapter?.trim() || (it.index ? `第${it.index}章` : "");
      if (title) return `## ${title}\n${content}`;
      // 无章号、无结构特征：保留原文本（不伪造标题），由落库 check 拦截提示重试
      return content;
    })
    .join("\n\n");
}

/** 提取单个 XML 标签内容（取第一个） */
export function extractXmlTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].trim() : "";
}

// ── 工作区读写 ──

/** 已知数组字段（workData 结构 SSOT）：字符串形态统一归一为数组再落库 */
const ARRAY_FIELDS = ["chapters", "constraints", "constraintTransforms", "foreshadows", "timeLine", "subplots"] as const;

/**
 * 数组字段出口归一化：某条写入路径（E2E 实测 world 门禁重做期间）曾把数组字段写成
 * JSON 字符串（"[]"）——读取侧 parseField/readWorkConstraints 各有兜底，但字段形态
 * 漂移会累积（前端 Array.isArray 判断失效）。落库出口统一归一，写入侧新增字符串值自动纠正。
 */
export function normalizeArrayFields(data: Record<string, unknown>): Record<string, unknown> {
  for (const k of ARRAY_FIELDS) {
    const v = data?.[k];
    if (typeof v === "string") {
      try {
        data[k] = JSON.parse(v);
      } catch {
        /* 非法 JSON 保持原值，由读取侧兜底 */
      }
    }
  }
  return data;
}

async function getWorkData(projectId: number, agentKey: string): Promise<any> {
  const row = await u.db("o_agentWorkData").where({ projectId, key: agentKey }).first();
  if (!row) return {};
  try {
    return JSON.parse(row.data ?? "{}");
  } catch {
    return {};
  }
}

async function saveWorkData(projectId: number, agentKey: string, data: any) {
  const existing = await u.db("o_agentWorkData").where({ projectId, key: agentKey }).first();
  // updateTime 维护：生成链路串行写入（服务端权威最后写），版本号供 setPlanData 乐观锁比对
  const payload = JSON.stringify(normalizeArrayFields(data));
  if (existing) {
    await u.db("o_agentWorkData").where({ id: existing.id }).update({ data: payload, updateTime: Date.now() });
  } else {
    await u.db("o_agentWorkData").insert({ projectId, key: agentKey, data: payload, updateTime: Date.now() });
  }
}

// ── 章节落库（o_novel upsert by chapterIndex） ──

/** 本地 id 生成（同 utils.nextIntId：int4 防溢出 + 随机防同毫秒碰撞；绕开 @/utils 循环依赖与 mock 脆弱性） */
function nextIntId(): number {
  return (Date.now() % 2000000000) + Math.floor(Math.random() * 1000);
}

/** 剥离章名序号前缀（「第1章 · 穿越」「第12章·破局」「第一章 下山」→ 穿越/破局/下山）；剥后为空（纯「第N章」）返回空串 */
export function stripChapterNoPrefix(name: string): string {
  return (name ?? "")
    .replace(/^\s*第\s*[0-9〇零一二三四五六七八九十百千]{1,6}\s*章\s*[·・•‥…．:：、\-—–]?[\s　]*/, "")
    .trim();
}

/** 章卡标题查询（章名的唯一真相源；DB 异常降级空串，走剥前缀兜底） */
async function getChapterPlanTitle(projectId: number, chapterIndex: number): Promise<string> {
  try {
    const row = (await u.db("o_chapter_plan").where({ projectId, chapterIndex }).select("title").first()) as { title?: string } | undefined;
    return String(row?.title ?? "").trim();
  } catch {
    return "";
  }
}

async function upsertNovelChapter(projectId: number, index: number, reel: string, chapter: string, content: string): Promise<number> {
  const row = (await u.db("o_novel").where({ projectId, chapterIndex: index }).first()) as { id: number; reel?: string; chapter?: string } | undefined;
  if (row) {
    await u.db("o_novel").where({ id: row.id }).update({
      reel: reel || row.reel,
      chapter: chapter || row.chapter,
      chapterData: content,
    });
    return row.id;
  }
  // 批次0/1 修复：id 非自增列（integer primary），insert 必须显式赋值（原漏 id/createTime 为潜在约束违反）
  const id = nextIntId();
  await u.db("o_novel").insert({
    id,
    projectId,
    chapterIndex: index,
    reel: reel || "",
    chapter: chapter || `第${index + 1}章`,
    chapterData: content,
    createTime: Date.now(),
  });
  return id;
}

/**
 * 消费 Agent 执行层产物 XML，按 Agent 类型解析落库。
 * @param agentKey novelAgent
 */
export async function consumeAgentOutput(
  agentKey: string,
  projectId: number,
  xml: string,
): Promise<{ consumed: string[]; chapters: number }> {
  const result = { consumed: [] as string[], chapters: 0 };
  if (!xml?.trim()) return result;

  if (agentKey === "novelAgent") {
    // 构思 / 世界模型 / 人物设定 / 小说简介 / 大纲 / 章节（七阶段链路）
    // Schema SSOT 驱动：遍历 singleFieldStageKeys 提取+校验+落库，消除 5 段重复代码
    const tagCounts: Record<string, number> = {};
    for (const key of singleFieldStageKeys) {
      const tag = stageXmlTag(key);
      if (key === "outline") {
        // 大纲专用：保留属性重建 ## 标题（前端 splitOutline 按 ## 切分），并做结构完整性校验
        const outlineEntries = extractOutlineEntries(xml);
        tagCounts[key] = outlineEntries.length;
        if (outlineEntries.length) {
          const rawText = rebuildOutlineMarkdown(outlineEntries);
          // check 机制：结构条目（## 全书结构）+ 至少 1 个可解析逐章条目必须齐备；
          // 批次1：章号兼容中文数字/序章（原 /## 第\d+章/ 只认阿拉伯数字，LLM 输出「第一章」即两连败卡死）
          const hasStructure = /## 全书结构/.test(rawText);
          const hasChapter = hasParseableChapterHeading(rawText);
          if (!hasStructure || !hasChapter) {
            throw new ConsumeError(
              "novelAgent",
              "outline",
              `[outline] 大纲结构不完整：${hasStructure ? "缺少逐章条目（## 第N章）" : "缺少结构条目（## 全书结构）"}，请重新生成`,
            );
          }
          const data = await getWorkData(projectId, "novelAgent");
          // 批次1 合并式消费：按章号去重合并（单卷细化只产出新卷逐章、整卷重生成产出同章号新稿，统一语义；
          // 原「整包替换」会让单卷细化覆盖丢失既有卷）
          data.outline = mergeOutlineMarkdown(String(data.outline ?? ""), rawText);
          const mergedValidated = validateStageOutput("outline", data.outline);
          if (!mergedValidated.success) {
            throw new ConsumeError("novelAgent", "outline", `[outline] 产物 schema 校验失败：${mergedValidated.error.issues.map((i: any) => i.message).join("; ")}`);
          }
          await saveWorkData(projectId, "novelAgent", data);
          // 批次1：markdown → o_volume/o_chapter_plan/o_foreshadow 三表同步（结构真相源）
          try {
            await syncOutlineStructure(projectId, data.outline);
          } catch (e) {
            console.warn("[xmlConsume] 大纲结构化同步失败（不阻断落库，下次打开项目懒补）:", u.error(e).message);
          }
          result.consumed.push("outline");
        }
        continue;
      }
      const items = extractXmlTags(xml, tag);
      tagCounts[key] = items.length;
      if (items.length) {
        // 单字段阶段（brief/world/characters/synopsis）：取最长条目
        // （LLM 偶发输出多个标签时，正式产物最长，思考/分析片段较短——取最长丢弃短标签）
        const rawText = items.reduce((a, b) => (b.length > a.length ? b : a));
        // brief 落库存完整 JSON（{versions,selected,title}），与前端内存语义统一：
        // - 子 Agent preload 经 extractPlanDataValue 提取 selected 纯文本注入 prompt（见 planDataCompat.ts）
        // - 立项（前端选版确认 /project/confirmNovelProject）经提取逻辑取 selected 写 o_project.intro
        // - 前端 UI 版本切换读完整 JSON
        // 历史行为：落库时提前提取 selected 文本，导致 DB 与前端内存（完整 JSON）语义分裂，
        // 且 world/characters 子 Agent preload（走前端 socket）拿到 JSON 而非 selected 文本。
        let storeValue = rawText;
        // 非 JSON 格式时走常规 schema 校验（XML 降级路径）
        if (!rawText.trim().startsWith("{")) {
          const validated = validateStageOutput(key, rawText);
          if (!validated.success) {
            throw new ConsumeError("novelAgent", key, `[${key}] 产物 schema 校验失败：${validated.error.issues.map((i) => i.message).join("; ")}`);
          }
        } else if (key === "brief") {
          // 缺口③：brief JSON 形态（{title,versions,selected}）此前以 { 开头即跳过全部校验——
          // 畸形 JSON 直接落库并触发自动立项。此处补 zod 结构校验，失败抛 ConsumeError 走重试。
          const validated = validateBriefJsonOutput(rawText);
          if (!validated.success) {
            throw new ConsumeError("novelAgent", "brief", `[brief] 产物 JSON 校验失败：${validated.message}`);
          }
        }
        const data = await getWorkData(projectId, "novelAgent");
        data[key] = storeValue;
        await saveWorkData(projectId, "novelAgent", data);
        result.consumed.push(key);
      }
    }

    // 约束消费（<constraints> 标签：JSON 数组，按 id 去重追加——只加不偷偷删）。
    // brief/world/characters 产物都可带约束块；追加不覆盖（已有 id 保留工作区版本，防 redo 覆盖用户编辑）。
    const constraintItems = extractXmlTags(xml, "constraints");
    if (constraintItems.length) {
      const rawConstraints = constraintItems.reduce((a, b) => (b.length > a.length ? b : a));
      const incoming = parseConstraintsXml(rawConstraints);
      // 缺口④：<constraints> 标签存在但解析失败（JSON 损坏）原静默丢弃 → 抛 ConsumeError 重试一次；
      // 重试后仍失败由 stageEngine 标记阶段失败（可见），不静默空转。
      if (incoming === null) {
        throw new ConsumeError("novelAgent", "brief|world|characters", `[constraints] <constraints> 标签内容 JSON 解析失败，请重新生成`);
      }
      if (incoming.length) {
        const data = await getWorkData(projectId, "novelAgent");
        const existing = Array.isArray(data.constraints) ? (data.constraints as NovelConstraint[]) : [];
        data.constraints = mergeConstraints(existing, incoming);
        await saveWorkData(projectId, "novelAgent", data);
      }
    }
    // 伏笔清单消费（<foreshadows> 标签：JSON 数组，outline 一次性规划全卷，覆盖式写入）
    const foreshadowItems = extractXmlTags(xml, "foreshadows");
    if (foreshadowItems.length) {
      const rawFs = foreshadowItems.reduce((a, b) => (b.length > a.length ? b : a));
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(rawFs);
      } catch (e) {
        // 缺口④：<foreshadows> 标签存在但 JSON 损坏——原静默丢弃（伏笔追踪/核查地基空转）→ 抛错重试一次
        throw new ConsumeError("novelAgent", "outline", `[foreshadows] 标签内容 JSON 解析失败：${u.error(e).message}，请重新生成`);
      }
      if (Array.isArray(parsed)) {
        const data = await getWorkData(projectId, "novelAgent");
        data.foreshadows = parsed.filter((f: any) => f && typeof f === "object" && typeof f.id === "string" && typeof f.description === "string");
        await saveWorkData(projectId, "novelAgent", data);
        // 批次1：伏笔结构化标签变化 → o_foreshadow 表同步（真相源）
        try {
          await syncOutlineStructure(projectId, String(data.outline ?? ""));
        } catch {
          /* 表同步失败不阻断（下次大纲同步/懒补兜底） */
        }
      }
    } else {
      // 降级补种：标签缺失（旧版大纲/漏输）时从大纲文本解析散文伏笔行 → 结构化（幂等：仅当空时补）
      const data = await getWorkData(projectId, "novelAgent");
      const existing = Array.isArray(data.foreshadows) ? data.foreshadows : [];
      if (!existing.length) {
        const parsed = parseOutlineForeshadows(String(data.outline ?? ""));
        if (parsed.length) {
          data.foreshadows = parsed;
          await saveWorkData(projectId, "novelAgent", data);
        }
      }
    }
    // 约束转化规划消费（<constraintTransforms> 标签：JSON 数组，outline 一次性规划，覆盖式写入）
    const transformItems = extractXmlTags(xml, "constraintTransforms");
    if (transformItems.length) {
      const rawTf = transformItems.reduce((a, b) => (b.length > a.length ? b : a));
      let parsedTf: unknown = null;
      try {
        parsedTf = JSON.parse(rawTf);
      } catch (e) {
        // 缺口④：<constraintTransforms> 标签存在但 JSON 损坏——原静默丢弃 → 抛错重试一次
        throw new ConsumeError("novelAgent", "outline", `[constraintTransforms] 标签内容 JSON 解析失败：${u.error(e).message}，请重新生成`);
      }
      if (Array.isArray(parsedTf)) {
        const data = await getWorkData(projectId, "novelAgent");
        data.constraintTransforms = parsedTf.filter(
          (t: any) => t && typeof t === "object" && typeof t.constraintId === "string" && typeof t.resolvedReason === "string",
        );
        await saveWorkData(projectId, "novelAgent", data);
      }
    }

    // 金手指/背景事件/支线消费（附加标签：各条件触发，共享一次 workData 读写）
    // 性能（B5）：原三个分支各自 getWorkData+saveWorkData（全量 JSON 往返 3 次），合并为读一次写一次；
    // 可选标签：缺失不阻塞主产物落库（旧输出/模型不崩）
    const data = await getWorkData(projectId, "novelAgent");
    let dirty = false;
    const cheatItems = extractXmlTags(xml, "cheatItem");
    if (cheatItems.length) {
      const rawCheat = cheatItems.reduce((a, b) => (b.length > a.length ? b : a));
      if (rawCheat.trim()) {
        data.cheat = rawCheat.trim();
        dirty = true;
      }
    }
    const backstoryItems = extractXmlTags(xml, "backstoryEventsItem");
    if (backstoryItems.length) {
      const rawBe = backstoryItems.reduce((a, b) => (b.length > a.length ? b : a));
      if (rawBe.trim()) {
        data.backstoryEvents = rawBe.trim();
        dirty = true;
      }
    }
    const subplotItems = extractXmlTags(xml, "subplots");
    if (subplotItems.length) {
      const rawSp = subplotItems.reduce((a, b) => (b.length > a.length ? b : a));
      let parsedSp: unknown = null;
      try {
        parsedSp = JSON.parse(rawSp);
      } catch (e) {
        // 缺口④ 同源：<subplots> 标签存在但 JSON 损坏——抛错重试一次，不静默丢弃
        throw new ConsumeError("novelAgent", "outline", `[subplots] 标签内容 JSON 解析失败：${u.error(e).message}，请重新生成`);
      }
      if (Array.isArray(parsedSp)) {
        data.subplots = parsedSp.filter((s: any) => s && typeof s === "object" && typeof s.title === "string" && typeof s.goal === "string");
        dirty = true;
      }
    }
    if (dirty) await saveWorkData(projectId, "novelAgent", data);

    // 章节阶段（结构化三字段，单独处理）
    const chapterItems = extractXmlTags(xml, stageXmlTag("chapter"));
    tagCounts.chapter = chapterItems.length;

    // 产物消费网关：6 类标签全缺失时区分两种情况——
    // - 输出含 XML 标签痕迹（如 <xxxItem>）但标签名不对 → 格式错误，抛 ConsumeError
    // - 输出是纯文本无标签痕迹（决策层对话/问题引导阶段，answers 走工具写工作区不产出 XML）→ 返回空
    //   历史事故：决策层"工作区数据异常"分析文本曾通过 fallback 全文落库成 characters 阶段产物，
    //   污染正式人物设定——此处禁止任何无标签文本落库，宁可阶段 skip 也不落脏数据
    const totalParsed = Object.values(tagCounts).reduce((a, b) => a + b, 0);
    if (totalParsed === 0) {
      const hasXmlTrace = /<[a-zA-Z][\w-]*[^>]*>/.test(xml);
      if (hasXmlTrace) {
        throw new ConsumeError("novelAgent", "brief|world|characters|synopsis|outline|chapter");
      }
    }

    // 批量路径（B7）：本批涉及卷的集合，循环后统一重算卷状态（替代逐章 markChapterWritten 级联查询）
    const touchedVolumes = new Set<number>();

    for (const item of chapterItems) {
      const reel = extractXmlTag(item, "reel");
      const chapter = extractXmlTag(item, "chapter");
      const content = extractXmlTag(item, "content");
      // 空壳防护：无内容的 chapterItem 不落库（LLM 偶发输出空 chapterItem）
      if (!content.trim()) continue;
      // P3-1 合规：章节正文落库前审核（本地词库恒生效 + 第三方渠道未配时标「机器未审」；命中拦截 + 留痕，跳过该章落库）
      const audit = await textModerate(content);
      if (!audit.pass) {
        await recordAudit({
          projectId,
          sourceType: "chapter",
          sourceKey: chapter,
          contentSnapshot: content.slice(0, 500),
          result: "fail",
          label: audit.label,
          score: audit.score,
        });
        console.warn(`[contentSafety] 章节「${chapter}」命中审核拦截（${audit.label ?? "未分类"}），跳过落库`);
        continue;
      }
      // 批次4：渠道未配置（仅本地词库过审）→ 留 pass 痕迹（machine-unscreened 可查「机器未审」覆盖范围）
      if (audit.unscreened) {
        await recordAudit({
          projectId,
          sourceType: "chapter",
          sourceKey: chapter,
          contentSnapshot: content.slice(0, 200),
          result: "pass",
          label: "machine-unscreened",
          handler: "system",
        }).catch(() => {});
      }
      // 章名代码裁定（A1：标题一致性不依赖模型自觉）：
      // - 匹配键沿用模型输出章名（chapterKey 兼容修订后缀「第1章·下山」vs「第1章·下山（修订）」）
      // - 落库标题以章卡 title 为唯一真相源（大纲层真相）；无章卡时剥离「第N章 ·」序号前缀兜底
      // - 模型标题与裁定值不一致 → recordTrace 留痕观测（漂移率监控），不阻断
      const key = chapterKey(chapter);
      // 查全部已有章键做同章匹配（修订版后缀变化也能命中：如「第1章·下山」vs「第1章·下山（修订）」）
      // 性能：只取轻量列做去重（不拖 chapterData 全文——长篇几百章每章写前整本搬正文是最大 DB 热点）
      const rows = await u.db("o_novel").where("projectId", projectId).select("id", "chapterIndex", "chapter");
      const dup = (rows as any[]).find((r) => chapterKey(r.chapter) === key);
      // index：修订覆盖命中时取既有章号，新章取 max+1（而非 count 总行数——删除章节后 count 与 index 错位，导致覆盖/跳号）
      const index = dup ? dup.chapterIndex : await nextChapterNo(projectId);
      const planTitle = await getChapterPlanTitle(projectId, index);
      const stripped = stripChapterNoPrefix(chapter);
      const finalChapter = planTitle || stripped || chapter;
      const resolvedName = planTitle || stripped;
      if (resolvedName && chapterKey(chapter) !== chapterKey(resolvedName)) {
        await recordTrace({
          projectId,
          agentKey: "novelAgent",
          stage: "chapter",
          gate: "gate1_harness",
          event: "fail",
          detail: `[章名漂移] 模型输出「${chapter}」与裁定章名「${resolvedName}」不一致，已按章卡/剥前缀裁定落库`,
        }).catch(() => {});
      }
      if (dup) {
        // P1-2：覆盖前存旧稿快照（历史版本回滚；覆盖普通生成 + 监督返工稿，两路径都经 consumeAgentOutput 落库）
        // 性能（B3）：查重行不含 chapterData，快照用旧稿需单独取一次（仅修订覆盖时）
        const oldData = (await u.db("o_novel").where({ id: dup.id }).select("chapterData").first()) as { chapterData?: string } | undefined;
        await snapshotChapter({
          projectId,
          novelId: dup.id,
          chapterIndex: dup.chapterIndex,
          chapter: dup.chapter,
          chapterData: oldData?.chapterData ?? "",
          source: "regen",
        });
        await u.db("o_novel").where({ id: dup.id }).update({ reel: reel || finalChapter, chapter: finalChapter, chapterData: content });
        // 批量路径（B7）：light 标记（置 done + 回填 volumeId），卷状态循环后统一重算
        const vid = await markChapterWrittenLight(projectId, dup.chapterIndex, dup.id);
        if (vid != null) touchedVolumes.add(vid);
        result.chapters++;
        continue;
      }
      // R6 章名-索引错位观测（软告警不阻断）：模型章名自带序号与实际落库 index 不一致 → 记 trace 供
      // 内容质量监控。E2E 实测样本：AI 合并大纲两段剧情并自称「第2章」，DB index=1 自洽但读者视角错位。
      // 仅在章名为阿拉伯数字「第N章」形态时比对（中文数字/楔子等跳过，保守不误报）
      const nameNum = /^(?:第\s*)(\d{1,3})(?:\s*章)/.exec(chapter ?? "");
      if (nameNum && Number(nameNum[1]) !== index) {
        await recordTrace({
          projectId,
          agentKey: "novelAgent",
          stage: "chapter",
          gate: "gate1_harness",
          event: "fail",
          detail: `[章名错位] 章名含「第${nameNum[1]}章」与落库 chapterIndex=${index} 不一致，建议核对是否合并了多段大纲剧情`,
        }).catch(() => {});
      }
      const novelId = await upsertNovelChapter(projectId, index, reel, finalChapter, content);
      const vid = await markChapterWrittenLight(projectId, index, novelId);
      if (vid != null) touchedVolumes.add(vid);
      result.chapters++;
    }
    // 批量路径（B7）：统一重算受影响卷状态 + 卷写完事件（原逐章级联 4-7 次/章 → 一次批量重算）
    if (touchedVolumes.size) {
      const volumeDones = await recomputeVolumeStatus(projectId, [...touchedVolumes]);
      for (const vd of volumeDones) await notePendingVolumeDone(projectId, vd);
    }
    // 章节同步回工作区 chapters 数组（前端章节 tab 依赖列表；①轻量化：只存索引/章名/卷号，
    // 正文以 o_novel 为唯一真相源，前端经 getChapterContent 按章懒加载——避免长篇全量正文随每次写章搬运）
    if (chapterItems.length) {
      const rows = await u.db("o_novel").where("projectId", projectId).orderBy("chapterIndex", "asc").select("chapterIndex", "reel", "chapter");
      const data = await getWorkData(projectId, "novelAgent");
      data.chapters = rows.map((r: any) => ({ chapterIndex: r.chapterIndex, reel: r.reel, chapter: r.chapter, status: "complete" }));
      await saveWorkData(projectId, "novelAgent", data);
    }
  }

  return result;
}
