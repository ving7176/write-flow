/**
 * qiflow-engine 最小宿主示例：在终端里跑通小说七阶段创作流水线（真库 + 真模型 + 人在回路确认）。
 *
 * 引擎包只提供编排原语（阶段表/门禁/质检/状态机/落库），决策层与工具集是宿主职责——
 * 本文件就是一个 ~250 行的完整宿主示范：如何装配 stageTools（生成/质检两类模型调用）、
 * 如何把 socket 确认点换成终端交互、如何让 Gate4 的 briefConfirmed 语义在终端闭环。
 *
 * 用法（在包根目录）：
 *   PG_HOST=127.0.0.1 PG_PORT=5432 PG_DATABASE=write-flow PG_USER=postgres PG_PASSWORD=xxx \
 *   WF_MODEL="1:deepseek-chat" \
 *   npx tsx examples/novel-cli.ts --idea "末世废土中的拾荒少女与一台残存的AI" [--auto]
 *
 * - WF_MODEL：o_vendorConfig.id + 模型名（供应商与 apiKey 配置见 README「模型配置」）
 * - 默认逐阶段确认（通过/重做/回退/终止）；--auto 全自动跑到底
 * - 密钥只从数据库行读取，绝不写入命令行或文件
 */
import fs from "fs";
import path from "path";
import readline from "readline";
import knexFactory from "knex";
import type { Socket } from "socket.io";
import u from "@/utils";
import { configureEngineDb } from "@/utils/db";
import ResTool from "@/socket/resTool";
import { createStageEngine } from "@/pipeline/stageEngine";
import type { AgentContext, StageCheckRunInput, StageToolMap } from "@/pipeline/stageEngine";
import { NOVEL_STAGES } from "@/agents/novelAgent/workflow";
import type { NovelStageKey } from "@/pipeline/schemas/novel";
import { renderXmlFormatHint, stageLabels, stageXmlTag } from "@/pipeline/schemas/novel";
import { resolveStageConfirm } from "@/pipeline/stageConfirm";

// ── CLI 参数与环境 ──

// 断言为模板字面量类型（"vendorId:model"）：格式校验在 main() 里做（不合规直接 die），空串运行时不可达
const MODEL = (process.env.WF_MODEL ?? "") as `${string}:${string}`;
const IDEA = (() => {
  const i = process.argv.indexOf("--idea");
  return i > 0 ? process.argv[i + 1] ?? "" : "";
})();
const AUTO = process.argv.includes("--auto");

function die(msg: string): never {
  console.error(`[novel-cli] ${msg}`);
  process.exit(1);
}

// ── 宿主装配：数据库 ──

/** 完整版 agentDeploy 种子（app/src/lib/fixDB.ts:202 起）中 novel 线的绑定 key；CLI 一次性绑定到 WF_MODEL */
const NOVEL_DEPLOY_KEYS: Array<{ key: string; name: string; desc: string }> = [
  { key: "novelAgent:decisionAgent", name: "小说Agent:决策层", desc: "决策层" },
  { key: "novelAgent:supervisionAgent", name: "小说Agent:监督层", desc: "监督层" },
  { key: "novelAgent:briefAgent", name: "小说Agent:简介生成", desc: "简介生成" },
  { key: "novelAgent:worldAgent", name: "小说Agent:世界模型", desc: "世界模型生成" },
  { key: "novelAgent:charactersAgent", name: "小说Agent:人物设定", desc: "人物设定生成" },
  { key: "novelAgent:synopsisAgent", name: "小说Agent:梗概生成", desc: "梗概生成" },
  { key: "novelAgent:outlineAgent", name: "小说Agent:大纲生成", desc: "大纲生成" },
  { key: "novelAgent:chapterAgent", name: "小说Agent:章节生成", desc: "章节生成" },
  { key: "novelAgent:midtermCheckAgent", name: "小说Agent:中期核查", desc: "跨章中期一致性核查" },
  { key: "novelAgent:milestoneCheckAgent", name: "小说Agent:里程碑终审", desc: "全书全局终审" },
  { key: "novelAgent:stageCheckAgent", name: "小说Agent:阶段质检", desc: "阶段产物质检" },
  { key: "novelAgent:stateExtractor", name: "小说Agent:状态抽取", desc: "章节状态账本抽取" },
  { key: "novelAgent:chapterAssistant", name: "小说Agent:章节助手", desc: "选区润色/改写/扩写/续写" },
];

