# 三项功能实施计划

> 目标：把「周报首版」「任务中心日常可用性」「文件总线可见闭环」补完整。  
> 依据：`docs/PROJECT_HANDBOOK.md`、当前 `renderer.js` / `main.js` / `preload.js` / `index.html` 实现。  
> 日期：2026-07-16  
> 文档状态：历史实施计划 / 验收记录。A/B/C 已实现；A.1、B.1、C.1 保留的是施工前事实快照，不代表当前状态。当前事实以 [`PROJECT_HANDBOOK.md`](./PROJECT_HANDBOOK.md) 和代码/测试为准。
> 最近同步：2026-07-24；本次只读核对确认实现已落地，完整 E2E 因 `cards-bay.e2e.js` 曾无输出挂起而未声明全量通过。

## 实施状态

| 功能 | 状态 | 说明 |
|---|---|---|
| A. 周报历史周次 + 模板字段 | **已实现（2026-07-16）** | 历史列表、prev/next、`weeklyReportDefaults`、生成保留备注；见手册变更记录 |
| B. 任务筛选 / 搜索 / 归档 | **已实现（2026-07-16）** | 搜索/状态 chips/学校筛选/归档字段；见手册变更记录 |
| C. 产物徽章 + 报告到达通知 | **已实现（2026-07-16）** | 三枚徽章、文件夹回扫、后台 Notification；见手册变更记录 |

本机验收步骤见 [`ACCEPTANCE_CHECKLIST_ABC.md`](./ACCEPTANCE_CHECKLIST_ABC.md)。


## 0. 总原则

1. **最小改动**：只改达成行为所需的行；不顺手重构 `main.js` / `renderer.js` 大拆分。
2. **不越界**：不做企业微信/腾讯文档 API；不扩大 Token/扩展权限；不把个人任务数据写进 Git。
3. **IPC 契约优先**：能在 renderer 完成的逻辑放 renderer；必须碰系统能力时再加主进程 API。
4. **可验证**：每个功能至少有静态或 E2E 覆盖；不能自动化的写明人工验收。
5. **交付同步**：改完后更新手册功能表、变更记录、相关测试与 README 入口（如有）。

## 推荐实施顺序

| 顺序 | 功能 | 理由 |
|---|---|---|
| 1 | A. 周报历史周次 + 模板字段 | 底层已有 `periodKey` 切换与多周存储；补 UI/默认值即可闭环手册推荐第 1 项 |
| 2 | B. 任务筛选 / 搜索 / 归档 | 纯 renderer + 少量任务字段；日常使用频率最高 |
| 3 | C. 产物徽章 + 报告到达通知 | 卡片已有部分芯片；补 cards 识别与系统通知，依赖任务字段稳定 |

可拆成 3 个独立提交（`feat:`），每个提交自带测试与手册片段更新。

---

## A. 周报历史周次 + 模板字段

### A.1 现状（代码事实）

- 周报按 `periodKey`（`YYYY-Www`）存 `userData/weekly-reports.json`。
- UI 已有 `#report-period`（`type="week"`），`switchWeeklyReportPeriod()` 会在切换前自动保存脏草稿。
- `loadWeeklyReports()` 已按 `periodKey` 去重并加载当前周；历史数据已能落盘，但**没有历史列表与快速翻周**。
- 标题默认 `reportTitleForPeriod()`（如 `M7W2周报`），姓名默认空；**无持久化模板**。
- 「从任务生成」`generateReportRowsFromTasks()` 已按 `sourceTaskId` 合并已有行，保留手动 `note/status`。

### A.2 目标行为

1. **历史周次可选**
   - 周报中心展示「已保存周次」列表（按 `periodKey` 倒序），点击切换。
   - 保留现有 `#report-period` week 输入；增加「上一周 / 下一周」按钮。
   - 切换到尚无草稿的周次时，用模板生成空草稿（不自动覆盖已有周报）。
