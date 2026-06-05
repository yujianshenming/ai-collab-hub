# 个人定制工作台缺陷审查与评估报告 (第 9 轮 - 扩展 background.js 深度突破版)

我已针对扩展在工作台内“仍无法使用”、“无法获取配置且报错”的问题，对您的扩展源码 [background.js](file:///C:/Users/24391/Downloads/chrome-extension-skill-training-course-main/dist/background.js) 进行了深度审查。

我们找出了**导致扩展功能失效的终极原因**并设计了破局方案。本报告已更新，请在确认后我们一起提交至 GitHub，由 Codex 实施双端重构。

---

## 一、 缺陷根本原因分析 (Root Cause)

1. **`chrome.cookies` 报错 `getAll` 属于 background.js 崩溃**：
   - 您的扩展中，获取 Cookie 和配置的实际逻辑并非运行在 Popup 弹窗中，而是运行在扩展独立的 Service Worker 进程 [background.js](file:///C:/Users/24391/Downloads/chrome-extension-skill-training-course-main/dist/background.js) 中（第 1122 行 `chrome.cookies.getAll` 以及第 1010 行 `chrome.cookies.get`）。
   - 之前我们通过 `preload-popup.js` 仅仅在 Popup 弹窗的 webview 中注入了 API。但是，**background.js 运行在独立的扩展后台页面上下文，完全无法加载 preload 脚本**。这导致 background 运行时因为调用了未定义的 `chrome.cookies` 直接崩溃。
2. **`chrome.tabs.query` 在 background.js 中获取不到当前网页 URL**：
   - background.js 频繁调用 `chrome.tabs.query({ active: true, currentWindow: true })` 来识别用户正在浏览的页面。
   - 在 Electron 环境中，后台进程无法将 `<webview>` 识别为标准浏览器 Tab。这导致 `chrome.tabs.query` 返回空数组，使插件误判定用户“未在能力训练页面”，因而按钮呈现灰色状态。

---

## 二、 终极整改方案 (请 Codex 实施双端重构)

由于扩展后台环境没有 IPC 权限，我们需要在工作台主进程中**开启一个超轻量的本地 HTTP 服务**，供扩展 background.js 异步获取工作台的 Cookie 和活动标签状态，从而完美实现桥接。

### 1. 工作台主进程重构：`personal-workbench/main.js`
- 引入 Node 原生的 `http` 模块，在主进程启动时监听本地端口（如 `38924`）。
- 注册两个微型 API 接口：
  - `/cookies`：读取工作台原生 Session 中的 Cookie。
  - `/active-tab`：返回当前工作台活跃的标签页 URL。

* **修改指导 (`personal-workbench/main.js`)**：
  在 `main.js` 中新增以下逻辑：
  ```javascript
  const http = require("node:http");
  let localServer;

  function startLocalServer() {
    if (localServer) return;
    localServer = http.createServer(async (req, res) => {
      // 允许跨域
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "*");
      
      const parsedUrl = new URL(req.url, "http://localhost");
      
      if (parsedUrl.pathname === "/cookies") {
        const urlParam = parsedUrl.searchParams.get("url");
        const nameParam = parsedUrl.searchParams.get("name");
        try {
          const filter = {};
          if (urlParam) filter.url = urlParam;
          if (nameParam) filter.name = nameParam;
          const cookies = await workbenchSession().cookies.get(filter);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(cookies));
        } catch {
          res.writeHead(500);
          res.end("[]");
        }
      } else if (parsedUrl.pathname === "/active-tab") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(activeTabInfo));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    // 监听本地回环端口
    localServer.listen(38924, "127.0.0.1");
  }

  function stopLocalServer() {
    if (localServer) {
      localServer.close();
      localServer = null;
    }
  }
  ```
  在 `app.whenReady()` 的最后调用 `startLocalServer()`，在 `window-all-closed` 处调用 `stopLocalServer()`。

---

### 2. 扩展后台文件重构：在 [background.js](file:///C:/Users/24391/Downloads/chrome-extension-skill-training-course-main/dist/background.js) 头部注入 Polyfill 垫片
- 我们需要在您的扩展文件 `C:\Users\24391\Downloads\chrome-extension-skill-training-course-main\dist\background.js` **第 1 行之前**，由 Codex 强行置入以下 polyfill 垫片，用于拦截扩展后台对 `chrome.cookies` 和 `chrome.tabs` 的调用，并自动请求本地接口：

* **修改指导 (`C:\Users\24391\Downloads\chrome-extension-skill-training-course-main\dist\background.js`)**：
  在 `background.js` 文件最顶端 prepend 写入以下代码：
  ```javascript
  // ================= Electron Extension Background Polyfill =================
  (function() {
    if (typeof chrome !== "undefined") {
      // 1. Polyfill chrome.cookies
      if (!chrome.cookies) {
        chrome.cookies = {
          async getAll(details = {}) {
            const url = details.url ? `?url=${encodeURIComponent(details.url)}` : "";
            const res = await fetch(`http://127.0.0.1:38924/cookies${url}`);
            return await res.json();
          },
          async get(details = {}) {
            const url = details.url ? `?url=${encodeURIComponent(details.url)}` : "";
            const name = details.name ? `&name=${encodeURIComponent(details.name)}` : "";
            const res = await fetch(`http://127.0.0.1:38924/cookies${url}${name}`);
            const list = await res.json();
            return list[0] || null;
          }
        };
      }
      // 2. Polyfill chrome.tabs
      if (chrome.tabs) {
        const originalQuery = chrome.tabs.query;
        chrome.tabs.query = async function(queryInfo, callback) {
          if (queryInfo && queryInfo.active) {
            try {
              const res = await fetch("http://127.0.0.1:38924/active-tab");
              const tabInfo = await res.json();
              const tab = { id: 9999, url: tabInfo.url, title: tabInfo.title, active: true };
              if (typeof callback === "function") callback([tab]);
              return [tab];
            } catch {
              return [];
            }
          }
          if (originalQuery) return originalQuery.apply(this, arguments);
        };
        const originalGetSelected = chrome.tabs.getSelected;
        chrome.tabs.getSelected = async function(windowId, callback) {
          const cb = typeof windowId === "function" ? windowId : callback;
          try {
            const res = await fetch("http://127.0.0.1:38924/active-tab");
            const tabInfo = await res.json();
            const tab = { id: 9999, url: tabInfo.url, title: tabInfo.title, active: true };
            if (typeof cb === "function") cb(tab);
            return tab;
          } catch {
            return null;
          }
        };
      }
    }
  })();
  // =========================================================================
  ```

---

## 三、 验证计划

1. **测试扩展自动配置**：
   - 重启工作台（通过双击 `启动工作台.vbs`）。
   - 切换到含有 `trainTaskId` 的网页页面。
   - 点击插件图标呼出右侧抽屉，验证**原本被禁用的“开始对话”大按钮已成功被激活（表示 tabs 成功匹配）**。
   - 点击“**一键获取平台配置**”按钮，验证 `Cannot read properties of undefined` 报错彻底清除，成功提取出该站点的 Cookie 和 JWT！
2. **测试拉伸流畅性与重置**：
   - 拖拽右侧栏看是否依然保持流畅的实时无过渡渲染。
   - 关闭后重试，确保自动缩回 `340px`。
