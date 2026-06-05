# 个人定制工作台缺陷审查与评估报告 (第 8.3 轮 - 丝滑拉伸、扩展 Cookies 注入与尺寸重置版)

我已结合您的最新反馈（① 右侧边栏关闭再打开后恢复默认宽度；② 扩展无法调用 cookies API 报错 `getAll` 的底层问题；③ 拖拽拉伸不丝滑的卡顿问题），对工作台进行了补充审查与架构重构。

本报告已在本地更新，请您进行确认。

---

## 一、 本轮新增核心缺陷与优化方案 (请 Codex 实施整改)

### 缺陷 1：右侧边栏自定义宽度关闭后被持久化记忆，无法恢复初始大小 [严重等级：中]
* **缺陷原因**：
  在拖拽右侧栏时，自定义宽度直接写入了全局 CSS 变量 `--right-sidebar-width`。当关闭右侧边栏（或切换标签）并重新打开时，该 CSS 变量依然存在，导致无法重置为默认的 `340px` 初始宽度。
* **整改方案**：
  在关闭右侧栏（或者初始化/切换）时，显式将 `--right-sidebar-width` 样式属性从文档根节点中移除，使其回退到 CSS 中定义的默认值。
* **修改指导 (`personal-workbench/renderer.js`)**：
  修改 `toggleRightSidebar(open, ...)` 函数：
  ```javascript
  function toggleRightSidebar(open, url = "", title = "") {
    elements.appShell.classList.toggle("right-sidebar-open", open);
    if (open) {
      elements.rightSidebarTitle.textContent = title || "扩展程序";
      elements.rightSidebarWebview.src = url;
    } else {
      elements.rightSidebarWebview.src = "about:blank";
      // 关键修复：关闭右侧栏时，移除自定义宽度，恢复为默认 340px
      document.documentElement.style.removeProperty("--right-sidebar-width");
    }
    setTimeout(() => {
      fitAddon?.fit();
      fitWebviewZoom();
    }, 230);
  }
  ```

### 缺陷 2：扩展运行报错 `Cannot read properties of undefined (reading 'getAll')` [严重等级：高]
* **缺陷原因**：
  您的 Chrome 扩展在点击“一键获取配置”时，调用了 `chrome.cookies.getAll` 来获取当前网页的登录状态。然而，**Electron 的 Chrome 扩展加载器默认并未实现 `chrome.cookies` API**（它是未定义的），导致插件在调用时抛出 Undefined 崩溃。
* **整改方案**：
  在我们的扩展垫片脚本 [preload-popup.js](file:///C:/Users/24391/Documents/New%20project/ai-collab-hub/personal-workbench/preload-popup.js) 中，为 `window.chrome` 补充注入 `chrome.cookies.getAll` 和 `chrome.cookies.get` 的 Shim 垫片。在插件调用时，通过 IPC 向主进程发起查询，主进程调用 Electron 原生 Session Cookies 接口返回结果，实现完美打通！
* **修改指导**：
  - **在 `personal-workbench/main.js` 中**：
    注册获取 Cookie 的 IPC 处理器：
    ```javascript
    ipcMain.handle("workbench:get-cookies", async (_event, details = {}) => {
      try {
        // 使用工作台 persist 分区查询原生 cookie
        return await workbenchSession().cookies.get(details);
      } catch (err) {
        return [];
      }
    });
    ```
  - **在 [preload-popup.js](file:///C:/Users/24391/Documents/New%20project/ai-collab-hub/personal-workbench/preload-popup.js) 中**：
    编写 `mockCookies` 实现，并在 `patchChromeTabs` 中将其绑定：
    ```javascript
    const mockCookies = {
      getAll(details, callback) {
        const promise = ipcRenderer.invoke("workbench:get-cookies", details).then((list) => list || []);
        if (typeof callback === "function") promise.then(callback);
        return promise;
      },
      get(details, callback) {
        const promise = ipcRenderer.invoke("workbench:get-cookies", details).then((list) => list?.[0] || null);
        if (typeof callback === "function") promise.then(callback);
        return promise;
      }
    };

    function patchChromeApis(chromeApi) {
      if (!chromeApi) return;
      // 注入 tabs API
      chromeApi.tabs = chromeApi.tabs || {};
      chromeApi.tabs.query = mockTabs.query;
      chromeApi.tabs.getSelected = mockTabs.getSelected;
      
      // 关键修复：注入 cookies API 补全
      chromeApi.cookies = chromeApi.cookies || {};
      chromeApi.cookies.getAll = mockCookies.getAll;
      chromeApi.cookies.get = mockCookies.get;
    }
    ```
    *(注：确保 getter/setter 劫持中也将 `patchChromeApis` 应用于 `window.chrome`。)*

### 缺陷 3：拉伸底部终端和右侧栏时存在“严重卡顿/延迟”不丝滑 [严重等级：中]
* **缺陷原因**：
  因为我们在 `.terminal-panel`（高）、`.app-shell`（网格列宽）中配置了 CSS 过渡动画（`transition: height 220ms ease` 等）。在鼠标拖动时，每一帧都在修改尺寸，而 CSS 动画会在每一帧之间尝试进行过渡，导致**界面渲染严重滞后于鼠标轨迹，显得极不跟手和卡顿**。
* **整改方案**：
  在开始拖拽（PointerDown）时，为 `body` 或 `.app-shell` 动态添加一个 `.resizing` 类；在结束拖拽（PointerUp）时移除该类。在 CSS 中配置：当处于 `.resizing` 状态下时，**强制禁用一切 transition 过渡**，从而实现绝对实时、丝滑跟手的拉拽体验。
* **修改指导**：
  - **[style.css](file:///C:/Users/24391/Documents/New%20project/ai-collab-hub/personal-workbench/style.css)**：
    ```css
    /* 拖拽拉伸时禁用一切过渡效果，保障绝对流畅 */
    .app-shell.resizing,
    .app-shell.resizing * {
      transition: none !important;
    }
    ```
  - **[renderer.js](file:///C:/Users/24391/Documents/New%20project/ai-collab-hub/personal-workbench/renderer.js)**：
    在 `beginTerminalResize` 和 `beginRightSidebarResize` 的 `pointerdown` 处加入：
    ```javascript
    elements.appShell.classList.add("resizing");
    ```
    在对应的 `onUp` 处理函数（拖拽结束）中加入：
    ```javascript
    elements.appShell.classList.remove("resizing");
    ```

---

## 二、 之前的缺陷与优化项目（保留并整合）

1. **缺陷 4：删除 `shell` 模块导致外部协议链接（如 `mailto:`、`vscode:`）失效**。
2. **缺陷 5：地址栏对 `file://` 协议的支持缺失**。
3. **缺陷 6：新建标签页保存 URL 未做智能清洗导致死链接**。
4. **缺陷 7：桌面端一键启动与打包支持（新增 `启动工作台.vbs` 免黑框脚本，配置打包命令）**。
5. **缺陷 8：网页加载或网络异常时，缺乏任何 UI 进度反馈**。
