# 个人定制工作台自动化打通与任务管理系统实现方案

本方案旨在解决用户在测试、评估、分析流程中频繁手动下载与上传文件的痛点，并通过在顶部工具栏集成“本周任务列表”，实现“任务 -> 测试 -> 评估 -> 分析”的全链路自动化闭环。

---

## 1. 痛点分析与设计目标

### 1.1 现有痛点工作流
1. 在 **测试页面** 利用插件完成对话测试。
2. **手动下载** 测试对话文件（JSON/TXT）。
3. 切换至 **评估页面**（`https://www.wl363eval.top/`），**手动上传** 测试对话文件，并**手动上传** 关联的任务文档。
4. 点击评估，等待评估完成。
5. **手动下载** 评估报告文件（PDF/HTML）。
6. 切换至 **Hermes分析页面**，**手动输入或上传** 测试对话与评估报告的路径/内容，发送给 Hermes 进行诊断分析。

### 1.2 优化后的自动化工作流
1. 用户在 **任务列表** 中点击某项任务的 **“一键自动化执行”**，系统自动加载对应的任务文档，并切换到 **测试页面**。
2. 用户在测试页面完成对话后点击下载，Electron **自动拦截下载** 并静默保存至本地临时目录（如 `temp/chats/`）。
3. 平台检测到测试文件下载完成后，**自动切换到评估页面**，通过 Webview 注入脚本**自动点击上传按钮**并**静默注入**刚下载的测试对话与对应的任务文档，**自动触发评估**。
4. 评估完成后触发报告下载，Electron **自动拦截下载** 并静默保存至本地临时目录（如 `temp/reports/`）。
5. 平台检测到报告下载完成后，**自动切换到 Hermes 页面**，将测试对话与评估报告的本地路径（或内容摘要）自动填充到输入框并**自动发送给 Hermes**，供其直接分析。

---

## 2. 核心技术方案

为了实现上述静默上传与脚本自动化，我们需要将现有的 `<iframe>` 标签替换为 Electron 的 `<webview>` 标签。`<webview>` 提供了极强的进程隔离和更底层的事件拦截能力。

### 2.1 启用 Webview 与解除安全限制 (`main.js`)
在主进程创建窗口时，必须开启 `webviewTag: true`。
```javascript
mainWindow = new BrowserWindow({
  width: 1400,
  height: 900,
  webPreferences: {
    nodeIntegration: true,
    contextIsolation: false,
    webSecurity: false,
    webviewTag: true // 必须启用 webview 标签
  },
  title: "个人专属工作台",
  autoHideMenuBar: true
});
```

### 2.2 下载自动拦截与静默保存 (`main.js`)
监听主进程 session 的 `will-download` 事件，拦截文件下载并根据文件格式自动归类保存，避免弹出“另存为”对话框。
```javascript
const fs = require('fs');

session.defaultSession.on('will-download', (event, item, webContents) => {
  const filename = item.getFilename();
  let saveDir = path.join(app.getAppPath(), 'temp');
  let fileType = 'generic';

  // 根据文件名和格式区分测试对话与评估报告
  if (filename.endsWith('.json') || filename.includes('chat') || filename.includes('dialog')) {
    saveDir = path.join(saveDir, 'chats');
    fileType = 'chat';
  } else if (filename.endsWith('.pdf') || filename.includes('report') || filename.includes('eval')) {
    saveDir = path.join(saveDir, 'reports');
    fileType = 'report';
  }

  // 确保目录存在
  fs.mkdirSync(saveDir, { recursive: true });
  const savePath = path.join(saveDir, `${Date.now()}_${filename}`);
  item.setSavePath(savePath);

  item.once('done', (event, state) => {
    if (state === 'completed') {
      // 通过 IPC 发送通知给渲染进程
      mainWindow.webContents.send('download-completed', {
        type: fileType,
        path: savePath,
        filename: filename
      });
    }
  });
});
```

### 2.3 网页端文件上传静默注入 (`renderer.js`)
在网页中点击 `<input type="file">` 会弹出系统文件选择框。在 Electron 中，我们可以拦截 `<webview>` 的 `select-file-dialog` 事件，直接返回指定的本地文件路径，彻底实现静默上传！
```javascript
// 渲染进程中为每个 webview 绑定拦截器
function setupWebviewUploadInterceptor(webview, getFilePathCallback) {
  webview.addEventListener('select-file-dialog', (e) => {
    e.preventDefault(); // 阻止默认的系统文件选择框
    const targetPath = getFilePathCallback(e.details);
    if (targetPath) {
      e.callback([targetPath]); // 注入本地文件路径
    } else {
      e.callback([]); // 取消上传
    }
  });
}
```

