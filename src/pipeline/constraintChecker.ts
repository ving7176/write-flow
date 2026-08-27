import type { NovelConstraint } from "@/agents/novelAgent/constraints";

/**
 * 监督层代码硬校验：machineHint 数值断言器（2B）。
 *
 * 背景：constraints 的 machineHint 字段设计用于「给判定逻辑做数值比对」，但历史上零消费——
 * 约束逐条核对全交 LLM。这里落地最小数值断言：带 machineHint 的约束，从 stateLedger
 * 按 field 路径取实际值，做 lte/gte/eq 断言，命中即硬冲突（触发返工闭环）。
 *
 * 防误伤（U1 兜底）：
 * - 数据缺失（stateLedger 无该字段 / 值为 null / 非数字）→ 降级交 LLM 判断，不阻断
 * - 非法 DSL（field 非 string / op 非法 / value 非 number）→ 跳过该条
 */

/** machineHint 数值断言 DSL：field 指向 stateLedger 内路径（如 "resources.money"） */
export type MachineHint = {
  field: string;
  op: "lte" | "gte" | "eq";
  value: number;
};

/** 数值断言结果：pass / violated（硬冲突）/ missing（数据缺失，降级） */
export type NumericCheck =
  | { kind: "pass" }
  | { kind: "violated"; field: string; op: MachineHint["op"]; expected: number; actual: number }
  | { kind: "missing"; field: string };

/** 硬冲突条目（带约束上下文，供返工 prompt 回灌） */
export interface NumericViolation {
  constraintId: string;
  statement: string;
  field: string;
  op: MachineHint["op"];
  expected: number;
  actual: number;
}

/** 从 ledger 按点分路径取值（"resources.money" → 50）；任意一环缺失返回 undefined */
export function readLedgerValue(ledger: unknown, path: string): unknown {
  if (ledger == null || typeof ledger !== "object") return undefined;
  let acc: unknown = ledger;
  for (const seg of path.split(".")) {
    if (acc == null || typeof acc !== "object") return undefined;
    acc = (acc as Record<string, unknown>)[seg];
  }
  return acc;
}

/** 单条数值断言（纯函数，可单测） */
export function checkNumeric(hint: MachineHint, actual: unknown): NumericCheck {
  if (typeof actual !== "number") return { kind: "missing", field: hint.field };
  let violated = false;
  if (hint.op === "lte") violated = actual > hint.value;
  else if (hint.op === "gte") violated = actual < hint.value;
  else violated = actual !== hint.value;
  return violated ? { kind: "violated", field: hint.field, op: hint.op, expected: hint.value, actual } : { kind: "pass" };
}

/** 校验 machineHint 是否合法 DSL（非法跳过，防脏数据误判） */
function isMachineHint(v: unknown): v is MachineHint {
  if (!v || typeof v !== "object") return false;
  const h = v as Record<string, unknown>;
  return typeof h.field === "string" && typeof h.value === "number" && (h.op === "lte" || h.op === "gte" || h.op === "eq");
}

/**
 * 遍历约束清单做数值断言：返回硬冲突列表。
 * - 只对带合法 machineHint 的约束断言
 * - 数据缺失（missing）不纳入（降级交 LLM）
 * - 调用方负责传「当前生效」约束（activeConstraints 过滤）与当前账本
 */
export function checkConstraintsNumeric(constraints: NovelConstraint[], ledger: unknown): NumericViolation[] {
  const violations: NumericViolation[] = [];
  for (const c of constraints) {
    const hint = c.machineHint;
    if (!isMachineHint(hint)) continue;
    const actual = readLedgerValue(ledger, hint.field);
    const r = checkNumeric(hint, actual);
    if (r.kind === "violated") {
      violations.push({ constraintId: c.id, statement: c.statement, field: r.field, op: r.op, expected: r.expected, actual: r.actual });
    }
  }
  return violations;
}

/**
 * 约束 id 引用回查：从监督报告 issue 文本提取引用的约束 id（如 C-002），
 * 返回不在已知清单中的可疑 id（监督可能凭空捏造约束——约束力流失点）。
 */
export function extractConstraintRefs(text: string): string[] {
  return Array.from(new Set(text.match(/\b[A-Za-z]+-\d+\b/g) ?? []));
}

/** 回查：issue 文本引用的约束 id 是否都在 knownIds 内；返回可疑（未知）id 列表 */
export function verifyConstraintRefs(issues: { type: string; text: string }[], knownIds: Set<string>): string[] {
  const refs = issues.flatMap((i) => extractConstraintRefs(i.text));
  return Array.from(new Set(refs.filter((id) => !knownIds.has(id))));
}
