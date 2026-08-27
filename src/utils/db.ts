import type { Knex } from "knex";

/**
 * 引擎数据访问层（注入式）：宿主启动时调用 configureEngineDb 提供 knex 实例；
 * 导出保持「可调用对象」形态以对齐主仓 u.db("table") 的用法。
 */
let instance: Knex | null = null;

export function configureEngineDb(knexInstance: Knex): void {
  instance = knexInstance;
}

function getEngineDb(): Knex {
  if (!instance) throw new Error("[qiflow-engine] 数据库未初始化：请先调用 configureEngineDb(knex)");
  return instance;
}

/** Proxy 可调用句柄：函数调用转发 knex(tableName)，成员访问转发 raw/builder 等 */
const callable = new Proxy(((..._a: unknown[]) => undefined) as unknown as Knex, {
  apply(_target, _thisArg, args) {
    return (getEngineDb() as unknown as (...a: unknown[]) => unknown)(...args);
  },
  get(_target, prop, receiver) {
    const inst = getEngineDb() as unknown as Record<string | symbol, unknown>;
    const v = Reflect.get(inst, prop, receiver);
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(inst) : v;
  },
});

export default callable;
