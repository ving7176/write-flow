# qiflow-engine

AI 长文本创作的确定性编排引擎 —— WriteFlow 完整平台的核心层独立包。

从一句话延展成一部小说的七阶段流水线（构思 → 世界模型 → 人物设定 → 梗概 → 大纲 → 章节）背后，是这套可复用的工程化引擎：

- **确定性 DAG 编排**：阶段依赖表驱动 + Gate4 前置门禁 + 缺口重算；DB 为唯一事实源，进程重启/断线后从任意中间态续跑。
- **双轨质量门禁**：LLM 盲评（A/B/C/D 评级）× 代码硬校验（禁忌词 / 重复度 / ERA 时代错位）并行拦截；门禁重做带上限、劣化时自动保留历史最优稿。
- **人在回路状态机**：manual / semi / full 三档授权模型，confirm / redo（针对性返工备注）/ back 显式回退链 / abort 全语义支持。
- **可编程供应商系统**：模型适配代码即数据（`src/lib/vendor.json`），vm 沙箱执行，换供应商零改码。
- **XML 产物消费**：Schema 单一事实源派生标签与校验，格式错自动回灌重生成一次。
- **提示词资产随包**：`data/skills/novel_*` 阶段质检技能文件即引擎验收标准的一部分。

## 环境要求

- Node.js 23.11.1+、Yarn
- PostgreSQL 14+
- 一个大模型 API Key（内置文字供应商适配：DeepSeek / OpenAI / MiniMax / 火山引擎 / AtlasCloud 等）

## 快速开始：本地从零玩起来

### 1. 安装与建库建表

```bash
git clone https://gitee.com/kkje/write-flow.git qiflow-engine
cd qiflow-engine && yarn install
```

建库建表（42 张表一次建齐；也可用 pgAdmin 等客户端执行 `sql/schema.sql`）：

```bash
createdb write-flow                    # 或使用任意现有数据库
psql -d write-flow -f sql/schema.sql
```

### 2. 配置模型（一次性）

