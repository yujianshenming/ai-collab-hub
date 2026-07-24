# personal-workbench 多智能体对抗性审查报告

| 项 | 内容 |
|---|---|
| 项目 | `personal-workbench`（Windows Electron 桌面工作台） |
| 分支 | `codex/personal-workbench-redesign` |
| 日期 | 2026-07-24 |
| 方法 | Map（5 面）→ Find（4 维）→ Verify（3 透镜多数决）→ Synthesize |
| 规模 | 64 代理 · 34 原始发现 · 17 多数通过 · 合并后 **11 项确认** |
| 抽查 | 已对 SEC-01 / SEC-03 / COR-01 / COR-03 / purge 回退链做源码核对 |

---

## 1. 执行摘要

近期功能（周报 A、筛选归档 B、产物徽章 C、泳道拖拽/dueDate/跨周清理、托盘重命名与裁切覆盖、TokenBox、作业批阅）在业务上已落地，但对抗审查确认：

1. **IPC 信任边界不一致**：`tasks:*` 有 `resolveTaskPath`，而 `desktop-app:launch`、`prefs.todoFilePath`、`upload:resolve-files` 无对等守卫。
2. **数据正确性风险集中在任务中心与周报**：「从任务生成」无视 `periodKey`；导入 `completed` 不盖章 `completedAt` 可被 purge 误删；同栏拖拽会把 `running/paused/evaluating` 压成 `pending`。
3. **产物元数据与磁盘脱节**：rename/delete 不维护 `chatLogPath/reportPath`，徽章 path 优先且不校验存在。
4. **本地 HTTP 固定端口失败静默**，导致扩展/local-apps/e2e 同源假设脆弱。

**结论**：确认 **3 CRITICAL + 8 HIGH**。建议先封 IPC 写/执行边界，再堵数据丢失路径，最后补状态与产物一致性及测试。

已剔除：CLI 命令拼接（SEC-02）——属用户配置的 shell 能力，无额外跨信任边界。

---

## 2. 确认问题清单（按修复优先级）

### CRITICAL

#### P1 · SEC-01 · `desktop-app:launch` 无白名单任意 spawn

| 字段 | 内容 |
|---|---|
| 级别 | **CRITICAL** |
| 位置 | `main.js:2560`、`preload.js:80` |
| 失败场景 | 主 renderer 被控，或恶意 localStorage 标签配置 `type=desktop-app` + 任意 `exePath` + `autoLaunch=true`；打开标签即 `spawn(exePath)`，当前用户权限本地执行任意程序。 |
| 证据 | `ipcMain.handle("desktop-app:launch")` 直接 `spawn(exePath, [], …)`，无 realpath / 扩展名 / 白名单 / 签名校验；preload 全量暴露；表单与拖入 `.exe/.bat/.cmd` 可写自由路径。对比 `local-apps:register` 有 realpath 约束。 |
| 修复建议 | 仅允许经 dialog 选中并在主进程登记的绝对路径；spawn 前 realpath + 扩展名校验；禁止 renderer 自由字符串路径；autoLaunch 仅对已登记路径生效。补拒绝契约测试。 |

#### P2 · SEC-03 · `prefs:set-workbench` 可写任意 `todoFilePath`

| 字段 | 内容 |
|---|---|
| 级别 | **CRITICAL** |
| 位置 | `main.js:1506`、`main.js:2196`、读写 `2213` / `2283` |
| 失败场景 | `setWorkbenchPrefs({ todoFilePath: 任意已存在文件 })` 后：`readTodoFile` 泄露内容；`writeTodoFile` 在文件存在时 bak 再 `writeFileSync` 覆盖，破坏任意可写文件。 |
| 证据 | `todoFilePath` 仅 `typeof string` 校验；`set-workbench` 合并客户端 prefs 不剥离；读写直接用 prefs 路径，无 `resolveTaskPath`。合法 UI 保存偏好并不传 `todoFilePath`；dialog 本应是唯一写入口却可被绕过。 |
| 修复建议 | `todoFilePath` 仅能由 `dialog:pick-todo-file` 写入；`set-workbench` 忽略客户端 `todoFilePath`；读写前 realpath 并限制扩展名/允许目录。 |

#### P3 · COR-01 · 从任务生成周报忽略 period，丢 orphan 行

| 字段 | 内容 |
|---|---|
| 级别 | **CRITICAL**（数据丢失） |
| 位置 | `renderer.js:3555`、调用点约 `3850` |
| 失败场景 | 打开历史周草稿点「从任务生成」：映射**全部** `weeklyTasks`，不按 `periodKey`/`dueDate` 过滤；已被 purge 的 `sourceTaskId` 行既不在 generated 也不在 manualRows → 静默丢弃；当前板任务写入历史周。脏草稿切周会 auto-persist。 |
| 证据 | `generated = weeklyTasks.map(...)`；`manualRows = rows.filter(!sourceTaskId)`；与 `purgeCompletedFromPreviousWeeks` 叠加放大损失。e2e 仅测当前周 note 保留。 |
| 修复建议 | 按 `report.periodKey` 过滤归属该 ISO 周的任务；保留 orphan `sourceTaskId` 行；历史周生成前二次确认。补 e2e。 |

