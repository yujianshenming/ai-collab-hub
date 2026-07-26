# Personal Workbench（个人工作台）

一个面向 Windows 的 Electron 桌面工作台。把全部工作入口集合进一个应用——常驻浏览器页面、企业微信、Codex / Cursor、终端、文件夹与文档，并用「任务驱动 + 文件总线 + 卡片舱」打通能力训练搭建的端到端流程。

> **定位**：打开工作台 = 完成全部工作，不再开额外的应用。
> 当前状态：V3.4 稳定能力 + 周报中心首版 + Token 统计首版 + 独立任务状态引擎与 GitHub CI；当前实现、架构、数据边界和维护规则以 [`docs/PROJECT_HANDBOOK.md`](docs/PROJECT_HANDBOOK.md) 为准。

## 启动

### 日常使用（推荐）

双击桌面 **`打开个人工作台.vbs`**。

- 无常驻黑窗；工作台与启动脚本进程分离，关掉启动器不会关掉应用。
- 在项目目录执行 `electron.exe .`，加载本应用（不要只双击 `electron.exe`）。
- 不生成 `personal-workbench-launch.log`；桌面不再保留 `.cmd` / `.ps1` 启动器。

### 开发启动

```powershell
cd personal-workbench
npm install
npm start
```

> Windows 沙箱/包装器下若遇到 `node-pty` 的 `AttachConsole failed` 闪退，改用独立进程启动：
> ```powershell
> Start-Process .\node_modules\electron\dist\electron.exe -ArgumentList "." -WorkingDirectory <项目目录>
> ```

## 功能总览

### 基础壳
- 多个网页以常驻 `webview` 标签承载，切换只控制显示状态，不重新加载，保留登录态、表单输入与滚动位置。
- 地址栏支持后退、前进、停止/刷新与直接导航。
- 标签支持添加、编辑、删除、拖拽排序、分类折叠；侧边栏可折叠。
- 左右分屏与上下分屏，分屏 resizer 可拖动。
- 底部本地 PowerShell 终端（node-pty + xterm），可展开、收起、拖动调整高度；CLI 类工具可作为独立标签常驻运行。
- Chrome 扩展加载：支持扩展 ID 或已解压扩展目录；有交互页面的扩展显示在顶栏，点击在可折叠右侧栏中使用。

### 任务驱动（V3）
- 任务中心作为默认落地页，统计卡：总数 / 进行中 / 已暂停 / 已完成。
- 任务卡列表 + 居中表单 dialog（学校/课程必填校验）。
- **流水线五步模型**：准备 → 本地测试 → 评估上传 → 捕获报告 → 完成；任务舱与状态栏芯片同步进度。
- 任务暂停 / 继续（带防冲突拦截）、结束任务清理临时文件夹、重新打开已完成任务复用同名文件夹。
- 多子任务由独立 `task-state-engine.js` 驱动：每个父任务最多一个运行子任务；暂停后可切换；单项完成状态独立保留；全部子任务完成后父任务才完成。
- 异常退出后的 `running/evaluating` 状态在启动时统一恢复为 `paused`；任务写盘前检查父子状态不变量，校验失败时同步回滚内存变更。

### 文件总线（V3.1）
- 活动任务期间全局下载自动落到任务文件夹（重名追加序号）；无活动任务时下载行为不变。
- 文件托盘基于 `fs.watch` 实时刷新；托盘操作：打开 / 定位 / 复制路径 / 重命名 / 裁切（仅图片）/ 删除。
- 网页上传自动注入任务文件，支持「改用系统选择器」fallback。
- 图片裁切去水印（默认底部约 100px）会**覆盖原图**；`webp` 源因编码限制输出为同主文件名的 `.png` 并删除原 `.webp`。

### 任务源头（V3.2，验收通过）
- 解析桌面「待做任务.txt」导入为任务卡（带预览 dialog）。
- 未提交状态、子任务进度环。

### 可靠性 + 写回（V3.3，已合入 master）
- 文件总线 6 缺陷清零、上传拦截改用 CDP 重做、按来源域名门控下载归档。
- 任务状态写回「待做任务.txt」（预览 + 备份 + 反向安全合并）。

