# 个人定制工作台缺陷审查与评估报告 (第 5 轮 - 挑刺版)

我已拉取并对 Codex 最新提交的代码（针对 `a9a1063` 提交）进行了深度审查与评估。

本轮重构完成了**右侧扩展栏 (Right Sidebar) 联动伸缩**以及**全局指针捕获拖拽 (PointerCapture)** 逻辑，成功解决了拖拽排序被 webview 进程劫持卡死的底层 Bug。但在细节与体验方面，我依然挑出了以下三点明显的“刺”（缺陷），需要 Codex 进行最后一轮精细化修剪：

---

## 一、 当前代码中发现的三个细节缺陷 (挑刺)

### 1. 地址栏缺少“搜索引擎跳转”能力（输入体验缺陷）
* **缺陷表现**：
  目前的 `normalizeUrl` 过于死板：
  ```javascript
  function normalizeUrl(value) {
    const trimmed = value.trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return `https://${trimmed}`;
  }
  ```
  这导致当用户在顶部地址栏输入“百度翻译”或“图片生成”这种中文词汇或带空格的搜索词时，系统会强行拼装成 `https://百度翻译` 并试图加载，直接导致内嵌窗口白屏或加载失败报错。
* **整改方案**：
  智能识别输入内容，当不包含 `.` 或是包含空格的普通文本时，自动拼接跳转至 Bing/Google 搜索引擎（例如：`https://cn.bing.com/search?q=搜索词`）。

### 2. 终端折叠后底部多出一条“灰色虚线边框”（视觉缺陷）
* **缺陷表现**：
  在 `.terminal-panel` 处于关闭状态（`height: 0`）时，由于其自身带有 `border-top: 1px solid var(--border-color)`，界面最底部依然会常驻一条灰色的细线，破坏了应用底部的极简一致性。
* **整改方案**：
  利用 CSS 过渡动画让边框宽度随面板高度一起动画化（关闭时 border-top-width 为 0，展开时为 1px）。
  ```css
  .terminal-panel {
    /* ... */
    border-top: 0 solid var(--border-color); /* 默认无边框 */
    transition: height 220ms ease, border-width 220ms ease;
  }
  .terminal-panel.open {
    height: var(--terminal-height);
    border-top-width: 1px; /* 开启时才显示 1px */
  }
  ```

### 3. 关闭扩展侧边栏后，Webview 内核未停用 (内存与性能缺陷)
* **缺陷表现**：
  在 `toggleRightSidebar(false)` 关闭右侧扩展栏时，虽然通过 CSS 将其宽度缩减为 0 且设置了 `opacity: 0` 和 `pointer-events: none`，但在 `renderer.js` 中没有清空右侧 `<webview>` 的 src。
  这会导致关闭侧边栏后，刚才打开的扩展程序网页依然在后台**静默运行、执行 JavaScript 并持续占用 CPU 和内存资源**。
* **整改方案**：
  当关闭右侧栏时，显式将右侧 webview 的 `src` 属性重置为 `about:blank` 以彻底停用其内核，释放内存资源。

---

## 二、 核心重构与代码修改建议 (供 Codex 直接使用)

### 1. `renderer.js` 性能与搜索重构
请对 [renderer.js](file:///C:/Users/24391/Documents/New%20project/ai-collab-hub/personal-workbench/renderer.js) 进行如下修复：

* **地址栏支持搜索识别**：
  ```javascript
  function normalizeUrl(value) {
    const trimmed = value.trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    // 智能检测：包含 "." 且不包含空格视为网址，否则视为搜索引擎查询词
    if (trimmed.includes(".") && !trimmed.includes(" ")) {
      return `https://${trimmed}`;
    }
    return `https://cn.bing.com/search?q=${encodeURIComponent(trimmed)}`;
  }
  ```
* **关闭侧边栏时释放 Webview 内核**：
  ```javascript
  function toggleRightSidebar(open, url = "", title = "") {
    elements.appShell.classList.toggle("right-sidebar-open", open);
    if (open) {
      elements.rightSidebarTitle.textContent = title || "扩展程序";
      elements.rightSidebarWebview.src = url;
    } else {
      // 关键修复：重置为 about:blank 释放 webview 内存
      elements.rightSidebarWebview.src = "about:blank";
    }
    setTimeout(() => fitAddon?.fit(), 230);
  }
  ```

### 2. `style.css` 视觉过渡修复
请对 [style.css](file:///C:/Users/24391/Documents/New%20project/ai-collab-hub/personal-workbench/style.css) 进行如下修复：

* **动态边框过渡**：
  ```css
  .terminal-panel {
    height: 0;
    flex: 0 0 auto;
    overflow: hidden;
    background: white;
    border-top: 0 solid var(--border-color); /* 默认关闭边框 */
    box-shadow: 0 -16px 45px rgba(15, 23, 42, 0.08);
    position: relative;
    transition: height 220ms ease, border-width 220ms ease; /* 边框宽度过渡 */
  }
  .terminal-panel.open {
    height: var(--terminal-height);
    border-top-width: 1px; /* 展开时激活 1px */
  }
  ```