---

### HIGH

#### P4 · SEC-04 · sessionToken 全量暴露并注入 local-web 客页

| 字段 | 内容 |
|---|---|
| 级别 | **HIGH** |
| 位置 | `renderer.js:706-712`、`main.js:1065`、`preload.js:112` |
| 失败场景 | 注册含恶意脚本的 local-web 目录 → dom-ready 注入 `window.__workbenchSessionToken` → 客页以超级 token 访问 `/cookies`/`/tabs`/`/state` 等，读取 partition cookie 与标签状态。 |
| 修复建议 | 不向客页注入全量 sessionToken；改短期 scoped token 或主进程代理；收紧 `get-session-token` 调用面。 |

#### P5 · SEC-05 · `/cookies` 缺 url 时可倾印整个 partition

| 字段 | 内容 |
|---|---|
| 级别 | **HIGH** |
| 位置 | `main.js:1194-1212`、`937-941` |
| 失败场景 | 持 sessionToken 的 GET `/cookies` 不带 url；sessionToken 跳过 host 校验；无活动 http(s) 标签时 `cookies.get({})` 返回全部 cookie。 |
| 修复建议 | 强制要求 `url`，缺失返回 400；禁止空 filter 全量 get。 |

#### P6 · SEC-06 · `upload:resolve-files` 不校验路径

| 字段 | 内容 |
|---|---|
| 级别 | **HIGH** |
| 位置 | `main.js:2124`、`896-902` |
| 失败场景 | 主 renderer 被控后，在上传生命周期内传入敏感绝对路径 → `DOM.setFileInputFiles` 注入 → 用户提交或页面自动上传时敏感文件发往远程站。 |
| 修复建议 | 仅允许 dialog 主进程缓存路径或 `temp/tasks`/活动任务目录下路径；拒绝自由绝对路径。 |

#### P7 · COR-02 · 导入 completed 不盖章 completedAt，purge 误删

| 字段 | 内容 |
|---|---|
| 级别 | **HIGH**（数据丢失） |
| 位置 | `renderer.js:2064`、`5023`、`1941-1953`、`3359` |
| 失败场景 | 导入/更新 `status=completed` 只写 `TODO_IMPORT_FIELDS`（无 `completedAt`）；ownership 回退 `dueDate`；dueDate 属上周则下次 load 永久删除记录（文件夹保留）。 |
| 修复建议 | 导入/规范化 completed 且缺 `completedAt` 时 stamp now；或 purge 仅认 `completedAt`（无则不删）；去掉无效 `updatedAt` 回退。补负例单测。 |

#### P8 · COR-03 · 同栏重排强制改 pending

| 字段 | 内容 |
|---|---|
| 级别 | **HIGH** |
| 位置 | `renderer.js:4607-4609`、`1916-1920` |
| 失败场景 | 在 active 泳道内拖动 `running/paused/evaluating` 只为改顺序：`laneStatusForDrop('active')→pending`，`statusChanged` 因 `status!==pending` 为 true → 写 pending 并 persist；流水线任务还会先 pause。子任务 running 可能不被清理。 |
| 修复建议 | **仅当 `fromLane !== targetLane` 时改 status**；同栏只改 `sortKey`。补单元：paused 同区 drop 后仍 paused。 |

#### P9 · COR-04 · 托盘重命名不回写产物路径

| 字段 | 内容 |
|---|---|
| 级别 | **HIGH** |
| 位置 | `renderer.js:2671` |
| 失败场景 | 托盘重命名 `dialogue.json` / `eval_report*` 后仅磁盘改名；`task/pipeline` 旧 path 不变；Hermes/上传/徽章 open 指向失效路径，徽章仍 ready。 |
| 修复建议 | rename 成功后若旧 path 等于产物字段则更新为 `result.path`，并 force 刷新产物缓存。 |

#### P10 · COR-05 · 产物 path 优先且不校验存在

| 字段 | 内容 |
|---|---|
| 级别 | **HIGH** |
| 位置 | `renderer.js:2010`、`4317-4335` |
| 失败场景 | 已写 `chatLogPath/reportPath` 的文件被删除或移走后，`ready` 仍为 true；刷新只填空 path 不清理失效 path。现有单测反而固化「path 不在 files 仍 ready」。 |
| 修复建议 | path 在 files 中无匹配或 exists 失败时 `ready=false` 并清空失效 path。 |

#### P11 · ARC-02 · 固定端口 38924 失败静默

| 字段 | 内容 |
|---|---|
| 级别 | **HIGH**（静默失效 / 回归 #10） |
| 位置 | `main.js:261`、`1325-1331` |
| 失败场景 | 端口被占用时 listen 失败 → `localServer=null`，仅 debug log；sessionToken/SSE/local-apps 全失效无 toast；e2e 可出现「正确 token 仍 401」。 |
| 修复建议 | listen 失败必须 UI 报错；或 ephemeral 端口并广播；e2e 等待 listening 且验证 token 与 server 同源。 |

---

## 3. 驳回 / 合并项

