/**
 * 大纲伏笔清单降级解析（伏笔结构化采集；`<foreshadows>` 标签缺失时的兜底路径，已实现）。
 *
 * 背景：大纲提示词已约定输出 `<foreshadows>` 结构化标签（xmlConsume 消费），
 * 但旧版大纲/漏输标签时伏笔只以散文行存在（如 `- FS-01-001 物件：旧帆布包死扣（师父遗物）埋ch1 回收ch10（…）`）。
 * 本函数从大纲文本解析这些行 → 结构化 foreshadows，供速查面板/逾期检查/监督核查使用。
 *
 * 支持格式：
 * - `- FS-01-001 描述 埋ch1 回收ch10`
 * - `- FS-01-001 描述 埋设ch1 回收ch6（说明）`
 * - 回收可 `跨部`（无数字）
 */

export interface ParsedForeshadow {
  id: string;
  description: string;
  plantedAt: number;
  plannedResolve: number;
  status: "planted";
}

const LINE_RE = /^(FS-[\w-]+)\s+(.+?)\s*(?:埋设|埋)(?:ch)?([\d~]+)(?:\s*(?:回收|收)(?:ch)?([\d~]+|跨部))?/i;

/** 从大纲 markdown 提取伏笔行并解析（幂等：同 id 去重；无匹配返回空数组） */
export function parseOutlineForeshadows(outline: string | null | undefined): ParsedForeshadow[] {
  if (!outline) return [];
  const result: ParsedForeshadow[] = [];
  const seen = new Set<string>();
  for (const line of outline.split("\n")) {
    const raw = line.replace(/^[-*\s]+/, "").trim();
    const m = raw.match(LINE_RE);
    if (!m) continue;
    const id = m[1];
    if (seen.has(id)) continue; // 同 id 只取第一条（幂等）
    seen.add(id);
    // 描述清理：去「类型：」前缀（物件：/言行：/设定：/事件：…）
    let desc = m[2].trim().replace(/^[^：]+：/, "");
    // 去掉 desc 尾部残留的括号说明（如「（师父遗物）」保留在 desc 内属正常，不去）
    const plantedAt = Number(m[3].replace(/~.*$/, "")) || 0;
    const resolveRaw = m[4];
    const plannedResolve = resolveRaw && /^\d+$/.test(resolveRaw) ? Number(resolveRaw) : 0; // 跨部/未知 → 0（不参与逾期判断）
    if (desc.length > 120) desc = desc.slice(0, 120);
    result.push({ id, description: desc, plantedAt, plannedResolve, status: "planted" });
  }
  return result;
}
