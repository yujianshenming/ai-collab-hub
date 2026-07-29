# 个人工作台 回归测试清单

> 测试工程师维护 · 2026-06-10 建立
> 最近同步：2026-07-28（新增 §7 AI 网关与 AI 辅助导入解析；同日修复导入 7 项问题后刷新 §7.1/§7.3 并新增 §7.4）；附表只保留当前未关闭的代码风险，已修复项已从表中移除。
> 适用范围：每次交付（commit/Phase）合入后必须执行。静态部分可在不启动应用的情况下完成；动态部分需启动应用。
> 启动方式（避开 AttachConsole 崩溃）：不要用 `npm start` 包装器在沙箱终端里启动；用
> `Start-Process .\node_modules\.bin\electron.cmd -ArgumentList "." -WorkingDirectory <项目目录>`
> 或 Playwright `_electron.launch`（已验证可行，见 §0.2）。

---

## 0. 每次必跑的机器检查

### 0.1 静态检查
- [ ] `npm run check` 通过（仅语法层，查不出运行时引用错误）。
- [ ] 作业批阅集成额外执行 `python -m py_compile integrations/homework-variance/web_server.py integrations/homework-variance/polymas_grade_engine.py`；`npm test` 包含 sidecar 边界契约测试。
- [ ] **DOM 对账**：`renderer.js` 的 `elements` 映射与所有 `querySelector("#...")` 引用的 id，逐一在 `index.html` 中存在（历史前科：`rightSidebarBody` 未定义导致右分屏 TypeError，2128665 修复）。
- [ ] **IPC 三端对账**：`main.js` 的 `ipcMain.handle/on` 通道名 ↔ `preload.js` 的 `ipcRenderer.invoke/send/on` ↔ `renderer.js` 的 `window.workbench.*` 调用，三端一致；`preload-popup.js` 用到的 `workbench:get-active-tab-info`、`workbench:get-cookies`、`workbench:get-session-token` 不得删除。
- [ ] 新增 DOM 事件监听的目标元素在对应视图模板中真实存在（含动态 innerHTML 模板里的 class 选择器）。

### 0.2 自动化冒烟（Playwright + playwright-core）
- [ ] `npm i --no-save playwright-core` 后用 `_electron.launch({ args: ["."] })` 启动。
- [ ] 涉及本地 HTTP API 的隔离测试使用 `PERSONAL_WORKBENCH_LOCAL_SERVER_PORT` 随机端口；生产工作台保持打开时，测试请求仍只进入测试实例。
- [ ] 应用窗口出现，标题为「个人工作台」。
- [ ] `#task-center-view` 可见（任务中心为默认落地页）；统计卡数字非空。
- [ ] 侧边栏 `#nav-task-center`、状态栏 `#sb-terminal` 可见。
- [ ] 监听 `pageerror` 与 `console.error`，3 秒内零未捕获异常。
- 注意：冒烟阶段**不要打开终端面板**（node-pty 在包装器控制台下可能 AttachConsole 失败）；终端相关用例放人工部分。

---

## 1. 分屏（右分屏 / 底部分屏）
- [ ] 拖动标签到窗口右侧 30% 区域 → 右分屏开启，分屏视图正确挂载（前科：rightSidebarBody）。
- [ ] 拖动标签到窗口底部 25% 区域 → 底部分屏开启。
- [ ] 同一标签不能同时占据右分屏与底部分屏；主视图与分屏不能是同一标签。
- [ ] 分屏 resizer 拖动正常，松手后嵌入式桌面应用窗口位置同步。
- [ ] 关闭分屏（× 按钮）后 viewport 回到主栈，webview 不重载（保留登录态/滚动位置）。
- [ ] 标签数不足时（右分屏<2、双分屏<3）有 toast 拦截。
- [ ] 分屏中的标签被删除时，分屏自动关闭且无残留引用。
- [ ] 为网页 A 开启「保存跳转前的页面」，从 A1 跳转 A2 后左侧书签出现；点击回到 A1，再点可回 A2。
- [ ] 隐藏网页 A 的返回书签后不影响网页 B；编辑网页 A 并勾选「显示返回书签」后恢复。
- [ ] 关闭网页 A 的返回书签功能后，`personal_workbench_tabs` 不再保存其 `lastVisitedUrl` / `returnBookmarkUrl`；普通地址栏后退仍可用。
- [ ] 返回书签与右侧扩展面板同时使用时，两侧均可点击，webview 宽度正确收缩且无覆盖。

