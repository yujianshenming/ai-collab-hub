# Handoff: Antigravity -> Codex (第4轮 - 自定义HTML状态栏、WebView遮挡修复与任务文件夹工作流)

## Date
2026-06-05 18:08

## From
Antigravity

## To
Codex

## Summary
移交最新的个人工作台第4轮重构与新功能要求：
1. 彻底移除 `index.html` 侧边栏底部的“扩展设置”按钮。
2. 正在进行任务状态显示精细化：横幅更名为“正在进行任务”。在没有任务运行时，自定义 HTML 菜单栏中间**完全空白，隐藏横幅**；只有当点击任务“执行”后，菜单栏正中间才**显示横幅**。
3. 彻底修复拖拉蓝线卡死/无法拖拽 Bug：将 resizer 设为 Webview 与面板之间的**Flex 独立兄弟（Sibling）元素**，摆脱绝对定位，从而阻断 Native WebView 对拖拽把手的覆盖遮挡。
4. 开发任务专属文件夹逻辑：执行任务时自动创建专属目录 `temp/tasks/{taskId}_{school}_{course}`，并在该目录下保存测试对话 `dialogue.json` 与评估报告。
5. Hermes 自动化加载闭环：在完成评估报告下载后，支持一键将任务文件夹下对话记录和报告的**本地绝对路径**自动填入 Hermes 网页的输入框中，**但先不发送**，由用户确认后手动发送。

## Current State
1. 所有的本地源码修改已完全还原至 Codex 在 GitHub 上提交的最新节点（`94e2c84`）。
2. 在项目根目录起草了最新的第四轮设计规格：[personal-workbench-automation-plan.md](file:///C:/Users/24391/.gemini/antigravity/scratch/ai-collab-hub/personal-workbench-automation-plan.md)。
3. 在此移交任务，由 Codex 接力进行实际代码开发。

## Important Files
- **[Plan Spec] [personal-workbench-automation-plan.md](file:///C:/Users/24391/.gemini/antigravity/scratch/ai-collab-hub/personal-workbench-automation-plan.md)**: 包含了本轮开发的所有设计标准和改动参考。
- **[Handoff File] [handoff/antigravity-to-codex.md](file:///C:/Users/24391/.gemini/antigravity/scratch/ai-collab-hub/handoff/antigravity-to-codex.md)**: 本次交接的指引。

## Requested Next Action for Codex
请 Codex 按照以下步骤进行：
1. 本地拉取本分支（`codex/personal-workbench`）的最新更改，读取 [personal-workbench-automation-plan.md](file:///C:/Users/24391/.gemini/antigravity/scratch/ai-collab-hub/personal-workbench-automation-plan.md) 详细设计规范。
2. 清理左下角与横幅逻辑：
   - 移除 `index.html` 里的 `#settings-button`。
   - 实现 HTML 自定义菜单栏 `#app-menu-bar`（包含顶级一键直达的任务与终端按钮，悬浮的工作台、编辑、视图下拉框）。
   - 横幅在无任务时设置 `display: none` 隐藏；启动任务时由 `renderer.js` 设置其为 `display: flex` 并更新文字。
3. 兄弟元素重构 resizer：
   - 将 `.tab-extension-resizer` 从 `.tab-extension-panel` 内部移出，作为兄弟节点放在 `webview` 与 `panel` 中间。
   - 样式上设为独立的 flex 元素（宽度 `4px`），避免被 WebView 遮挡，且保证 0 宽闭合时能被拖拽拉开。
4. 专属文件夹机制开发：
   - 主进程在启动任务时，自动在 `temp/tasks` 创建专属文件夹。
   - 保存对话记录、拦截并移动保存评估报告至该目录下。
   - 自动在评估页面中拦截上传此文件夹下的文档和对话 JSON。
5. Hermes 灌入逻辑：
   - 提供“加载至 Hermes”按钮，读取专属文件夹下对话与报告的**绝对路径**。
   - 自动切换至 Hermes 页面，将文本填入输入框，**保留不发送**。
6. 完成开发后运行 `npm run check` 进行自检，重新启动工作台进行各项验证，并将代码提交和推送至 GitHub 协作分支上！
