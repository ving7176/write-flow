/**
 * 引擎包切割工具（开源分发配套）：
 * 按 manifest 从 app/src 拷贝创作编排引擎闭包到 packages/qiflow-engine，
 * 保持 src 目录同构（@/* 别名原样生效），替换/新增少数适配文件（db 注入层等）。
 * 幂等：重复执行覆盖重建 engine/src。
 */
import fs from "fs";
import path from "path";

const HERE = import.meta.dirname ?? ".";
const APP_SRC = path.resolve(HERE, "../../../app/src");
const APP_ROOT = path.resolve(APP_SRC, "..");
const OUT = path.resolve(HERE, "..");

/** 闭包清单（_tmp_closure.mts 分析产物 2026-08-27；剔除迁移器与将被重写的 db 层） */
const MANIFEST: string[] = [
  "agents/novelAgent/constraints.ts",
  "agents/novelAgent/foreshadowParse.ts",
  "agents/novelAgent/outlinePlan.ts",
  "agents/novelAgent/supervision.ts",
  "agents/novelAgent/workflow.ts",
  "lib/vendor.json",
  "pipeline/bannedWordScan.ts",
  "pipeline/chapterVersion.ts",
  "pipeline/chapterWords.ts",
  "pipeline/checkReport.ts",
  "pipeline/constraintChecker.ts",
  "pipeline/descriptionRatio.ts",
  "pipeline/deslopLexicon.ts",
  "pipeline/deslopPrompt.ts",
  "pipeline/eraScan.ts",
  "pipeline/humorSignal.ts",
  "pipeline/repeatDetect.ts",
  "pipeline/scanProvider.ts",
  "pipeline/schemas/novel.ts",
  "pipeline/stageConfirm.ts",
  "pipeline/stageEngine.ts",
  "pipeline/stageGate.ts",
  "pipeline/toolGuard.ts",
  "pipeline/trace.ts",
  "pipeline/workflowLoop.ts",
  "pipeline/xmlConsume.ts",
  "socket/chatMessagesData.d.ts",
  "socket/resTool.ts",
  "types/database.d.ts",
  "utils.ts",
  "utils/agent/embedding.ts",
  "utils/agent/memory.ts",
  "utils/ai.ts",
  "utils/cache.ts",
  "utils/chapterKey.ts",
  "utils/contentSafety.ts",
  "utils/error.ts",
  "utils/getArtPrompt.ts",
  "utils/getConfig.ts",
  "utils/getPath.ts",
  "utils/getPrompts.ts",
  "utils/oss.ts",
  "utils/password.ts",
  "utils/redis.ts",
  "utils/replaceUrl.ts",
  "utils/taskRecord.ts",
  "utils/vendor.ts",
  "utils/vm.ts",
  "utils/writeVersion.ts",
];

const OVERRIDES: Record<string, string> = {
  /** 数据访问注入层：替代主仓 db.ts（该文件耦合 initDB/fixDB 迁移器；引擎包由宿主注入 knex 实例） */
  "utils/db.ts": `
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
`.trim() + "\n",
};

/** 数据访问统一化：直引 @/utils/db 的文件改为走聚合运行时 u.db（引擎 mock 可测性与注入语义前提） */
function toAggregatedDb(source: string): string {
  return source.replace('import db from "@/utils/db";', 'import u from "@/utils";').replace(/(?<![\w.$])db\(/g, "u.db(");
}

const TRANSFORMS: Record<string, (source: string) => string> = {
  "pipeline/checkReport.ts": toAggregatedDb,
  "pipeline/chapterVersion.ts": toAggregatedDb,
  "utils/taskRecord.ts": toAggregatedDb,
  "agents/novelAgent/outlinePlan.ts": toAggregatedDb,
};

function main(): void {
  fs.rmSync(path.join(OUT, "src"), { recursive: true, force: true });
  let copied = 0;
  for (const rel of MANIFEST) {
    const from = path.join(APP_SRC, rel);
    if (!fs.existsSync(from)) {
      console.error(`manifest 缺失：${rel}`);
      process.exit(1);
    }
    const to = path.join(OUT, "src", rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    let content = fs.readFileSync(from, "utf-8");
    const transform = TRANSFORMS[rel];
    if (transform) content = transform(content);
    fs.writeFileSync(to, content, "utf-8");
    copied++;
  }
  for (const [rel, content] of Object.entries(OVERRIDES)) {
    const to = path.join(OUT, "src", rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, content, "utf-8");
  }
  // 提示词资产随包（引擎运行时按 cwd/data/skills 解析）：全部 novel_* 技能文件
  const skillDir = path.join(APP_ROOT, "data/skills");
  const outSkillDir = path.join(OUT, "data/skills");
  fs.rmSync(outSkillDir, { recursive: true, force: true });
  fs.mkdirSync(outSkillDir, { recursive: true });
  let skills = 0;
  for (const f of fs.readdirSync(skillDir)) {
    if (f.startsWith("novel") && f.endsWith(".md")) {
      fs.copyFileSync(path.join(skillDir, f), path.join(outSkillDir, f));
      skills++;
    }
  }
  // 建表 SQL 随包（README 部署文档引用包内路径，主仓副本不出仓）
  const outSqlDir = path.join(OUT, "sql");
  fs.mkdirSync(outSqlDir, { recursive: true });
  fs.copyFileSync(path.join(APP_ROOT, "sql/schema.sql"), path.join(outSqlDir, "schema.sql"));
  // 供应商适配代码随包（getCode 运行时按 cwd/data/vendor/<id>.ts 读取）；toonflow/comfyui 已退役，不随包
  const vendorDir = path.join(APP_ROOT, "data/vendor");
  const outVendorDir = path.join(OUT, "data/vendor");
  fs.rmSync(outVendorDir, { recursive: true, force: true });
  fs.mkdirSync(outVendorDir, { recursive: true });
  let vendors = 0;
  for (const f of fs.readdirSync(vendorDir)) {
    if (f.endsWith(".ts") && !f.startsWith("toonflow") && !f.startsWith("comfyui")) {
      fs.copyFileSync(path.join(vendorDir, f), path.join(outVendorDir, f));
      vendors++;
    }
  }
  console.log(`cut complete: ${copied} files + ${Object.keys(OVERRIDES).length} overrides + ${skills} skills + ${vendors} vendors + schema.sql -> ${path.relative(process.cwd(), OUT)}`);
}

main();
