# 小说创作 · 发布存档与番茄平台发布

> 发布链路两层：①发布存档（本系统内：正文 → publishRecord 记录，替代 xianxia 的 publish.py + release/ 目录）②番茄平台浏览器发布（沿用 xianxia 实战流程，正文源改为本系统导出物）。

---

## 一、数据载体（本系统约定）

发布记录存工作区 `publishRecord` 字段（set_plan_data 可读写），结构对齐 xianxia `notes/publish-record.json`：

```json
{
  "chapters": {
    "1": { "vol": 1, "words": 3011, "hash": "d75eed64", "updated": "2026-08-08", "published": "2026-07-28" }
  }
}
```

- `hash`：正文内容 hash（防重复发布/检测回改）；`published`：首发日期；`updated`：最近覆盖日期
- 发布红线沿用 xianxia：**禁止从未质检达标的章节直发**；发布即记录，无记录视为未发布

---

## 二、发布存档（脚本层等价操作）

1. 用 get_plan_data 读取章卡与正文（章节正文经章节内容接口按章懒加载；或用户指定导出物路径）
2. 对每章：计算正文可见字符数与 hash → 与 publishRecord.chapters[章号] 比对：
   - 无记录 → 新发布：写入 `{vol, words, hash, published: 今日, updated: 今日}`
   - hash 相同 → skip（未改章不重发）
   - hash 不同 → 覆盖更新：仅更新 `hash/words/updated`
3. 用 set_plan_data 回写 publishRecord（合并语义：保留未涉及章的既有记录）
4. 向用户汇报：新发布 N 章 / 覆盖 M 章 / 跳过 K 章

---

## 三、番茄平台浏览器发布（沿用 xianxia 实战流程）

> 前置：用户已登录番茄作家后台的浏览器（control-browser skill，IAB 后端）；作品 ID 由用户提供。
> 正文源：本系统导出物（导出全文 txt，每章以「第N章 章名」分隔）；或按用户指定章节清单从章节内容接口取正文。

### 0. 待发布清单
1. 与用户确认章节清单（去重；与上轮重叠合并为一次批量覆盖，避免重复触发平台重审）
2. 对照 publishRecord：未改章（hash 相同）自动 skip

### 1. 登录与定位
1. 打开 `https://fanqienovel.com/main/writer/chapter-manage/<作品ID>?type=1`；跳登录页则扫码（凭证只有用户有）
2. 列表倒序、每页 15 章，页码 = ceil((总章数 - 章节号 + 1) / 15)；翻页用 getByRole("listitem", { name: "第 N 页" })（数字文本须 role+name 定位）
3. 章节行：getByRole("row").filter({ hasText: "第NN章 章节名" }) → 修改链接 a[href*="enter_from=modifychapter"] → 等编辑页 URL 含 /publish/<章节ID>

### 2. 正文注入（ProseMirror）
1. **先确认编辑器内容是目标章节**（SPA 残留上一章内容是高频坑）：.ProseMirror 第一个的 textContent 开头比对目标章首句，不符 → reload 重进
2. bodyEditor = .ProseMirror.first()（页面 5 个编辑器，正文是第一个；不稳则 filter({ hasText: 首句 })）
3. fill(body) 是唯一可靠注入方式；正文提取：去 frontmatter/标题行（标题正则必须加 m 标志）/分隔线，压缩 3+ 连续换行
4. **fill 后验证长度**：textContent.length ≈ 目标字数（±10），防截断

### 3. 发布动作
1. 「下一步」→ 发布设置对话框 → 「是否使用 AI」选「是」（radio 视觉隐藏，用 label:has-text）→ 「确认发布」
2. 弹「检测到错别字未修改」→ 点「提交」（用户意图 = 忽略错别字）；回到发布设置 → 重新选「是」+ 确认发布

### 4. 发布后
1. 逐章验证列表行状态/字数
2. 更新 publishRecord（合并回写）+ 向用户汇报发布清单
