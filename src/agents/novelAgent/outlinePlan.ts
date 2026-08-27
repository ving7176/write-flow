import u from "@/utils";
import { chapterNoOf } from "@/utils/chapterKey";
import { parseOutlineForeshadows } from "@/agents/novelAgent/foreshadowParse";

/**
 * 大纲结构化核心（批次1 重方案）：大纲 markdown ⇄ 卷/章卡/伏笔三层结构化真相源。
 *
 * 设计：
 * - workData.outline 保留为生成产物缓存（聊天展示/兼容），o_volume/o_chapter_plan 为结构真相源；
 *   每次大纲落库（xmlConsume）/手动编辑（setPlanData）/启动迁移（fixDB）后同步（syncOutlineStructure）
 * - 大纲消费改为「合并式」（mergeOutlineMarkdown）：按章号去重合并——单卷细化（只产出新卷逐章）与
 *   整卷重生成（产出同章号新稿）都自然成立，无需 scope 标记
 * - 已写章节（status=done）的章卡不被解析删除（保留元数据）
 */

/** 本地 id 生成（同 utils.nextIntId：绕开 @/utils 循环依赖） */
function nextIntId(): number {
  return (Date.now() % 2000000000) + Math.floor(Math.random() * 1000);
}

export interface ParsedVolume {
  volumeIndex: number;
  title: string;
  summary: string;
  startChapter: number;
  endChapter: number;
  mainline?: string; // 卷头主线句（主角+困境+目标+对抗力量+最终得失）
  stageLabel?: string; // 起承转合阶段标注
  conflictScale?: string; // 本卷冲突尺度
  oneLineSummary?: string; // 卷一句话概括（人物+世界观+金手指+主要目标，分卷设计）
  stories?: string[]; // 卷内故事条目（故事1/2/3，分卷设计）
}

/** 卷内事件段（参考 xianxia-novel 卷内分段：段=章范围+事件名+战略贡献） */
export interface ParsedArc {
  volumeIndex: number;
  arcIndex: number;
  title: string;
  startChapter: number;
  endChapter: number;
  contribution: string;
}

export interface ParsedChapterPlan {
  chapterIndex: number;
  title: string;
  summary: string;
  hooks: string[];
  coolPoints: string[];
  foreshadowRefs: string[];
  wordTarget: number | null;
}

export interface OutlineStructure {
  volumes: Array<ParsedVolume & { id: number; status: string; plannedChapters: number }>;
  arcs: Array<ParsedArc & { id: number; volumeId: number }>;
  plans: Array<ParsedChapterPlan & { id: number; volumeId: number; arcId: number | null; status: string; sortOrder: number }>;
  foreshadows: Array<{
    id: number;
    fsKey: string;
    description: string;
    plantedChapterIndex: number;
    plannedResolveChapterIndex: number;
    resolvedChapterIndex: number | null;
    status: string;
    source: string;
  }>;
}

/** 大纲 section（## 标题切分；structure=全书结构；chapter 带 `第N章` 章号） */
interface OutlineSection {
  heading: string;
  chapterIndex: number | null;
  isStructure: boolean;
  content: string;
}

/**
 * 清洗「## 第undefined章」非法章号标题（历史缺陷：前端 joinOutline 未守空，无 chapter/index 的条目
 * 拼出 `第undefined章`；后端解析不认 → plans=[] → lazyBackfill 因 plans=0 自锁，存量卷/章卡永不迁移）。
 * 按出现顺序回填合法章号：首个 undefined 段 = 当前最大合法章号 + 1，其后依次递增。
 */
export function sanitizeUndefinedChapters(outline: string): string {
  if (!outline.includes("undefined")) return outline;
  let next = 0;
  for (const line of outline.split("\n")) {
    const m = line.match(/^##\s+第\s*([0-9一二三四五六七八九十百零两]+)\s*章/);
    const n = m ? chapterNoOf(`第${m[1]}章`) ?? 0 : 0;
    if (n > next) next = n;
  }
  return outline.replace(/##\s*第\s*undefined\s*章/g, () => {
    next += 1;
    return `## 第${next}章`;
  });
}

function splitSections(outline: string): OutlineSection[] {
  const sections: OutlineSection[] = [];
  const lines = outline.split("\n");
  let cur: OutlineSection | null = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(.+)$/);
    if (m) {
      cur = { heading: m[1].trim(), chapterIndex: null, isStructure: false, content: "" };
      if (cur.heading === "全书结构") cur.isStructure = true;
      else cur.chapterIndex = chapterNoOf(cur.heading);
      sections.push(cur);
    } else if (cur) {
      cur.content += (cur.content ? "\n" : "") + line;
    }
  }
  return sections;
}

/** 从全书结构 section 的卷索引表解析卷（容错：表格行或散文行均可） */
export function parseVolumes(structureContent: string): ParsedVolume[] {
  const volumes: ParsedVolume[] = [];
  // 事件段块跟踪：`第N卷 · 事件段：` 引导行之后到下一卷头前的表格行属事件段表，
  // 其数据行（第一列段序号 + 第二列章范围）与卷索引表行同形，会误判为卷 → 跳过
  // （与 parseArcs 的 currentVolume 状态机同思路，防事件段数据行误收卷）。
  let inArcSection = false;
  for (const rawLine of structureContent.split("\n")) {
    const line = rawLine.replace(/\|/g, " ").trim();
    if (!line) continue;
    // 「卷索引表（…）」引导说明行含「第N卷/1卷5章」字样但非卷条目（E2E 实测「按 volumePlan 第一卷第5章」
    // 被 `第N卷` 散文行分支误收，与卷索引表数据行同产 volumeIndex=N 的重复卷）——先于所有卷匹配跳过
    if (/卷索引表/.test(line)) continue;
    // 事件段引导行进入段块；卷头引导行重置段块（两者都非卷条目）
    if (/事件段/.test(line)) {
      inArcSection = true;
      continue;
    }
    if (/卷头/.test(line)) {
      inArcSection = false;
      continue;
    }
    // 带「第N卷」的散文行或表格行（兼容历史/后端 renderOutlineMarkdown 自产格式）
    if (/第\s*[0-9一二三四五六七八九十]+\s*卷/.test(line)) {
      // 卷号
      const vm = line.match(/第\s*([0-9一二三四五六七八九十]+)\s*卷/);
      if (!vm) continue;
      const volumeIndex = chapterNoOf(`第${vm[1]}章`) ?? 0;
      if (!volumeIndex) continue;
      // 章节范围（1-10 / 1~10 / 1至10）
      const rm = line.match(/([0-9]+)\s*[-–~至]\s*([0-9]+)/);
      const startChapter = rm ? Number(rm[1]) : 0;
      const endChapter = rm ? Number(rm[2]) : 0;
      // 卷名/概要：去卷号与范围后的剩余文本（清理表格分隔残留）
      let rest = line
        .replace(/第\s*[0-9一二三四五六七八九十]+\s*卷/g, " ")
        .replace(/[0-9]+\s*[-–~至]\s*[0-9]+/g, " ")
        .replace(/^[-:\s：]+|[-:\s：]+$/g, "")
        .trim();
      const nm = rest.match(/(?:卷名|标题)[：:]\s*([^\s；;，,]+)/);
      // 兜底名为空串：前端/重渲染均自带「第N卷」前缀，此处给名会重复显示
      let title = nm ? nm[1] : (rest.split(/[\s；;，,]{1}/)[0] || "").slice(0, 30);
      // 表格标题行残留（如「卷索引表（」）不是卷名 → 兜底默认名
      if (/^卷索引表/.test(title)) title = `第${volumeIndex}卷`;
      const summary = rest.slice(0, 200);
      volumes.push({ volumeIndex, title, summary, startChapter, endChapter });
      continue;
    }
    // 无「第N卷」：skill 规范裸数字表格行 `| 1 | 1~30 | 起 | 入局立威 |`（卷索引表行）。
    // 事件段块内不解析（数据行结构与卷行同形）；表头行（第一列「卷」）与散文行天然跳过。
    if (inArcSection) continue;
    const cells = rawLine.split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    if (!/^\d+$/.test(cells[0])) continue; // 第一列必须裸数字卷号
    const volumeIndex = Number(cells[0]);
    if (!volumeIndex) continue;
    const range = parseChapterRange(cells[1]);
    if (!range) continue; // 第二列必须是章范围（区分卷索引表行与其他表）
    const meta = cells.slice(2);
    const title = meta.length ? meta.join("·").slice(0, 60) : `第${volumeIndex}卷`;
    const summary = meta.join(" ").slice(0, 200);
    volumes.push({ volumeIndex, title, summary, startChapter: range.start, endChapter: range.end });
  }
  return volumes;
}

