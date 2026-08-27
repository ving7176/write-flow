/**
 * 描写占比计算（批次1 · 检查层自动化 P0-1）。
 *
 * 背景：xianxia 用段落特征分析法精确计算描写占比，阈值按场景分档：
 *  常规 12%~18%、冲突段 8%~12%、宏大场面 20%~25%、任何场景 ≤30%（红线）。
 *
 * 本模块做纯函数估算：按段落拆分，依据「感官词/修饰词/静态谓语」特征粗判描写占比。
 * 说明：判定是启发式（LLM 语境下描写 vs 情节边界模糊），仅输出「估算值 + 段落级分析」，
 * 供监督层作为参考信号，不独立阻断；超出 HARD_LIMIT（默认 30%）才标记问题。
 */

export interface DescriptionStats {
  /** 估算描写占比（0~1） */
  ratio: number;
  /** 描写字符数 */
  descChars: number;
  /** 总字符数 */
  totalChars: number;
  /** 判定为描写段的文本（供人工复核，最多取 3 段片段） */
  descSamples: string[];
  /**
   * 连续静态写景是否超限（P0-2 校准：硬红线标准，对齐 xianxia static_desc_limit ≤120 字）。
   * 判定：连续「纯静态写景」段（无对话、无强动作动词、静态信号强）累计 chars > staticLimit。
   * 占比 30% 是启发式参考易误报（对话为主章节也偏高），静态写景超限才是可靠的红线。
   */
  staticSceneryExceeded: boolean;
}

export interface DescriptionOptions {
  /** 参考红线：估算占比超此值标记（默认 0.30，报告级；不作为硬红线） */
  hardLimit?: number;
  /** 硬红线：连续静态写景字符上限（默认 120，对应 xianxia static_desc_limit） */
  staticLimit?: number;
}

const SENSORY_WORDS = [
  "闻到", "嗅到", "看见", "看到", "耳边", "听来", "触到", "冰凉", "温热", "刺眼",
  "昏暗", "明亮", "微风", "霞光", "山色", "灯火", "光影", "薄雾", "月光", "夕阳",
];
const STATIC_VERBS = ["是", "有", "像", "仿佛", "似", "宛如", "如同", "透着", "泛着", "挂着"];
const MODIFIER_WORDS = ["缓缓", "轻轻", "偷偷", "默默", "静静", "慢慢", "微微", "阵阵", "缕缕", "丝丝"];
/** 强动作动词（静态写景段中若出现则不算纯静态） */
const ACTION_VERBS = ["走", "跑", "看", "拿", "放", "说", "问", "答", "砍", "背", "推", "转身", "抬头", "低头"];

/** 统计一段文本中的特征词命中数（描写段信号） */
function signalScore(seg: string): number {
  let score = 0;
  for (const w of SENSORY_WORDS) if (seg.includes(w)) score++;
  for (const w of STATIC_VERBS) if (seg.includes(w)) score++;
  for (const w of MODIFIER_WORDS) if (seg.includes(w)) score++;
  return score;
}

/** 按空行/换行切段，返回 { text, charLen } 的非空段 */
export function splitParagraphs(text: string): Array<{ text: string; charLen: number }> {
  const out: Array<{ text: string; charLen: number }> = [];
  for (const para of text.split(/\n+/)) {
    const t = para.trim();
    if (t) out.push({ text: t, charLen: Array.from(t).length });
  }
  return out;
}

/** 判定某段是否为「描写倾向」：只统计特征信号强、且无对话无强动作的静态段。
 *  含对话（引号占比 ≥0.08）→ 对话段；含强动作动词 → 动作段；两者都不算纯描写。 */
function isDescriptionLike(seg: string): boolean {
  if (signalScore(seg) < 1) return false;
  if (quoteRatio(seg) >= 0.08) return false; // 有对话
  const hasAction = ACTION_VERBS.some((v) => seg.includes(v));
  if (hasAction) return false; // 有强动作（事件推进），非纯静态
  return true;
}

/** 段内引号字符占比 */
function quoteRatio(seg: string): number {
  const q = (seg.match(/[“”「」"]/g) ?? []).length;
  return seg.length === 0 ? 0 : q / seg.length;
}

/**
 * 计算章节描写占比与连续静态写景超限（P0-2 校准）。
 *
 * hardLimit（占比 30%）为报告级参考（启发式易对对话为主章节误报，不单独作硬红线）；
 * staticSceneryExceeded（连续静态写景 > staticLimit=120 字）为硬红线标准——
 * 把「连续无动作无对话的纯描写」累计字符数，超过上限判定为静态水文。
 */
export function computeDescriptionRatio(text: string, opts: DescriptionOptions = {}): DescriptionStats & { overLimit: boolean } {
  const hardLimit = opts.hardLimit ?? 0.3;
  const staticLimit = opts.staticLimit ?? 120;
  const paras = splitParagraphs(text);
  const totalChars = paras.reduce((acc, p) => acc + p.charLen, 0);
  const descSamples: string[] = [];
  let descChars = 0;
  // 连续静态写景累计：只统计「纯静态」段（无对话无动作），超过 staticLimit 置 hard 红线
  let staticAcc = 0;
  let staticSceneryExceeded = false;
  for (const p of paras) {
    if (isStaticScenery(p.text)) {
      staticAcc += p.charLen;
      if (staticAcc > staticLimit) staticSceneryExceeded = true;
    } else {
      staticAcc = 0; // 出现对话/动作段则重置累积
    }
    if (isDescriptionLike(p.text)) {
      descChars += p.charLen;
      if (descSamples.length < 3) descSamples.push(p.text.slice(0, 40));
    }
  }
  const ratio = totalChars === 0 ? 0 : descChars / totalChars;
  return {
    ratio,
    descChars,
    totalChars,
    descSamples,
    staticSceneryExceeded,
    overLimit: ratio > hardLimit,
  };
}

/** 纯静态写景段：无对话、无强动作动词、静态信号 >=1（连续段累计用于硬红线判定） */
function isStaticScenery(seg: string): boolean {
  if (signalScore(seg) < 1) return false;
  if (quoteRatio(seg) >= 0.08) return false;
  return !ACTION_VERBS.some((v) => seg.includes(v));
}

export default computeDescriptionRatio;
