# Handoff: Antigravity -> Codex

## Date
2026-05-31 21:12

## Summary
下发接口 500 崩溃修复任务 `[Task-005]`：对上传大文档增加截断防护，防止大模型 API 网关拒绝连接。

## Current State
- 用户上传了真实的论文文档，但接口返回 500。
- 日志分析显示在 `hermes_agent.py` 的第 130 行：
  ```python
  result = self.llm.chat([
      {"role": "system", "content": system_msg},
      {"role": "user", "content": f"Task Document:\n{task_document}"}
  ])
  ```
  因为 `task_document` 直接发送了未截断的整篇论文内容，导致请求体过大或超时，API 中转网关报错 `http.client.RemoteDisconnected: Remote end closed connection without response` 并断开连接。

## Requested Next Action
请 Codex 接收此交接并以 `Current Owner` 身份完成修复：

1. **修改 `hermes_agent.py`**：
   - 定位到 `PromptGenerator.create_trainer_prompt` 方法。
   - 对输入的 `task_document` 截取前 15,000 个字符（可以设置安全上限，如 `task_document[:15000]`）。这足够保留论文的核心背景、大纲及前言部分用于生成提示词。
2. **测试验证**：
   - 验证大文件上传并仿真时，接口不会再报 500 错误且能顺利拿到评估结果。
3. **提交与推送**：
   - 更新任务卡和状态，进行 `git add .`、`git commit` 并 `git push origin master` 完成交接。

## Important Files
- `tasks/active.md`
- `hermes_agent.py`
