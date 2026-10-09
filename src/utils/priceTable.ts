/**
 * 模型价表与成本结算（WP6 · 云栖 §1.6 成本治理「逐次记账」）。
 *
 * 口径：CNY / 1M tokens，input/output 分列；model 形如 "vendorId:modelName"。
 * 纪律：价表只登记有依据的真实价目（官方定价页核对后维护）——未登记模型 cost 结算跳过
 * （o_tasks.cost 保持 NULL），不估算不编造；登记/改价须 CHANGELOG 记价格依据与日期。
 */

const PRICE_TABLE = new Map<string, { input: number; output: number }>();

// ── 价目登记（平价口径：缓存未命中输入 + 空闲/常规时段；实际账单以平台为准，本表用于成本趋势与对账）──
// MiMo：来源 mimo.mi.com/docs/zh-CN/price/pay-as-you-go（2026-09-29 查证，实时推理价）
PRICE_TABLE.set("mimo-v2.6-flash", { input: 1, output: 2 }); // ¥1 / ¥2 每百万 tokens
PRICE_TABLE.set("mimo-v2.6-pro", { input: 3, output: 6 }); // ¥3 / ¥6 每百万 tokens
// DeepSeek：来源 api-docs.deepseek.com/zh-cn/quick_start/pricing（2026-09-29 查证，空闲时段价）
// 注意：高峰时段（周一至五 9-12/14-18 点）翻倍；旧名 deepseek-v4-flash 已由 V4.1-Flash 接管计费
PRICE_TABLE.set("deepseek-v4.1-flash", { input: 1, output: 4 }); // ¥1 / ¥4 每百万 tokens（空闲）
PRICE_TABLE.set("deepseek-flash", { input: 1, output: 4 }); // 同上别名

/** 登记价目（运维/测试注入口；modelName 为 "vendorId:modelName" 的冒号后段；改价须 CHANGELOG 记来源与日期） */
export function registerPrice(modelName: string, input: number, output: number): void {
  PRICE_TABLE.set(modelName, { input, output });
}

/** 查价：先按 modelName 精确匹配，再按完整 "vendorId:modelName" 匹配；未登记返回 undefined */
export function lookupPrice(model: string): { input: number; output: number } | undefined {
  const name = model.includes(":") ? model.split(":").slice(1).join(":") : model;
  return PRICE_TABLE.get(name) ?? PRICE_TABLE.get(model);
}

/** 成本结算（CNY）：未登记价目 / 无 token 数 → undefined（调用方保持 NULL，不估算） */
export function computeCost(model: string, promptTokens?: number, completionTokens?: number): number | undefined {
  const rate = lookupPrice(model);
  if (!rate) return undefined;
  if (promptTokens == null && completionTokens == null) return undefined;
  const p = promptTokens ?? 0;
  const c = completionTokens ?? 0;
  return (p / 1_000_000) * rate.input + (c / 1_000_000) * rate.output;
}