2. **模板字段**
   - 偏好中增加周报默认值：`author`、`titlePattern`（可选，默认仍走 `reportTitleForPeriod`）。
   - 新建周报（`newWeeklyReport`）时填入默认姓名；标题规则：有 `titlePattern` 则替换占位符，否则沿用现逻辑。
   - 设置页或周报中心提供「把当前姓名存为默认」入口（最小 UI：周报 meta 区一个 ghost 按钮即可）。
3. **从任务再生成策略（明确 UX，不静默）**
   - 保持现有合并逻辑（按 `sourceTaskId` 刷新进度/数量/学校课程；保留手动 note 与用户改过的 status）。
   - 生成前若当前周已有非空草稿，toast 文案改为：「已从任务刷新，手动备注已保留」。
   - **本阶段不做**「完全覆盖 / 丢弃手动行」双模式，避免增加确认弹窗复杂度；若后续需要再加。

### A.3 非目标

- 多人协作冲突合并。
- 企业微信 API 直连。
- 跨设备同步周报。

### A.4 数据与偏好

扩展 `workbench-prefs.json`（`normalizeWorkbenchPrefs`）：

```json
{
  "cropSide": "bottom",
  "cropPixels": 100,
  "todoFilePath": "",
  "platformFieldMap": {},
  "theme": "sky",
  "weeklyReportDefaults": {
    "author": "",
    "titlePattern": ""
  }
}
```

- `titlePattern` 支持占位符：`{period}`、`{month}`、`{weekOfMonth}`、`{isoWeek}`。空字符串 = 使用现有 `reportTitleForPeriod`。
- 周报记录结构**不改**；仍以 `periodKey` 为唯一键。

### A.5 改动面

| 文件 | 改动 |
|---|---|
| `main.js` | `normalizeWorkbenchPrefs` 接纳 `weeklyReportDefaults`；过滤非字符串脏数据 |
| `renderer.js` | 历史列表渲染；prev/next；`newWeeklyReport` 读默认值；「存为默认姓名」；生成 toast 文案 |
| `index.html` | 周报 meta 区：历史列表容器、上一周/下一周、存默认按钮 |
| `style.css` | 历史周次列表紧凑样式（与现有 report-panel 一致） |
| `tests/weekly-report.e2e.js` | 切换历史周次、默认姓名写入新周、再生成保留 note |
| 可选单元 | 抽 `applyReportTitlePattern(periodKey, pattern)` 到可测纯函数（若逻辑超过 ~15 行） |

**不改** `preload.js`（prefs API 已有）；**不改** 周报 IPC 契约。

### A.6 实现步骤

1. 扩展 prefs 归一化 + 设置/周报侧读写默认姓名。
2. `newWeeklyReport` / `normalizeWeeklyReport`（仅当 author 为空）填默认 author。
3. UI：`#report-history-list` 渲染 `weeklyReports` 倒序；高亮当前 `periodKey`。
4. 上一周/下一周：基于 ISO week 加减，调用已有 `switchWeeklyReportPeriod`。
5. 补 E2E：写入两周假数据 → 打开周报 → 点历史项 → 字段切换正确；新建周有默认 author。
6. 更新手册 §3 周报行为 + §11 变更记录。

### A.7 验收

- [x] 可在历史列表看到至少 2 个已保存周次并切换，内容不串。
- [x] 脏草稿切换周次仍会先保存（沿用现逻辑）。
- [x] 默认姓名只影响**新建**周报，不覆盖已有周报 author。
- [x] 周报相关单元测试通过；`npm run test:all` 尚未重新声明全量通过，详见项目手册 §8。
- [ ] 人工：企业微信粘贴完整周报/表格（既有能力，不回归）。

### A.8 风险

- `type="week"` 与 ISO `periodKey` 在个别 Chromium/时区边界可能差一天：继续复用现有 `currentReportPeriod` / `dateFromReportPeriod`，E2E 用固定 `periodKey` 字符串，不依赖本机「今天」。
- 历史列表过长：首版只展示已保存周次 + week 输入任意跳转，不做分页。

---

## B. 任务筛选 / 搜索 / 归档

### B.1 现状

