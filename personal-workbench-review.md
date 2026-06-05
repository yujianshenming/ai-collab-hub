# 个人定制工作台缺陷审查与评估报告 (第 8.2 轮 - 鼠标拉伸、插件 URL 获取与刷新版)

我已根据您的最新反馈（① 右侧栏需要鼠标拉拽调节宽度且中间比例缩放；② 插件无法获取当前页面链接；③ 扩展设置中需要刷新按钮），对工作台进行了补充审查与架构设计。

本报告已在本地更新，请您进行最终审查。确认无误后我们一同提交至 GitHub，由 Codex 实施重构。

---

## 一、 新增核心缺陷与优化方案 (请 Codex 实施整改)

### 缺陷 1：右侧插件边栏固定宽度，无法手动拖拽调节 [严重等级：中]
* **缺陷表现**：
  由于不同 Chrome 插件的 UI 比例和信息密度不同，固定的右侧栏宽度（340px）会导致部分插件内容显示不全。
* **整改方案**：
  在右侧边栏左边缘加入一条宽度为 `12px` 的隐形拖拽手柄（Resizer），并利用 `setPointerCapture` 手势监听，实现用鼠标拖拽实时调节右侧栏宽度，同时触发中间 Webview 区域的响应式缩放。
* **修改指导**：
  - **[index.html](file:///C:/Users/24391/Documents/New%20project/ai-collab-hub/personal-workbench/index.html)**：在 `#right-sidebar` 内部最前端加入：
    ```html
    <div id="right-sidebar-resizer" class="right-sidebar-resizer" title="拖动调整侧边栏宽度"></div>
    ```
  - **[style.css](file:///C:/Users/24391/Documents/New%20project/ai-collab-hub/personal-workbench/style.css)**：
    ```css
    .right-sidebar { position: relative; }
    .right-sidebar-resizer { width: 12px; cursor: ew-resize; position: absolute; left: -6px; top: 0; bottom: 0; z-index: 10; }
    ```
  - **[renderer.js](file:///C:/Users/24391/Documents/New%20project/ai-collab-hub/personal-workbench/renderer.js)**：
    实现 `beginRightSidebarResize` 监听器，并在拖拽过程中更新 CSS 变量 `--right-sidebar-width`：
    ```javascript
    const rightResizer = document.querySelector("#right-sidebar-resizer");
    rightResizer.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      rightResizer.setPointerCapture(event.pointerId);
      setWebviewPointerEvents(false);
      const startX = event.clientX;
      const startWidth = elements.rightSidebar.getBoundingClientRect().width;
      
      const onMove = (moveEvent) => {
        // 因为侧边栏在右侧，向左拖拽（clientX 变小）宽度变大
        const width = Math.max(280, Math.min(window.innerWidth * 0.6, startWidth + startX - moveEvent.clientX));
        document.documentElement.style.setProperty("--right-sidebar-width", `${width}px`);
        fitWebviewZoom();
      };
      const onUp = () => {
        rightResizer.releasePointerCapture(event.pointerId);
        setWebviewPointerEvents(true);
        rightResizer.removeEventListener("pointermove", onMove);
        rightResizer.removeEventListener("pointerup", onUp);
      };
      rightResizer.addEventListener("pointermove", onMove);
      rightResizer.addEventListener("pointerup", onUp);
    });
    ```

### 缺陷 2：嵌入的 Chrome 扩展无法获取工作台当前的网页链接（无法激活按钮） [严重等级：高]
* **缺陷原因**：
  Chrome 插件通常调用 `chrome.tabs.query({ active: true, currentWindow: true })` 来查询当前激活标签页的 URL。在 Electron 中，由于插件运行在独立的扩展上下文，它无法识别网页的 `<webview>` 为标准浏览器 Tab，导致插件查询不到当前 URL（出现您截图中的“请在训练页面打开”提示）。
* **整改方案**：
  通过编写一个专门针对扩展 Popup 窗口的 `webview 预加载脚本` (Popup Preload)，重写并注入 `chrome.tabs.query` 和 `chrome.tabs.getSelected` API。在插件调用该接口时，通过 IPC 向主进程获取工作台当前活跃的 webview 网页地址，实现无缝对接！
* **修改指导**：
  - **[NEW] [preload-popup.js](file:///C:/Users/24391/Documents/New%20project/ai-collab-hub/personal-workbench/preload-popup.js)**：
    ```javascript
    const { contextBridge, ipcRenderer } = require("electron");

    let mockChrome = {
      tabs: {
        query(queryInfo, callback) {
          ipcRenderer.invoke("workbench:get-active-tab-info").then((tabInfo) => {
            callback([{ id: 9999, url: tabInfo.url, title: tabInfo.title, active: true }]);
          });
        },
        getSelected(windowId, callback) {
          const cb = typeof windowId === "function" ? windowId : callback;
          ipcRenderer.invoke("workbench:get-active-tab-info").then((tabInfo) => {
            cb({ id: 9999, url: tabInfo.url, title: tabInfo.title, active: true });
          });
        }
      }
    };

    // 智能拦截并注入到 chrome API 中
    if (typeof window.chrome === "undefined") {
      let realChrome = undefined;
      Object.defineProperty(window, "chrome", {
        get() { return realChrome || mockChrome; },
        set(val) {
          realChrome = val;
          if (realChrome) {
            realChrome.tabs = realChrome.tabs || {};
            realChrome.tabs.query = mockChrome.tabs.query;
            realChrome.tabs.getSelected = mockChrome.tabs.getSelected;
          }
        },
        configurable: true
      });
    } else {
      window.chrome.tabs = window.chrome.tabs || {};
      window.chrome.tabs.query = mockChrome.tabs.query;
      window.chrome.tabs.getSelected = mockChrome.tabs.getSelected;
    }
    ```
  - **[preload.js](file:///C:/Users/24391/Documents/New%20project/ai-collab-hub/personal-workbench/preload.js)** & **[renderer.js](file:///C:/Users/24391/Documents/New%20project/ai-collab-hub/personal-workbench/renderer.js)**：
    - 渲染进程在切换标签页（`activateTab`）和网页跳转（`did-navigate`）时，通过 IPC 更新主进程记录的 `activeTabInfo`：
      `window.workbench.updateActiveTabInfo({ url: webview.getURL(), title: tab.name })`。
    - 为右侧侧边栏 webview 动态绑定该预加载脚本：
      `<webview id="right-sidebar-webview" partition="persist:personal-workbench" preload="preload-popup.js"></webview>`。
  - **[main.js](file:///C:/Users/24391/Documents/New%20project/ai-collab-hub/personal-workbench/main.js)**：
    - 增加内存状态变量 `let activeTabInfo = { url: "", title: "" };`
    - 注册 IPC 监听：`ipcMain.on("tab:active-update", (_, info) => { activeTabInfo = info; });`
    - 注册 IPC 处理：`ipcMain.handle("workbench:get-active-tab-info", () => activeTabInfo);`

### 缺陷 3：扩展设置弹窗缺少“刷新扩展”功能 [严重等级：中]
* **缺陷原因**：
  修改或添加扩展路径后，必须彻底重启整个应用才能让扩展生效，调试和使用过程极不方便。
* **整改方案**：
  在扩展设置的弹窗标题旁增加一个刷新的图标按钮。点击后，主进程遍历并卸载所有已加载扩展，并重新从配置文件载入加载，实现热重载。
* **修改指导**：
  - **[index.html](file:///C:/Users/24391/Documents/New%20project/ai-collab-hub/personal-workbench/index.html)**：在 `#settings-dialog` 的标题右侧添加刷新按钮：
    ```html
    <h2>本地扩展设置 <button id="refresh-extensions-button" class="icon-button inline-refresh" type="button" title="刷新并重新加载扩展">↻</button></h2>
    ```
  - **[main.js](file:///C:/Users/24391/Documents/New%20project/ai-collab-hub/personal-workbench/main.js)**：
    ```javascript
    ipcMain.handle("extensions:refresh", async () => {
      const loaded = workbenchSession().extensions.getAllExtensions();
      for (const ext of loaded) {
        try { workbenchSession().extensions.removeExtension(ext.id); } catch {}
      }
      extensionResults = await loadConfiguredExtensions();
      return extensionResults;
    });
    ```
  - **[renderer.js](file:///C:/Users/24391/Documents/New%20project/ai-collab-hub/personal-workbench/renderer.js)**：
    绑定 `#refresh-extensions-button` 的点击事件，调用 `window.workbench.refreshExtensions()` 并在完成后重新渲染扩展列表。

---

## 二、 之前的缺陷与优化项目（保留并整合）

1. **缺陷 4：删除 `shell` 模块导致外部协议链接（如 `mailto:`、`vscode:`）失效**。
2. **缺陷 5：地址栏对 `file://` 协议的支持缺失**。
3. **缺陷 6：新建标签页保存 URL 未做智能清洗导致死链接**。
4. **缺陷 7：桌面端一键启动与打包支持（新增 `启动工作台.vbs` 免黑框脚本，配置打包命令）**。
5. **缺陷 8：网页加载或网络异常时，缺乏任何 UI 进度反馈**。
