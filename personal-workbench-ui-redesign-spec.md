# 个人工作台 V3「任务驱动」UI 重构规格书（Round 5）

> 产品经理产出 · 2026-06-10
> 视觉基准：`artifacts/personal-workbench-ui-redesign-v3.html`（可交互示意图，浏览器打开对照实现）
> 改造对象：`personal-workbench/index.html`、`style.css`、`renderer.js`（必要时 `main.js`、`preload.js`）

---

## 0. 设计目标与总原则

**核心理念：任务是一等公民。** 任务流水线（准备 → 本地测试 → 评估上传 → 捕获报告 → Hermes 诊断）是贯穿全应用的主线，UI 必须让用户随时知道"现在在第几步"。

四个融合点：

| # | 新组件 | 取代 | 说明 |
|---|--------|------|------|
| 1 | 任务中心首页（Home View） | 菜单栏"任务"下拉抽屉 `#task-manager-panel` | 应用默认落地页 |
| 2 | 任务舱（Task Rail，右侧常驻栏） | 菜单栏中间小横幅 `#active-task-banner` | 跨标签页持续可见 |
| 3 | 底部状态栏任务芯片 | 无 | 任务舱收起时的最小感知 |
| 4 | 侧边栏标签脉冲点 | 无 | 流程进行到哪个标签页，该标签亮橙色脉冲点 |

**硬性约束：**
- 不引入任何前端框架，维持原生 JS + CSS。
- 不破坏既有能力：webview 常驻不重载、标签拖拽排序、左右/底部分屏、扩展加载、终端（node-pty）、任务暂停/恢复、上传拦截 `setupWebviewUploadInterceptor`、下载捕获 `handleDownloadCompleted`、Hermes 注入 `runHermesPrompt`。
- 保持 CSP 与 contextIsolation 安全设定，不放宽 preload IPC 面。
- `task_system_requirements.md` 中已修复的三个问题（composedPath 判定、Token 注入白名单、路径穿越）不得回退。

---

## 1. 设计令牌（style.css 重写 :root）

```css
:root {
  --bg-app: #f4f7f9;        /* 应用底色 */
  --bg-surface: #ffffff;    /* 卡片/面板 */
  --bg-sunken: #eef2f5;     /* 输入框/下沉区 */
  --border: #e2e8ee;
  --border-strong: #cbd6e0;
  --text-1: #16242f;        /* 主文字 */
  --text-2: #4d6173;        /* 次级文字 */
  --text-3: #8aa0b2;        /* 弱化文字 */
  --primary: #0d9488;       /* teal 主色：品牌/已完成步骤/主按钮 */
  --primary-strong: #0f766e;
  --primary-light: #f0fdfa;
  --primary-border: #99f6e4;
  --cta: #f97316;           /* 橙色行动色：仅用于"执行"按钮、进行中状态、当前步骤 */
  --cta-strong: #ea580c;
  --cta-light: #fff7ed;
  --warn: #b45309;  --warn-bg: #fffbeb;   /* 已暂停 */
  --ok: #15803d;    --ok-bg: #f0fdf4;     /* 已完成 */
  --danger: #dc2626; --danger-bg: #fef2f2;
  --info: #1d4ed8;  --info-bg: #eff6ff;   /* 评估中 */
}
```

颜色语义铁律：**橙色只表达"正在进行/需要行动"**（执行按钮、当前步骤、运行中徽章、脉冲点、任务芯片）；teal 表达"品牌/已完成步骤/确认类主按钮"。不要混用。

字体维持系统栈：`"Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif`；等宽场景（文件名、路径）用 `Consolas, monospace`。

---

## 2. 布局骨架改造（Phase 1）

### 2.1 删除双层头部，合并为单层顶栏

- **删除** `#app-menu-bar` 整个节点及其样式。
- 原菜单项去向：
  - 「任务」→ 由任务中心首页取代（见 2.3），不再需要按钮。
  - 「终端」→ 移到底部状态栏（见 2.4）。
  - 「工作台/编辑/视图」（扩展设置、复制粘贴全选、重新加载）→ 收进顶栏最右侧「⋯ 更多」popover（hover 或 click 展开均可，建议 click + 失焦关闭）。
- 改造后的 `.topbar`（高度 52px）：
  ```
  [侧栏切换] [面包屑: 当前视图名 + 副标题] [地址栏(仅浏览视图显示)] [扩展工具栏] [⋯更多]
  ```
- **地址栏显隐规则**：当前激活的是任务中心 → 隐藏地址栏，面包屑显示「任务中心 · 本周 N 项 · 进行中 M 项」；激活的是 webview 标签 → 显示地址栏（保留 back/forward/reload/trainTaskId 提取按钮，全部换成 SVG 图标，禁止 emoji 与字符箭头）。

### 2.2 左侧导航重组

