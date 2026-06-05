# Handoff: Antigravity -> Codex (第2轮 - 菜单栏原生化与任务系统重构)

## Date
2026-06-05 16:34

## From
Antigravity

## To
Codex

## Summary
移交最新的个人工作台重构方案：任务和终端切换功能收进左上角原生菜单；任务管理弹窗修改为列表优先（拆分为列表视图和新增/编辑表单视图），更新五种具体任务类型并移除关联文档路径。

## Current State
1. 已在协作仓库中起草了最新的第二轮设计方案 [personal-workbench-automation-plan.md](file:///C:/Users/24391/.gemini/antigravity/scratch/ai-collab-hub/personal-workbench-automation-plan.md)。
2. 先前制定的后台一键 Git 同步、可视化进度条等后续扩展建议已全部舍弃，不予采纳。
3. 修正了任务数据格式，初始化在 [weekly_tasks.json](file:///C:/Users/24391/.gemini/antigravity/scratch/ai-collab-hub/tasks/weekly_tasks.json) 中。

## Important Files
- **[Plan Spec] [personal-workbench-automation-plan.md](file:///C:/Users/24391/.gemini/antigravity/scratch/ai-collab-hub/personal-workbench-automation-plan.md)**: 包含了 `main.js`、`index.html`、`renderer.js` 和 `style.css` 的具体修改规格。
- **[Tasks JSON] [weekly_tasks.json](file:///C:/Users/24391/.gemini/antigravity/scratch/ai-collab-hub/tasks/weekly_tasks.json)**: 更新后的任务数据底板。

## Decisions Made
- **原生菜单栏实现**：不再使用 HTML 绘制的顶部栏 Tasks 和 >_ 按钮，而是完全通过 Electron 提供的应用级 Menu API，将操作选项融入 Windows 窗口左上角的菜单系统（工作台 -> 本周任务/本地终端/扩展设置），使用原生快捷键触发。
- **列表优先的双视图弹窗**：任务管理器弹窗初次打开时只渲染任务表格（如果无数据展示“暂无任务”的提示）。点击最下方的“添加任务”或操作列的“编辑”后，弹窗内容平滑切换为表单输入界面；保存或取消后再切换回列表展示。
- **重新界定任务类型**：移除 docPath，只维护 5 种业务类型的映射（能力训练搭建、能力训练修改、能力训练验收、作业批阅搭建、作业批阅验收）。

## Requested Next Action for Codex
请 Codex 按照以下步骤进行：
1. 本地拉取本分支（`codex/personal-workbench`）的最新更改。
2. 按照 [personal-workbench-automation-plan.md](file:///C:/Users/24391/.gemini/antigravity/scratch/ai-collab-hub/personal-workbench-automation-plan.md) 指引对 [personal-workbench](file:///C:/Users/24391/.gemini/antigravity/scratch/ai-collab-hub/personal-workbench) 下的文件进行重构。
3. 完成重构后，再次启动工作台，并手动测试：
   - 验证原生菜单栏及其快捷键（Ctrl+T / Ctrl+`）可正常打开任务管理器和切换终端。
   - 验证打开任务弹窗时只展示任务列表，只有点击“添加任务”才渲染表单，且操作流程闭环。
   - 验证任务类型与 weekly_tasks.json 读写无误。
4. 将最新的代码提交并推送到 GitHub 仓库。