async function setupDatabase() {
  const db = knexFactory({
    client: "pg",
    connection: {
      host: process.env.PG_HOST ?? "127.0.0.1",
      port: Number(process.env.PG_PORT ?? 5432),
      database: process.env.PG_DATABASE ?? "write-flow",
      user: process.env.PG_USER ?? "postgres",
      password: process.env.PG_PASSWORD ?? "",
    },
  });
  configureEngineDb(db);

  // 建表检查：核心表缺失 → 指向包内 schema.sql（42 表一次建齐）
  try {
    await u.db("o_project").select("id").limit(1);
  } catch {
    die(`数据库「${process.env.PG_DATABASE ?? "write-flow"}」尚未建表。先执行：psql -d <库名> -f sql/schema.sql`);
  }

  // 绑定模型：novel 线全部 agentKey → WF_MODEL（幂等，可重复运行）
  for (const dep of NOVEL_DEPLOY_KEYS) {
    const row = await u.db("o_agentDeploy").where("key", dep.key).first();
    if (row) {
      if (row.modelName !== MODEL) await u.db("o_agentDeploy").where("key", dep.key).update({ modelName: MODEL, vendorId: MODEL.split(":")[0] });
    } else {
      await u.db("o_agentDeploy").insert({ id: u.nextIntId(), key: dep.key, name: dep.name, desc: dep.desc, modelName: MODEL, vendorId: MODEL.split(":")[0], disabled: false });
    }
  }
  return db;
}

async function createProject(idea: string): Promise<number> {
  const projectId = u.nextIntId();
  await u.db("o_project").insert({
    id: projectId,
    name: idea.slice(0, 30),
    intro: idea,
    type: "novel",
    status: "active",
    createTime: Date.now(),
  });
  // 引擎工作区行（o_agentWorkData key=agentKey）：getWorkData 的落点，先 ensure 空行
  await u.db("o_agentWorkData").insert({ id: u.nextIntId(), projectId, key: "novelAgent", data: "{}" });
  return projectId;
}

// ── 宿主装配：终端交互（替代 socket 前端）──

const SOCK_ID = "cli";
let awaitingStage: string | null = null;

/** mock socket：引擎所有 emit 都走到这里——awaitConfirm 转终端提问，其余打事件摘要 */
const cliSocket = {
  id: SOCK_ID,
  emit: (event: string, payload: Record<string, unknown>) => {
    if (event === "awaitConfirm") {
      awaitingStage = String(payload.stageKey);
      void confirmLoop(String(payload.stageKey));
      return;
    }
    if (event === "stageProgress") {
      console.log(`\n▶ ${payload.stageName ?? payload.stageKey}`);
      return;
    }
    if (event === "stageDone") {
      console.log(`✔ ${payload.stageName ?? payload.stageKey} 已落库`);
      return;
    }
    // message/delta/confirmTimeout 等其余事件不逐条渲染，只提示存在（产物统一在落库后打印）
  },
} as unknown as Socket;

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    // stdin EOF（管道喂完/断开）视为终止，避免确认点永久挂起
    rl.on("close", () => resolve("q"));
    rl.question(question, (a) => resolve(a.trim()));
  });
}