结构（自上而下）：
1. 品牌区（保留，副标题改 "Task-First Workbench"）。
2. **「任务中心」导航项**：置顶独立分组，带网格 SVG 图标；右侧角标显示待处理任务数（橙色圆角徽章）。点击切换到任务中心视图。
3. 「工作空间」分组：现有标签列表逻辑全部保留（`renderTabs`、拖拽、分类折叠）。新增：**当 `pipelineState.active` 且流程当前停留在某标签**（评估平台或 Hermes）时，该标签项右侧渲染橙色脉冲点 `.running-pulse`（CSS animation，`prefers-reduced-motion` 下停用动画只保留静态圆点）。
4. 底部连接状态（保留）。

实现提示：任务中心可实现为一个特殊的"内置视图"。建议在 `renderer.js` 中将 `activeTabId` 扩展支持特殊值 `"__taskcenter__"`，`activateTab` 时隐藏所有 `.tab-viewport`、显示 `#task-center-view` 节点；这样无需引入路由概念。

### 2.3 任务中心首页（取代下拉抽屉）

**删除** `#task-panel-overlay`、`#task-manager-panel` 下拉抽屉及 `openTaskPanel/closeTaskPanel` 的展开收起逻辑（数据层函数保留）。新增 `#task-center-view`（与 `#webview-stack` 同级或内部互斥显示），包含：

1. **页头**：`本周任务` 标题 + 周次副标题 + 右侧橙色「添加任务」按钮（打开原任务表单，表单改为居中 dialog，复用现有 `#task-form` 字段与校验，school/course/type/quantity/owner 不变）。
2. **统计行**：4 张统计卡（本周任务 / 进行中 / 已暂停 / 已完成），数字从 `weeklyTasks` 实时计算。
3. **进行中聚焦卡**（`pipelineState.active` 时渲染，否则整块隐藏）：
   - 任务标题 + 类型徽章 + 「暂停」「查看详情」按钮（暂停调用现有 `pauseTaskAutomation`）。
   - 元信息：负责人、任务文件夹路径。
   - **水平 5 步流水线 stepper**：步骤定义见 §4；已完成步骤 teal 实心 + 对勾，当前步骤橙色描边 + 光晕，未来步骤灰描边。
4. **任务卡片网格**（取代表格，`renderWeeklyTasks` 重写为 `renderTaskCenter`）：
   - 分组：「待处理 / 已暂停」、「已完成」（已完成组卡片 opacity 0.82）。
   - 每卡内容：学校（主标题）/ 课程 + 类型（副标题）、状态徽章、负责人、数量、**进度条 + 步骤文案**（如 `2/5 本地测试`）、产物 chips（dialogue.json / eval_report.pdf，存在才显示）、底部操作区。
   - **操作收敛铁律**：卡片主操作只保留一个按钮 —— 待处理→橙色「执行」；已暂停→teal「继续」；已完成→「打开产物文件夹」。「编辑」「删除」收进卡片右下角「⋯」菜单（popover，参考 task_system_requirements.md §1 用 composedPath 判定外点关闭）。
   - 执行/继续/暂停/删除分别接现有 `startTaskAutomation / resumeTaskAutomation / pauseTaskAutomation / deleteWeeklyTask`，防冲突 toast 逻辑不变。

### 2.4 底部状态栏（新增，高 32px）

`.statusbar` 固定在 main 列最底部（终端面板之下），左→右：
1. 「终端」按钮：toggle `toggleTerminal`，打开时按钮高亮（`.on` 态 teal 浅底）。
2. 分隔线。
3. **任务芯片** `#sb-task-chip`：`pipelineState.active` 时显示「{学校缩写} · {课程} — {当前步骤名} {n}/5」+ 橙色脉冲点；点击展开任务舱。无活动任务时整个芯片隐藏（不显示占位文字）。
4. 右侧：`temp/tasks 已挂载` 提示 + 连接状态点。

终端面板本体逻辑不变（node-pty、resizer、xterm），仅入口从菜单栏迁到状态栏。

---

## 3. 任务舱 Task Rail（Phase 2 核心）

### 3.1 结构与位置

- 新增 `<aside id="task-rail">`，作为 **`.main-col` 内 `.content-row` 的 flex 兄弟元素**（与视图区平级，位于最右），宽 296px，展开/收起用 width 过渡（参考 Round 4 蓝线修复经验：**绝不用绝对定位叠在 webview 上**，flex 兄弟天然不会被原生 webview 遮挡）。
- 注意与现有 `#right-sidebar`（分屏）共存：任务舱排在 right-sidebar 更外侧（最右）；两者同时打开时均为 flex 项，互不重叠。
- **收起态**：宽度 0 + 右缘悬浮把手 `#rail-handle`（26px 宽小条，含迷你进度环 + 竖排「任务 n/5」文字），点击展开。把手仅在 `pipelineState.active` 时显示。
- 无活动任务时：任务舱与把手都不渲染。

### 3.2 任务舱内容（自上而下）