/**
 * 解析卷头元信息行（structure 内，格式：`第N卷 · 卷头：一句话概括=…；主线句=…；阶段=…；冲突尺度=…；故事N=…`）。
 * 归并进对应卷（volumeIndex 匹配；无匹配卷时忽略）。
 * 分卷设计字段：一句话概括（人物+世界观+金手指+主要目标）与卷内故事条目（故事1/2/3）都在卷头行内承载。
 */
export function parseVolumeHeads(structureContent: string, volumes: ParsedVolume[]): ParsedVolume[] {
  for (const rawLine of structureContent.split("\n")) {
    const line = rawLine.trim();
    const m = line.match(/^第\s*([0-9一二三四五六七八九十]+)\s*卷[^：:]*卷头[：:]\s*(.+)$/);
    if (!m) continue;
    const idx = chapterNoOf(`第${m[1]}章`) ?? 0;
    const vol = volumes.find((v) => v.volumeIndex === idx);
    if (!vol) continue;
    const body = m[2];
    vol.oneLineSummary = body.match(/一句话概括\s*[=＝]\s*([^；;]+)/)?.[1]?.trim() || "";
    vol.mainline = body.match(/主线句\s*[=＝]\s*([^；;]+)/)?.[1]?.trim() || "";
    vol.stageLabel = body.match(/阶段\s*[=＝]\s*([^；;]+)/)?.[1]?.trim() || "";
    vol.conflictScale = body.match(/冲突尺度\s*[=＝]\s*([^；;]+)/)?.[1]?.trim() || "";
    // 卷内故事条目（故事1=…；故事2=…；可任意条数，按序号排序）
    const stories = [...body.matchAll(/故事\s*(\d+)\s*[=＝]\s*([^；;]+)/g)]
      .map((mm) => ({ n: Number(mm[1]), text: mm[2].trim() }))
      .sort((a, b) => a.n - b.n)
      .map((s) => s.text)
      .filter(Boolean);
    if (stories.length) vol.stories = stories;
  }
  return volumes;
}

/** 章范围单元格（`ch1~10` / `1-10` / `1至10`）→ {start,end}；非范围返回 null */
function parseChapterRange(cell: string): { start: number; end: number } | null {
  // 前缀 `ch` 须整体可选（`(?:ch)?`）；原 `ch?` 语义是「c 必选 + h 可选」，
  // 导致 `1-10`/`1~30` 这类无前缀范围永远不匹配（注释声称支持，实际漏掉——本次 o_chapter_arc 全空的原因之一）
  const m = cell.trim().match(/^(?:ch)?\s*(\d+)\s*[-–~～至]\s*(\d+)$/i);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!start || !end || end < start) return null;
  return { start, end };
}

/**
 * 解析卷内事件段表（structure 内）：
 * `第N卷 · 事件段：` 引导行 + 表格行 `| 段 | 章范围 | 事件名 | 战略贡献 |`。
 * 引导行前无卷号时忽略（容错：事件段必须挂在卷下）。
 */
export function parseArcs(structureContent: string): ParsedArc[] {
  const arcs: ParsedArc[] = [];
  let currentVolume = 0;
  for (const rawLine of structureContent.split("\n")) {
    const line = rawLine.trim();
    const vm = line.match(/^第\s*([0-9一二三四五六七八九十]+)\s*卷[^：:]*事件段/);
    if (vm) {
      currentVolume = chapterNoOf(`第${vm[1]}章`) ?? 0;
      continue;
    }
    if (!currentVolume) continue;
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length < 4) continue;
    const n = /^\d+$/.test(cells[0]) ? Number(cells[0]) : null;
    if (n == null) continue;
    const range = parseChapterRange(cells[1]);
    if (!range) continue; // 第二列必须是章范围（区分卷索引表/章表）
    const title = cells[2];
    if (!title) continue;
    const contribution = cells.slice(3).join(" ");
    arcs.push({ volumeIndex: currentVolume, arcIndex: n, title: title.slice(0, 60), startChapter: range.start, endChapter: range.end, contribution: contribution.slice(0, 500) });
  }
  return arcs;
}