- `renderTaskCenter()` 固定三组：`pending|paused`、`unsubmitted`、`completed`；进行中在 focus card。
- 任务字段含 `school`、`course`、`taskType`、`status`、`owner`、`note`、`weekday`。
- **无**搜索框、状态/学校过滤、归档概念。
- 完成组文案写死「本周还没有已完成的任务」，实际是全量 completed，无时间窗。

### B.2 目标行为

1. **搜索**
   - 任务中心工具条：`#task-search` 输入框。
   - 匹配字段：`school`、`course`、`owner`、`note`、`taskType` 中文标签；大小写不敏感；去空格子串匹配。
2. **筛选**
   - 状态 chips：全部 / 待处理 / 进行中 / 已暂停 / 未提交 / 已完成 / 已归档。
   - 学校下拉：从当前任务集动态生成选项（「全部学校」+ 去重 school）。
   - 统计卡**仍显示全局计数**（不受筛选影响），避免「点筛选后总数变了」的困惑；列表与空状态受筛选影响。
3. **归档**
   - 任务增加可选字段 `archived: boolean`（默认 `false`）。
   - 卡片菜单：「归档」/「取消归档」。
   - 默认列表**隐藏** `archived === true`；筛选选「已归档」才显示。
   - 归档不改变 `status`、不删文件夹、不改 `chatLogPath`/`reportPath`。
   - 写回「待做任务.txt」时：归档任务视为已从本周活跃列表移出（若现有写回逻辑会枚举全部任务，需只写未归档；实现时对照 `writeTodoFile` 路径单测/手工确认）。

### B.3 非目标

- 跨周任务数据库、多工作区。
- 批量多选操作（可列为后续；本阶段仅单卡归档）。
- 服务端同步。

### B.4 数据

`tasks/weekly_tasks.json` 任务对象扩展：

```json
{
  "id": "task-id",
  "archived": false
}
```

- `normalizeWeeklyTask` 强制 `archived = Boolean(task.archived)`。
- 旧数据缺字段 = 未归档。

### B.5 改动面

| 文件 | 改动 |
|---|---|
| `renderer.js` | `taskCenterFilters` 状态；`getVisibleTasks()`；改 `renderTaskCenter` 用过滤结果；归档 action；搜索 debounce（~150ms） |
| `index.html` | `home-head` 或 stat-row 下增加 filter bar |
| `style.css` | filter bar、chip 激活态 |
| `tests/` | 新增 `tests/task-filter-helpers.test.js`（纯函数：匹配/归档过滤）+ 可选 `task-controls.e2e.js` 增补 |
| `task_system_requirements.md` | 若仍维护，补归档语义一句 |

**尽量不改** `main.js`：任务读写仍走现有 `tasks:read-weekly` / `write-weekly`。

### B.6 实现步骤

1. 抽出纯函数（便于单测）：

```text
matchesTaskQuery(task, query) -> boolean
filterTasks(tasks, { query, status, school, showArchivedOnly }) -> tasks
```

2. `normalizeWeeklyTask` 增加 `archived`。
3. UI filter bar + 状态绑定；`renderTaskCenter` 入口改为 `getVisibleTasks()`。
4. 分组逻辑保持：visible 集内再分 active / unsubmitted / done；archived-only 模式单独一区或复用 done 区标题改为「已归档」。
5. 卡片菜单归档/取消归档 → `updateTaskFields`。
6. 单测覆盖：空 query、中文学校、归档隐藏、状态 chip。
7. E2E：导入 3 条不同状态任务 → 搜索只剩 1 条 → 归档后默认列表消失 → 选已归档可见。
8. 更新手册 §5.3 任务字段 + §3 任务中心状态。

### B.7 验收

- [x] 搜索「医学」只显示课程/学校含该字的任务。
- [x] 状态 chip「已暂停」与统计卡 paused 数字语义一致（统计仍全局）。
- [x] 归档后默认不可见；筛选「已归档」可见且可取消归档。
- [x] 归档不清除产物路径；重新打开任务流程不受影响。
- [x] `npm test` + 相关 E2E 通过。

