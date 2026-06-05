# 个人定制工作台菜单栏优化与任务系统重构方案

根据用户的最新反馈，我们将移除之前方案中的后续拓展设想（已被用户否决），并对工作台的菜单栏布局、任务管理系统交互进行重构。

---

## 1. 核心修改需求

### 1.1 界面布局优化 (移除顶部栏按钮，使用原生菜单栏)
- **痛点**：现有的“任务”和“终端”按钮（Tasks 和 >_）直接放置在顶部栏，显得杂乱且不够原生。
- **方案**：
  1. 移除 `index.html` 顶部工具栏中的 `#btn-toggle-tasks` 和 `#terminal-toggle` 按钮。
  2. 启用 Electron 的原生菜单栏，并在窗口左上角添加自定义的“工作台”原生菜单，包含：
     - **本周任务** (快捷键：`Ctrl+T`)
     - **本地终端** (快捷键：`Ctrl+\``)
     - **扩展设置**

### 1.2 任务系统交互重构 (列表优先与表单拆分)
- **痛点**：当前打开任务弹窗时，直接展示了编辑表单，占据了大量空间，且交互不够直观。
- **方案**：
  - 打开任务弹窗后，**默认只展示任务列表表格**（如果无任务则展示“暂无任务”的空白状态）。
  - 在列表下方添加一个 **“添加任务”** 按钮。
  - 点击“添加任务”或“编辑”后，弹窗切换为 **新增/编辑表单视图**，列表隐藏。
  - 点击“保存任务”或“取消”后，表单隐藏，切换回 **任务列表视图**。

### 1.3 字段与任务类型调整
- **删除字段**：完全移除 **“关联文档路径”** (Task Doc Path) 字段，精简界面与任务对象属性。
- **更新任务类型**：将原有的任务类型重新划分为以下五种，并在下拉框中进行适配：
  1. **能力训练搭建** (`capability-setup`)
  2. **能力训练修改** (`capability-edit`)
  3. **能力训练验收** (`capability-acceptance`)
  4. **作业批阅搭建** (`grading-setup`)
  5. **作业批阅验收** (`grading-acceptance`)

---

## 2. 具体修改指引 (Codex 执行参考)

### 2.1 `main.js` (原生菜单栏实现)
1. 移除创建窗口时的 `autoHideMenuBar: true`，确保菜单栏正常显示。
2. 引入 `Menu` 模块，并构建自定义的应用菜单：
```javascript
const { app, BrowserWindow, ipcMain, session, shell, Menu } = require("electron");

function setAppMenu() {
  const template = [
    {
      label: "工作台",
      submenu: [
        {
          label: "本周任务",
          accelerator: "CmdOrCtrl+T",
          click: () => sendToRenderer("menu:toggle-tasks")
        },
        {
          label: "本地终端",
          accelerator: "CmdOrCtrl+`",
          click: () => sendToRenderer("menu:toggle-terminal")
        },
        {
          label: "扩展设置",
          click: () => sendToRenderer("menu:open-settings")
        },
        { type: "separator" },
        {
          label: "退出",
          role: "quit"
        }
      ]
    },
    {
      label: "编辑",
      submenu: [
        { label: "撤销", role: "undo" },
        { label: "重做", role: "redo" },
        { type: "separator" },
        { label: "剪切", role: "cut" },
        { label: "复制", role: "copy" },
        { label: "粘贴", role: "paste" },
        { label: "全选", role: "selectAll" }
      ]
    },
    {
      label: "视图",
      submenu: [
        { label: "重新加载", role: "reload" },
        { label: "开发者工具", role: "toggleDevTools" },
        { type: "separator" },
        { label: "实际大小", role: "resetZoom" },
        { label: "放大", role: "zoomIn" },
        { label: "缩小", role: "zoomOut" }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
```
3. 在 `app.whenReady()` 后调用 `setAppMenu()`。

### 2.2 `index.html` (DOM 结构修改)
1. **顶部栏按钮移除**：移除 `.topbar-actions` 里的 `#btn-toggle-tasks` 和 `#terminal-toggle`。
2. **任务弹窗重构**：
   - 任务弹窗中将新增/编辑区域与表格区域包装为独立的容器：`#task-form-view`（表单视图）和 `#task-list-view`（列表视图）。
   - 移除 `C:\path\to\task.md` 的关联文档路径 Input。
   - 类型下拉框中修改为 5 种新任务类型。
   - 列表视图下方添加 `<button id="btn-add-new-task" class="primary-button">添加任务</button>`。

### 2.3 `renderer.js` (视图切换与 IPC 监听)
1. **IPC 菜单事件监听**：
   - 监听 `menu:toggle-tasks`：直接打开/关闭任务列表弹窗。
   - 监听 `menu:toggle-terminal`：切换下方终端面板显示。
   - 监听 `menu:open-settings`：打开扩展设置弹窗。
2. **双视图状态机控制**：
   - 定义变量 `let taskViewMode = 'list'; // 'list' | 'form'`。
   - 实现切换函数 `switchTaskModalView(mode)`，通过 CSS 类控制 `#task-form-view` 和 `#task-list-view` 的显示/隐藏（例如，使用 `display: none`）。
   - 打开弹窗时默认调用 `switchTaskModalView('list')`。
   - 点击“添加任务”按钮时，清空表单并调用 `switchTaskModalView('form')`。
   - 在表格中点击“编辑”时，填充表单并调用 `switchTaskModalView('form')`。
   - 保存任务成功或点击“取消/返回”时，调用 `switchTaskModalView('list')` 并刷新表格。
3. **数据字段移除**：
   - 在 `taskFromForm` 中移除 `docPath` 字段。
   - 在自动化流程中，移除对 `docPath` 的上传逻辑，仅针对已下载的 `chatPath`（测试对话）和 `reportPath`（评估报告）执行流转。

### 2.4 `style.css` (双视图排版样式)
- 适配 `#task-form-view` 和 `#task-list-view` 的布局。当处于 `form` 模式时，确保表单美观居中，且操作按钮对齐；当处于 `list` 模式时，表格宽度占满，表格下方的“添加任务”按钮具备高颜值浅色强调设计。