/** 逐章 section → 章卡（钩子/爽点/伏笔引用/字数目标独立字段） */
export function parseChapterPlan(chapterIndex: number, heading: string, content: string): ParsedChapterPlan {
  const title = heading
    .replace(/第\s*[0-9一二三四五六七八九十百零两]+\s*章/, "")
    .replace(/^[·．.:：\s]+/, "")
    .trim()
    .slice(0, 60);
  const hooks: string[] = [];
  const coolPoints: string[] = [];
  let wordTarget: number | null = null;
  // 钩子/爽点行可能与下文同段（分隔符不一定是 ；）——取值后按下文关键词边界截断
  const cutAtNext = (v: string, keywords: RegExp): string => {
    const idx = v.search(keywords);
    return (idx >= 0 ? v.slice(0, idx) : v).trim().replace(/[。，,]+$/, "").slice(0, 120);
  };
  for (const m of content.matchAll(/钩子\s*[：:=]\s*([^\n]+)/g)) {
    const v = cutAtNext(m[1].trim(), /爽点|字数\s*[：:]/);
    if (v) hooks.push(v);
  }
  for (const m of content.matchAll(/爽点\s*[：:=]\s*([^\n]+)/g)) {
    const v = cutAtNext(m[1].trim(), /字数\s*[：:]/);
    if (v) coolPoints.push(v);
  }
  const wm = content.match(/字数\s*[：:]\s*约?\s*([0-9]+)/);
  if (wm) wordTarget = Number(wm[1]);
  const foreshadowRefs = [...new Set([...content.matchAll(/FS-[A-Za-z0-9-]+/g)].map((m) => m[0]))];
  return { chapterIndex, title, summary: content.trim().slice(0, 2000), hooks, coolPoints, foreshadowRefs, wordTarget };
}

/** 大纲 markdown → 卷 + 事件段 + 章卡（逐章 section 优先；无 `## 第N章` 段落时降级解析卷索引表逐章行） */
export function parseOutlineStructure(outline: string): { volumes: ParsedVolume[]; arcs: ParsedArc[]; plans: ParsedChapterPlan[] } {
  // 入口清洗：旧数据「## 第undefined章」非法章号回填为合法章号（否则该段被丢弃 + lazyBackfill 自锁）
  const sections = splitSections(sanitizeUndefinedChapters(outline));
  let volumes: ParsedVolume[] = [];
  const plans: ParsedChapterPlan[] = [];
  const structureContents: string[] = [];
  for (const s of sections) {
    if (s.isStructure) {
      volumes = parseVolumes(s.content);
      structureContents.push(s.content);
    } else if (s.chapterIndex != null) {
      plans.push(parseChapterPlan(s.chapterIndex, s.heading, s.content));
    }
  }
  // 卷头元信息 + 卷内事件段（都在 structure 内容里）；卷头在单卷兜底后归并（兜底卷也可挂卷头）
  const structureText = structureContents.join("\n");
  const arcs = parseArcs(structureText);
  // 2026-08-14 排查补充：存量项目大纲多为「卷索引表」式（`| 章 | 阶段 | 核心事件 |`），无独立 `## 第N章` 段落——
  // 原解析产 0 章卡 → 章卡视图空。此处从卷索引表逐章行降级解析（首列数字=章号，阶段+事件组 summary）。
  if (!plans.length && structureContents.length) {
    for (const rawLine of structureContents.join("\n").split("\n")) {
      const cells = rawLine.split("|").map((c) => c.trim()).filter(Boolean);
      if (cells.length < 3) continue;
      const n = /^\d+$/.test(cells[0]) ? Number(cells[0]) : null;
      if (n == null) continue;
      const stage = cells[1];
      // 第二列是章范围（`ch1~10`/`1-10`）→ 卷索引表/事件段表行，不是逐章行（误收会产出幽灵章卡）
      if (parseChapterRange(stage)) continue;
      const event = cells.slice(2).join(" ");
      if (!event) continue;
      plans.push({
        chapterIndex: n,
        title: stage.slice(0, 60),
        summary: `${stage}：${event}`.slice(0, 2000),
        hooks: [],
        coolPoints: [],
        foreshadowRefs: [...new Set([...event.matchAll(/FS-[A-Za-z0-9-]+/g)].map((m) => m[0]))],
        wordTarget: null,
      });
    }
  }
  if (!volumes.length && plans.length) {
    // 无卷索引表 → 单卷兜底（覆盖全部章）
    volumes = [{ volumeIndex: 1, title: "", summary: "", startChapter: 1, endChapter: Math.max(...plans.map((p) => p.chapterIndex)) }];
  }
  // 卷同号去重归并（须在 parseVolumeHeads 前：卷头按 find 挂到首条，重复卷会把卷头信息挂在被丢弃的条上）。
  // 同号多条字段级合并——后者非空字段优先，前条独有的非空值保留；章范围取有效（>0）者。
  // 重复来源（E2E 实测）：散文说明行与卷索引表行同产 volumeIndex=N → 批量 upsert 报
  // ON CONFLICT DO UPDATE cannot affect row a second time → 三表整体同步失败（fixDB 存量错同源）
  const volByIdx = new Map<number, ParsedVolume>();
  for (const v of volumes) {
    const prev = volByIdx.get(v.volumeIndex);
    if (!prev) {
      volByIdx.set(v.volumeIndex, v);
      continue;
    }
    const pick = <T>(a: T, b: T, isEmpty: (x: T) => boolean): T => (isEmpty(b) ? a : b);
    volByIdx.set(v.volumeIndex, {
      ...prev,
      ...v,
      title: pick(prev.title ?? "", v.title ?? "", (s) => !s.trim()),
      summary: pick(prev.summary ?? "", v.summary ?? "", (s) => !s.trim()),
      startChapter: v.startChapter > 0 ? v.startChapter : prev.startChapter,
      endChapter: v.endChapter > 0 ? v.endChapter : prev.endChapter,
    });
  }
  volumes = [...volByIdx.values()];
  parseVolumeHeads(structureText, volumes);
  // 同章号去重（后出现的覆盖）；事件段同卷内 (volumeIndex,arcIndex) 去重
  const byIndex = new Map<number, ParsedChapterPlan>();
  for (const p of plans) byIndex.set(p.chapterIndex, p);
  const arcSeen = new Set<string>();
  const dedupArcs = arcs.filter((a) => {
    const k = `${a.volumeIndex}:${a.arcIndex}`;
    if (arcSeen.has(k)) return false;
    arcSeen.add(k);
    return true;
  });
  return { volumes, arcs: dedupArcs, plans: [...byIndex.values()].sort((a, b) => a.chapterIndex - b.chapterIndex) };
}

/** 章号 → 卷（范围命中；否则归入 startChapter 最大的前置卷；无卷归卷 1） */
function volumeOf(volumes: ParsedVolume[], chapterIndex: number): number {
  const hit = volumes.find((v) => v.startChapter <= chapterIndex && chapterIndex <= v.endChapter && v.startChapter > 0);
  if (hit) return hit.volumeIndex;
  const before = volumes.filter((v) => v.startChapter > 0 && v.startChapter <= chapterIndex).sort((a, b) => b.startChapter - a.startChapter)[0];
  return before?.volumeIndex ?? 1;
}