### B.8 风险

- `renderTaskCenter` 重渲染频繁：搜索输入必须 debounce，避免每个按键整表 rebuild 卡顿。
- 与 focus card / 活动流水线任务：活动任务即使被筛选隐藏，任务舱仍应保留（筛选只影响中心网格，不影响 `pipelineState`）。
- 写回待做任务：实现时打开现有 writeback 代码路径确认是否会把归档任务写回；若会，过滤掉。

---

## C. 产物徽章 + 报告到达通知

### C.1 现状

- 任务卡 `taskCardElement` 已有 `dialogue.json` / `eval_report.pdf` 芯片（依赖 `chatLogPath` / `reportPath`）。
- 任务舱托盘能识别 `cards.md` 并解析；**任务卡上无 cards 徽章**。
- `handleDownloadCompleted` 对 report 已 `showToast`；窗口在后台时 toast 可能不可见。
- `task-folder-changed` 只触发 `refreshRailTray()`，不回扫任务卡徽章。
- 无 Electron `Notification`。

### C.2 目标行为

1. **产物徽章（任务卡）**
   - 统一三种关键产物：
     - 对话：`chatLogPath` 或文件夹内 dialogue 类文件
     - 报告：`reportPath` 或 `eval_report*`
     - 卡片：`cards.md` 存在
   - 芯片状态：`ready` / `missing`（missing 用 muted 样式，ready 用实色）。
   - 点击 ready 芯片：打开文件或定位文件夹（复用 `taskFileAction` / `openTaskFolder`）。
2. **文件夹回扫（轻量）**
   - 当任务有 `taskFolder` 时，在 `renderTaskCenter` 或 `task-folder-changed` 后异步 `listTaskFiles`，推导 badges，**不**在每次渲染阻塞。
   - 回扫结果缓存：`Map<taskId, { mtimeOrSig, badges }>`，文件夹未变不重复 IPC。
   - 回扫**只更新展示**；是否写回 `chatLogPath`/`reportPath`：
     - 若路径为空且发现标准文件名 → 可写回路径（与下载归档一致）。
     - 若路径已有 → 不覆盖。
3. **报告到达通知**
   - 主进程在下载 `type === "report"` 且 `state === completed` 时：
     - 现有 `download-completed` 事件保留。
     - 若主窗口未聚焦，发系统 `Notification`（标题：评估报告已就绪；正文：学校 + 课程或文件名）。
   - Windows 需 `app.setAppUserModelId`（若尚未设置）以保证通知显示；查 `main.js` 现有 app 就绪逻辑，缺则补最小一行。
   - 用户关闭系统通知权限时静默失败，不影响 toast。

### C.3 非目标

- 通用任意文件类型的智能分类。
- 邮件/企业微信推送。
- 报告 PDF 应用内预览（可后续）。

### C.4 数据

可选任务字段（展示缓存，非必须持久化）：

```json
{
  "artifacts": {
    "chat": true,
    "report": true,
    "cards": true
  }
}
```

**推荐首版**：不新增持久化字段，仅用内存 cache + 已有 `chatLogPath`/`reportPath` + 文件夹 list。减少写放大与迁移。

### C.5 改动面

| 文件 | 改动 |
|---|---|
| `main.js` | report 完成时条件触发 `Notification`；确认 `app.setAppUserModelId('com.personal.workbench')` |
| `renderer.js` | `taskArtifactsFromPathsAndFiles()`；任务卡徽章 UI；`onTaskFolderChanged` 刷新相关任务徽章；下载 report 时若窗口可见仍 toast |
| `style.css` | `.file-chip.ready` / `.file-chip.missing` / cards 芯片 |
| `tests/` | 纯函数单测文件名识别；E2E 可在夹具任务文件夹放入假 `cards.md` 断言芯片出现 |
| `preload.js` | 通常不改 |

### C.6 实现步骤

