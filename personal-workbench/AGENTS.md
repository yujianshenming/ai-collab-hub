# Personal Workbench 维护规则

开始任何代码工作前，先阅读：

1. `docs/PROJECT_HANDBOOK.md`
2. `README.md`
3. 与当前任务相关的 `tests/` 和 `regression-checklist.md`

完成任何新功能、Bug 修复或重构后，必须：

- 更新 `docs/PROJECT_HANDBOOK.md` 的当前状态、受影响架构/数据流和变更记录。
- 为可复现的行为补充或更新测试；不能只依赖手工截图。
- 运行与风险等级匹配的测试，交付前运行 `npm run test:all`。
- 检查 `git diff --check` 和 `git status --short`。
- 不要提交 `tasks/weekly_tasks.json`、`temp/`、下载物、Cookie、Token、扩展本机路径或其他个人数据，除非用户明确要求。

修改 IPC、扩展权限、Token 注入、路径处理、下载归档或上传注入时，必须同时阅读手册的“安全边界”章节和回归清单，并添加安全回归证据。