/**
 * 合并式大纲消费（单卷细化/整卷重生成统一语义）：按 section key（全书结构 / 章号 / 原标题）去重，
 * next 覆盖 prev 同 key section，next 新章追加；末尾按 章号 排序（structure 置顶）。
 */
export function mergeOutlineMarkdown(prev: string, next: string): string {
  if (!prev.trim()) return next;
  const prevSections = splitSections(prev);
  const nextSections = splitSections(next);
  const structure = nextSections.find((s) => s.isStructure)?.content ?? prevSections.find((s) => s.isStructure)?.content ?? "";
  const keyed = new Map<string, { heading: string; content: string; chapterIndex: number | null }>();
  const others: Array<{ heading: string; content: string }> = [];
  const put = (s: OutlineSection) => {
    if (s.isStructure) return; // structure 单独处理
    const key = s.chapterIndex != null ? `num:${s.chapterIndex}` : `raw:${s.heading}`;
    keyed.set(key, { heading: s.heading, content: s.content, chapterIndex: s.chapterIndex });
  };
  for (const s of prevSections) put(s);
  for (const s of nextSections) put(s);
  // 分组：数字章 / 无章号条目（楔子/番外等，保序追加）
  const numbered = [...keyed.values()].filter((s) => s.chapterIndex != null).sort((a, b) => (a.chapterIndex ?? 0) - (b.chapterIndex ?? 0));
  const unnumbered = [...keyed.values()].filter((s) => s.chapterIndex == null);
  void others;
  const parts: string[] = [];
  if (structure.trim()) parts.push(`## 全书结构\n${structure.trim()}`);
  for (const s of numbered) parts.push(`## ${s.heading}\n${s.content.trim()}`);
  for (const s of unnumbered) parts.push(`## ${s.heading}\n${s.content.trim()}`);
  return parts.join("\n\n");
}

/** 是否存在可解析的逐章标题（outline 落库硬校验；替代原 `/## 第\d+章/` 只认阿拉伯数字的脆校验） */
export function hasParseableChapterHeading(outline: string): boolean {
  return splitSections(outline).some((s) => s.chapterIndex != null);
}

// ── DB 同步 ──

async function readWorkForeshadows(projectId: number): Promise<Array<{ id: string; description: string; plantedAt: number; plannedResolve: number; status: string; resolvedAt?: number }>> {
  const row = await u.db("o_agentWorkData").where({ projectId, key: "novelAgent" }).first();
  let foreshadows: Array<{ id: string; description: string; plantedAt: number; plannedResolve: number; status: string; resolvedAt?: number }> = [];
  try {
    const data = row?.data ? JSON.parse(row.data) : {};
    const raw = data.foreshadows;
    const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? JSON.parse(raw) : [];
    foreshadows = arr.filter((f: any) => f && typeof f.id === "string");
  } catch {
    foreshadows = [];
  }
  return foreshadows;
}

/**
 * 同步大纲 markdown → o_volume/o_chapter_plan/o_foreshadow（幂等 upsert）。
 * - 卷/章卡按唯一键 upsert；解析集中不存在的章卡若 status=done（已写正文）保留，否则删除
 * - 伏笔以工作区 foreshadows 为准（结构化标签/降级解析先行），为空时从大纲散文行兜底解析
 * - 性能（批次B）：四类均改批量 onConflict().merge() upsert + whereIn/whereNotIn 批量删除，
 *   原逐条 select+update/insert（300 章 ≈ 800 次串行查询）降到 ~13 次 DB 往返
 */
