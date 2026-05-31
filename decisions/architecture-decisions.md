# Architecture Decisions

记录重要的架构决策和选择原因。

## [ADR-001] 初始化 AI 协作协议
- **Status**: Accepted
- **Date**: 2026-05-31
- **Context**: 需要在生活与工作电脑间共享任务和进展。
- **Decision**: 采用 ai_collaboration_protocol.md 约定的目录结构与 Git 同步工作流。
- **Consequences**: 后续所有工作需要先 pull 并遵循 Handoff 规范进行交接。