/** 确认点终端交互：喂给引擎的 resolveStageConfirm（与 socket 路由同语义：confirm/redo/back/abort） */
async function confirmLoop(stageKey: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    const action = await ask(rl, `\n⏸  「${stageLabels[stageKey as NovelStageKey] ?? stageKey}」待确认  [y]通过 / [r]重做 / [b]回退上一步 / [q]终止 > `);
    if (action === "y") {
      resolveStageConfirm(SOCK_ID, stageKey, "confirm");
      break;
    }
    if (action === "r") {
      const note = await ask(rl, "   返工补充要求（可空，直接回车跳过）> ");
      resolveStageConfirm(SOCK_ID, stageKey, "redo", note || undefined);
      break;
    }
    if (action === "b") {
      resolveStageConfirm(SOCK_ID, stageKey, "back");
      break;
    }
    if (action === "q") {
      resolveStageConfirm(SOCK_ID, stageKey, "abort");
      break;
    }
    console.log("   无效输入，请输入 y / r / b / q");
  }
  rl.close();
}

function preview(text: unknown, max = 600): string {
  const s = typeof text === "string" ? text : JSON.stringify(text, null, 2);
  return s.length > max ? `${s.slice(0, max)}\n…（已截断，完整内容见数据库工作区）` : s;
}

// ── 宿主装配：引擎 + 阶段工具 ──

