# Handoff: Antigravity -> Codex (第3轮 - 自定义HTML菜单栏、同行居中状态栏与助手全功能复原)

## Date
2026-06-05 18:03

## From
Antigravity

## To
Codex

## Summary
移交最新的个人工作台第3轮重构任务：
1. 修复分屏和主视图中，原生智能助手面板（`.native-assistant-panel`）折叠至 0 宽时内部文本泄漏的 Bug。
2. 弃用原生 Windows 菜单栏，引入在 `index.html` 最顶部渲染的**自定义 HTML 应用菜单栏**（`#app-menu-bar`）。
3. 任务与终端功能一键直达：在 HTML 菜单栏中提供直点按钮，不再使用多级 dropdown 子菜单。
4. 任务状态栏同行居中：将任务状态横幅移至 HTML 菜单栏的中间，并更名为“正在进行任务: XXX”，消除跑偏和越界问题，无任务时显示“正在进行任务: 无”。
5. 原生智能训练助手的全功能实现：美化 UI 界面质感，支持自定义测试人设与参数、对话历史持久化与回显加载、大模型 API 参数设置以及 Prompt 导出下载。

## Current State
1. 已将本地代码的所有更改还原至您最近提交的稳定点（`94e2c84`）。
2. 在项目根目录更新了最新的第三轮设计规格：[personal-workbench-automation-plan.md](file:///C:/Users/24391/.gemini/antigravity/scratch/ai-collab-hub/personal-workbench-automation-plan.md)。
3. 在此移交任务，由 Codex 进行代码开发。

## Important Files
- **[Plan Spec] [personal-workbench-automation-plan.md](file:///C:/Users/24391/.gemini/antigravity/scratch/ai-collab-hub/personal-workbench-automation-plan.md)**: 包含了本轮开发的所有设计标准和改动参考。
- **[Handoff File] [handoff/antigravity-to-codex.md](file:///C:/Users/24391/.gemini/antigravity/scratch/ai-collab-hub/handoff/antigravity-to-codex.md)**: 本次交接的指引。

## Requested Next Action for Codex
请 Codex 按照以下步骤进行：
1. 本地拉取本分支（`codex/personal-workbench`）的最新更改，读取 [personal-workbench-automation-plan.md](file:///C:/Users/24391/.gemini/antigravity/scratch/ai-collab-hub/personal-workbench-automation-plan.md) 的详细设计规范。
2. 隐藏原生菜单栏并开发 HTML 菜单栏：
   - 在 `main.js` 中设置 `mainWindow.setMenuBarVisibility(false)` 隐藏原生菜单。
   - 在 `index.html` 最顶部插入 `#app-menu-bar` 容器，横向展示：左侧“工作台”（有二级下拉菜单）、“任务”和“终端”直点按钮；中间绝对居中展示正在进行任务状态栏；右侧“编辑”、“视图”（带二级下拉菜单）。
   - 在 `renderer.js` 中捕获顶级按钮的点击直接呼起对应的弹窗或面板。同时拦截全局快捷键。
3. 助手面板折叠泄漏修复：
   - 仿照 `.tab-extension-panel`，为 `.native-assistant-panel` 包裹内部的 `.native-assistant-content` 容器，并设置 `overflow: hidden; width: 100%; height: 100%;` 使得宽度为 0 时内部文本完美裁剪。
4. 全面复原并升级智能助手：
   - **UI 升级**：融入毛玻璃背景、精致圆角与阴影聊天气泡、及交互发光与缩放微动画。
   - **测试人设**：开发独立的人格配置与增删改页面。
   - **对话记录**：将会话内容实时存储至本地 JSON，重开任务时自动加载回显历史记录。
   - **登录态与参数获取**：读取 Webview 内的 `ai-poly` Cookie，并调用 Polymas API 渲染当前步骤的卡片参数。
   - **模型设置与 Prompt 下载**：支持自定义配置大模型服务各项参数，并提供下载 Prompt 与对话日志文件的功能。
5. 完成开发后运行 `npm run check` 自检，然后重新启动工作台进行各项验证，最终将代码提交和推送至 GitHub 协作仓库中！
