# Current Status

## Active Goal
个人工作台当前在 `codex/personal-workbench-redesign` 分支上进行作业批阅方差工具的集成收尾，同时保持周报中心、Token 统计和 V3.4 平台填写助手的既有能力稳定可回归。

## Current Owner
Codex（负责当前集成的代码、测试、文档和发布前检查；真实平台批阅验收仍需要用户提供登录态与样本）。

## Last Updated
2026-07-24

## Latest Summary
1. **V3.4 基线能力已交付**：任务驱动流程、文件总线、卡片舱、平台填写辅助、任务状态/子任务和启动入口已在代码与项目手册中记录。
2. **周报中心已接入**：支持从任务生成快照、历史周次、手动编辑、企业微信文档粘贴所需的纯文本/HTML/表格 HTML+TSV 复制，以及 HTML/Markdown/DOCX 导出。
3. **Token 统计已接入**：工作台通过白名单 IPC 调用 TokenBox Rust sidecar；未构建 sidecar 时明确提示，不伪造统计结果。
4. **作业批阅方差集成已完成首版本地接线**：按需启动 Python + FastAPI 侧车，使用动态 loopback 端口、随机本地令牌和 `userData/homework-variance` 数据目录；源码、契约测试、README 和打包资源规则均已加入当前工作区，但尚未提交或推送。
5. **个人数据保持隔离**：`tasks/weekly_tasks.json`、`personal-workbench/temp/`、本机扩展配置和打包输出均不应进入提交；当前 `tasks/weekly_tasks.json` 的修改是用户本地数据变更。

## Verification
- `personal-workbench/npm run check`：通过。
- `personal-workbench/npm test`：70/70 通过。
- 作业批阅 Python 文件 `py_compile`：通过。
- 本地 Uvicorn 冒烟：健康检查 200、无令牌 API 401、带令牌空任务列表可读。
- 隔离 Electron 冒烟：点击「作业批阅方差」后侧车就绪，iframe 加载成功，授权 `/api/jobs` 返回 200。
- `personal-workbench/npm run pack`：通过；打包资源包含 `resources/integrations/homework-variance/web_server.py`。
- `npm run test:all`：未全绿。冒烟 8/8、卡片舱 24/24、P1 缺陷 13/13 通过；既有 `security-http.e2e.js` 仍有 2 项失败：正确 session token 访问 `/tabs` 返回 401，以及联接目录用例返回 404 而非测试期望的 403。

## Next Step
1. 复核当前源码、测试和文档改动，显式排除个人任务数据后再决定是否提交。
2. 在本机安装并确认 Python 3.10+ 与 `integrations/homework-variance/requirements.txt` 依赖，使用真实 Polymas 登录态和样本完成批阅/方差/Excel 下载验收。
3. 单独定位 `security-http.e2e.js` 的两项既有失败，保存日志和复现步骤后再决定是否修复测试夹具或应用行为。
4. TokenBox Rust sidecar 仍受当前机器缺少 MSVC `link.exe` 影响；具备工具链后再执行真实 `build:bridge:stage` 和发布构建。

## Known Risks
- 作业批阅集成只携带 Python 源码，不捆绑 Python runtime；目标机器需要自行安装解释器和依赖。
- 作业批阅侧车需要用户提供有效的 Polymas URL、JWT/Cookie 和作业文件；自动化验证没有读取真实隐私数据。
- 完整 E2E 尚未全绿，不能声称当前工作区已完成发布验收。
- TokenBox 统计的真实 sidecar 构建、首次扫描和重启复用仍需本机手工验证。
- 扩展注入、第三方平台 DOM、企业微信文档粘贴和 Windows 通知仍受外部页面/权限变化影响。

## Workspace Boundary
- 当前分支：`codex/personal-workbench-redesign`，跟踪 `origin/codex/personal-workbench-redesign`。
- 当前功能改动仍在未提交工作区；本次收尾没有执行 commit、push、merge、deploy 或 live 验证。
- `personal-workbench/build-output/` 是约 400 MB 的可重建打包输出；`personal-workbench/temp/` 是约 77 MB 的本机任务/下载数据；二者均仅作为清理候选，不在未确认前删除。
- 根目录 `__pycache__/` 与 `personal-workbench/.claude/` 是本机运行/Agent 配置，保留且不纳入提交。