### 2.4 自动化操作脚本注入 (`renderer.js` & webview)
利用 `webview.executeJavaScript(code)` 动态注入操作指令。

**在评估页面自动填表并提交：**
```javascript
// 执行流程：
// 1. 触发任务文档上传输入框的点击
webview.executeJavaScript(`document.querySelector('input[name="document"]').click()`);
// 此时 select-file-dialog 事件被触发，注入器返回本地任务文档路径。

// 2. 触发测试对话上传输入框的点击（如果评估页面支持上传测试对话文件）
webview.executeJavaScript(`document.querySelector('input[name="chat_log_file"]').click()`);
// 此时 select-file-dialog 被触发，注入器返回已下载的测试对话 JSON 路径。

// 3. 点击提交按钮开始评估
webview.executeJavaScript(`document.querySelector('button[type="submit"]').click()`);
```

**在 Hermes 页面自动发送分析请求：**
```javascript
const promptText = `系统自动指令：请帮我分析以下测试与评估结果。
【测试对话本地路径】：${chatPath}
【评估报告本地路径】：${reportPath}
请根据上述文件的内容，诊断当前提示词的表现，并给出具体的迭代优化建议。`;

// 注入脚本并自动点击发送
webview.executeJavaScript(`
  const textarea = document.querySelector('textarea') || document.querySelector('#prompt-input');
  if (textarea) {
    textarea.value = \`${promptText}\`;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    const sendBtn = document.querySelector('button[type="submit"]') || document.querySelector('.send-btn');
    if (sendBtn) sendBtn.click();
  }
`);
```

---

## 3. 本周任务管理系统设计

为强化工作台与实际开发流程的协作，任务系统将被集成在 **顶部工具栏** 处。

### 3.1 界面与入口设计
- **按钮入口**：在顶部工具栏的右侧操作区添加 `📋 任务列表` 按钮。
- **呈现形式**：点击按钮弹出一个精致的模态窗口（Modal）或下滑面板，展示本周的任务表格。
- **任务字段**：
  1. **学校名称**（如：清华大学、北京大学等）
  2. **课程名称**（如：高中体育教师、Python初学等）
  3. **任务类型**（可选：提示词设计、仿真测试、智能评估、优化分析）
  4. **任务数量**（本周计划完成的量）
  5. **当前任务状态**（状态胶囊：待处理 `pending`、进行中 `running`、评估中 `evaluating`、已完成 `completed`）
  6. **负责人**（默认为当前用户）
  7. **关联文档**（本地任务文档路径，支持点击选择本地 `.txt/.md/.json` 等文档）
  8. **测试对话路径**（执行中自动记录的 chat log 路径）
  9. **评估报告路径**（执行中自动记录的 report 路径）

### 3.2 共享数据存储 (Collaboration Sync)
为了让 Codex 和其他 AI 代理人也能读取并配合该任务列表，数据不能仅保存在 `localStorage` 中。
- **存储文件**：在协作仓库中创建 `tasks/weekly_tasks.json`。
- **读写机制**：
  - 主进程提供 `read-weekly-tasks` 和 `write-weekly-tasks` 的 IPC 接口。
  - 前端对任务进行的增删改查操作，都会触发 IPC 写入本地文件。
  - 该文件纳入 Git 版本控制。用户或 Codex 可以通过 Git Commit 同步任务进度，实现真正跨主机的协同工作。

### 3.3 任务与自动化流水线的联动
在任务列表中，每行任务的最右侧有一列“操作”，包含 **“一键自动化执行”** 按钮。
点击按钮后：
1. 更新该任务状态为 **进行中 (running)**。
2. 自动记录当前任务的 `docPath`（任务文档路径）。
3. 激活并切换至 **测试页面** 的标签页，顶部显示浮动提示条：“正在为【学校-课程】执行仿真测试，请在测试完成后点击下载”。
4. 一旦捕获到测试文件下载（`download-completed` 且类型为 `chat`）：
   - 将下载路径记录到任务对象的 `chatLogPath` 字段。
   - 自动切换到 **评估页面**。
   - 触发任务文档和测试对话的静默上传并开始评估，任务状态变更为 **评估中 (evaluating)**。
5. 一旦捕获到评估报告下载（`download-completed` 且类型为 `report`）：
   - 将下载路径记录到任务对象的 `reportPath` 字段。
   - 自动切换到 **Hermes页面**。
   - 自动将测试对话和评估报告路径填充至 Hermes 输入框并发送分析。
   - 任务状态变更为 **已完成 (completed)**，并将最新任务列表写入 `tasks/weekly_tasks.json`。

---

## 4. 给 Codex 的具体修改指南

### 4.1 `package.json`
确保 Electron 版本支持 webview 标签。无需做多余改动，直接使用当前环境即可。

### 4.2 `main.js` (主进程)
1. **启用 Webview 标签**：在创建窗口的 `webPreferences` 中添加 `webviewTag: true`。
2. **拦截下载**：使用 `session.defaultSession.on('will-download', ...)` 捕获文件下载，并判断保存路径，静默保存后通过 `mainWindow.webContents.send` 传递给渲染进程。
3. **任务文件读写 IPC**：
   - 注册 `read-weekly-tasks` 接口：读取 `C:\Users\24391\.gemini\antigravity\scratch\ai-collab-hub\tasks\weekly_tasks.json`。如果文件不存在，返回空列表。
   - 注册 `write-weekly-tasks` 接口：接收任务数组并写入 `weekly_tasks.json`。

### 4.3 `src/index.html` (界面结构)
1. **替换 iframe 为 webview**：将所有的 `<iframe>` 标签改为 `<webview>`。
2. **顶部工具栏**：在 `.top-bar-actions` 中，添加任务列表的触发按钮：
   ```html
   <button class="action-btn" id="btn-toggle-tasks" title="本周任务列表">
     <i data-lucide="list-todo"></i>
     <span>任务列表</span>
   </button>
   ```
3. **任务管理弹窗**：在 `body` 底部新增 `#task-manager-modal`：
   - 包含新增任务表单（字段：学校、课程、类型、数量、负责人、文档路径）。
   - 包含任务列表展示表格。
   - 提供导入/导出及一键执行按钮。