export async function syncOutlineStructure(projectId: number, outline: string): Promise<{ volumes: number; arcs: number; plans: number; foreshadows: number }> {
  const { volumes, arcs, plans } = parseOutlineStructure(outline);
  const now = Date.now();

  // ── 卷批量 upsert（唯一键 projectId+volumeIndex）──
  const volIdByIndex = new Map<number, number>();
  const existingVols = (await u.db("o_volume").where({ projectId }).select("id", "volumeIndex")) as Array<{ id: number; volumeIndex: number }>;
  for (const v of existingVols) volIdByIndex.set(v.volumeIndex, v.id);
  if (volumes.length) {
    const volRows = volumes.map((v) => {
      const id = volIdByIndex.get(v.volumeIndex) ?? nextIntId();
      if (!volIdByIndex.has(v.volumeIndex)) volIdByIndex.set(v.volumeIndex, id);
      return {
        id,
        projectId,
        volumeIndex: v.volumeIndex,
        title: v.title,
        summary: v.summary,
        mainline: v.mainline ?? "",
        stageLabel: v.stageLabel ?? "",
        conflictScale: v.conflictScale ?? "",
        oneLineSummary: v.oneLineSummary ?? "",
        stories: JSON.stringify(v.stories ?? []),
        plannedChapters: v.endChapter > 0 ? v.endChapter - v.startChapter + 1 : plans.length,
        status: "planning",
        createTime: now,
        updateTime: now,
      };
    });
    await u.db("o_volume").insert(volRows).onConflict(["projectId", "volumeIndex"]).merge([
      "title", "summary", "mainline", "stageLabel", "conflictScale", "oneLineSummary", "stories", "plannedChapters", "updateTime",
    ]);
  }

  // ── 事件段：预载 id → 批量 upsert + 批量清理（唯一键 projectId+volumeId+arcIndex）──
  const parsedArcs = arcs.filter((a) => volIdByIndex.has(a.volumeIndex));
  const existingArcs = (await u.db("o_chapter_arc").where({ projectId }).select("id", "volumeId", "arcIndex")) as Array<{ id: number; volumeId: number; arcIndex: number }>;
  const arcIdByKey = new Map<string, number>();
  for (const ea of existingArcs) arcIdByKey.set(`${ea.volumeId}:${ea.arcIndex}`, ea.id);
  const parsedArcKeys = new Set(parsedArcs.map((a) => `${volIdByIndex.get(a.volumeIndex)}:${a.arcIndex}`));
  // 解析缺失的段删除（章卡 arcId 同步清空）
  const staleArcs = existingArcs.filter((ea) => !parsedArcKeys.has(`${ea.volumeId}:${ea.arcIndex}`));
  if (staleArcs.length) {
    await u.db("o_chapter_plan").whereIn("arcId", staleArcs.map((a) => a.id)).update({ arcId: null });
    await u.db("o_chapter_arc").whereIn("id", staleArcs.map((a) => a.id)).del();
  }
  if (parsedArcs.length) {
    const arcRows = parsedArcs.map((a) => {
      const volumeId = volIdByIndex.get(a.volumeIndex)!;
      const key = `${volumeId}:${a.arcIndex}`;
      const id = arcIdByKey.get(key) ?? nextIntId();
      if (!arcIdByKey.has(key)) arcIdByKey.set(key, id);
      return {
        id,
        projectId,
        volumeId,
        arcIndex: a.arcIndex,
        title: a.title,
        startChapter: a.startChapter,
        endChapter: a.endChapter,
        contribution: a.contribution,
        createTime: now,
        updateTime: now,
      };
    });
    await u.db("o_chapter_arc").insert(arcRows).onConflict(["projectId", "volumeId", "arcIndex"]).merge(["title", "startChapter", "endChapter", "contribution", "updateTime"]);
  }

  // ── 章卡：预载 id → 批量 upsert + 批量清理（唯一键 projectId+chapterIndex）──
  const existingPlans = (await u.db("o_chapter_plan").where({ projectId }).select("id", "chapterIndex", "status")) as Array<{
    id: number;
    chapterIndex: number;
    status: string;
  }>;
  const planIdByIndex = new Map<number, { id: number; status: string }>();
  for (const p of existingPlans) planIdByIndex.set(p.chapterIndex, { id: p.id, status: p.status });
  const parsedIndexes = new Set(plans.map((p) => p.chapterIndex));
  // 解析集中不存在的章卡：已写正文的保留（元数据不丢），未写的删除（用户手动改大纲删章）
  const stalePlans = existingPlans.filter((p) => !parsedIndexes.has(p.chapterIndex) && p.status !== "done");
  if (stalePlans.length) await u.db("o_chapter_plan").whereIn("id", stalePlans.map((p) => p.id)).del();
  if (plans.length) {
    const planRows = plans.map((p) => {
      const volumeId = volIdByIndex.get(volumeOf(volumes, p.chapterIndex)) ?? volIdByIndex.get(1) ?? 0;
      // 归段：同卷内章范围命中的事件段（无命中 → null=未分段）
      const hitArc = parsedArcs.find(
        (a) => a.volumeIndex === volumeOf(volumes, p.chapterIndex) && a.startChapter <= p.chapterIndex && p.chapterIndex <= a.endChapter,
      );
      const arcId = hitArc ? (arcIdByKey.get(`${volIdByIndex.get(hitArc.volumeIndex)}:${hitArc.arcIndex}`) ?? null) : null;
      return {
        id: planIdByIndex.get(p.chapterIndex)?.id ?? nextIntId(),
        projectId,
        chapterIndex: p.chapterIndex,
        volumeId,
        arcId,
        title: p.title,
        summary: p.summary,
        hooks: JSON.stringify(p.hooks),
        coolPoints: JSON.stringify(p.coolPoints),
        foreshadowRefs: JSON.stringify(p.foreshadowRefs),
        wordTarget: p.wordTarget ?? 0,
        sortOrder: p.chapterIndex,
        status: "planned",
        createTime: now,
        updateTime: now,
      };
    });
    await u.db("o_chapter_plan").insert(planRows).onConflict(["projectId", "chapterIndex"]).merge([
      "volumeId", "arcId", "title", "summary", "hooks", "coolPoints", "foreshadowRefs", "wordTarget", "sortOrder", "updateTime",
    ]);
  }

  // ── 伏笔：批量 upsert + 批量清理（唯一键 projectId+fsKey；工作区结构化清单为准）──
  let foreshadows = await readWorkForeshadows(projectId);
  if (!foreshadows.length) foreshadows = parseOutlineForeshadows(outline) as typeof foreshadows;
  const existingFs = (await u.db("o_foreshadow").where({ projectId }).select("id", "fsKey")) as Array<{ id: number; fsKey: string }>;
  const fsIdByKey = new Map(existingFs.map((f) => [f.fsKey, f.id]));
  const fsKeys = new Set(foreshadows.map((f) => f.id));
  if (foreshadows.length) {
    const fsRows = foreshadows.map((f) => ({
      id: fsIdByKey.get(f.id) ?? nextIntId(),
      projectId,
      fsKey: f.id,
      description: f.description ?? "",
      plantedChapterIndex: Number(f.plantedAt) || 0,
      plannedResolveChapterIndex: Number(f.plannedResolve) || 0,
      resolvedChapterIndex: f.status === "resolved" && f.resolvedAt != null ? Number(f.resolvedAt) : null,
      status: f.status ?? "planted",
      source: "outline",
      createTime: now,
      updateTime: now,
    }));
    await u.db("o_foreshadow").insert(fsRows).onConflict(["projectId", "fsKey"]).merge([
      "description", "plantedChapterIndex", "plannedResolveChapterIndex", "resolvedChapterIndex", "status", "updateTime",
    ]);
  }
  // 工作区已删除的伏笔：表内同步删除（全部跟随工作区删除，保持单一真相）
  const staleFs = existingFs.filter((f) => !fsKeys.has(f.fsKey));
  if (staleFs.length) await u.db("o_foreshadow").whereIn("id", staleFs.map((f) => f.id)).del();

  return { volumes: volumes.length, arcs: parsedArcs.length, plans: plans.length, foreshadows: foreshadows.length };
}

/** 读结构化大纲（前端章卡视图 / 章节预加载 / 检查报告用） */
export async function getOutlineStructure(projectId: number): Promise<OutlineStructure> {
  const volumes = (await u.db("o_volume").where({ projectId }).orderBy("volumeIndex", "asc").select("*")) as any[];
  const arcs = (await u.db("o_chapter_arc").where({ projectId }).orderBy("volumeId", "asc").orderBy("startChapter", "asc").orderBy("arcIndex", "asc").select("*")) as any[];
  const plans = (await u.db("o_chapter_plan").where({ projectId }).orderBy("chapterIndex", "asc").select("*")) as any[];
  const foreshadows = (await u.db("o_foreshadow").where({ projectId }).orderBy("fsKey", "asc").select("*")) as any[];
  const parseArr = (v: unknown): string[] => {
    if (Array.isArray(v)) return v;
    if (typeof v === "string") {
      try {
        const p = JSON.parse(v);
        return Array.isArray(p) ? p : [];
      } catch {
        return [];
      }
    }
    return [];
  };
  return {
    volumes: volumes.map((v) => ({
      id: v.id,
      volumeIndex: v.volumeIndex,
      title: v.title ?? "",
      summary: v.summary ?? "",
      mainline: v.mainline ?? "",
      stageLabel: v.stageLabel ?? "",
      conflictScale: v.conflictScale ?? "",
      oneLineSummary: v.oneLineSummary ?? "",
      stories: parseArr(v.stories),
      status: v.status ?? "planning",
      plannedChapters: v.plannedChapters ?? 0,
      startChapter: 0,
      endChapter: 0,
    })),
    arcs: arcs.map((a) => ({
      id: a.id,
      volumeId: a.volumeId ?? 0,
      volumeIndex: volumes.find((v) => v.id === a.volumeId)?.volumeIndex ?? 0,
      arcIndex: a.arcIndex ?? 0,
      title: a.title ?? "",
      startChapter: a.startChapter ?? 0,
      endChapter: a.endChapter ?? 0,
      contribution: a.contribution ?? "",
    })),
    plans: plans.map((p) => ({
      id: p.id,
      volumeId: p.volumeId ?? 0,
      arcId: p.arcId ?? null,
      chapterIndex: p.chapterIndex,
      title: p.title ?? "",
      summary: p.summary ?? "",
      hooks: parseArr(p.hooks),
      coolPoints: parseArr(p.coolPoints),
      foreshadowRefs: parseArr(p.foreshadowRefs),
      wordTarget: p.wordTarget ?? 0,
      status: p.status ?? "planned",
      bookmarked: !!p.bookmarked,
      sortOrder: p.sortOrder ?? p.chapterIndex,
    })),
    foreshadows: foreshadows.map((f) => ({
      id: f.id,
      fsKey: f.fsKey,
      description: f.description ?? "",
      plantedChapterIndex: f.plantedChapterIndex ?? 0,
      plannedResolveChapterIndex: f.plannedResolveChapterIndex ?? 0,
      resolvedChapterIndex: f.resolvedChapterIndex ?? null,
      status: f.status ?? "planted",
      source: f.source ?? "outline",
    })),
  };
}

