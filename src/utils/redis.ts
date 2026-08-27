import Redis from "ioredis";

/**
 * Redis 客户端单例（SaaS 生产必配；未配置/连不上时由 cache 层自动降级进程内存，见 utils/cache.ts）。
 * 连接地址优先 REDIS_URL 环境变量（照 db.ts 的 PG_* 模式），默认本机 6379。
 * lazyConnect：进程启动不阻塞、不主动建连，首次使用时探测。
 */
export const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379", {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  retryStrategy: (times) => Math.min(times * 1000, 10_000),
});

let ready = false;
let probePromise: Promise<boolean> | null = null;
let failUntil = 0;

redis.on("ready", () => {
  if (!ready) console.log("[redis] 已连接（缓存与限流走 Redis，多实例共享）");
  ready = true;
});
redis.on("end", () => {
  ready = false;
  probePromise = null;
});
// error 静默：降级与否由 redisReady() 探测结果决定，避免每次重试刷屏

/**
 * Redis 是否可用（惰性探测；失败后 30 秒退避内直接降级，不反复打探测开销）。
 */
export async function redisReady(): Promise<boolean> {
  if (ready) return true;
  if (Date.now() < failUntil) return false;
  if (!probePromise) {
    probePromise = (async () => {
      try {
        if (redis.status === "wait" || redis.status === "end") await redis.connect();
        return (await redis.ping()) === "PONG";
      } catch {
        failUntil = Date.now() + 30_000;
        console.warn("[redis] 不可用，缓存/限流降级为进程内存（单实例语义；重启/多实例不共享；30 秒后重试）");
        return false;
      } finally {
        probePromise = null;
      }
    })();
  }
  return probePromise;
}

/** 测试辅助：重置探测退避状态 */
export function resetRedisProbe(): void {
  failUntil = 0;
  probePromise = null;
}
