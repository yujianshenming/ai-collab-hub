# 个人定制工作台缺陷审查与评估报告 (第 7 轮 - 新窗口链接与终端优化版)

我已对工作台在运行中的交互体验进行了深度审查，并结合您的最新反馈，找出了关于“超链接弹到外部浏览器”、“终端自动重启后尺寸变形”、以及“地址栏搜索限制”的核心问题。

本报告已提交至 GitHub，请通知 Codex 读取本报告并对相应文件进行重构。

---

## 一、 核心缺陷分析与整改方案 (请 Codex 实施)

### 1. 超链接跳转外部浏览器问题
* **缺陷表现**：
  当在工作台内页（如评估页面）点击一些含有 `target="_blank"` 的链接时，新页面会跳出工作台，直接在用户的系统默认浏览器（如 Chrome/Edge）中打开，破坏了工作台的闭环使用体验。
* **整改方案**：
  在主进程中拦截 Webview 新窗口创建事件，让其直接在当前 Webview 的 WebContents 中通过 `loadURL` 进行覆盖加载。
* **修改指导 (`personal-workbench/main.js`)**：
  定位到 `app.on("web-contents-created", ...)` 部分：
  ```javascript
  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() === "webview") {
      contents.setWindowOpenHandler(({ url }) => {
        // 核心修复：直接在当前 Webview 中加载 URL 覆盖当前页面
        contents.loadURL(url);
        return { action: "deny" };
      });
    }
  });
  ```

### 2. 终端自动重建时尺寸变形/出现黑边的问题
* **缺陷表现**：
  当内嵌 CMD 进程被退出（例如在终端内运行 `exit`）后，再次在键盘打字会通过 IPC 自动拉起一个新的终端。但因为此时没有传入当前的 `cols` 和 `rows`，导致拉起的新终端以默认的 `80x24` 大小进行初始化，出现渲染错位或大片黑边。
* **整改方案**：
  在主进程中维护一个全局的终端尺寸变量 `lastTerminalSize`。每次终端被缩放时，更新该变量。当因键盘输入触发终端重建时，自动应用最后一次记录的有效尺寸。
* **修改指导 (`personal-workbench/main.js`)**：
  - 在文件头部定义 `lastTerminalSize`：
    ```javascript
    let lastTerminalSize = { cols: 80, rows: 24 };
    ```
  - 修改 `startTerminal` 函数，在启动时将传入的尺寸保存到全局中，若无传入则使用最后记录的尺寸：
    ```javascript
    function startTerminal(size = {}) {
      if (terminalProcess) return;

      if (size.cols) lastTerminalSize.cols = Math.max(20, Number(size.cols));
      if (size.rows) lastTerminalSize.rows = Math.max(6, Number(size.rows));

      terminalProcess = pty.spawn("cmd.exe", ["/Q", "/K", "chcp 65001>nul"], {
        cols: lastTerminalSize.cols,
        rows: lastTerminalSize.rows,
        cwd: os.homedir(),
        env: { ...process.env, TERM: "xterm-256color" }
      });
      // ... 保持其他监听与交互逻辑不变
    }
    ```
  - 修改 `terminal:resize` 的 IPC 监听器：
    ```javascript
    ipcMain.on("terminal:resize", (_event, size) => {
      if (size) {
        if (size.cols) lastTerminalSize.cols = Math.max(20, Number(size.cols));
        if (size.rows) lastTerminalSize.rows = Math.max(6, Number(size.rows));
      }
      if (!terminalProcess) return;
      terminalProcess.resize(lastTerminalSize.cols, lastTerminalSize.rows);
    });
    ```

### 3. 地址栏输入非网址文本报错的问题
* **缺陷表现**：
  如果在地址栏中输入的是搜索词（如 `claude 使用教程`），目前的 `normalizeUrl` 会将其暴力拼接为 `https://claude 使用教程`，导致 Webview 无法加载。
* **整改方案**：
  优化地址栏的 URL 检测。如果输入不符合域名格式，则自动转为百度/Google等搜索引擎的搜索结果页。
* **修改指导 (`personal-workbench/renderer.js`)**：
  重构 `normalizeUrl(value)` 函数：
  ```javascript
  function normalizeUrl(value) {
    const trimmed = value.trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    
    // 如果是本地开发地址
    if (/^localhost(:\d+)?$/i.test(trimmed)) {
      return `http://${trimmed}`;
    }
    // 如果是域名或 IP (包含 "." 且不包含空格)
    if (/^[a-zA-Z0-9-]+\.[a-zA-Z0-9.-]+/i.test(trimmed) && !/\s/.test(trimmed)) {
      return `https://${trimmed}`;
    }
    // 否则作为百度搜索词
    return `https://www.baidu.com/s?wd=${encodeURIComponent(trimmed)}`;
  }
  ```

---

## 二、 后续优化与演进方向建议 (Roadmap Suggestions)

为使工作台未来更加强大实用，建议后续考虑以下重构路线：
1. **系统托盘后台运行常驻**：
   支持最小化到右下角托盘，不占任务栏，通过全局快捷键（如 `Alt + Space`）一键唤醒或隐藏主界面。
2. **多账号 Cookie 会话隔离**：
   在添加自定义标签页时，可选“隔离容器”，以使用独立的存储空间多开同一网站的不同账号。
3. **全局快捷键管理**：
   添加在多个工作台标签页中快速切换的快捷键（如 `Ctrl + Tab`），提升纯键盘流操作效率。