## 2. 终端（主终端 + CLI 标签）
- [ ] 状态栏「终端」按钮开关终端面板，按钮高亮 `.on` 态正确。
- [ ] 终端可输入命令并回显（node-pty 正常）；AttachConsole 失败时应用不闪退、终端区显示失败信息（main.js uncaughtException 守护）。
- [ ] 终端 resizer 拖动调高，xterm fit 后无错位。
- [ ] CLI 类型标签打开后自动启动命令、可输入；删除 CLI 标签后对应 pty 被杀掉（`tab:cleanup-resources`）。
- [ ] 窗口 resize 时各 CLI 终端 fit 不抛错。

## 3. 扩展
- [ ] 扩展设置弹窗可打开、可添加/删除行、保存后结果卡片显示成功/失败。
- [ ] 有 popup 的扩展出现在顶栏；点击在当前标签内打开扩展面板，再点关闭。
- [ ] 扩展按钮在 web/local-web 标签上可用；非 web 标签点击时应显示“不支持扩展面板”提示且不抛异常。
- [ ] 「刷新并重新加载扩展」按钮可用。
- [ ] preload-popup 的 chrome.tabs/chrome.cookies mock 不回归（扩展内能拿到活动标签与 cookie）。

## 4. 任务流水线（V3 任务驱动 UI）
- [ ] 任务中心为默认落地页；统计卡（总数/进行中/已暂停/已完成）与 weekly_tasks.json 一致。
- [ ] 首次进入默认是「专注视图」；进行中、暂停、未提交、过期/临期任务优先，普通待办最多补足到 6 项，紧急项不会因数量限制被隐藏。
- [ ] 切换「全部任务」可看到全部未归档记录；搜索、状态 chip 或学校筛选能命中专注列表之外的任务，且统计卡仍按全局计数。
- [ ] 学校、课程、任务类型三项完全相同的多条记录显示疑似重复提示；提示不修改、合并或删除任务 JSON。
- [ ] 添加/编辑/删除任务走居中 dialog，校验（学校/课程必填）生效。
- [ ] 「执行」→ 任务文件夹创建于 `temp/tasks/{id}_{school}_{course}/`，任务舱自动展开，步骤推进到「本地测试」。
- [ ] 下载 dialogue（json）→ 步骤推进「评估上传」，自动切到评估标签并尝试注入。
- [ ] 捕获 report（pdf）→ 状态变已完成、步骤「捕获报告」，「加载至 Hermes」按钮解除 disabled。
- [ ] 暂停：任务舱/把手/状态栏芯片全部消失，卡片变「已暂停」+「继续」；继续后状态完整恢复；双任务防冲突 toast。
- [ ] 结束任务：临时文件夹被清理，任务舱隐藏。
- [ ] 重新打开已完成任务（04ebbb3）：状态回退待处理，taskFolder/chatLogPath/reportPath 保留；再次执行复用同名文件夹，产物不丢失。
- [ ] 任务舱收起把手进度环、状态栏芯片文案 `n/5` 与当前步骤一致。
- [ ] 侧边栏脉冲点：评估上传亮评估标签、Hermes 阶段亮 Hermes 标签；`findTabByUrlPart` 对无 `url` 的标签不抛异常。

## 5. 文件总线（V3.1）
- [ ] 活动任务期间任意标签下载 → 文件落任务文件夹（非系统下载目录），toast「已捕获到任务文件夹」；重名追加 ` (2)`。
- [ ] 无活动任务时下载行为不变（temp/chats|reports|downloads）。
- [ ] 托盘实时刷新：资源管理器中增删文件，500ms 内托盘同步（fs.watch + debounce）。
- [ ] 托盘五操作可用：打开 / 定位 / 复制路径 / 裁切（仅图片）/ 删除（带确认），全部不能越出 temp/tasks。
- [ ] 活动任务期间任意网页点上传 → 弹工作台文件浮层；多选注入成功；「改用系统选择器」fallback 正常；ESC 取消等同用户取消。**（待确认项：`select-file-dialog` 事件在 stock Electron 是否存在，需真机点上传验证）**
- [ ] 评估页流水线自动注入行为不变（uploadQueue 优先，不弹浮层）。
- [ ] 图片裁切：默认底部 100px，覆盖原图；偏好（方向/像素）修改后生效；webp 输出为同主名 png。

