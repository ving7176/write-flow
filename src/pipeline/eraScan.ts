/**
 * 时代错位扫描（P2-2，对齐 xianxia check_continuity 的时代错位维度）。
 *
 * 目标：为 `[ERA]` 红线提供代码扫描辅助——现代科技/现代生活概念出现在非现代世界观（古代/修真/末世无电）中，
 * 若世界观不允许且无合法获取途径（捡到/遗物）则报时代错位。
 *
 * 词库提取自监督技能 `novel_agent_supervision.md` 三（时代词库）。纯函数，输入为章节正文；
 * worldEra 声明当前世界观时代（默认 "ancient" 非现代），命中词且无合法引入说明 → 报 [ERA]。
 *
 * 合法引入豁免（search：段落含「捡到/遗物/前人留下/符箓/灵石/系统奖励」等合法来源词，则不报）：
 * 避免误伤「穿越/系统流」等合法引入设定。
 */

export interface EraScanOptions {
  /** 世界观时代：modern=现代允许；否则为非现代（默认 ancient，报错） */
  worldEra?: "modern" | "ancient" | "xianxia";
  /**
   * 合法引入豁免关键词：命中则假定该时代错位有合法来源（如「捡来的」），不报。
   * 默认空，靠 worldEra 之外的第三条 = 段落含豁免词的直接浏览。
   */
  exemptKeywords?: string[];
  /**
   * 穿越豁免（结构化）：穿越类题材——穿越者/携带物语境下的现代词合法，本土人穿帮仍报。
   * 从约束声明 derive（见 deriveTransportExemption），比段落临时豁免跨章节稳定。
   */
  transportExemption?: TransportExemption;
}

export interface EraScanIssue {
  type: "ERA";
  word: string;
  snippet: string;
  line: number;
}

/** 穿越豁免配置：仅 carrier 作用域（穿越者相关行现代词豁免），不做全书一刀切 */
export interface TransportExemption {
  /** 穿越者角色名（从约束「主角·名」结构提取；拿不到用「主角」兜底） */
  carriers: string[];
  scope: "carrier";
}

/** 现代科技/生活词库（监督技能三：二维码/移动支付/手机/电灯/汽车/塑料等） */
const MODERN_WORDS = [
  "二维码", "移动支付", "微信", "支付宝", "手机", "智能手机", "直播", "电脑", "键盘", "编程",
  "互联网", "网络", "APP", "app", "电灯", "电力", "充电", "汽车", "驾驶", "飞机", "塑料",
  "不锈钢", "抗生素", "疫苗", "监控", "摄像头", "身份证", "社保", "外卖", "快递", "电梯",
  "空调", "冰箱", "WiFi", "wifi",
];

/** 合法引入豁免关键词（穿越/系统流/遗物等：合法来源则不报） */
const DEFAULT_EXEMPT = ["捡到", "捡来的", "遗物", "前人留下", "系统奖励", "系统发放", "穿越带来的", "储物戒里的", "灵石换来的", "法宝储物"];

/** 按行定位行号 */
function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/** 段落是否含合法引入豁免词 */
function hasExempt(segment: string, exempt: string[]): boolean {
  return exempt.some((w) => segment.includes(w));
}

/** 段落对某现代词是否为否定语境（「无X」「没有X」——声明世界不存在该物，非时代错位误用） */
function isNegated(segment: string, word: string): boolean {
  return segment.includes(`无${word}`) || segment.includes(`没有${word}`) || segment.includes(`不含${word}`);
}

/**
 * 从项目约束推导世界观时代（非章节硬校验入口用）。
 * 判定反转（宁漏报不误杀，E2E 两轮实测）：era 约束是 AI 对世界观的显式声明——
 * 声明含非现代标记（古代/王朝/修真/仙侠/灵气/宫廷/封建等）→ ancient；声明了世界观但
 * 无非现代标记（「当代都市」「与现实一致」等千变百态的现代表述无法枚举）→ modern。
 * 误判代价：现代题材误判 ancient = 设定文档现代词全拦、门禁停机（阻断级）；
 * 古代题材漏判 = ERA 漏报（LLM 质检评级兜底）。无 era 约束时调用方自行跳过 ERA。
 */
