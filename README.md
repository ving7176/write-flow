# qiflow-engine

AI 长文本创作的确定性编排引擎 —— QIFLOW 的核心层独立包。

从一句话延展成一部小说的七阶段流水线（构思 → 世界模型 → 人物设定 → 梗概 → 大纲 → 章节）背后，是这套可复用的工程化引擎：

- **确定性 DAG 编排**：阶段依赖表驱动 + Gate4 前置门禁 + 缺口重算；DB 为唯一事实源，进程重启/断线后从任意中间态续跑。
- **双轨质量门禁**：LLM 盲评 × 代码硬校验（禁忌词 / 重复度 / ERA 时代错位）并行拦截；门禁重做带上限、劣化时自动保留历史最优稿。
- **人在回路状态机**：manual / semi / full 三档授权模型，confirm / redo（针对性返工备注）/ back 显式回退链 / abort 全语义支持。
- **XML 产物消费**：Schema 单一事实源派生标签与校验，格式错自动回灌重生成一次。
- **提示词资产随包**：`data/skills/novel_*` 阶段质检技能文件即引擎验收标准的一部分。

## 快速体验（零依赖）

```bash
npx tsx examples/state-machine-demo.ts   # 纯状态机剧情推演，无需 DB 与 API Key
yarn test                                # 78 例单测（转移矩阵 + 编排全流程）
```

## 构建与刷新

源码由宿主仓库切割生成，本包不手工编辑 `src/`：

```bash
yarn cut     # 从 ../../app/src 按 scripts/cut-engine.mts manifest 重建 src/
yarn lint    # tsc --noEmit
```

## 宿主接入

```ts
import { configureEngineDb } from "@/utils/db"; // 注入你自己的 knex 实例（PG14+，schema 见 ../sql/schema.sql）
// socket.io / ai SDK 依赖按需装配后，使用 pipeline 的 runWorkflow / runStageDirect /
// makeWorkflowStageTool / createWfLoop / decideConfirm 组合你的编排层。
```

数据访问采用注入模式：引擎内部统一经聚合运行时取 `db`，宿主负责生命周期与迁移策略。

## 目录

```
src/pipeline/            # 编排引擎主体（状态机/门禁/XML 消费/扫描器）
src/agents/novelAgent/   # 小说线阶段表 SSOT、约束、伏笔解析、监督
src/socket/resTool.ts    # 流式消息渲染适配（socket.io peerDependency）
data/skills/             # 提示词资产随包（novel_* 共 16 个；运行时按 cwd/data/skills 解析）
__tests__/               # 行为等价测试（与主仓同套断言）
examples/                # 零依赖演示脚本
scripts/cut-engine.mts   # 切割重建工具
```

## License

Apache-2.0 —— Copyright 2026 WriteFlow Project Authors
