import db from "@/utils/db";
import { redis, redisReady } from "./redis";

/**
 * 通用缓存抽象：Redis 可用走 Redis（多实例共享），不可用降级进程内存（Map+TTL）。
 * 降级窗口内的不一致性由各调用点的 TTL 兜底（见 cacheThrough 调用处注释）。
 * 语义约定：cacheGet 返回 undefined = miss；null 是合法缓存值（如"库中无此配置"）。
 */

const MEM_MAX_KEYS = 2000;
const mem = new Map<string, { value: string; expireAt: number }>();

function memGet(key: string): string | null {
  const hit = mem.get(key);
  if (!hit) return null;
  if (hit.expireAt <= Date.now()) {
    mem.delete(key);
    return null;
  }
  return hit.value;
}

function memSet(key: string, value: string, ttlMs: number): void {
  if (mem.size >= MEM_MAX_KEYS) {
    const now = Date.now();
    for (const [k, v] of mem) {
      if (v.expireAt <= now) mem.delete(k);
    }
    while (mem.size >= MEM_MAX_KEYS) {
      const oldest = mem.keys().next().value;
      if (oldest === undefined) break;
      mem.delete(oldest);
    }
  }
  mem.set(key, { value, expireAt: Date.now() + ttlMs });
}

function memDel(key: string): void {
  mem.delete(key);
}

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  let raw: string | null = null;
  if (await redisReady()) {
    try {
      raw = await redis.get(key);
    } catch {
      raw = null;
    }
  } else {
    raw = memGet(key);
  }
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export async function cacheSet(key: string, value: unknown, ttlMs: number): Promise<void> {
  const raw = JSON.stringify(value);
  if (await redisReady()) {
    try {
      await redis.set(key, raw, "PX", ttlMs);
      return;
    } catch {
      // 降级内存
    }
  }
  memSet(key, raw, ttlMs);
}

export async function cacheDel(key: string): Promise<void> {
  if (await redisReady()) {
    try {
      await redis.del(key);
    } catch {
      // 忽略：内存侧仍会删
    }
  }
  memDel(key);
}

/**
 * 读穿缓存：命中直接返回，未命中执行 loader 并回填。
 * 用于读多写少的热点（tokenKey/角色/配置/订阅展示读），写侧主动 cacheDel 失效 + TTL 兜底。
 */
export async function cacheThrough<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const hit = await cacheGet<T>(key);
  if (hit !== undefined) return hit;
  const value = await loader();
  await cacheSet(key, value, ttlMs);
  return value;
}

/**
 * o_setting 单键读的统一缓存入口（30s TTL + 写侧失效）。
 * 调用方覆盖：每请求级（tokenKey）、每次 AI 调用（agentUseMode/switchAiDevTool/textFallbackModel）、
 * 记忆与 embedding 参数、autoConfirm、内容安全渠道配置等。
 */
const SETTING_TTL_MS = 30_000;

export function getSettingValue(key: string): Promise<string | null> {
  return cacheThrough<string | null>(`setting:${key}`, SETTING_TTL_MS, async () => {
    const row = await db("o_setting").where("key", key).first();
    return (row?.value as string | null) ?? null;
  });
}

/** o_setting 多键批量读（whereIn 场景），逐键走缓存并行合并 */
export async function getSettingValues(keys: string[]): Promise<Record<string, string | null>> {
  const list = await Promise.all(keys.map((k) => getSettingValue(k)));
  const out: Record<string, string | null> = {};
  keys.forEach((k, i) => (out[k] = list[i]));
  return out;
}

/** o_setting 写侧失效（值传新值可直接回填缓存，省一次回源） */
export async function invalidateSetting(key: string, newValue?: string | null): Promise<void> {
  if (newValue === undefined) await cacheDel(`setting:${key}`);
  else await cacheSet(`setting:${key}`, newValue, SETTING_TTL_MS);
}