引擎的模型调用由数据库驱动：`o_vendorConfig` 表一行 = 一个供应商实例，`id` 必须是**内置供应商名**（适配代码随包 `data/vendor/`：deepseek / openai / minimax / volcengine / atlascloud / grsai / vidu，运行时按 id 读取）。以 DeepSeek 为例（先到 [platform.deepseek.com](https://platform.deepseek.com/) 申请 API Key）：

```sql
INSERT INTO "o_vendorConfig" ("id", "inputValues", "models", "enable") VALUES (
  'deepseek',
  '{"apiKey":"sk-你的密钥","baseUrl":"https://api.deepseek.com"}',
  '[]',
  1
);
```

- `inputValues`：该供应商声明所需的输入项 JSON（各家 `inputs` 定义不同，`apiKey` 必填、`baseUrl` 多数必填）
- `models`：额外模型清单（可 `'[]'`——引擎会把适配代码内置的模型清单与它合并）
- 引用格式为 `"供应商id:模型名"`（如 `deepseek:deepseek-v4-flash`）；各家可用模型见 `data/vendor/<id>.ts` 内的 `models` 定义

密钥只存数据库行，不进代码、不进环境文件、不进 git。

### 3. 体验一：零依赖状态机推演（无 DB、无 Key）

```bash
npx tsx examples/state-machine-demo.ts
```

### 4. 体验二：终端创作流水线（真库 + 真模型）

`examples/novel-cli.ts` 是一个完整的最小宿主（~250 行）：终端输入一句话想法，跑完七阶段流水线，每个阶段生成后自动质检并在终端等你裁决。

```bash
PG_HOST=127.0.0.1 PG_PORT=5432 PG_DATABASE=write-flow PG_USER=postgres PG_PASSWORD=数据库密码 \
WF_MODEL="deepseek:deepseek-v4-flash" \
npx tsx examples/novel-cli.ts --idea "末世废土中的拾荒少女与一台残存的AI"
```

运行中你会看到：

- 自动建项目、自动把 novel 线 13 个 agentKey 绑定到你指定的模型（幂等，可重复运行）
- 逐阶段暂停等你裁决：`[y]`通过 / `[r]`重做（可带补充要求，引擎会把备注回灌进重跑 prompt）/ `[b]`回退上一步 / `[q]`终止；加 `--auto` 全自动跑到底
- 每阶段生成后自动跑 LLM 盲评质检（评级 A/B/C/D）+ 代码硬校验；C/D 级强制停下等你裁决，返回的产物预览含评级与问题摘要
- 产物落库位置：工作区 `o_agentWorkData`、质检报告 `o_check_report`、章节 `o_chapter_plan`/`o_chapter_arc`，可直接 SQL 查看

> 连续多章创作、深度监督修复闭环等进阶玩法是宿主扩展点，见下文「扩展点」。

### 5. 作为库接入你的应用

引擎包只含**编排原语层**；决策层（理解用户意图、调度阶段的对话 Agent）与业务工具集是宿主职责——WriteFlow 完整平台就是官方参考宿主。接入骨架：

```ts
import knexFactory from "knex";
import { configureEngineDb } from "@/utils/db"; // 1. 注入你的 knex 实例
import { createStageEngine } from "@/pipeline/stageEngine"; // 2. 创建引擎
import { NOVEL_STAGES } from "@/agents/novelAgent/workflow"; // 3. 阶段表 SSOT（也可自定义）
import { stageXmlTag, stageLabels } from "@/pipeline/schemas/novel";
import { resolveStageConfirm } from "@/pipeline/stageConfirm";

configureEngineDb(knexFactory({ client: "pg", connection: { /* ... */ } }));

const engine = createStageEngine({
  agentKey: "novelAgent",
  defs: NOVEL_STAGES,
  registry: { agentKey: "novelAgent", stageXmlTag: (k) => stageXmlTag(k as never), stageLabels },
  hooks: { /* 宿主扩展点，见下文 */ },
});

// 4. 提供阶段生成工具（宿主决定如何调模型；可参考 examples/novel-cli.ts 的 buildStagePrompt）
const stageTools = {
  brief: { execute: async ({ prompt }) => ({ raw: await myLLM(prompt) }) },
  run_stage_check: /* 质检工具：用 engine.makeStageCheckTool() 工厂创建 */,
  /* ...world/characters/synopsis/outline/chapter */
};

// 5. 跑流水线（manual=每阶段等确认；semi/full 语义见 decideConfirm）
await engine.runWorkflow(ctx, { autoFlow: "manual" }, { stageTools });
// 确认点：引擎 emit awaitConfirm → 宿主收集用户动作 → resolveStageConfirm(socketId, stageKey, action)
```

## 引擎包 vs 宿主的职责边界

| 引擎包提供（开源） | 宿主实现（完整版即参考实现） |
| --- | --- |
| 阶段表 / DAG 门禁 / 缺口重算 / 状态机 | 决策层对话 Agent（意图理解与调度） |
| 生成-质检-硬校验-门禁重做-落库副作用流水线 | 业务工具集（项目/章节管理等操作） |
| 确认点状态机（confirm/redo/back/abort） | 前端 UI（socket 事件渲染、确认浮层） |
| 可编程供应商系统 + vm 沙箱 | 密钥管理、配额/订阅、多租户 |
| 提示词资产（16 个 novel_* skill） | 会话归档、向量记忆等外围能力 |

## 扩展点（StageHooks）

| Hook | 用途 |
| --- | --- |
| `beforeRunStage` | 执行前改写/拦截 prompt（如章节目标章号解析） |
| `afterSubAgent` | 产物通过 Gate2 后的深度监督（完整版 20 项章节监督在此挂接） |
| `shouldRepeatStage` | 阶段重复执行询问（连续写多章） |
| `shouldForceChapterStage` | 「继续写/写第N章」类指令把章节阶段加回队列 |
| `onStagePersisted` | 落库后回调（brief 选版确认写回、通知等） |
| `makeWorkflowStageTool` / `makeStageCheckTool` | 装配决策层的阶段执行/质检子 Agent 工具 |
| `genMeta` | 生成期断线标记（mark/clearPendingReview），断线恢复用 |

## 目录

```
src/pipeline/            # 编排引擎主体（状态机/门禁/XML 消费/扫描器）
src/agents/novelAgent/   # 小说线阶段表 SSOT、约束、伏笔解析、监督
src/socket/resTool.ts    # 流式消息渲染适配（socket.io peerDependency）
data/skills/             # 提示词资产随包（novel_* 共 16 个；运行时按 cwd/data/skills 解析）
data/vendor/             # 可编程供应商适配代码随包（7 家；运行时按 cwd/data/vendor/<id>.ts 解析）
sql/schema.sql           # 建表语句（42 表，与宿主库同构）
__tests__/               # 行为等价测试（82 例，与主仓同套断言）
examples/                # 零依赖状态机推演 + 真库真模型终端流水线
scripts/cut-engine.mts   # 切割重建工具（维护者用）
scripts/sync-engine.mts  # 主仓→双站一条命令同步（维护者用）
scripts/sync-sentinel.mts # 双站漂移巡检：站点 hash 一致性 + 闭包未同步检测（维护者用）
```

## 开发

```bash
yarn test     # vitest 全量（无需 DB，mock 注入）
yarn lint     # tsc --noEmit
yarn cut      # 源码由宿主仓库切割生成，本包不手工编辑 src/（维护者）
yarn sync     # 主仓变更 → 切割 → 门禁 → 提交推送双站（维护者）
yarn sentinel # 巡检双站 hash 一致性与闭包漂移，--notify 附 macOS 本地通知（维护者）
```

## License

Apache-2.0 —— Copyright 2026 WriteFlow Project Authors
