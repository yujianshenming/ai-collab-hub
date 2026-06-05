# Handoff: Antigravity -> Codex (第3轮 - 原生菜单优化、分屏溢出修复与智能助手全功能复原)

## Date
2026-06-05 17:50

## From
Antigravity

## To
Codex

## Summary
移交最新的个人工作台重构方案：
1. 修复分屏和主视图中，扩展及助手面板折叠到 0 宽时内部文本/按钮泄漏溢出的 CSS 渲染 Bug。
2. 将地址栏上方占地方的 HTML 任务状态横幅移除，改为在 Electron 原生菜单栏的中间作为一个置灰/禁用的顶级菜单项展示，并更名为“正在进行任务”。
3. 优化原生菜单栏中“任务”和“终端”的点击响应，去除二级子菜单，使点击顶级标签即可直接触发相应的功能弹窗或面板。
4. 全面升级与复原内置的“Polymas 原生智能训练助手”：美化 UI 界面质感，支持测试人设增删改配、历史聊天持久化与加载、自动读取页面核心卡片参数、灵活的模型 Endpoint 设置以及 Prompt 导出下载。

## Current State
1. 所有的本地源码修改已完全还原至 Codex 在 GitHub 上提交的最新提交点（`6dab867`）。
2. 在项目根目录起草了最新的第三轮设计规格：[personal-workbench-automation-plan.md](file:///C:/Users/24391/.gemini/antigravity/scratch/ai-collab-hub/personal-workbench-automation-plan.md)。
3. 在此移交任务，由 Codex 接力进行实际的代码开发和逻辑实现。

## Important Files
- **[Plan Spec] [personal-workbench-automation-plan.md](file:///C:/Users/24391/.gemini/antigravity/scratch/ai-collab-hub/personal-workbench-automation-plan.md)**: 包含了本轮开发的所有设计标准和改动参考。
- **[Handoff File] [handoff/antigravity-to-codex.md](file:///C:/Users/24391/.gemini/antigravity/scratch/ai-collab-hub/handoff/antigravity-to-codex.md)**: 本次交接的书面指引。

## Requested Next Action for Codex
请 Codex 按照以下步骤进行：
1. 本地拉取本分支（`codex/personal-workbench`）的最新更改，读取 [personal-workbench-automation-plan.md](file:///C:/Users/24391/.gemini/antigravity/scratch/ai-collab-hub/personal-workbench-automation-plan.md) 的详细设计规范。
2. 修复面板折叠泄漏 Bug：为面板内部的所有 header 和 body 结构包裹一层 `.tab-extension-content` 或 `.native-assistant-content` 容器，设置 `width: 100%; height: 100%; overflow: hidden;`，使内容能够随面板降为 0 宽时被完美裁剪。
3. 原生菜单精简：移除“任务”与“终端”的原生二级 `submenu` 下拉框，直接给它们绑定顶级 `click` 事件处理器以一键调用 toggle，同时保留 `CmdOrCtrl+T` 和 `CmdOrCtrl+`` 的快捷键绑定。
4. 任务状态栏转移：
   - 彻底移除 `index.html` 的 HTML 任务指示横幅 `#active-task-banner`。
   - 在 `main.js` 原生菜单模版的“终端”与“编辑”中间，定义一个 ID 为 `active-task-menu-item`、状态为 `enabled: false` 的顶级置灰菜单项。
   - 编写 IPC 信道在 `renderer.js` 执行/结束任务时，动态通知主进程修改其 `label` 文案为 `正在进行任务: XXX`。
5. 重构内置助手面板：
   - 使用现代色彩搭配（毛玻璃特效 `backdrop-filter: blur(16px)`，优雅的非默认系统字体，高颜值聊天气泡等）彻底重绘 UI 质感。
   - 实现测试人设（测试人格）的增、删、改、配置管理界面与 System Prompt 模版映射。
   - 实现完整的对话存储（以 taskId 为名写入本地 json 文件）与自动恢复加载机制。
   - 读取主 Webview 的页面参数和 Cookies 登录态，配合 Polymas 服务端进行会话交互。
   - 支持自定义模型接口 Endpoint、Key 及一键导出 Prompt 的功能。
6. 完成开发后运行 `npm run check` 进行自检，启动工作台进行各项验证，并最终将代码提交和推送至 GitHub 协作仓库中！
