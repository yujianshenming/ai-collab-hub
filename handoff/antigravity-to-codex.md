# Handoff: Antigravity -> Codex

## Date
2026-05-31 20:38

## Summary
下发 Hermes Agent 系统开发任务 `[Task-003]`，整合公司 API Key 和 `gpt-5.4` / `gpt-5.5` 模型进行开发。

## Current State
- 系统名称纠正为：**Hermes Agent**。
- 已在桌面的 `api_key.txt` 中找到用户公司的 API 凭证：
  - API Key: `[REDACTED - stored only in local config.json]`
  - Base URL: `http://llm-service.polymas.com/api/openai/v1`
  - 运行模型：优先选用 `gpt-5.4`，也可使用 `gpt-5.5`。
- 任务 `[Task-003]` 细节已更新入 `tasks/active.md`。

## Requested Next Action
请 Codex 接收此交接，并开始在本地执行以下具体动作：

1. **安全配置**：
   - 创建 `.gitignore`，写入 `config.json` 及其他缓存目录，绝对不能让 API Key 泄露到公共 GitHub 上。
   - 创建 `config.json`，写入查找到的 API Key、Base URL 及选用的模型（`gpt-5.4`）。
2. **实现后端 `hermes_agent.py` 与 `server.py`**：
   - 依赖包可包含 `openai`、`fastapi`、`uvicorn`（使用 `pip install openai fastapi uvicorn` 安装）。
   - 在 `hermes_agent.py` 中，使用 `openai.OpenAI(api_key=..., base_url=...)` 调用服务，通过 `gpt-5.4` 模型完成提示词生成、智能体对话沙箱仿真和诊断打分流程。
3. **实现 Web 前端界面**：
   - 搭建漂亮的暗黑色彩、卡片化布局的 HTML/CSS/JS 页面。能够上传/粘贴任务文本，实时打印老师和学生的“对话气泡”，展示仪表盘评分和最终优化的系统提示词。
4. **验证与提交**：
   - 启动本地服务，确保运行顺畅。
   - 更新任务和状态后，进行 `git push origin master` 提交（确认 `config.json` 没有被 stage 进去）。

## Important Files
- `tasks/active.md`
- `.gitignore`（待新建）
- `config.json`（待新建，本地保存，勿 push）
- `hermes_agent.py`（待新建）
- `server.py`（待新建）

## Open Questions
- 暂无。如有问题请随时在交接文档中列出。
