# Current Status

## Active Goal
修复大文档上传接口 500 异常 (Task-005)

## Current Owner
Codex

## Last Updated
2026-05-31 21:12

## Latest Summary
在用户上传真实大型论文文档测试时，系统抛出 API 拒绝连接的 500 异常。定位原因为大模型接口对单次请求包大小限制。Antigravity 已将方案规范与任务 `[Task-005]` 提交，并交接给 Codex。

## Next Step
等待 Codex 接收任务，开始修改 `hermes_agent.py` 对大文档上传添加截断防护逻辑。

## Known Risks
- 暂无扫描版 PDF 如不含文本层，`pypdf` 无法提取正文；后续如需要可增加 OCR 支持。
