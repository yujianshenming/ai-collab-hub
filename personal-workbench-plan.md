# 个人定制工作台 (Personal Workbench) 详细开发与设计计划书

本计划书专为 AI 编程助手（如 Codex）编写，指导如何开发一个专属的高颜值桌面工作台应用。

---

## 1. 核心需求与架构设计

### 1.1 核心技术栈
- **运行环境**：Electron (Desktop Runtime)
  - *原因*：需要在内嵌窗口中加载任意第三方网页，并支持 Chrome 浏览器插件（Extensions）以及本地 PowerShell/CMD 终端。
- **前端界面**：HTML5 + Vanilla CSS + JavaScript (ES6+)
- **界面风格**：极简极光白（Warm Minimalist Light Theme），采用毛玻璃质感、淡雅投影与温和的渐变强调色。

### 1.2 浏览器插件 (Chrome Extensions) 支持方案
在 Electron 中，可以使用 `session.defaultSession.loadExtension` API 加载本地已解压的 Chrome 插件（例如 AdBlock、翻译插件等）。
- **插件加载逻辑**：
  在 Windows 系统中，Chrome 插件默认下载在：
  `%LOCALAPPDATA%\Google\Chrome\User Data\Default\Extensions\<extension-id>\<version>`
  主进程启动时，通过读取指定路径并加载插件：
  ```javascript
  const { app, session } = require('electron');
  const path = require('path');
  const os = require('os');

  // 示例：加载本地 Chrome 插件
  const extensionId = 'gighmmpiobklfepjocnamgkkbiglidom'; // AdBlock ID 示例
  const extensionPath = path.join(
    os.homedir(),
    'AppData/Local/Google/Chrome/User Data/Default/Extensions',
    extensionId
  );

  app.whenReady().then(async () => {
    try {
      // 扫描并加载最新版本的插件目录
      await session.defaultSession.loadExtension(extensionPath, { allowFileAccess: true });
      console.log('Extension loaded successfully');
    } catch (e) {
      console.error('Failed to load extension:', e);
    }
    createWindow();
  });
  ```

### 1.3 标签页状态保持 (State Preservation)
为确保在评估页面（`https://www.wl363eval.top/`）或其他标签页之间切换时，页面中的输入、登录状态和滚动条位置不丢失：
- **实现方式**：在 DOM 中为每一个侧边栏标签维护一个独立的 `<iframe>`（或 `<webview>`）容器。
- **显示控制**：切换侧边栏时，使用 CSS 类名控制显示隐藏，**严禁重构或重新赋值 iframe.src**。
  ```css
  .iframe-wrapper {
    display: none; /* 隐藏非活跃标签页，保留内存状态 */
  }
  .iframe-wrapper.active {
    display: flex; /* 仅展示活跃标签页 */
  }
  ```

---

## 2. 浅色主题 (Light Theme) UI 视觉规格

### 2.1 颜色系统 (CSS 变量)
```css
:root {
  --bg-app: #f8fafc;           /* 极浅灰蓝色背景 */
  --bg-sidebar: #ffffff;       /* 纯白侧边栏 */
  --bg-panel: #ffffff;         /* 纯白卡片与面板 */
  --border-color: #e2e8f0;     /* 浅灰边框 */
  --text-primary: #0f172a;     /* 深 slate 蓝主文本 */
  --text-secondary: #475569;   /* 中 gray 辅文本 */
  --text-muted: #94a3b8;       /* 浅 gray 弱化文本 */
  --accent-color: #3b82f6;     /* 科技蓝强调色 */
  --accent-light: rgba(59, 130, 246, 0.08); /* 强调色浅色背景 */
  --accent-gradient: linear-gradient(135deg, #3b82f6 0%, #6366f1 100%);
  --shadow-sm: 0 1px 3px rgba(0,0,0,0.05);
  --shadow-md: 0 4px 6px -1px rgba(0,0,0,0.05), 0 2px 4px -1px rgba(0,0,0,0.03);
  --shadow-lg: 0 10px 15px -3px rgba(0,0,0,0.04), 0 4px 6px -2px rgba(0,0,0,0.02);
}
```

### 2.2 视觉布局与交互设计
1. **侧边栏 (Sidebar)**：
   - 背景为纯白（`#ffffff`），右侧一条精致的淡灰边框（`1px solid #e2e8f0`）。
   - 菜单项在 Hover 时呈现微弱浅蓝底色（`--accent-light`） and 圆角过渡。
   - 激活项左侧有一条蓝色的立体状态指示条（`3px wide`），图标和字体颜色变更为强调蓝（`--accent-color`）。
2. **顶部工具栏 (Top Bar)**：
   - 采用半透明毛玻璃效果：`background: rgba(255, 255, 255, 0.85); backdrop-filter: blur(12px);`。
   - 当前正在进行的项目显示为精致的药丸状 Badge。
3. **底部终端栏 (Terminal Panel)**：
   - 面板高度支持向上滑出和向下隐藏的过渡动画。
   - 终端背景使用非常干净的浅色系代码底色（如 `#ffffff` 或 `#f8fafc`），文本为深蓝色，光标为强调色。
4. **弹窗模态窗 (Modal)**：
   - 居中显示，底板带有微弱毛玻璃模糊投影（`box-shadow: var(--shadow-lg)`），呈现高级悬浮感。

---

## 3. 核心功能文件结构与逻辑说明

### 3.1 `main.js` (主进程)
- 负责：窗口生命周期管理、解除 X-Frame-Options 限制、加载本地 Chrome 插件。
- 拦截并过滤响应头代码：
  ```javascript
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = details.responseHeaders;
    const deleteHeader = (name) => {
      const key = Object.keys(responseHeaders).find(k => k.toLowerCase() === name.toLowerCase());
      if (key) delete responseHeaders[key];
    };
    deleteHeader('x-frame-options');
    deleteHeader('content-security-policy');
    callback({ cancel: false, responseHeaders });
  });
  ```
- 建立 IPC 通道连接本地 Shell 进程（在 Windows 上默认启动 `powershell.exe`），将输入输出通过 `ipcMain` / `ipcRenderer` 与前端通讯。

### 3.2 `renderer.js` (渲染进程)
- 负责：多 iframe 标签管理、动态添加/删除标签、本地配置存储（LocalStorage）、呼出终端。
- 逻辑：
  - 初始化时，读取 LocalStorage 中的 `workbench_tabs`，渲染侧边栏和对应的 iframe。
  - 默认包含：**评估** -> `https://www.wl363eval.top/`。
  - 点击“添加标签页”，获取用户输入的名称和 URL，向 `tabs` 列表中 Push 数据，在 DOM 中追加一个新的 `iframe` 并执行 `display: none`。
  - 切换标签页时，仅移除前一个 `iframe-wrapper` 的 `.active` 类，并为当前选中的 `iframe-wrapper` 加上 `.active`。
  - 终端交互：在前端引入 `xterm.js` 并绑定 `#terminal-container`，通过调用 `ipcRenderer.send('terminal-input', data)` 与底层 PowerShell 交互。

---

## 4. 交付与下一步工作

1. **由 Codex 细化界面设计**：
   - 请 Codex 按照上述 **浅色极简视觉规格 (CSS 变量)** 重新编写 `style.css`，着重提升卡片阴影、圆角、间距和按钮微交互的视觉精致度。
2. **本地配置与插件目录对接**：
   - 开发者在使用时需要将 Chrome 插件 ID 和本地路径填入 `main.js` 中，以便 Electron 正确装载您的日常浏览器插件。
