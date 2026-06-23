# 个人工作台 回归测试清单

> 测试工程师维护 · 2026-06-10 建立
> 适用范围：每次交付（commit/Phase）合入后必须执行。静态部分可在不启动应用的情况下完成；动态部分需启动应用。
> 启动方式（避开 AttachConsole 崩溃）：不要用 `npm start` 包装器在沙箱终端里启动；用
> `Start-Process .\node_modules\.bin\electron.cmd -ArgumentList "." -WorkingDirectory <项目目录>`
> 或 Playwright `_electron.launch`（已验证可行，见 §0.2）。

---

## 0. 每次必跑的机器检查

### 0.1 静态检查
- [ ] `npm run check` 通过（仅语法层，查不出运行时引用错误）。
- [ ] **DOM 对账**：`renderer.js` 的 `elements` 映射与所有 `querySelector("#...")` 引用的 id，逐一在 `index.html` 中存在（历史前科：`rightSidebarBody` 未定义导致右分屏 TypeError，2128665 修复）。
- [ ] **IPC 三端对账**：`main.js` 的 `ipcMain.handle/on` 通道名 ↔ `preload.js` 的 `ipcRenderer.invoke/send/on` ↔ `renderer.js` 的 `window.workbench.*` 调用，三端一致；`preload-popup.js` 用到的 `workbench:get-active-tab-info`、`workbench:get-cookies`、`workbench:get-session-token` 不得删除。
- [ ] 新增 DOM 事件监听的目标元素在对应视图模板中真实存在（含动态 innerHTML 模板里的 class 选择器）。

### 0.2 自动化冒烟（Playwright + playwright-core）
- [ ] `npm i --no-save playwright-core` 后用 `_electron.launch({ args: ["."] })` 启动。
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

## 2. 终端（主终端 + CLI 标签）
- [ ] 状态栏「终端」按钮开关终端面板，按钮高亮 `.on` 态正确。
- [ ] 终端可输入命令并回显（node-pty 正常）；AttachConsole 失败时应用不闪退、终端区显示失败信息（main.js uncaughtException 守护）。
- [ ] 终端 resizer 拖动调高，xterm fit 后无错位。
- [ ] CLI 类型标签打开后自动启动命令、可输入；删除 CLI 标签后对应 pty 被杀掉（`tab:cleanup-resources`）。
- [ ] 窗口 resize 时各 CLI 终端 fit 不抛错。

## 3. 扩展
- [ ] 扩展设置弹窗可打开、可添加/删除行、保存后结果卡片显示成功/失败。
- [ ] 有 popup 的扩展出现在顶栏；点击在当前标签内打开扩展面板，再点关闭。
- [ ] **仅在 web/local-web 标签上点扩展按钮**（已知缺陷：非 web 标签激活时点扩展按钮会抛 TypeError，修复前注意）。
- [ ] 「刷新并重新加载扩展」按钮可用。
- [ ] preload-popup 的 chrome.tabs/chrome.cookies mock 不回归（扩展内能拿到活动标签与 cookie）。

## 4. 任务流水线（V3 任务驱动 UI）
- [ ] 任务中心为默认落地页；统计卡（总数/进行中/已暂停/已完成）与 weekly_tasks.json 一致。
- [ ] 添加/编辑/删除任务走居中 dialog，校验（学校/课程必填）生效。
- [ ] 「执行」→ 任务文件夹创建于 `temp/tasks/{id}_{school}_{course}/`，任务舱自动展开，步骤推进到「本地测试」。
- [ ] 下载 dialogue（json）→ 步骤推进「评估上传」，自动切到评估标签并尝试注入。
- [ ] 捕获 report（pdf）→ 状态变已完成、步骤「捕获报告」，「加载至 Hermes」按钮解除 disabled。
- [ ] 暂停：任务舱/把手/状态栏芯片全部消失，卡片变「已暂停」+「继续」；继续后状态完整恢复；双任务防冲突 toast。
- [ ] 结束任务：临时文件夹被清理，任务舱隐藏。
- [ ] 重新打开已完成任务（04ebbb3）：状态回退待处理，taskFolder/chatLogPath/reportPath 保留；再次执行复用同名文件夹，产物不丢失。
- [ ] 任务舱收起把手进度环、状态栏芯片文案 `n/5` 与当前步骤一致。
- [ ] 侧边栏脉冲点：评估上传亮评估标签、Hermes 阶段亮 Hermes 标签（注意：当前 `findTabByUrlPart` 对无 url 的标签会抛错，修复前此项与非 web 标签并存时会崩）。

## 5. 文件总线（V3.1）
- [ ] 活动任务期间任意标签下载 → 文件落任务文件夹（非系统下载目录），toast「已捕获到任务文件夹」；重名追加 ` (2)`。
- [ ] 无活动任务时下载行为不变（temp/chats|reports|downloads）。
- [ ] 托盘实时刷新：资源管理器中增删文件，500ms 内托盘同步（fs.watch + debounce）。
- [ ] 托盘五操作可用：打开 / 定位 / 复制路径 / 裁切（仅图片）/ 删除（带确认），全部不能越出 temp/tasks。
- [ ] 活动任务期间任意网页点上传 → 弹工作台文件浮层；多选注入成功；「改用系统选择器」fallback 正常；ESC 取消等同用户取消。**（待确认项：`select-file-dialog` 事件在 stock Electron 是否存在，需真机点上传验证）**
- [ ] 评估页流水线自动注入行为不变（uploadQueue 优先，不弹浮层）。
- [ ] 图片裁切：默认底部 100px，生成 `_cropped` 新文件，原图保留；偏好（方向/像素）修改后生效；webp 输出为 png。

