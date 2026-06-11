# 任务系统与安全问题修复需求文档

在第一阶段编码完成后，我们对工作台进行了严格审查与验证。以下是发现的缺陷及整改要求，请 Codex 进行修复。

---

## 1. 任务面板（Task Panel）交互边缘缺陷修复

### 1.1 缺陷现象：点击删除任务时，面板会意外收起
* **原因分析**：
  在任务面板内，用户点击“删除任务”按钮（`.task-delete`）后，底层数据发生改变并重新渲染表格，这导致原有的删除按钮 DOM 节点被销毁（离线化）。
  在事件冒泡到 `document` 时，`event.target` 指向的该按钮已经不在文档树中。此时，`panel.contains(target)` 会返回 `false`，从而误判为“点击了面板外部”，非预期地触发了 `closeTaskPanel()` 并关闭了下拉抽屉。
* **修改方案 (`renderer.js`)**：
  不使用 `panel.contains(target)` 进行简单判断，而是改用现代 Web API `event.composedPath()`。它可以获取完整的事件冒泡路径。只要冒泡路径中包含面板元素或“任务”按钮，即说明点击起源于它们内部，不应关闭面板。
  
  请修改 `renderer.js` 中的全局点击监听器：
  ```javascript
  document.addEventListener("click", (event) => {
    const panel = elements.taskPanel;
    if (!panel?.classList.contains("open")) return;

    const taskButton = elements.menuTaskButton;
    // 使用 composedPath 获取事件冒泡路径，防止子元素销毁后导致判定失效
    const path = event.composedPath();
    if (path.includes(panel) || path.includes(taskButton)) return;

    closeTaskPanel();
  });
  ```

---

## 2. 系统高危安全漏洞修复

### 2.1 修复 Session Token 泄露给第三方网站的风险
* **漏洞描述**：
  在 `renderer.js` 中，当 `dom-ready` 触发时，无差别地为所有 webview 注入了 `window.__workbenchSessionToken`。当用户在工作台打开不受信任的第三方网站（如 `type === "web"`）时，该网站的脚本即可获取该 Token，并通过本地 HTTP API 发送请求，接管本地服务或读取机密 Cookie。
* **修改方案 (`renderer.js`)**：
  仅在受信的本地 Web 应用（`type === "local-web"`）或访问本地服务器（如 `localhost` 或 `127.0.0.1` 的任意端口，用于支持开发者在其他端口启动本地服务进行跨会话通信）的 webview 中注入 Token。
  
  请修改 `renderer.js` 中注入 Token 的逻辑：
  ```javascript
  webview.addEventListener("dom-ready", () => {
    fitWebviewZoom();
    const url = webview.getURL() || "";
    const isLocalUrl = url.startsWith("http://127.0.0.1") || 
                       url.startsWith("http://localhost") || 
                       url.startsWith("https://127.0.0.1") || 
                       url.startsWith("https://localhost");
                       
    // 仅在 local-web 应用或以本地环回地址 (localhost/127.0.0.1) 开头的服务中注入安全 Token
    // 这既保证了跨会话数据流通总线 (SSE/State) 的正常使用，又避免了向外网第三方站点泄漏凭证
    if (tab.type === "local-web" || isLocalUrl) {
      window.workbench.getSessionToken().then((token) => {
        webview.executeJavaScript(`window.__workbenchSessionToken = "${token}";`).catch(() => {});
      });
    }
  });
  ```

### 2.2 修复静态文件服务路径穿越漏洞（Directory Traversal）
* **漏洞描述**：
  在 `main.js` 的 `/local-apps` 文件服务中，路径穿越校验使用了 `!targetPath.startsWith(path.resolve(baseDir))`。因为匹配没有加上路径分隔符，导致“同名前缀目录穿越”。例如，若 `baseDir` 为 `C:\Users\Public`，则攻击者可以读取 `C:\Users\Public-Secret\data.txt`。
* **修改方案 (`main.js`)**：
  在比对路径前缀时，必须追加平台目录分隔符 `path.sep`。
  
  请修改 `main.js` 中静态文件请求处理的相关路径安全比对逻辑（约第 517 行）：
  ```javascript
  const targetPath = path.resolve(baseDir, relPath);
  const resolvedBase = path.resolve(baseDir);
  // 确保比对前缀包含分隔符，保障绝对限定在目标目录树下
  const baseWithSep = resolvedBase.endsWith(path.sep) ? resolvedBase : resolvedBase + path.sep;
  if (!targetPath.startsWith(baseWithSep) && targetPath !== resolvedBase) {
    sendJson(res, 403, { error: "Access denied" });
    return;
  }
  ```

---

## 3. 新增任务暂停（Pause）与继续（Resume）功能

为了支持多任务切换和挂起，需要为任务管理面板增加“暂停”和“继续”机制：

### 3.1 状态与按钮渲染变化 (`renderer.js`)
- 在 `taskStatusLabel` 中增加 `paused: "已暂停"` 状态。
- 在 `renderWeeklyTasks()` 渲染任务动作时：
  - 如果任务处于正在进行（`running`）或评估中（`evaluating`），不显示“执行”按钮，而是显示一个**“暂停”**按钮，点击调用 `pauseTaskAutomation(task.id)`。
  - 如果任务处于已暂停（`paused`），不显示“执行”按钮，而是显示一个**“继续”**按钮，点击调用 `resumeTaskAutomation(task.id)`。
  - 其他状态显示默认的**“执行”**按钮。