### 平台填写助手「卡片舱」（V3.4，回归验收通过，待补真机上传验证）
- 解析任务文件夹下的 `cards.md`（Hermes 能力训练五项制产出）为结构化卡片包。
- 任务舱「卡片」区逐字段一键复制（卡片名称 / 建议轮次 / 阶段描述 / 开场白 / 提示词，及任务描述/封面图描述/评价标准/测试人格）。
- 流式「逐项填写」模式：高亮下一个未复制字段，把多次「选中-切页-定位-粘贴」压缩成逐项点击；已复制状态持久化。
- 开场白超 200 字符标红徽章；提示词复制为代码块内原文（不含围栏）。
- 平台表单注入预研铺垫（`platformFieldMap` 选择器映射 + 单字段试注入）；V3.5 将重点增强任务、文件、页面、报告之间的协作，建设强辅助工作台，自动化只作为辅助能力，不追求全自动填卡。

### 周报中心（首版）
- 从当前任务生成独立周报快照，不反向修改任务数据。
- 支持周报表格、非量化事项、产品需求 / Bug / 卡点 / 疑问的手动编辑。
- 支持历史周次切换、上一周/下一周，以及默认姓名/标题模板（工作台偏好）。
- 支持完整周报复制纯文本 + HTML 到企业微信文档；另可单独复制表格（HTML + TSV），便于粘贴到已有表格的首个单元格；支持 HTML / Markdown / DOCX 导出。
- 周报保存于 Electron `userData/weekly-reports.json`，不写入版本库中的任务数据。

### Token 统计（长期方案首版）
- 工作台内置 Token 统计视图，按 provider 和日期范围展示总 Token、官方估算成本、请求次数、模型用量与每日用量，并提供每日趋势折线图和模型占比圆环图。
- 统计由独立 TokenBox Rust sidecar 扫描本机 Codex / Claude Code JSONL，并从 `%LOCALAPPDATA%\TokenBox\tokenbox.db` 读取统一账本；工作台不复制解析和计费逻辑。
- 统计视图还提供事件级 evidence、源日志/SQLite 审计、JSON/CSV 看板导出；未定价模型保留 Token 并显示状态，并提供 SQLite 备份和带备份的派生账本重建。
- sidecar 使用 JSONL gateway contract（`ping`、`refresh_dashboard`、`get_evidence`、`get_audit_summary`、`export_dashboard` 等），宿主只传 provider/date/model/filter，不传任意源文件路径或会话正文。
- 开发态先构建并 staging sidecar：`npm run build:bridge:stage`；再运行 `npm start` 或 `npm run dist`。未构建 sidecar 时页面会明确提示，不会伪造统计数据。

## 开发验证

```powershell
cd personal-workbench
npm test
npm run test:e2e
npm run test:all
npm run pack
```

- `npm test` 包含语法、DOM/IPC 对账、任务状态机、CI 契约及其他单元/静态回归。
- `.github/workflows/personal-workbench-ci.yml` 在 Pull Request 和 `master` 推送时使用 Windows + Node.js 22 运行 `npm test` 与完整 Electron E2E。
- Electron E2E 使用隔离的用户目录、任务文件和下载目录，不读取版本库外的个人任务数据。

## 安全说明

- 使用 `contextIsolation` 与受限的 preload IPC，不向网页暴露 Node.js；网页弹出的新窗口交给系统默认浏览器打开。
- 会话 Token 仅注入 `local-web` 标签或 `localhost`/`127.0.0.1` 本地服务，不向外网第三方站点泄露。
- 静态文件服务与 temp/tasks IPC 均做路径穿越防护；本地 HTTP API 需 token 鉴权。
- Chrome 扩展配置保存在 Electron 用户数据目录，不提交本机路径或隐私配置到仓库。

## 相关文档

- **项目主手册（新成员 / 新模型首先阅读）**：`./docs/PROJECT_HANDBOOK.md`
- 版本路线图：`../personal-workbench-roadmap.md`
- 回归测试清单（含 6 个当前待处理风险登记）：`./regression-checklist.md`
- 各版本规格书：`../personal-workbench-*-spec.md`
- 项目全景介绍页：`../personal-workbench-overview.html`