## 6. 安全四项（每次交付必测，不得回退）
- [ ] **composedPath 外点关闭**：任务卡「⋯」菜单内点删除，菜单行为正常、面板不误关（task_system_requirements §1）。
- [ ] **Token 注入白名单**：打开普通外网页面（如 baidu.com），在其 webview 控制台验证 `window.__workbenchSessionToken === undefined`；local-web 标签与 `http://127.0.0.1:*` 页面能拿到 token（§2.1）。
- [ ] **静态服务路径穿越**：`http://127.0.0.1:38924/local-apps/{tabId}/..%2F..%2F` 及同名前缀目录（如 base 为 `C:\X`，请求解析到 `C:\X-secret`）一律 403（§2.2）。
- [ ] **temp/tasks IPC 防穿越**：`tasks:open-folder / list-folder / list-files / file-action / crop-image / cleanup-folder / task:active-update` 传入 temp/tasks 之外的绝对路径（如 `C:\Windows`）、`..` 相对路径，全部拒绝；`temp/tasks` 根目录本身不可被 delete/cleanup。
- [ ] 本地 HTTP API 鉴权：`/cookies /events /broadcast /state /tabs /active-tab /active-task` 无 token 返回 401。
- [ ] 作业批阅侧车只监听 `127.0.0.1` 动态端口；无 `X-Workbench-Token` 的 `/api/jobs` 返回 401，带令牌可访问；关闭 Electron 后 Python 进程退出，任务数据仍只留在 `userData/homework-variance`。

## 7. AI 网关与 AI 辅助导入解析（2026-07-28 新增）

### 7.1 契约测试（npm test 已覆盖，合入前必跑）
- [ ] `tests/llm-model-registry.test.js`：注册表 9 模型、仅 stableDefault 可设默认、`sanitizeModelId` 只接受字符串（前科：数字 42 被 String 强转放行）。
- [ ] `tests/llm-client.test.js`：本地假网关，验证固定 Base URL、Bearer 头、超时/取消/非 2xx 处理；不碰真实网关。
- [ ] `tests/llm-task-parser.test.js`：防编造（学校/课程/负责人逐字在原文）、防注入、未知字段丢弃、低置信度标记、漏行补 unresolved；关键字段（学校/课程/类型/负责人）非空缺证据整行进 unresolved；分批保留原始 sourceLine，超 400 行明确拒绝，单批失败该批进 unresolved 其余批继续。
- [ ] `tests/parse-todo-lines.test.js` + `tests/task-import-helpers.test.js`：缺 taskType 行进 unresolved（不伪装「未分类」）；模糊负责人不猜测（仅明确语法/常见姓氏规则）；尾部备注不丢；同稳定键多个现有任务进 conflicts 且默认不勾选、禁止自动选最后一个。
- [ ] `tests/ai-import-regression.test.js`：`ai:test-model`/`ai:parse-todo-lines` 拒绝未注册模型；`ai:cancel-parse` 三端接线 + AbortController 登记/清理 + senderId 校验；renderer 迟到保护先于状态重置；合并按原文行不整体覆盖；编辑字段 manual 标记 + 应用前 confirm。
- [ ] `tests/ai-import.e2e.js`：隔离 userData/任务文件 + 本地随机端口假网关（不碰真实网关）；覆盖预览分组、冲突候选选择、逐字段编辑、AI 合并（inferred 默认不勾选）、真取消（网关连接被 abort、任务文件不写）、应用流程落盘。

### 7.2 安全边界（每次交付必查，不得回退）
- [ ] API key 只存在于主进程（env > 会话 key > `userData/llm-secret.bin`）；grep 确认 key 不出现在任何 IPC 返回值、console/日志输出。
- [ ] Base URL 固定在 `llm-client.js`，renderer/preload 无任何可注入网关地址的入口。
- [ ] `ai:get-config` 返回值只含 `configured/encryptionAvailable/defaultModel/models`，不含密钥明文或密文。
- [ ] `tasks/weekly_tasks.json`、`llm-secret.bin`、真实 key 均未进入 git 暂存区。

### 7.3 人工动态检查
- [ ] 未配置 key 时：导入预览、规则解析、应用所选等全部功能不受影响；点 AI 按钮只得到友好失败提示。
- [ ] 偏好→AI 模型区：状态三态（加密保存/仅会话/未配置）正确；key 保存后输入框立即清空；非 stableDefault 模型在默认模型下拉中不可选。
- [ ] 导入预览未解析行：勾选行→「使用 AI 解析所选行」前有二次确认展示将发送的行；AI 失败/超时时规则解析结果原样保留。
- [ ] 低置信度（<0.75）或含推断/默认字段的 AI 候选在预览中默认不勾选；取消预览不写盘，只有「应用所选」并经 confirm 确认后才修改任务 JSON。
- [ ] AI 请求进行中关闭预览再重新打开：迟到的旧结果被代际 token 丢弃，不污染新预览。