### 3.2 样式支持 (`style.css`)
- 在 `style.css` 中，为已暂停状态的 Badge 添加样式：
  ```css
  .status-paused {
    color: #b45309;
    background: #fffbeb;
  }
  ```

### 3.3 逻辑方法实现 (`renderer.js`)
- **防冲突检查**：在 `startTaskAutomation` 和 `resumeTaskAutomation` 入口处判断。如果当前有正在运行的活跃任务 (`pipelineState.active` 为 true)，应使用 `showToast` 提示：“当前已有正在运行的任务，请先暂停或结束当前任务。”并中断操作。
- **暂停逻辑 `pauseTaskAutomation(id)`**：
  1. 查找任务。如果 `pipelineState.active && pipelineState.taskId === id`，将当前的全局管线状态暂存入该任务对象：
     ```javascript
     task.chatLogPath = pipelineState.chatPath || "";
     task.reportPath = pipelineState.reportPath || "";
     task.taskFolder = pipelineState.taskFolder || "";
     task.step = pipelineState.step || "testing";
     ```
  2. 将 `task.status` 设为 `"paused"`。
  3. 重置全局 `pipelineState` 为未激活（`active: false, taskId: null, step: "idle", ...`）。
  4. 调用 `updateActiveTaskMenu(null)` 隐藏进行中横幅。
  5. 调用 `persistWeeklyTasks()` 和 `renderWeeklyTasks()`。
- **继续逻辑 `resumeTaskAutomation(id)`**：
  1. 检查防冲突限制。
  2. 从任务中提取保存的字段并还原 `pipelineState`：
     ```javascript
     pipelineState = {
       active: true,
       taskId: id,
       step: task.step || "testing",
       chatPath: task.chatLogPath || "",
       reportPath: task.reportPath || "",
       taskFolder: task.taskFolder || "",
       uploadQueue: []
     };
     ```
  3. 还原任务状态：如果 `task.step === "evaluating"` 则设为 `"evaluating"`，否则设为 `"running"`。
  4. 调用 `updateActiveTaskMenu(task)` 浮现横幅。
  5. 调用 `persistWeeklyTasks()` 和 `renderWeeklyTasks()`。

---

## 4. 验收标准
1. 点击面板内删除任务，删除成功且面板**保持展开**。
2. 面板关闭时点击顶栏“终端”或侧边栏正常工作，无点击失效或遮挡问题。
3. 加载普通网页（如 `http://baidu.com`）时，其 `window.__workbenchSessionToken` 应该为 `undefined`，不可泄露凭证。
4. 静态文件目录不可被穿越到具有同名前缀的邻近文件夹。
5. **任务暂停**：点击运行中任务的“暂停”，顶部横幅消失，任务状态变为“已暂停”（橙黄色 Badge），按钮变为“继续”。任务临时文件夹**不应被清理**。
6. **任务继续**：点击暂停中任务的“继续”，如果此时无其他活跃任务，则正常恢复执行（横幅重新显现），状态还原；若此时有其他任务正在运行，则弹出防冲突警告并拦截。

---

## 5. Windows 启动控制台附加冲突（AttachConsole failed）排查与建议

在非交互式命令行沙箱或某些特定的 Terminal 包装环境（例如通过 `npm start` 脚本包装器启动）下启动 Electron 应用时，可能会在创建 `node-pty` 终端实例时抛出如下错误并导致应用闪退：
```text
C:\Users\24391\.gemini\antigravity\scratch\ai-collab-hub\personal-workbench\node_modules\node-pty\lib\conpty_console_list_agent.js:13
var consoleProcessList = getConsoleProcessList(shellPid);
                         ^
Error: AttachConsole failed
```
* **原因分析**：这是由于 `node-pty` 在 Windows 环境下，尝试获取终端子进程列表时调用了 Windows 原生的 `AttachConsole` API。若 Electron 进程是通过命令行工具（如 npm 包装器）启动，且控制台会话被外部父环境拦截/捕获，极易产生控制台会话占用冲突，导致 API 执行失败。
* **解决与排查建议**：
  1. **避开 npm 包装器启动**：不要在沙箱命令行中执行 `npm start`。应当直接使用 Electron 的本地可执行文件或者以 detached 进程方式启动，例如：
     ```powershell
     # 1. 命令行中直接调用本地 Electron 二进制启动
     .\node_modules\.bin\electron.cmd .
     
     # 2. 或是通过 PowerShell 起独立分离窗口启动（推荐，已验证能完全避免控制台冲突）
     Start-Process .\node_modules\.bin\electron.cmd -ArgumentList "." -WorkingDirectory "C:\Users\24391\.gemini\antigravity\scratch\ai-collab-hub\personal-workbench"
     ```
  2. **加固未捕获异常处理**：建议 Codex 可以考虑在进程层面或 PTY 终端初始化代码外侧捕获此类未捕获错误，防止因为单个终端进程获取列表失败而直接导致整个 Electron 主窗口闪退崩溃。