const NON_MODERN_MARKERS = /古代|王朝|皇室|宫廷|封建|农耕|修真|修仙|仙侠|武侠|宗门|灵气|灵石|灵力|法术|符箓|大明|大宋|大唐|大秦|架空中古/;

/** 词前 6 字内的否定排除前缀（「无修仙/不含修真/除…外」——声明世界不存在该元素，非题材归属） */
const NEGATED_MARKER_PREFIX = /(?:无|不含|没有|杜绝|禁止|排除|不出现|不涉|不写|除)\s*$/;

/** 单条 statement 是否含非现代标记：排除否定语境（「无修仙/系统/穿越元素」是负向排除而非题材声明，
 *  E2E 五轮实测：现代都市 era 约束写「无修仙/系统/穿越元素」被误判 ancient → world 全拦门禁停机） */
function hasNonModernMarker(statement: string): boolean {
  for (const m of statement.matchAll(new RegExp(NON_MODERN_MARKERS.source, "g"))) {
    const idx = m.index;
    const before = statement.slice(Math.max(0, (idx ?? 0) - 6), idx ?? 0);
    if (NEGATED_MARKER_PREFIX.test(before)) continue; // 「无修仙」式否定排除不算标记
    return true;
  }
  return false;
}

/** 穿越声明标记同样排除否定语境（「无系统/不含金手指」是排除声明，非穿越题材） */
function hasTransportMarker(text: string): boolean {
  for (const m of text.matchAll(new RegExp(TRANSPORT_MARKERS.source, "g"))) {
    const idx = m.index;
    const before = text.slice(Math.max(0, (idx ?? 0) - 6), idx ?? 0);
    if (NEGATED_MARKER_PREFIX.test(before)) continue;
    return true;
  }
  return false;
}

/**
 * 治本1 结构化优先：era 约束携带显式 `worldEra` 字段（brief 按 schema 指引产出）→ 直接采信；
 * 缺字段（存量项目/AI 漏输出）→ 降级到文本启发式（否定语境感知的标记匹配）。
 * 字段是唯一权威——启发式只服务兼容，不再承载新项目的判定。
 */
export function deriveWorldEraFromConstraints(
  constraints: Array<{ type?: unknown; statement?: unknown; worldEra?: unknown }>,
): "modern" | "ancient" {
  const eraItems = constraints.filter((c) => c?.type === "era");
  for (const c of eraItems) {
    const explicit = String((c as { worldEra?: unknown }).worldEra ?? "").trim().toLowerCase();
    if (explicit === "modern" || explicit === "ancient") return explicit;
  }
  const eraStatements = eraItems.map((c) => String(c.statement ?? ""));
  return eraStatements.some(hasNonModernMarker) ? "ancient" : "modern";
}

/** 穿越声明标记（约束 subject/statement 命中即判定为穿越类题材；排除「无系统」式否定排除） */
const TRANSPORT_MARKERS = /穿越|魂穿|身穿|重生|系统|随身空间|金手指/;
/** 兜底穿越者名：约束未显式给出时用「主角」 */
const DEFAULT_TRANSPORT_CARRIER = "主角";
/** 「主角·名」结构提取（subject/statement 权威字段，名 ≥2 字、后跟句读/动词/结尾防误捕） */
const CARRIER_NAME_RE = /主角[·:：]?([\u4e00-\u9fa5]{2,3})(?=[，。、，]|从|穿越|魂穿|身穿|携带|身怀|带回|回到|带|$)/;

/**
 * 从约束推导穿越豁免（结构化，唯一权威）：任何约束（首选 era）statement/subject 声明
 * 「穿越/魂穿/重生/系统/随身空间/金手指」→ 判定为穿越类题材，返回豁免配置。
 * 不返回 = 非穿越文，扫描保持全量拦截。穿越不改变 worldEra（本土时代仍按标记判 ancient）。
 * 豁免作用域 = carrier 行（含穿越者名即放行）；携带物语境（「主角之物被本土人看到」）
 * 由 LLM 监督层按上下文主语判定（行级正则无法区分「店小二掏出手机」vs「盯着主角的手机」）。
 */
