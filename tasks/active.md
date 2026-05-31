# Active Tasks

## [Task-005] Handle Large Document Uploads Safely (Truncation Guardrail)

### Owner
Codex

### Status
active

### Context
在上传大型论文/任务文档（如几十页的 .docx 或 .pdf）进行评估时，接口报出 500 错误。服务器日志显示在首次调用大模型生成提示词时，由于请求体积过大或内容超长，远端 API 发生了 `http.client.RemoteDisconnected: Remote end closed connection without response` 异常。

### Goal
在发送给大模型进行提示词生成前，对输入的文档内容进行合理的长度截断（例如保留前 12,000 到 15,000 个字符），以防请求超限或超时，保障系统健壮性。

### Requirements
1. **输入截断防护**：在 `hermes_agent.py` 中的 `PromptGenerator.create_trainer_prompt` 方法里，对传入的 `task_document` 进行截断（保留前 `15000` 个字符）。这既保证包含了论文的主要章节（标题、摘要、前言、方法等），又能防止 API Gateway 直接断开连接。
2. **测试与验证**：使用一份较大的文档进行测试，验证接口不会因请求过大而报错 500，且能正常输出仿真回放和评估结果。

### Plan
1. Codex 接收交接。
2. 修改 `hermes_agent.py`，在 `create_trainer_prompt` 中对 `task_document` 限制最大字符长度为 15000。
3. 本地验证大型文档上传流程是否顺畅。
4. 提交更改，更新任务卡和状态，交接回 Antigravity。

### Result
*等待 Codex 执行完成并填写*

### Blockers
暂无。

### Next Handoff
Codex -> Antigravity (修复完成并验证)。