1. **头部**：`ACTIVE TASK` eyebrow + 收起按钮；任务标题；状态徽章（`步骤 n/5 · {步骤名}`）+ 负责人。
2. **执行流程**（垂直 stepper，5 步，见 §4）：每步含标题 + 描述行（描述里文件名/路径用 `<code>`）。状态样式同水平 stepper。
3. **任务产物**：3 行 artifact 列表 —— 任务文档（若 taskFolder 内检测到）、`dialogue.json`（task.chatLogPath）、`eval_report.pdf`（task.reportPath）。每行：文件图标 + 名称 + 来源/大小副文案 + 右侧状态徽章（`就绪` 绿 / `等待` 灰，未就绪行 opacity 0.65）。
4. **底部操作区**（固定底部）：
   - 主按钮「加载至 Hermes」：调用现有 `runHermesPrompt`；**仅当 `task.reportPath` 非空才激活**，否则 disabled + 半透明 + title 提示「捕获报告后激活」。
   - 次行两个 ghost 按钮：「暂停任务」（amber 描边）、「结束任务」（红描边，调用 `finishActiveTask`）。

### 3.3 状态接线

- 重写 `updateActiveTaskMenu(task)` → `updateTaskRail(task)`：横幅 DOM 已删除，此函数负责渲染/更新任务舱、状态栏芯片、侧边栏脉冲点三处。
- `pipelineState.step` 变化的所有调用点（`startTaskAutomation`、`runEvaluationUpload`、`handleDownloadCompleted`、`pauseTaskAutomation`、`resumeTaskAutomation`、`finishActiveTask`）统一改为调用 `updateTaskRail`。
- 暂停时：任务舱整体隐藏（与现有"横幅隐藏"语义一致），任务中心聚焦卡消失，对应任务卡变「已暂停」。

---

## 4. 流水线步骤统一模型

新增单一事实来源（renderer.js 顶部常量）：

```js
const PIPELINE_STEPS = [
  { key: "prepare",    name: "准备",       desc: "建立任务文件夹" },
  { key: "testing",    name: "本地测试",   desc: "生成 dialogue.json" },
  { key: "evaluating", name: "评估上传",   desc: "评估平台自动注入" },
  { key: "report",     name: "捕获报告",   desc: "自动拦截下载归档" },
  { key: "hermes",     name: "Hermes 诊断", desc: "一键载入产物路径" },
];
```

- 现有 `pipelineState.step` 取值需归一映射到上述 key（现状有 `"testing"`、`"evaluating"`、`"idle"` 等；`prepare` 在 `startTaskAutomation` 创建文件夹瞬间，`report` 在 `handleDownloadCompleted` 成功后，`hermes` 在 `runHermesPrompt` 触发后）。
- 进度数 `n/5 = PIPELINE_STEPS.findIndex(s => s.key === step) + 1`。
- 水平 stepper（任务中心聚焦卡）、垂直 stepper（任务舱）、任务卡进度条、状态栏芯片，全部从该常量 + `pipelineState` 派生渲染，**禁止四处硬编码步骤名**。

---

## 5. 视觉细则（对照示意图）

- 圆角体系：卡片 13-16px、按钮 8-10px、徽章 999px。
- 阴影三档：`--shadow-sm/md/lg`（示意图 :root 中有现成值）。
- 状态徽章配色：待处理灰、进行中橙（带边框）、评估中紫、已暂停 amber、已完成绿 —— 与现有 `status-*` class 对齐，仅换色值。
- **图标一律内联 SVG（Lucide 风格，24 viewBox，stroke 2）**，删除现有 `🆔`、`×`、`←` 等字符/emoji 图标。
- 所有可点元素 `cursor: pointer`，hover 用颜色/阴影过渡（150-250ms），禁止 scale 引起布局抖动。
- 动画统一尊重 `@media (prefers-reduced-motion: reduce)`。

---

## 6. 分期与验收标准

### Phase 1 — 布局骨架（先交付）
1. 双层头部合并为单层顶栏；「更多」popover 收纳扩展设置/编辑/重载，功能可用。
2. 任务中心成为默认落地视图；统计卡数字正确；任务卡片网格渲染正确；添加/编辑/删除/执行/暂停/继续全部功能与改造前等价。
3. 下拉抽屉与遮罩代码、`#active-task-banner` 删除干净，无残留死代码与样式。
4. 底部状态栏出现，终端从状态栏正常开关、resizer 正常。
5. webview 标签切换/拖拽/分屏/扩展不回归。
6. `npm run check` 通过。

### Phase 2 — 任务舱与状态贯通
1. 执行任务后：任务舱自动展开，5 步流程实时推进（执行→准备/测试完成→评估上传→报告捕获逐步点亮）。
2. 切换到任意其他标签页，任务舱保持可见且状态同步；收起后把手 + 状态栏芯片可感知进度，点击均可重新展开。
3. 产物列表三个文件状态实时正确；「加载至 Hermes」在 reportPath 就绪前 disabled，就绪后点击行为与原按钮一致。
4. 暂停：任务舱/把手/芯片全部消失，任务中心对应卡片变「已暂停」+「继续」；继续后全部恢复（含防冲突 toast）。
5. 侧边栏脉冲点：评估上传阶段亮在评估平台标签，Hermes 阶段亮在 Hermes 标签。
6. `npm run check` 通过；按 task_system_requirements.md §4 验收项 1-6 全量回归。

### 提交要求
- 分两个 commit（Phase 1 / Phase 2），message 用英文祈使句风格与仓库现有记录一致。
- 完成每个 Phase 后截图（任务中心、浏览+任务舱两个视图）回报。
