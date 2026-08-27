/**
 * 幽默信号检测（P2-1，对齐 xianxia humor-check）。
 *
 * 目标：为「连续 2 章零幽默」红线提供代码信号辅助（报告级，不硬阻断——幽默判定靠 LLM 更可靠，
 * 本模块检测「反差/自嘲/戏仿/荒诞」结构信号词 + 感叹号反差，输出信号分供监督层参考）。
 *
 * 参考 xianxia absurd-humor-toolkit 的 7 类反差滑稽手法，抽象为可检测的信号：
 *  ① 自嘲（角色主动笑自己/贬自己）
 *  ② 边缘路人拌嘴（市井互怼句式）
 *  ③ 反差滑稽（物品/语气/场景错位）
 *  ④ 经典台词戏仿
 *
 * 检测是启发式，输出 0~N 的信号计数 + 是否>0 标记；连续 2 章无信号 → 提示作者（报告级）。
 */

export interface HumorSignalOptions {
  /** 报告级阈值：信号数少于该值标记「幽默可能不足」（默认 1） */
  minSignals?: number;
}

/** 反差/自嘲信号句式与词（命中即+1） */
const SIGNAL_PATTERNS: Array<{ label: string; patterns: RegExp[] }> = [
  {
    label: "自嘲",
    patterns: [
      /(念叨|嘟囔|苦笑着|自言自语)(着)?[:：，]?\s*["“]?.*(不中用|没出息|老了|蠢|笨|倒霉|活该)/,
      /自嘲(道|地|着)/,
    ],
  },
  {
    label: "反差错位",
    patterns: [
      /明明.{0,8}(却|偏|非要|结果)/,
      /(堂堂|好歹|一个堂堂).{0,10}(竟|居然|结果)/,
    ],
  },
  {
    label: "路人拌嘴",
    patterns: [
      /(王婶|李二|老婆子|老头子|隔壁|街坊|村口|店掌柜).{0,8}(骂|啐|翻个白眼|撇撇嘴|回嘴|接话)/,
    ],
  },
  {
    label: "叹词/夸张反应",
    patterns: [
      /(咳|嘿|哟|嚯|哎哟|得嘞|好家伙|乖乖).{0,4}[，。!！?？]/,
    ],
  },
  {
    label: "戏仿/俗语反用",
    patterns: [
      /(俗话|古人云|常言道|老话讲).{0,6}(却|可|偏|倒)/,
    ],
  },
];

export interface HumorSignalResult {
  /** 命中的信号数 */
  count: number;
  /** 命中的信号类别（去重 label） */
  signals: string[];
  /** 是否达到 minSignals（默认 ≥1 视为有幽默信号） */
  hasSignal: boolean;
  /** 抽样命中片段（供复核，最多 3 条） */
  samples: string[];
  /** 章节字符数 */
  totalChars: number;
}

/** 检测一章文本的幽默信号 */
export function detectHumorSignals(text: string, opts: HumorSignalOptions = {}): HumorSignalResult {
  const minSignals = opts.minSignals ?? 1;
  const signals = new Set<string>();
  const samples: string[] = [];
  const hits = Array.from({ length: SIGNAL_PATTERNS.length }, () => 0);

  // 按句子（含对话）遍历，避免跨句误匹配
  const sentences = text.split(/[。！？\n]/).map((s) => s.trim()).filter(Boolean);
  for (const sent of sentences) {
    for (let i = 0; i < SIGNAL_PATTERNS.length; i++) {
      const { label, patterns } = SIGNAL_PATTERNS[i];
      if (hits[i] > 0) continue; // 每类信号一章最多计 1（防同一句式重复刷分）
      if (patterns.some((p) => p.test(sent))) {
        hits[i]++;
        signals.add(label);
        if (samples.length < 3 && sent.length < 40) samples.push(sent.slice(0, 36));
      }
    }
  }

  const count = hits.reduce((a, b) => a + b, 0);
  const totalChars = Array.from(text.replace(/\s/g, "")).length;
  return {
    count,
    signals: Array.from(signals),
    hasSignal: count >= minSignals,
    samples,
    totalChars,
  };
}

export const HUMOR_SIGNAL_LABELS = SIGNAL_PATTERNS.map((s) => s.label);
export default detectHumorSignals;