## 6. 安全四项（每次交付必测，不得回退）
- [ ] **composedPath 外点关闭**：任务卡「⋯」菜单内点删除，菜单行为正常、面板不误关（task_system_requirements §1）。
- [ ] **Token 注入白名单**：打开普通外网页面（如 baidu.com），在其 webview 控制台验证 `window.__workbenchSessionToken === undefined`；local-web 标签与 `http://127.0.0.1:*` 页面能拿到 token（§2.1）。
- [ ] **静态服务路径穿越**：`http://127.0.0.1:38924/local-apps/{tabId}/..%2F..%2F` 及同名前缀目录（如 base 为 `C:\X`，请求解析到 `C:\X-secret`）一律 403（§2.2）。
- [ ] **temp/tasks IPC 防穿越**：`tasks:open-folder / list-folder / list-files / file-action / crop-image / cleanup-folder / task:active-update` 传入 temp/tasks 之外的绝对路径（如 `C:\Windows`）、`..` 相对路径，全部拒绝；`temp/tasks` 根目录本身不可被 delete/cleanup。
- [ ] 本地 HTTP API 鉴权：`/cookies /events /broadcast /state /tabs /active-tab /active-task` 无 token 返回 401。

---

## 附：已知问题登记（修复后移除）

> 2026-06-23 V3.4 回归实测：#1 / #2 / #6 已修复并验证通过（详见下表标注），待下次清理时从附表物理移除。

| # | 级别 | 描述 | 位置 |
|---|------|------|------|
| ~~1~~ | ~~P1~~ ✅已修 | `findTabByUrlPart` 已加 `String(tab.url\|\|"")` 防护，无 url 标签不再抛错；Hermes 阶段实测 13/13 通过（commit 3db281e） | renderer.js |
| ~~2~~ | ~~P1~~ ✅机制已修 | 旧 `select-file-dialog` 已废弃，改用 CDP `Page.fileChooserOpened` + `DOM.setFileInputFiles` + 系统选择器降级（commit 2eb1a87）；真机点公司平台上传【待人工】 | main.js |
| 3 | P2 | `DOMNodeRemovedFromDocument` 突变事件已被 Chromium 127+ 移除，删除标签后桌面应用轮询定时器与 CLI 监听器泄漏 | renderer.js:560/685/890 |
| 4 | P2 | 非 web 标签激活时点击顶栏扩展按钮 TypeError（`extBody` 为 null） | renderer.js:2158 |
| 5 | P2(待确认) | 全局下载捕获下，任意 .txt/.md/.json 被改名 dialogue.json 并误触发流水线推进 | main.js:651 |
| ~~6~~ | ~~P3~~ ✅已修 | Hermes 提示词换行已修为真换行（实测确认） | renderer.js |
| 7 | P3 | 流水线 `prepare` 步骤定义后从未被置为当前步骤（执行后直接 testing，2/5 起步） | renderer.js:1965 |
| 8 | P2 | 上传拦截 debugger 意外 detach（devtools 抢占）后重开拦截会重复注册 `debugger.on("message")`，fileChooserOpened 双处理、浮层弹两次（原扫描 M2） | main.js `setWebviewFileChooserInterception` |
| 9 | P2 | renderer 重载/无响应时 `pendingUploadRequests` 条目永久残留（Map 泄漏 + 该次选择悬挂）；建议 webContents destroyed/did-navigate 时清理（原扫描 M3） | main.js `handleFileChooserOpened` |
| 10 | P2 | 本地服务 38924 端口被占用时 error 回调静默置 null，本地项目标签/token/SSE/HTTP API 全部失效且无提示（原扫描 M5） | main.js `startLocalServer` |
| 11 | P2 | 删除扩展条目保存后已加载扩展不卸载，需手动「刷新并重新加载」才生效；建议 save 时对差集调用 removeExtension（原扫描 M6） | main.js `extensions:save` |
| 12 | P3 | 写回用打开预览时读到的 sourceText，预览停留期间 txt 被外部改动会被覆盖（有 .bak 兜底）；建议确认时重读比对（原扫描 L1） | renderer.js `applyTodoWriteback` |
| 13 | P3 | `swapTabs` 为死代码，拖拽重排已改用 categoryTabs splice 实现，可删除（原扫描 L2） | renderer.js `swapTabs` |
| 14 | P3 | CLI/白板视图 100ms setTimeout 初始化与「创建后立即删除标签」存在竞态：cleanup 先跑、pty 仍被拉起/resize 监听仍注册（极小窗口）（原扫描 L3） | renderer.js CLI/whiteboard 视图 |
| 15 | P3 | `fallbackSystemChooser` 中 `dialog.showOpenDialog(mainWindow ?? undefined, ...)` 首参传 undefined，建议改条件分支传参（原扫描 L4） | main.js `fallbackSystemChooser` |
| 16 | P3 | `serveFile` 中 existsSync 与 readFile 之间竞态会把已删除文件回 500 而非 404（仅状态码语义）（原扫描 L5） | main.js `serveFile` |