| ID | 处理 | 原因 |
|---|---|---|
| SEC-02 | **驳回** | CLI 是用户配置的 shell 入口；主窗 isolation 下 guest 无法写主窗 tabs；同应用已有交互式 cmd |
| ARC-01 | **合并** | desktop-app 并入 SEC-01；CLI 随 SEC-02 驳回 |
| REG-01 / ARC-03 | **合并** | 同根因并入 COR-03 |
| REG-02 / ARC-04 | **合并** | 同根因并入 COR-01 |
| REG-03 | **合并** | 同根因并入 COR-02 |

---

## 4. 架构味道

1. **IPC 信任模型不一致**：`tasks:*` 严，`desktop-app` / todo prefs / upload 松。
2. **sessionToken 能力过大**：本机 HTTP 超权 + IPC 可读 + 可注入用户注册的 local-web。
3. **产物元数据与磁盘生命周期脱节**：rename/delete 不维护，refresh 不清理。
4. **purge 回退链含从未持久化的 `updatedAt`**，设计债直接变成误删面。
5. **固定端口 + 硬编码 URL + 静默 error**，扩展/e2e 同源假设脆弱。
6. **`main.js` / `renderer.js` 单体过大**，状态机（泳道 drop、purge、产物 path、周报 generate）分散易漏边界。

---

## 5. 测试覆盖缺口

| 缺口 | 对应问题 |
|---|---|
| `desktop-app:launch` 拒绝非法路径契约 | SEC-01 |
| `set-workbench` 剥离 `todoFilePath` + todo 读写越界 | SEC-03 |
| 周报历史 period 生成 + orphan 保留 | COR-01 |
| 同栏 drop 保 `paused/running` | COR-03 |
| 导入 completed + 旧 dueDate 不误 purge | COR-02 |
| upload 路径白名单 | SEC-06 |
| `/cookies` 强制 url、禁止空 filter | SEC-05 |
| sessionToken 不对 guest 超权 | SEC-04 |
| rename 后 path retarget | COR-04 |
| stale path `ready=false`（现有单测方向相反） | COR-05 |
| 38924 EADDRINUSE 可见失败 | ARC-02 |
| `security-http.e2e` 已知失败（/tabs 401、junction 404vs403） | 回归可信度 |
| open risks #8 debugger 双注册、#14 CLI race、#15 dialog undefined、#16 serveFile TOCTOU | 历史未关 |

---

## 6. 建议修复顺序

1. 封 **desktop-app:launch**（dialog 登记 + allowlist）+ 契约测试
2. 封 **todoFilePath**（仅 dialog 可写；set-workbench 剥离）
3. 修 **周报 generate**（period 过滤 + orphan 保留）+ e2e
4. 收紧 **sessionToken**；**/cookies 强制 url**
5. **upload:resolve-files** 仅接受主进程缓存 / 任务目录路径
6. 导入 completed **stamp completedAt**；purge 仅认 completedAt
7. **applyTaskCardDrop 同栏不改 status** + 单元测试
8. **rename/delete 同步产物 path**；stale → ready=false
9. **38924** 失败 UI 报错或 ephemeral 端口广播
10. 补齐 **security-http** 与 open risks #8/#14/#15/#16 最小回归

---

## 7. 残留风险（未升格为确认项）

- 主窗 XSS 完整利用链未在仓库复现；SEC-01/03/06 仍依赖「已能调 workbench」前提，但 IPC 面过宽是实的。
- webview `contextIsolation=no` + 剥离 XFO/CSP，扩大 guest 攻击面。
- `resolveTaskPath` 字符串前缀非 realpath，Windows junction 下 tasks 根逃逸残留。
- homework-variance token 进 iframe query；非 `/api` 静态页无鉴权（loopback 限定）。
- TokenBox `TOKENBOX_BRIDGE_PATH` 环境变量可替换 bridge 可执行文件。
- `writeWeeklyReports` 全量 rewrite 竞态 last-writer-wins。
- `security-http.e2e` 未绿使安全回归可信度下降。

---

## 8. 审查方法说明

| 阶段 | 内容 |
|---|---|
| Map | 安全面、任务中心、周报/文件总线、集成/架构、测试覆盖 5 路并行 |
| Find | security / correctness-data / regression-ux / architecture-tests 独立对抗搜索 |
| Verify | 每项 3 透镜：正确性复现、安全影响、测试能否证伪；≥2 票 real 才确认 |
| Synthesize | 合并重复、排序优先级、输出修复顺序与残留风险 |

**说明**：CRITICAL 中的安全项当前主要威胁模型是「主 renderer 已被控或恶意本地配置」；即便没有完整 XSS 链，过宽 IPC 仍属真实边界缺陷，应按 CRITICAL 处理。

---

## 9. 后续动作

如需落地修复，建议从 **SEC-01 + SEC-03** 开始，再做 **COR-01 / COR-03 / COR-02**。

相关文档：

- 当前事实主文档：`docs/PROJECT_HANDBOOK.md`
- 回归清单：`regression-checklist.md`
- A/B/C 验收清单：`docs/ACCEPTANCE_CHECKLIST_ABC.md`