/**
 * 章节写完后标记章卡 done + 回填 o_novel.volumeId（xmlConsume 章节落库后调用）。
 * 顺带做「卷写完」检测：该章是其卷内最后一张规划章卡且下一卷不存在 → 返回 volumeDone 事件数据。
 */
export async function markChapterWritten(
  projectId: number,
  chapterIndex: number,
  novelId?: number,
): Promise<{ volumeDone?: { volumeIndex: number; nextVolumeIndex: number } }> {
  const plan = (await u.db("o_chapter_plan").where({ projectId, chapterIndex }).first()) as any;
  if (!plan) return {};
  await u.db("o_chapter_plan").where({ id: plan.id }).update({ status: "done", updateTime: Date.now() });
  if (novelId != null) {
    await u.db("o_novel").where({ id: novelId }).update({ volumeId: plan.volumeId });
  }
  // 卷状态推进：卷内全部章卡 done → 卷置 done；部分写 → writing
  const volumeId = plan.volumeId;
  if (volumeId) {
    const siblings = (await u.db("o_chapter_plan").where({ projectId, volumeId }).select("status")) as Array<{ status: string }>;
    const allDone = siblings.length > 0 && siblings.every((s) => s.status === "done");
    const anyDone = siblings.some((s) => s.status === "done");
    await u.db("o_volume").where({ id: volumeId }).update({ status: allDone ? "done" : anyDone ? "writing" : "planning", updateTime: Date.now() });
    if (allDone) {
      const vol = (await u.db("o_volume").where({ id: volumeId }).first()) as any;
      const nextVolumeIndex = (vol?.volumeIndex ?? 0) + 1;
      const nextVol = (await u.db("o_volume").where({ projectId, volumeIndex: nextVolumeIndex }).first()) as any;
      const nextHasPlans = nextVol
        ? !!(await u.db("o_chapter_plan").where({ projectId, volumeId: nextVol.id }).first())
        : false;
      if (!nextHasPlans) return { volumeDone: { volumeIndex: vol?.volumeIndex ?? 0, nextVolumeIndex } };
    }
  }
  return {};
}

/**
 * 章节写完的轻量标记（批量路径用，性能 B7）：只置章卡 done + 回填 o_novel.volumeId，
 * 不做逐章卷状态级联查询（省 4-7 次/章 DB 往返）；卷状态由调用方循环后统一 recomputeVolumeStatus 重算。
 * @returns 所属卷 id（null=无章卡/无卷，供批量重算收集）
 */
export async function markChapterWrittenLight(projectId: number, chapterIndex: number, novelId?: number): Promise<number | null> {
  const plan = (await u.db("o_chapter_plan").where({ projectId, chapterIndex }).first()) as any;
  if (!plan) return null;
  await u.db("o_chapter_plan").where({ id: plan.id }).update({ status: "done", updateTime: Date.now() });
  if (novelId != null && plan.volumeId != null) {
    await u.db("o_novel").where({ id: novelId }).update({ volumeId: plan.volumeId });
  }
  return plan.volumeId ?? null;
}

/**
 * 卷状态统一重算（批量路径，性能 B7）：读指定卷的全部章卡 status → 卷置 done/writing/planning；
 * 检测「卷写完」事件（全部章卡 done 且下一卷无规划章卡）。
 * @returns 卷写完事件列表（调用方经工作区标志中转 emit）
 */
export async function recomputeVolumeStatus(
  projectId: number,
  volumeIds: number[],
): Promise<Array<{ volumeIndex: number; nextVolumeIndex: number }>> {
  if (!volumeIds.length) return [];
  const volumes = (await u.db("o_volume").whereIn("id", volumeIds).select("id", "volumeIndex")) as Array<{ id: number; volumeIndex: number }>;
  const plans = (await u.db("o_chapter_plan").where({ projectId }).whereIn("volumeId", volumeIds).select("volumeId", "status")) as Array<{
    volumeId: number;
    status: string;
  }>;
  const done: Array<{ volumeIndex: number; nextVolumeIndex: number }> = [];
  for (const vol of volumes) {
    const siblings = plans.filter((p) => p.volumeId === vol.id);
    const allDone = siblings.length > 0 && siblings.every((s) => s.status === "done");
    const anyDone = siblings.some((s) => s.status === "done");
    await u.db("o_volume").where({ id: vol.id }).update({ status: allDone ? "done" : anyDone ? "writing" : "planning", updateTime: Date.now() });
    if (allDone) {
      const nextVolumeIndex = (vol.volumeIndex ?? 0) + 1;
      const nextVol = (await u.db("o_volume").where({ projectId, volumeIndex: nextVolumeIndex }).first()) as any;
      const nextHasPlans = nextVol ? !!(await u.db("o_chapter_plan").where({ projectId, volumeId: nextVol.id }).first()) : false;
      if (!nextHasPlans) done.push({ volumeIndex: vol.volumeIndex ?? 0, nextVolumeIndex });
    }
  }
  return done;
}
export async function renumberChapterPlans(projectId: number): Promise<Array<{ from: number; to: number }>> {
  const plans = (await u.db("o_chapter_plan").where({ projectId }).orderBy("sortOrder", "asc").select("id", "chapterIndex", "status", "sortOrder")) as any[];
  const movable = plans.filter((p) => p.status !== "done");
  const fixed = new Map<number, number>(plans.filter((p) => p.status === "done").map((p) => [p.chapterIndex, p.id]));
  // 可用号位 = 1..N 中被 done 占用之外的号位（保持 done 原号不动）
  const total = plans.length;
  const takenByDone = new Set(fixed.keys());
  const freeSlots: number[] = [];
  for (let n = 1; n <= total; n++) {
    if (!takenByDone.has(n)) freeSlots.push(n);
  }
  const moves: Array<{ from: number; to: number }> = [];
  if (freeSlots.length !== movable.length) return moves; // 号位不足（异常态不动）
  // 两阶段搬移：先全部腾号（from+OFFSET），再统一落位——直接改号在搬移中途会撞
  // (projectId, chapterIndex) 唯一约束（例：顺序 [1,3,2] 时把 3→2，2 还没挪走即冲突）
  const OFFSET = 1000000;
  const renumber: Array<{ id: number; to: number }> = [];
  for (let i = 0; i < movable.length; i++) {
    const to = freeSlots[i];
    if (movable[i].chapterIndex !== to) {
      moves.push({ from: movable[i].chapterIndex, to });
      renumber.push({ id: movable[i].id, to });
      await u.db("o_chapter_plan").where({ id: movable[i].id }).update({ chapterIndex: movable[i].chapterIndex + OFFSET });
    }
  }
  if (renumber.length) {
    for (const r of renumber) {
      await u.db("o_chapter_plan").where({ id: r.id }).update({ chapterIndex: r.to, sortOrder: r.to, updateTime: Date.now() });
    }
  }
  if (moves.length) await reassignPlanArcs(projectId); // 章号变了 → 按事件段范围重算归段
  return moves;
}