async function main(): Promise<void> {
  if (!MODEL.match(/^.+:.+/)) die('缺少 WF_MODEL 环境变量（格式 "<o_vendorConfig.id>:<模型名>"，如 "1:deepseek-chat"）');
  if (!IDEA) die('缺少 --idea 参数（一句话创作想法，如 --idea "末世拾荒少女与残存AI"）');

  const db = await setupDatabase();
  const projectId = await createProject(IDEA);
  console.log(`[novel-cli] 项目已创建 id=${projectId}，模型=${MODEL}，模式=${AUTO ? "全自动" : "逐阶段确认"}\n`);

  const engine = createStageEngine({
    agentKey: "novelAgent",
    defs: NOVEL_STAGES,
    registry: { agentKey: "novelAgent", stageXmlTag: (k) => stageXmlTag(k as NovelStageKey), stageLabels },
    hooks: {
      // 落库后：打印质检报告；brief 通过即视为选版完成（写 briefConfirmed，Gate4 放行 world/characters）
      async onStagePersisted(pid, stageKey) {
        const report = await u.db("o_check_report").where({ projectId: pid, stageKey }).orderBy("createTime", "desc").first();
        if (report) {
          console.log(`\n📋 质检「${stageLabels[stageKey as NovelStageKey] ?? stageKey}」评级=${report.rating ?? "-"}${report.summary ? `\n   ${String(report.summary).slice(0, 200)}` : ""}`);
          const workData = await engine.getWorkData(pid);
          console.log(`\n──── 产物预览 ────\n${preview(workData[stageKey])}\n────────────────`);
        }
        if (stageKey === "brief") {
          const row = await u.db("o_agentWorkData").where({ projectId: pid, key: "novelAgent" }).first();
          const data = row ? (JSON.parse(row.data ?? "{}") as Record<string, unknown>) : {};
          data.briefConfirmed = "confirmed";
          await u.db("o_agentWorkData").where({ projectId: pid, key: "novelAgent" }).update({ data: JSON.stringify(data) });
        }
      },
    },
  });

  /** 组阶段 prompt：skill（验收标准）+ 想法 + 前序产物 + XML 格式要求 + 引擎传入的追加要求（redo 备注走这里） */
  async function buildStagePrompt(stageKey: NovelStageKey, extra: string): Promise<string> {
    const def = NOVEL_STAGES.find((s) => s.stageKey === stageKey)!;
    const skill = await fs.promises.readFile(path.resolve(process.cwd(), "data/skills", `novel_execution_${stageKey}.md`), "utf-8");
    const workData = await engine.getWorkData(projectId);
    const preloaded = def.preloadKeys
      .filter((k) => workData[k] != null)
      .map((k) => `### ${k}\n${preview(workData[k], 1500)}`)
      .join("\n\n");
    return [
      skill,
      `## 创作想法\n${IDEA}`,
      preloaded && `## 已确认的前序产物\n${preloaded}`,
      renderXmlFormatHint(stageKey),
      extra && `## 本次追加要求\n${extra}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const stageTools: StageToolMap = {};
  for (const def of NOVEL_STAGES) {
    stageTools[def.stageKey] = {
      execute: async ({ prompt }: { prompt: string }) => {
        const res = await u.Ai.Text(MODEL, false, 0).invoke({ prompt: await buildStagePrompt(def.stageKey, prompt) });
        return { raw: res.text };
      },
    };
  }
  // 阶段质检工具（LLM 盲评轨）：引擎在每次生成后自动调用，产出 <checkReport> 评级
  const ctx: AgentContext = {
    socket: cliSocket,
    isolationKey: String(projectId),
    text: IDEA,
    resTool: new ResTool(cliSocket, { projectId }),
    msg: {} as ReturnType<ResTool["newMessage"]>,
    thinkConfig: { think: false, thinlLevel: 0 },
  };
  stageTools.run_stage_check = engine.makeStageCheckTool(ctx, {
    checkAgentKey: "novelAgent:stageCheckAgent",
    name: "阶段质检",
    runSubAgent: async (input: StageCheckRunInput) => {
      const res = await u.Ai.Text(MODEL, false, 0).invoke({
        system: input.system,
        prompt: [input.prompt, input.preloadData ? `## 前置产物\n${JSON.stringify(input.preloadData)}` : ""].filter(Boolean).join("\n\n"),
      });
      return { raw: res.text };
    },
    preloadWorkData: async (keys) => {
      const workData = await engine.getWorkData(projectId);
      const out: Record<string, string> = {};
      for (const k of keys) if (workData[k] != null) out[k] = preview(workData[k], 2000);
      return out;
    },
  });

  // 引擎语义：brief 选版确认后 runWorkflow 统一 return（选版动作与循环解耦，完整版由前端重触发）。
  // 宿主对应做法 = 外层续跑循环：每轮缺口重算，产物齐 → 完成；中止（abort/失败）→ 退出
  for (let round = 1; ; round++) {
    if (round > 1) console.log(`\n──── 第 ${round} 轮：从缺口续跑 ────`);
    const result = await engine.runWorkflow(ctx, { autoFlow: AUTO ? "full" : "manual" }, { stageTools });
    if (!result.ok) {
      console.error(`\n[novel-cli] 流水线中止：${result.error ?? "未知错误"}`);
      break;
    }
    const workData = await engine.getWorkData(projectId);
    // 缺口判定与引擎 isStageGap 同口径：非 chapter 阶段查 stageKey；chapter 落库键是 chapters 数组
    const missing = NOVEL_STAGES.filter((d) => (d.chapter ? !Array.isArray(workData.chapters) || workData.chapters.length === 0 : workData[d.stageKey] == null));
    if (missing.length === 0) {
      console.log("\n🎉 七阶段全部完成。已落库产物：");
      for (const def of NOVEL_STAGES) console.log(`   ✔ ${def.name}（${def.stageKey}）`);
      console.log("\n多章连写/续写/监督修复闭环等宿主扩展点见 README「扩展点」节。");
      break;
    }
    // ok 返回但仍有缺口：只可能是 brief 选版 return，继续下一轮；兜底防死循环
    if (round >= NOVEL_STAGES.length) {
      console.error(`\n[novel-cli] 异常：多轮未推进，剩余缺口 ${missing.map((d) => d.stageKey).join(", ")}`);
      break;
    }
  }
  await db.destroy();
}

main().catch((e: unknown) => {
  console.error("[novel-cli] 运行失败：", e instanceof Error ? e.message : e);
  process.exit(1);
});