### 4.4 `src/renderer.js` (交互逻辑)
1. **渲染 webview**：修改 `renderTabs` 函数，动态创建 `<webview>` 元素替代 `<iframe>`，并确保设置了必要的属性（如 `webpreferences="contextIsolation=no"` 等）。
2. **绑定上传拦截**：在 webview 创建时，注册 `select-file-dialog` 事件监听，并根据当前正在执行的任务自动化状态，动态回馈对应的文件路径。
3. **下载监听**：使用 `ipcRenderer.on('download-completed', ...)` 监听主进程的下载完成事件，推动自动化流水线状态机的流转。
4. **自动化流水线状态机**：
   - 定义状态变量 `let pipelineState = { active: false, taskId: null, step: 'idle', chatPath: '', reportPath: '', docPath: '' };`
   - 实现状态机转移逻辑，负责执行 `webview.executeJavaScript` 和 Tab 切换。
5. **任务列表管理与持久化**：
   - 启动时通过 `ipcRenderer.invoke('read-weekly-tasks')` 获取任务列表，渲染在表格中。
   - 每次任务状态更新或增删，均调用 `ipcRenderer.send('write-weekly-tasks', tasks)` 进行持久化保存。

### 4.5 `src/style.css` (高颜值设计规范)
1. **顶部按钮样式**：为 `#btn-toggle-tasks` 添加悬浮高亮、过渡动画，使其符合“极简极光白”视觉风格。
2. **任务弹窗**：采用毛玻璃底板（`backdrop-filter: blur(20px)`），圆角设定为 `16px`，搭配柔和投影。
3. **状态胶囊 (Pills)**：
   - 待处理：浅灰蓝底 + 深灰字（`background: #f1f5f9; color: #475569;`）
   - 进行中：浅蓝底 + 深蓝字（`background: #eff6ff; color: #1d4ed8;`）
   - 评估中：浅紫底 + 深紫字（`background: #faf5ff; color: #7e22ce;`）
   - 已完成：浅绿底 + 深绿字（`background: #f0fdf4; color: #15803d;`）
4. **表格设计**：采用极简双色行交替，表头使用微小字体和淡灰底色，操作按钮具有清晰的微交互动效。
