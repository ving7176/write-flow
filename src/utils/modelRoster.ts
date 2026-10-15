import u from "@/utils";

/**
 * 模型名册对账（harness A12 双侧契约归一，2026-10-15）。
 *
 * 背景：模型名散在三处（o_agentDeploy 路由 / o_setting.textFallbackModel / vendor 模板 models[]），
 * API 端名册一变三处齐炸——2026-10-14 实证 deepseek-v4.1-flash 被 API 淘汰后 failover 400 炸链。
 * 本模块对「配置内全部在用模型名」与「远端 /models 名册」定期对账：不在册即告警 + trace，
 * 把过期从「跑批中途炸链」提前到「定时对账告警」。探测失败降级跳过，不阻断任何链路。
 */

interface RosterEntry {
  vendorId: string;
  modelName: string;
  origin: string;
}

/** 收集配置内在用模型名：o_agentDeploy（未禁用路由）+ textFallbackModel */
async function collectConfiguredModels(): Promise<RosterEntry[]> {
  const entries: RosterEntry[] = [];
  const rows = await u.db("o_agentDeploy").where("disabled", false).select("vendorId", "modelName");
  for (const r of rows as any[]) {
    if (r.vendorId && r.modelName && String(r.modelName).includes(":")) {
      // modelName 存「vendor:model」全名（个别库行），剥掉 vendor 前缀统一口径
      const pure = String(r.modelName).split(/:(.+)/)[1] || String(r.modelName);
      entries.push({ vendorId: r.vendorId, modelName: pure, origin: `agentDeploy:${r.vendorId}` });
    } else if (r.vendorId && r.modelName) {
      entries.push({ vendorId: r.vendorId, modelName: r.modelName, origin: `agentDeploy:${r.vendorId}` });
    }
  }
  const fallback = await u.db("o_setting").where("key", "textFallbackModel").first();
  const fb = String((fallback as { value?: string } | undefined)?.value ?? "").trim();
  if (fb && fb !== "auto" && fb.includes(":")) {
    const [vendorId, modelName] = fb.split(/:(.+)/);
    entries.push({ vendorId, modelName, origin: "textFallbackModel" });
  }
  // 同 vendor+model 去重
  const seen = new Set<string>();
  return entries.filter((e) => {
    const k = `${e.vendorId}:${e.modelName}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 拉远端名册（OpenAI 兼容 GET /models）；失败返回 null（对账降级跳过）。供 failover auto 解析复用 */
export async function fetchRemoteRoster(vendorId: string): Promise<Set<string> | null> {
  try {
    const vendor = u.vendor.getVendor(vendorId);
    const cfg = await u.db("o_vendorConfig").where("id", vendorId).first();
    const inputValues = { ...(vendor?.inputValues ?? {}), ...JSON.parse((cfg?.inputValues as string) ?? "{}") };
    const baseUrl = String(inputValues.baseUrl ?? "").replace(/\/$/, "");
    const apiKey = String(inputValues.apiKey ?? "").replace(/^Bearer\s+/i, "");
    if (!baseUrl || !apiKey) return null;
    const res = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: Array<{ id?: string }> };
    return new Set((j.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean));
  } catch {
    return null;
  }
}

/** 对账一次：每个 enable vendor 的在用模型名比对远端名册，缺失即告警 + trace */
export async function probeModelRoster(): Promise<void> {
  const entries = await collectConfiguredModels();
  const vendors = [...new Set(entries.map((e) => e.vendorId).filter((v) => v && v !== "null"))];
  for (const vendorId of vendors) {
    const enabled = await u.db("o_vendorConfig").where("id", vendorId).where("enable", 1).first();
    if (!enabled) continue;
    const remote = await fetchRemoteRoster(vendorId);
    if (!remote) {
      console.warn(`[modelRoster] ${vendorId} 名册探测失败（网络/私有端点），本轮跳过`);
      continue;
    }
    const missing = entries.filter((x) => x.vendorId === vendorId && !remote.has(x.modelName));
    if (!missing.length) {
      console.warn(`[modelRoster] ${vendorId} 对账通过（${entries.filter((x) => x.vendorId === vendorId).length} 个在用模型名均在册）`);
      continue;
    }
    const supported = [...remote].slice(0, 12).join(", ");
    for (const e of missing) {
      console.warn(`[modelRoster] 模型名疑似过期：${vendorId}:${e.modelName}（来源 ${e.origin}）不在远端名册；远端支持：${supported}`);
    }
  }
}

/** 定时对账：首跑延迟 2 分钟避开启动高峰，默认每 12 小时一次（unref 不阻止退出） */
export function startModelRosterWatch(opts: { intervalMs?: number } = {}): NodeJS.Timeout {
  const timer = setInterval(
    () => {
      void probeModelRoster().catch(() => {});
    },
    opts.intervalMs ?? 12 * 60 * 60 * 1000,
  );
  timer.unref?.();
  setTimeout(() => void probeModelRoster().catch(() => {}), 2 * 60 * 1000).unref?.();
  return timer;
}
