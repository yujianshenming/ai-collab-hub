# Handoff: Antigravity -> Codex

## Date
2026-06-05 15:53

## From
Antigravity

## To
Codex

## Summary
制定了定制工作台“测试-评估-分析”自动化流水线和顶部栏本周任务列表的设计方案，现将编码实现和集成验证交给 Codex 执行。

## Current State
1. 梳理了自动化拦截与注入的完整流程，包括：
   - 主进程拦截 `will-download`，静默归类保存文件至 `temp/chats/` 和 `temp/reports/`。
   - WebView 启用（`webviewTag: true`）与 X-Frame-Options 解除。
   - WebView 拦截 `select-file-dialog` 事件，实现静默注入上传本地文件路径，彻底避免文件选择框。
   - WebView 注入脚本（`executeJavaScript`）自动点击、上传并提交。
2. 设计了基于 Git 共享的任务列表系统，并在本地初始化了数据结构 [weekly_tasks.json](file:///C:/Users/24391/.gemini/antigravity/scratch/ai-collab-hub/tasks/weekly_tasks.json)。
3. 在本地已切出 `codex/personal-workbench` 开发分支。

## Important Files
- **[Plan Spec] [personal-workbench-automation-plan.md](file:///C:/Users/24391/.gemini/antigravity/scratch/ai-collab-hub/personal-workbench-automation-plan.md)**: 详细实现规格与具体文件修改指引（包含 main.js, renderer.js, index.html, style.css）。
- **[Tasks JSON] [weekly_tasks.json](file:///C:/Users/24391/.gemini/antigravity/scratch/ai-collab-hub/tasks/weekly_tasks.json)**: 用于存放本周任务，包含学校、课程、状态、负责人、关联文件路径等。
- **[Workbench Codebase] [personal-workbench](file:///C:/Users/24391/.gemini/antigravity/scratch/personal-workbench)**: 包含 Electron 运行的主进程、渲染进程和样式文件。

## Decisions Made
- **WebView 替换 IFrame**：为使用 `select-file-dialog` 和 `executeJavaScript` 绕过沙箱拦截上传文件，所有工作台面板必须用 `<webview>` 代替 `<iframe>`。
- **任务 Git 共享**：任务列表不仅存在 `localStorage`，而必须持久化在协作仓库的 `tasks/weekly_tasks.json` 中，以便多 AI 跨电脑协作。
- **顶部栏入口**：为不挤占侧边栏空间，任务列表界面通过顶部工具栏的新增按钮触发模态框显示。

## Open Questions
- 各大网页（测试页面、评估页面、Hermes页面）的具体 DOM 结构，如输入框、文件上传 input、提交按钮的 CSS 选择器（selector），Codex 在编写时需要通过运行程序、打开开发者工具（DevTools）或注入调试脚本来确认，以确保 CSS 选择器 100% 正确。

## Requested Next Action for Codex
请 Codex 按照以下步骤进行：
1. 检出本地的 `codex/personal-workbench` 分支，并将当前方案提交推送到 GitHub。
2. 根据 [personal-workbench-automation-plan.md](file:///C:/Users/24391/.gemini/antigravity/scratch/ai-collab-hub/personal-workbench-automation-plan.md) 指引，开始对 [personal-workbench](file:///C:/Users/24391/.gemini/antigravity/scratch/personal-workbench) 进行代码修改。
3. 修改完成后，启动 Electron 实例进行实际测试（可结合内置终端），确保拦截下载、静默上传和自动分析流水线全部打通。
4. 验证任务系统的增删改查及 IPC 读写 `weekly_tasks.json` 正确无误。