/** 按事件段章范围重算全部章卡归段（重排/手动改范围后；范围外 → null 未分段） */
export async function reassignPlanArcs(projectId: number): Promise<void> {
  const arcs = (await u.db("o_chapter_arc").where({ projectId }).select("id", "volumeId", "startChapter", "endChapter")) as Array<{
    id: number; volumeId: number; startChapter: number; endChapter: number;
  }>;
  const plans = (await u.db("o_chapter_plan").where({ projectId }).select("id", "volumeId", "chapterIndex", "arcId")) as any[];
  for (const p of plans) {
    const hit = arcs.find((a) => a.volumeId === p.volumeId && a.startChapter <= p.chapterIndex && p.chapterIndex <= a.endChapter);
    const nextArcId = hit?.id ?? null;
    if (p.arcId !== nextArcId) {
      await u.db("o_chapter_plan").where({ id: p.id }).update({ arcId: nextArcId, updateTime: Date.now() });
    }
  }
}

/** 启动/打开项目时懒补：outline 已有但章卡缺失/不全（存量项目迁移入口，幂等） */
export async function lazyBackfillOutlineStructure(projectId: number): Promise<boolean> {
  const row = await u.db("o_agentWorkData").where({ projectId, key: "novelAgent" }).first();
  if (!row?.data) return false;
  let outline = "";
  try {
    outline = JSON.parse(row.data)?.outline ?? "";
  } catch {
    return false;
  }
  if (!outline.trim()) return false;
  // 缺口判定：章卡或事件段缺失才补（表空=首次迁移；不全=解析器升级前的旧迁移；
  // 库内多于大纲=用户手动加过章卡/段，不回退删除）
  const { plans, arcs } = parseOutlineStructure(outline);
  const count = await u.db("o_chapter_plan").where({ projectId }).count("* as c").first();
  const arcCount = await u.db("o_chapter_arc").where({ projectId }).count("* as c").first();
  if (Number((count as any)?.c ?? 0) >= plans.length && Number((arcCount as any)?.c ?? 0) >= arcs.length) return false;
  await syncOutlineStructure(projectId, outline);
  return true;
}

/**
 * 删章回滚（markChapterWritten 的逆操作）：章节正文已删除时，对应章卡 done→planned，
 * 并重算所属卷状态（全卷 done 才 done；部分 done → writing；否则 planning）。
 * 非 done 章卡不动（删章不影响其状态）；幂等。
 */
export async function markChapterUnwritten(projectId: number, chapterIndex: number): Promise<boolean> {
  const plan = (await u.db("o_chapter_plan").where({ projectId, chapterIndex }).first()) as { id: number; volumeId: number | null; status: string } | undefined;
  if (!plan || plan.status !== "done") return false;
  await u.db("o_chapter_plan").where({ id: plan.id }).update({ status: "planned", updateTime: Date.now() });
  if (plan.volumeId) {
    const siblings = (await u.db("o_chapter_plan").where({ projectId, volumeId: plan.volumeId }).select("status")) as Array<{ status: string }>;
    const allDone = siblings.length > 0 && siblings.every((s) => s.status === "done");
    const anyDone = siblings.some((s) => s.status === "done");
    await u.db("o_volume").where({ id: plan.volumeId }).update({ status: allDone ? "done" : anyDone ? "writing" : "planning", updateTime: Date.now() });
  }
  return true;
}

/**
 * 章卡状态懒修复：o_novel 已有正文的章节，章卡仍 planning（存量项目章节先于章卡体系产生）→ 补 done。
 * 复用 markChapterWritten（顺带回填 o_novel.volumeId + 卷状态推进）。幂等：已 done 不动。
 */
export async function lazyHealPlanStatus(projectId: number): Promise<number> {  const novels = (await u.db("o_novel").where({ projectId }).select("id", "chapterIndex")) as Array<{ id: number; chapterIndex: number }>;
  let healed = 0;
  for (const nv of novels) {
    const plan = (await u.db("o_chapter_plan").where({ projectId, chapterIndex: nv.chapterIndex }).first()) as any;
    if (plan && plan.status !== "done") {
      await markChapterWritten(projectId, nv.chapterIndex, nv.id);
      healed++;
    }
  }
  return healed;
}

/**
 * 结构 → 大纲 markdown（章卡手动增删改/拖拽后重渲染工作区 outline 缓存，保持两视图一致）。
 * 渲染为规范形态（全书结构=卷表格 + 逐章 `## 第N章 · 标题`），结构是 SSOT，缓存可随时重建。
 */