1. 纯函数：根据文件名列表 → `{ chat, report, cards }`（与 main 下载命名规则对齐：`dialogue*`、`eval_report*`、`cards.md`）。
2. 改 `taskCardElement` 芯片渲染，始终显示三枚（或至少 chat/report/cards 有一真才显示组）。
3. `scheduleArtifactRefresh(taskId)`：debounce list files → patch cache → 若该卡在 DOM 中则局部更新芯片，避免整表闪烁。
4. `onTaskFolderChanged` / `handleDownloadCompleted` 触发 refresh。
5. main：report 下载完成 + `!mainWindow.isFocused()` → Notification。
6. 单测文件名规则；E2E 用 temp 任务夹 + 写文件触发（若 E2E 难模拟下载，至少测 list 后渲染）。
7. 更新手册 §6 数据流 + 风险（通知依赖系统权限）。

### C.7 验收

- [x] 有 `chatLogPath` 的任务显示对话徽章 ready。
- [x] 任务夹内放入 `cards.md` 后，任务卡在文件夹变更或重新进入中心后出现卡片徽章。
- [x] 报告下载完成：前台 toast；后台系统通知（人工在 Windows 验证）。
- [x] 无活动任务时的普通下载不误发「评估报告」通知。
- [x] 安全：`listTaskFiles` 仍受 temp/tasks 边界约束，不新增路径穿越面。

### C.8 风险

- 每个任务都 list 文件夹可能在任务多时抖 IPC：必须 cache + debounce；仅对「有 taskFolder 且未归档」的任务回扫。
- 通知在部分 Windows 环境被专注助手拦截：文档写明，失败不阻塞流水线。
- 与功能 B 的归档：归档任务默认不回扫、不通知。

---

## 4. 跨功能依赖与提交切片

```text
Commit 1  feat: weekly report history list and author template
  - prefs + UI + weekly-report.e2e 扩展
  - handbook 周报段落

Commit 2  feat: task search filter and archive
  - filter bar + archived 字段 + unit/e2e
  - handbook 任务字段

Commit 3  feat: task artifact badges and report notifications
  - badges + Notification + tests
  - handbook 文件总线 / 风险
```

合并前每提交至少：

```powershell
npm run check
npm test
# 触及 UI 流程时再跑相关 e2e 或 npm run test:e2e
```

全量交付前：`npm run test:all`。

---

## 5. 明确不做（本计划外）

| 项 | 原因 |
|---|---|
| 企业微信/腾讯文档 API | 手册非目标 |
| 全自动平台填卡 | 与「强辅助」定位冲突 |
| 拆分 main/renderer 大重构 | 可并行，但不阻塞这三项；IPC 契约不变前提下另开任务 |
| 周报「完全覆盖生成」模式 | 增加确认成本；现有 merge 已够用 |
| 任务多选批量归档 | 可后续；先验证单卡归档语义 |

---

## 6. 工作量粗估（单人熟悉代码库）

| 功能 | 实现 | 测试与文档 | 合计 |
|---|---|---|---|
| A 周报历史 + 模板 | 0.5–1 天 | 0.5 天 | ~1–1.5 天 |
| B 筛选搜索归档 | 1 天 | 0.5–1 天 | ~1.5–2 天 |
| C 徽章 + 通知 | 0.5–1 天 | 0.5 天 | ~1–1.5 天 |

合计约 **3.5–5 人日**，含回归与手册。

---

## 7. 开始实现前检查清单

1. 确认当前分支仍为 `codex/personal-workbench-redesign`，工作区无无关大面积 diff。
2. 跑一次 `npm test` 建立绿线基线。
3. 按 A → B → C 顺序开做；每完成一项更新本计划顶部状态（可选）与 `PROJECT_HANDBOOK.md`。
4. 安全相关：功能 C 若动下载路径逻辑，补跑 `security-http.e2e` / 静态安全测试。

---

## 8. 建议的首个实现切入点

若立刻开工，从 **A.4 prefs 扩展 + A.5 历史列表 DOM** 开始：改动面最小、手册已点名、且 `switchWeeklyReportPeriod` 可直接复用，容易在半天内做出可演示增量。