### 7.4 导入 7 项修复的行为验收（2026-07-28 新增，不得回退）
- [ ] 缺少/未知 taskType 的行只出现在「无法解析」组（带行号与原因），不进导入项、不默认勾选；编辑指定合法类型后才可导入。
- [ ] 预览每行显示原文行号与原文；非 source 来源字段（推导/默认/AI推断/手动）有明确标识；AI 行显示置信度徽章。
- [ ] 「编辑字段」可逐字段修改，保存前过本地 Schema 校验（失败仅提示不落盘），改过的字段来源变「手动」。
- [ ] 「AI 重新解析全部」超 80 行分批发送（sourceLine 不漂移）、超 400 行明确拒绝；AI 失败/部分失败/取消时规则解析结果原样保留，合并按原文行进行、不整体覆盖。
- [ ] AI 解析进行中出现「取消解析」按钮：点击后主进程 abort 网络请求（不是仅忽略结果），预览与任务数据不变。
- [ ] 同稳定键（学校+课程+类型）存在多个现有任务时进「疑似重复/冲突」组：默认不勾选、勾选框禁用，必须先在候选（含任务 ID/状态/数量/负责人）中选定目标才可导入。
- [ ] 普通备注（如「本月重点跟进」）不会被误判为负责人；无法证明负责人时 owner 留空、剩余文本进备注并带 warning。
- [ ] renderer 传入未注册模型 ID 时 `ai:test-model`/`ai:parse-todo-lines` 直接拒绝，不向网关发请求。

---

## 附：当前未关闭问题登记

> 2026-07-24 已移除有代码/回归证据的历史条目 #1、#2、#3、#4、#5、#6、#7、#9、#11。剩余 7 项仍需单独修复或人工确认；不要把它们误写成“已解决”。

| # | 级别 | 描述 | 位置 |
|---|------|------|------|
| 8 | P2 | 上传拦截 debugger 意外 detach（devtools 抢占）后重开拦截会重复注册 `debugger.on("message")`，fileChooserOpened 双处理、浮层弹两次（原扫描 M2） | main.js `setWebviewFileChooserInterception` |
| 12 | P3 | 写回用打开预览时读到的 sourceText，预览停留期间 txt 被外部改动会被覆盖（有 .bak 兜底）；建议确认时重读比对（原扫描 L1） | renderer.js `applyTodoWriteback` |
| 13 | P3 | `swapTabs` 为死代码，拖拽重排已改用 categoryTabs splice 实现，可删除（原扫描 L2） | renderer.js `swapTabs` |
| 14 | P3 | CLI/白板视图 100ms setTimeout 初始化与「创建后立即删除标签」存在竞态：cleanup 先跑、pty 仍被拉起/resize 监听仍注册（极小窗口）（原扫描 L3） | renderer.js CLI/whiteboard 视图 |
| 15 | P3 | `fallbackSystemChooser` 中 `dialog.showOpenDialog(mainWindow ?? undefined, ...)` 首参传 undefined，建议改条件分支传参（原扫描 L4） | main.js `fallbackSystemChooser` |
| 16 | P3 | `serveFile` 中 existsSync 与 readFile 之间竞态会把已删除文件回 500 而非 404（仅状态码语义）（原扫描 L5） | main.js `serveFile` |

## 8. Adversarial review closure ? 2026-07-25

- [x] SEC-01 desktop launch uses canonical executable validation plus a persisted main-process allowlist.
- [x] SEC-03 todo path writes are dialog-owned and read/write paths are canonical existing `.txt` files.
- [x] COR-01 historical reports filter tasks by ISO period and retain orphan source rows.
- [x] SEC-04 local webviews receive per-tab scoped tokens; the full session token is not exposed in renderer preload.
- [x] SEC-05 cookie requests require an explicit HTTP(S) URL.
- [x] SEC-06 upload injection accepts only task-folder files or main-process approved picker paths.
- [x] COR-02 completed imports get `completedAt`; purge ignores records without that timestamp.
- [x] COR-03 same-lane reorder preserves running/paused/evaluating status.
- [x] COR-04 rename/delete retargets or clears stored artifact paths.
- [x] COR-05 artifact badges follow the current folder scan and stale paths show missing.
- [x] ARC-02 fixed-port startup errors are reported through IPC and a renderer toast.

Evidence: `npm test` and `npm run test:e2e`.