export function renderOutlineMarkdown(structure: OutlineStructure): string {
  const parts: string[] = [];
  if (structure.volumes.length) {
    const lines: string[] = ["| 卷 | 章节范围 | 卷名/概要 |", "| --- | --- | --- |"];
    for (const v of structure.volumes) {
      const ps = structure.plans.filter((p) => p.volumeId === v.id);
      const start = ps.length ? Math.min(...ps.map((p) => p.chapterIndex)) : 0;
      const end = ps.length ? Math.max(...ps.map((p) => p.chapterIndex)) : 0;
      lines.push(`| 第${v.volumeIndex}卷 | ${start ? `${start}-${end}` : "-"} | ${v.title}${v.summary ? `：${v.summary}` : ""} |`);
    }
    for (const v of structure.volumes) {
      // 卷头 + 事件段（有内容才渲染；格式与 parseVolumeHeads/parseArcs 对齐保证回解析）
      const headParts: string[] = [];
      if (v.oneLineSummary) headParts.push(`一句话概括=${v.oneLineSummary}`);
      if (v.mainline) headParts.push(`主线句=${v.mainline}`);
      if (v.stageLabel) headParts.push(`阶段=${v.stageLabel}`);
      if (v.conflictScale) headParts.push(`冲突尺度=${v.conflictScale}`);
      if (Array.isArray(v.stories) && v.stories.length) {
        for (let i = 0; i < v.stories.length; i++) headParts.push(`故事${i + 1}=${v.stories[i]}`);
      }
      if (headParts.length) lines.push(``, `第${v.volumeIndex}卷 · 卷头：${headParts.join("；")}`);
      const volArcs = structure.arcs.filter((a) => a.volumeId === v.id).sort((a, b) => a.arcIndex - b.arcIndex);
      if (volArcs.length) {
        lines.push(``, `第${v.volumeIndex}卷 · 事件段：`, "| 段 | 章范围 | 事件名 | 战略贡献 |", "| --- | --- | --- | --- |");
        for (const a of volArcs) lines.push(`| ${a.arcIndex} | ch${a.startChapter}~${a.endChapter} | ${a.title} | ${a.contribution} |`);
      }
    }
    parts.push(`## 全书结构\n${lines.join("\n")}`);
  }
  for (const p of structure.plans) {
    parts.push(`## 第${p.chapterIndex}章${p.title ? ` · ${p.title}` : ""}\n${p.summary}`);
  }
  return parts.join("\n\n");
}

/** 手动结构变更后重渲染工作区 outline 缓存（renderOutlineMarkdown 的 DB 落库包装） */
export async function refreshOutlineCache(projectId: number): Promise<string> {
  const structure = await getOutlineStructure(projectId);
  const md = renderOutlineMarkdown(structure);
  const row = await u.db("o_agentWorkData").where({ projectId, key: "novelAgent" }).first();
  if (row) {
    let data: Record<string, unknown> = {};
    try {
      data = row.data ? JSON.parse(row.data) : {};
    } catch {
      data = {};
    }
    data.outline = md;
    await u.db("o_agentWorkData").where({ id: row.id }).update({ data: JSON.stringify(data) });
  }
  return md;
}

/** 事件段上下文行（写章注入：段名 + 战略贡献 + 段内第 x/y 章；纯函数可单测） */
export function arcContextOf(
  arc: { title: string; contribution?: string | null },
  arcPlans: Array<{ chapterIndex: number }>,
  chapterNo: number,
): string {
  const pos = arcPlans.findIndex((p) => p.chapterIndex === chapterNo) + 1;
  const seg = arcPlans.length ? `（本章为段内第 ${pos}/${arcPlans.length} 章）` : "";
  return `所属事件段：${arc.title}${seg}\n段战略贡献（本章应服务于此）：${arc.contribution || "（未填）"}`;
}

/**
 * 长篇大纲窗口截断（多卷/30 章以上防章节 Agent prompt 膨胀）：
 * 保留 全书结构 section（卷索引/卷头/事件段表/伏笔清单，属创作约束必须全量）+ 目标章前后窗口内的逐章 section；
 * 被省略的连续章节段合并为一行省略标记。章节总数 ≤ 窗口大小时全量返回（不截断）。
 */
export function buildOutlineWindow(outline: string, chapterNo: number, before = 3, after = 7): string {
  if (!outline.trim()) return outline;
  const sections = splitSections(outline);
  const numbered = sections.filter((s) => s.chapterIndex != null);
  if (!numbered.length || numbered.length <= before + after + 1) return outline; // 短大纲全量，免截断
  const keep = new Set<number>();
  for (const s of numbered) {
    if (s.chapterIndex != null && s.chapterIndex >= chapterNo - before && s.chapterIndex <= chapterNo + after) keep.add(s.chapterIndex);
  }
  const parts: string[] = [];
  let skipped = false; // 连续省略段只插一次标记
  for (const s of sections) {
    if (s.isStructure) {
      parts.push(`## 全书结构\n${s.content.trim()}`);
      continue;
    }
    if (s.chapterIndex == null || keep.has(s.chapterIndex)) {
      parts.push(`## ${s.heading}\n${s.content.trim()}`);
      skipped = false;
      continue;
    }
    if (!skipped) {
      parts.push(`> ……第 ${s.chapterIndex} 章起的大纲已省略（长篇窗口截断，完整大纲见工作区/章卡视图）`);
      skipped = true;
    }
  }
  return parts.join("\n\n");
}

// ── 卷完成事件（写完一卷 → 前端提示「细化下一卷」；xmlConsume 落库时无 socket，经工作区标志中转） ──

export interface VolumeDoneEvent {
  volumeIndex: number;
  nextVolumeIndex: number;
}

async function readWorkDataRaw(projectId: number): Promise<{ row: any; data: Record<string, any> }> {
  const row = await u.db("o_agentWorkData").where({ projectId, key: "novelAgent" }).first();
  let data: Record<string, any> = {};
  try {
    data = row?.data ? JSON.parse(row.data) : {};
  } catch {
    data = {};
  }
  return { row, data };
}

/** xmlConsume 章节落库后写入「卷已写完」标志（有 socket 的调用方随后 consume 并 emit） */
export async function notePendingVolumeDone(projectId: number, event: VolumeDoneEvent): Promise<void> {
  const { row, data } = await readWorkDataRaw(projectId);
  data.pendingVolumeDone = event;
  const serialized = JSON.stringify(data);
  if (row) await u.db("o_agentWorkData").where({ id: row.id }).update({ data: serialized });
  else await u.db("o_agentWorkData").insert({ id: nextIntId(), projectId, key: "novelAgent", data: serialized });
}

/** 有 socket 的路径（runWorkflow/stageGenerate）取走待发卷完成事件并 emit（幂等：取走即清） */
export async function consumePendingVolumeDone(
  socket: { emit: (event: string, payload: unknown) => void },
  projectId: number,
): Promise<VolumeDoneEvent | null> {
  const { row, data } = await readWorkDataRaw(projectId);
  if (!row || !data.pendingVolumeDone) return null;
  const event = data.pendingVolumeDone as VolumeDoneEvent;
  delete data.pendingVolumeDone;
  await u.db("o_agentWorkData").where({ id: row.id }).update({ data: JSON.stringify(data) });
  try {
    socket.emit("volumeDone", event);
  } catch {
    /* emit 失败忽略（事件可丢失，前端 OutlinePanel 有手动「细化下一卷」入口兜底） */
  }
  return event;
}
