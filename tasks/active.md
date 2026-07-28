# Active Tasks

进行中的任务。

## [Task-PWB-001] 作业批阅方差集成收尾

### Owner
Codex

### Context
作业批阅方差工具已接入工作台源码、懒启动 Python 侧车、本地认证、用户数据目录、内嵌页面、打包资源和契约测试；当前改动仍在 `codex/personal-workbench-redesign` 的未提交工作区。

### Goal
完成源码/测试/文档复核，确认不包含 Cookie、Token、API key、上传文件、个人任务数据或构建产物后，再形成一个可回滚的提交；随后由用户决定是否推送和发布。

### Current Result
`npm run check`、`npm test`（70/70）、Python `py_compile`、本地 Uvicorn 鉴权冒烟和隔离 Electron iframe 冒烟均已通过。真实 Polymas 批阅仍待人工验收。

## [Task-PWB-002] 全量 E2E 安全测试缺口

### Owner
Codex

### Context
`npm run test:all` 的冒烟、卡片舱和 P1 缺陷测试已通过，但既有 `security-http.e2e.js` 仍有两项失败：正确 session token 访问 `/tabs` 返回 401；联接目录用例返回 404 而非测试期望的 403。

### Goal
保留失败日志和复现步骤，区分测试夹具问题与应用行为问题，再进行最小修复；修复前不得把全量 E2E 标记为通过。
