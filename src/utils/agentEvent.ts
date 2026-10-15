import u from "@/utils";
import appendJsonLine from "@/utils/jsonl";

/**
 * 生成事件流统一入口（HP1 · app/docs/event-stream-schema.md v1）：
 * 事件双写 o_chatHistory（role="event"）+ JSONL 旁路（data/logs/agent-event.jsonl）。
 * 纪律：fire-and-forget，失败只告警不阻断主链路；payload 只放摘要/指针/哈希，
 * 大文本一律存 o_chapter_version 由事件放指针。
 */

export const AGENT_EVENT_VERSION = 1;
export const AGENT_EVENT_TYPES = [
  "generation_begin",
  "generation_end",
  "tool_call",
  "tool_result",
  "workdata_write",
  "chapter_checkpoint",
  "confirm_wait",
  "confirm_resolve",
  "attempt_abort",
  "chapter_write_suspect",
] as const;
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

/** 追加一条生成事件（同步返回，内部异步落库；任何失败静默） */
export function appendAgentEvent(entry: {
  projectId: number;
  agentKey: string;
  eventType: AgentEventType;
  payload?: Record<string, unknown>;
}): void {
  try {
    u.db("o_chatHistory")
      .insert({
        id: u.uuid(),
        projectId: entry.projectId,
        agentKey: entry.agentKey,
        role: "event",
        name: null,
        content: "",
        stageKey: null,
        eventType: entry.eventType,
        payload: JSON.stringify(entry.payload ?? {}),
        version: AGENT_EVENT_VERSION,
        createTime: Date.now(),
      } as any)
      .catch((e: unknown) => console.warn(`[agentEvent] 入库失败（不阻断）: ${e instanceof Error ? e.message : String(e)}`));
    appendJsonLine("agent-event.jsonl", { src: entry.agentKey, level: "info", msg: entry.eventType, projectId: entry.projectId, ...entry.payload });
  } catch (e) {
    console.warn(`[agentEvent] 事件构造失败（不阻断）: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 内容摘要指纹（HP3 留痕口径：hash 前 12 位 + 长度，防全量文本进 trace/payload） */
export function contentFingerprint(text: unknown): { hash: string; len: number } {
  const s = typeof text === "string" ? text : text == null ? "" : JSON.stringify(text);
  // djb2（不引 crypto，纯同步轻量；指纹用途非安全）
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return { hash: (h >>> 0).toString(16).padStart(8, "0").slice(0, 12), len: s.length };
}
