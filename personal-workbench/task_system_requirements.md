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
  仅在受信的本地 Web 应用（`type === "local-web"`）或访问本地服务的 webview 中注入 Token。
  
  请修改 `renderer.js` 中注入 Token 的逻辑：
  ```javascript
  webview.addEventListener("dom-ready", () => {
    fitWebviewZoom();
    const url = webview.getURL() || "";
    // 仅在 local-web 应用或以本地服务 URL 开头时注入安全 Token
    if (tab.type === "local-web" || url.startsWith("http://127.0.0.1:38924")) {
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

## 3. 验收标准
1. 点击面板内删除任务，删除成功且面板**保持展开**。
2. 面板关闭时点击顶栏“终端”或侧边栏正常工作，无点击失效或遮挡问题。
3. 加载普通网页（如 `http://baidu.com`）时，其 `window.__workbenchSessionToken` 应该为 `undefined`，不可泄露凭证。
4. 静态文件目录不可被穿越到具有同名前缀的邻近文件夹。