export function deriveTransportExemption(
  constraints: Array<{ type?: unknown; subject?: unknown; statement?: unknown; transport?: unknown }>,
): TransportExemption | undefined {
  // 治本1 结构化优先：era 约束携带 transport 字段（brief 按 schema 指引产出）→ 直接采信
  for (const c of constraints) {
    const t = (c as { transport?: unknown }).transport as { carriers?: unknown } | null | undefined;
    if (t && typeof t === "object") {
      const carriers = Array.isArray(t.carriers)
        ? t.carriers.map((n) => String(n).trim()).filter(Boolean)
        : [];
      return { carriers: carriers.length ? carriers : [DEFAULT_TRANSPORT_CARRIER, "穿越者"], scope: "carrier" };
    }
  }
  // 兼容兜底：无结构化字段时降级到文本标记启发式（存量项目/AI 漏输出）
  const declared = constraints
    .filter((c) => c && (hasTransportMarker(String(c.statement ?? "")) || hasTransportMarker(String(c.subject ?? ""))))
    .map((c) => ({ subject: String(c.subject ?? ""), statement: String(c.statement ?? "") }));
  if (declared.length === 0) return undefined;

  const carriers = new Set<string>();
  for (const d of declared) {
    const m = d.subject.match(CARRIER_NAME_RE) ?? d.statement.match(CARRIER_NAME_RE);
    if (m) carriers.add(m[1]);
  }
  // 恒定兜底指代（E2E 实测：world/characters 设定文档行文用「主角」「穿越者」指代穿越者，
  // 只提角色名会漏豁免 → 设定文档讨论携带物被全拦、门禁重做耗尽；章节正文以角色名行文不受影响）
  carriers.add(DEFAULT_TRANSPORT_CARRIER);
  carriers.add("穿越者");
  return { carriers: [...carriers], scope: "carrier" };
}

/**
 * 穿越豁免判定：行含穿越者名（carrier）→ 该行现代词全部豁免（穿越者使用/内心/携带）。
 * 本土人自行使用现代物/现代语的行（无穿越者名）→ 不豁免（真穿帮，仍报）。
 */
function isTransportExempt(t: TransportExemption, segment: string): boolean {
  return t.carriers.some((n) => segment.includes(n));
}

/**
 * 扫描非现代世界观章节中的时代错位。
 *
 * @param text 章节正文
 * @param opts 配置
 * @returns [ERA] 问题列表；现代世界观或全部豁免返回 []
 */
export function scanEraAnachronism(text: string, opts: EraScanOptions = {}): EraScanIssue[] {
  const worldEra = opts.worldEra ?? "ancient";
  if (worldEra === "modern") return []; // 现代世界观允许全部
  const exempt = opts.exemptKeywords ?? DEFAULT_EXEMPT;

  const issues: EraScanIssue[] = [];
  const seen = new Set<string>();
  for (const word of MODERN_WORDS) {
    if (seen.has(word)) continue;
    seen.add(word);
    let idx = text.indexOf(word);
    while (idx !== -1) {
      // 取所在段落判断合法豁免
      const paraStart = Math.max(0, text.lastIndexOf("\n", idx) + 1);
      const paraEnd = text.indexOf("\n", idx) === -1 ? text.length : text.indexOf("\n", idx);
      const segment = text.slice(paraStart, paraEnd);
      const negated = isNegated(segment, word);
      const exempted = hasExempt(segment, exempt) || (opts.transportExemption ? isTransportExempt(opts.transportExemption, segment) : false);
      if (!exempted && !negated) {
        issues.push({
          type: "ERA",
          word,
          snippet: text.slice(Math.max(0, idx - 4), idx + word.length + 4),
          line: lineOf(text, idx),
        });
        break; // 一词一章第一处命中即可（防重复刷），除非有合法豁免的后续
      }
      idx = text.indexOf(word, idx + word.length);
    }
  }
  return issues;
}

export default scanEraAnachronism;
