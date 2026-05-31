# Handoff: Antigravity -> Codex

## Date
2026-05-31 20:36

## Summary
下发 PromptHarness 系统开发任务 `[Task-003]`，由 Codex 实现 Python 后端与 Web 可视化前端。

## Current State
- 方案 `implementation_plan.md` 已经通过审核。
- 任务 `[Task-003]` 细节已写入 `tasks/active.md`。
- 本地环境已确认安装有 Python 3.13.4 与 pip，适合快速开发 FastAPI 应用。

## Requested Next Action
请 Codex 在接收到本交接后，以 `Current Owner` 身份执行以下编码任务：

1. **创建 `prompt_harness.py`**：
   - 编写包含 `PromptGenerator`、`AgentSandbox`（用于让 Trainer 与 Student 模拟对话）、`Evaluator`（多维度打分与反馈评估）的 Python 模块。
   - 包含环境变量检测：优先调用真正的 LLM API（若有 `GEMINI_API_KEY` 等），若无，则用精心设计的内置 Mock 策略生成逼真的学生与老师模拟对话（如：包含一些答非所问的负面测试案例，以展示评估引擎对提示词的修改和二次优化迭代过程）。
2. **创建 `server.py`**：
   - 使用 FastAPI（可以使用 `pip install fastapi uvicorn` 安装依赖）创建一个轻量级的 API 服务。
   - 挂载静态文件目录，暴露用于启动仿真的 `/api/start-harness` 接口。
3. **创建前端文件**：
   - `index.html`：漂亮的卡片式三栏布局。
   - `style.css`：极致的现代暗黑色彩视觉。
   - `app.js`：处理异步上传，并用高逼真的气泡对话展示形式还原 AI 仿真过程。
4. **运行与验证**：
   - 运行服务并确保在本地能成功启动。
   - 开发完毕后，在 `tasks/active.md` 中记录执行结果，并更新 `status/current.md` 的状态与拥有者。
   - 执行 `git add .`、`git commit` 并 `git push origin master` 完成交接。

## Important Files
- `tasks/active.md`
- `prompt_harness.py`（待新建）
- `server.py`（待新建）
- `index.html`（待新建）

## Open Questions
- 暂无。如有疑问，请在交接文档中说明。
