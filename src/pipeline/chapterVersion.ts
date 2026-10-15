import u from "@/utils";

/**
 * 章节版本快照（P1-2 交付闭环：版本管理与回滚）。
 *
 * 语义：每次章节「重新生成/监督返工/手动编辑」覆盖旧正文前，把**旧版** chapterData 存快照，
 * 供前端「历史版本」查看/回滚。覆盖点收敛：xmlConsume.ts（消费主路径）、setPlanData.ts（前端保存）、
 * novelAgent/index.ts（监督返工）。
 *
 * 设计约束：
 * - 快照失败不阻断落库（降级：跟随现有降级风格，只 console.warn）
 * - version 按 novelId 递增（同章多版本，第 N 版即第 N 次覆盖前的旧稿）
 * - source 标识覆盖来源：regen=重新生成 / supervision=监督返工 / manual=手动编辑
 */

export type ChapterSnapshotSource = "regen" | "supervision" | "manual" | "deleted" | "aiEdit" | "rejected" | "crash";

export interface ChapterSnapshotInput {
  projectId: number;
  novelId: number;
  chapterIndex: number;
  chapter: string;
  /** 旧版正文（覆盖前的内容） */
  chapterData: string;
  source: ChapterSnapshotSource;
}

/** 章节覆盖前存快照；成功返回版本号，失败返回 null（不阻断主流程） */
export async function snapshotChapter(input: ChapterSnapshotInput): Promise<number | null> {
  try {
    const maxRow = await u.db("o_chapter_version").where("novelId", input.novelId).max("version as max").first();
    const version = (Number((maxRow as { max?: unknown })?.max) || 0) + 1;
    const id = (Date.now() % 2000000000) + Math.floor(Math.random() * 1000);
    await u.db("o_chapter_version").insert({
      id,
      projectId: input.projectId,
      novelId: input.novelId,
      chapterIndex: input.chapterIndex,
      chapter: input.chapter,
      chapterData: input.chapterData,
      source: input.source,
      version,
      createTime: Date.now(),
    });
    return version;
  } catch (e) {
    console.warn(`[chapterVersion] 快照写入失败（不阻断）: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * 半截稿流式 checkpoint（HP2 · harness「撕尾抢救」按 qiflow 成本结构的反向改造）：
 * 章稿落库窗口=整章含全部返工循环（最坏 30 分钟级），崩溃即纯内存丢失——生成流中途
 * 周期性把半截稿快照到 o_chapter_version（source=crash，novelId=0 与真章版本序列隔离）。
 * 覆盖语义：同 (projectId, chapterIndex) 只留最新一条 crash 快照（先删后插），防 30 分钟
 * 生成写爆版本表。失败静默（留痕通道纪律）。
 */
export async function checkpointChapterDraft(input: { projectId: number; chapterIndex: number; chapter: string; content: string }): Promise<void> {
  try {
    if (Array.from(input.content ?? "").length < 200) return; // 过短不值得快照
    await u.db("o_chapter_version").where({ projectId: input.projectId, novelId: 0, chapterIndex: input.chapterIndex, source: "crash" }).del();
    await snapshotChapter({
      projectId: input.projectId,
      novelId: 0,
      chapterIndex: input.chapterIndex,
      chapter: input.chapter,
      chapterData: input.content,
      source: "crash",
    });
  } catch (e) {
    console.warn(`[chapterVersion] 半截稿 checkpoint 失败（不阻断）: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 清除章的半截稿 checkpoint：正常落库/拒收终态时调用（防残留被误读为未完成稿） */
export async function clearChapterCheckpoints(projectId: number, chapterIndex: number): Promise<void> {
  try {
    await u.db("o_chapter_version").where({ projectId, novelId: 0, chapterIndex, source: "crash" }).del();
  } catch {
    /* 清理失败无害（下次 checkpoint 覆盖） */
  }
}
