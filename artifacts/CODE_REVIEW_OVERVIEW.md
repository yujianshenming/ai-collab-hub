# 代码审查机制 · 交付概览

> 由 Code Reviewer 角色产出，2026-07-30。

## 做了什么
为仓库建立了一套**可对齐、可复用、可机器校验**的代码审查机制，包含标准、流程、PR 模板与自动门禁。全程挂靠现有 `PROTOCOL.md`（Antigravity↔Codex 分工）、`personal-workbench/regression-checklist.md`（前端安全回归）、`AGENTS.md`（维护纪律），不另立沟通渠道。

## 交付物
| 文件 | 用途 |
|------|------|
| `docs/CODE_REVIEW_STANDARD.md` | 查什么：严重级别、五审查维度、Python/JS 分语言清单、安全红线、统一注释格式、真实代码案例 |
| `docs/CODE_REVIEW_PROCESS.md` | 怎么走：七步流程、角色分工、SLA、分歧升级、分阶段落地路线图 |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR 模板：变更类型/自审/测试证据/安全影响/回滚 |
| `.github/workflows/ci.yml` + `pyproject.toml` | 自动门禁：ruff+pytest+前端 `npm check/test` |

## 关键判断
- **最大短板在 Python 侧**：零测试/零 lint，且代码里已有 6 处真实隐患（见标准 §5 案例表 C1–C6），列为阶段 1 优先补测试项。
- **前端已较规范**：直接复用 `regression-checklist.md` §6/§7 作为安全必查项，CI 调用现有 `npm test`。
- **渐进强制**：ruff 上线首月仅报告，避免"第一天全红"劝退；阶段 2 转阻塞 + branch protection。

## 落地路线
- 阶段 0（本周）：文档合入，团队对齐严重级别。
- 阶段 1（2 周内）：Python 补最小测试 + 引入 ruff；前端 CI 跑通。
- 阶段 2（1 月内）：CI 必需 + 1 批准；安全 PR 强制双人复核。
- 阶段 3（每月）：复盘评审数据，清案例表，修订标准。
