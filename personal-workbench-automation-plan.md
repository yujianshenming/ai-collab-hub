# 个人定制工作台重构与内置助手功能恢复技术规格书 (Round 3 - 最终重构)

根据您的最新审查反馈，我们需要解决以下四个核心问题，并由 Codex 进行代码实现：

1. **分屏面板溢出问题**：除扩展面板外，内置的原生智能助手面板（`.native-assistant-panel`）折叠至 0 宽时内部文字依然溢出，需要同样包裹内容容器并配置 `overflow: hidden` 裁剪。
2. **直达顶级菜单**：在 Windows 原生菜单栏中，“任务”与“终端”作为顶级菜单存在直接点击限制（OS 会展开空下拉框，且点击冗余）。我们需要采用**自定义 HTML 应用菜单栏**的方案，将“工作台”、“任务”、“终端”等功能标签与任务状态展示整合在同一行中，消除冗余步骤。
3. **状态栏同行居中与更名**：任务横幅需更名为“正在进行任务”（非“正在运行”），且必须与菜单标签在同一行中居中展示，防止越界并提升空间利用率。
4. **内置智能助手的全面复原**：复原原 Chrome 扩展的完整功能（自定义测试人设、完整对话历史、核心参数读取、模型配置、下载提示词），并进行界面美化升级。

---

## 1. 工作台核心界面与交互重构指引

### 1.1 移除原生菜单栏，引入 HTML 自定义菜单栏
* **主进程配置 (`main.js`)**：
  - 隐藏原生 Electron 菜单栏，在 `createWindow()` 中设置 `mainWindow.setMenuBarVisibility(false)`（或通过 `frame: true` 但不设 Menu）。
* **DOM 结构调整 (`index.html`)**：
  - 在 `.workspace` 容器的最顶部（`.topbar` 之上），新增一个 `#app-menu-bar`（HTML 应用菜单栏）节点：
    ```html
    <div id="app-menu-bar" class="app-menu-bar">
      <!-- 左侧功能菜单 -->
      <div class="menu-left-section">
        <div class="menu-item-dropdown">
          <button class="menu-btn" id="menu-workbench-btn">工作台</button>
          <div class="dropdown-content">
            <button id="submenu-extension-settings">扩展设置</button>
            <button id="submenu-exit">退出</button>
          </div>
        </div>
        <button class="menu-btn" id="menu-task-btn" title="快捷键: Ctrl+T">任务</button>
        <button class="menu-btn" id="menu-terminal-btn" title="快捷键: Ctrl+`">终端</button>
      </div>

      <!-- 中间居中显示的任务状态栏 -->
      <div class="menu-center-section">
        <div id="active-task-banner-inline" class="active-task-banner-inline" style="display: none;">
          <span class="active-task-pulse"></span>
          🏃 正在进行任务: <span id="active-task-text-inline"></span>
          <button id="clear-task-banner-btn-inline" class="active-task-close-inline" type="button" title="停止当前任务">结束</button>
        </div>
        <span id="active-task-empty-inline" class="active-task-empty-inline">正在进行任务: 无</span>
      </div>

      <!-- 右侧辅助菜单 -->
      <div class="menu-right-section">
        <div class="menu-item-dropdown">
          <button class="menu-btn">编辑</button>
          <div class="dropdown-content">
            <button onclick="document.execCommand('undo')">撤销</button>
            <button onclick="document.execCommand('redo')">重做</button>
            <button onclick="document.execCommand('cut')">剪切</button>
            <button onclick="document.execCommand('copy')">复制</button>
            <button onclick="document.execCommand('paste')">粘贴</button>
          </div>
        </div>
        <div class="menu-item-dropdown">
          <button class="menu-btn">视图</button>
          <div class="dropdown-content">
            <button id="submenu-reload">重新加载</button>
            <button id="submenu-devtools">开发者工具</button>
          </div>
        </div>
      </div>
    </div>
    ```
* **核心交互逻辑 (`renderer.js`)**：
  - 点击左侧的“任务”按钮直接触发 `openTaskModal()` 打开任务弹窗（一键直达，无任何子菜单阻碍）。
  - 点击左侧的“终端”按钮直接触发 `toggleTerminal()` 切换终端展现（一键直达，无任何子菜单阻碍）。
  - 全局快捷键（`Ctrl+T` 和 `Ctrl+``）的键盘事件处理在 `renderer.js` 中捕获并直接触发相应函数。
  - 任务的启动、结束和清除逻辑与中间的居中任务状态栏（`#active-task-banner-inline`）绑定，有任务时显示跑马灯和详情，无任务时显示 `正在进行任务: 无`。
* **样式定义 (`style.css`)**：
  - `#app-menu-bar` 高度约为 `32px`，背景采用高质感亮色 (`#ffffff` 或极浅灰色 `#f8fafc`) 并带底边框。
  - 左侧、右侧、中间部分使用 Flex 弹性排列，中间区域（`menu-center-section`）使用绝对居中对齐，确保与两侧标签在同一水平线上，且保证长文本不越界（可以使用 `text-overflow: ellipsis` 截断）。
  - 下拉菜单使用 CSS 悬浮（`:hover`）或点击切换展开，确保悬浮效果自然、反馈灵敏。

### 1.2 修复助手面板的溢出折叠 Bug
* **DOM 包裹 (`index.html` 或 `renderer.js`)**：
  - 在 `createTabViewport` 函数中，对 `.native-assistant-panel` 内除 `.tab-extension-resizer` 外的所有子元素，全部包裹在 `<div class="native-assistant-content">` 容器内。
* **CSS 样式限制 (`style.css`)**：
  - 配置 `.native-assistant-content { display: flex; flex-direction: column; width: 100%; height: 100%; min-width: 0; overflow: hidden; }`。
  - 确保面板宽度为 `0` 时，内部的所有聊天列表、表单、按钮和文本被 content 容器彻底隐藏裁剪，而边缘的 resizer 正常保留。

---

## 2. 内置 “Polymas 原生智能训练助手” 重构规格

为彻底解决“不能对话、没有历史记录、界面太简陋、无法设置人设、大模型参数固定”等问题，Codex 必须在 `src/assistant.js`（或相关引入文件中）完整复原原扩展功能，并提供高级 UI：

### 2.1 高颜值质感 UI 设计 (CSS Premium)
* **毛玻璃质感**：面板背景使用 `backdrop-filter: blur(16px); background: rgba(255, 255, 255, 0.8)`。
* **聊天气泡**：
  - AI 教师气泡（左侧）：白色背景，带精致柔和阴影（`box-shadow: 0 4px 12px rgba(0,0,0,0.03)`），暗色细边框。
  - 学生气泡（右侧）：采用蓝紫色渐变（`background: linear-gradient(135deg, #3b82f6 0%, #6366f1 100%)`），白色文字，右下角尖角过渡。
  - 系统信息气泡（居中）：圆角卡片，浅灰色半透明背景，精致的 Emoji 提示。
* **动画与微动作**：发送按钮、清空按钮及人设卡片在 hover 时有轻微上浮（`-1px`）和边框发光特效；大模型回复时提供打字呼吸效果（或加载点动画）。

### 2.2 恢复测试人设 (Test Personas) 设置功能
* 在助手控制区中，提供“管理测试人设”视图。
* 允许用户自定义测试人格列表，每个人格可以配置并下载保存：
  - **人设名称**（如：优秀学生、偏题学生、中等学生）
  - **系统提示词 (System Prompt)**
  - **表达温度 (Temperature)**
  - **专属话术与风格描述**
  - **兜底/缺省话术模板**
* 对话运行时，根据下拉框选择的人格，向大模型注入对应的 System Prompt 和温度参数进行回复生成。

### 2.3 对话历史记录与持久化机制 (History Log)
* **本地日志持久化**：原生助手需在每次收到或发送消息时，将当前的对话历史数组保存至本地 temp 目录下：`temp/chats/history_{taskId}.json`。
* **历史回显**：当用户切换标签页或重新打开带有相同 `trainTaskId` 的 Polymas 页面时，助手能静默读取该文件，并完美将历史聊天记录复显在对话窗口中，支持无限滚动查看。

### 2.4 获取登录态与页面上下文参数 (Parameters Parser)
* **读取凭证**：通过 Preload 的 `getCookies`，自动获取 `hike-teaching-center.polymas.com` 下的 `ai-poly` token。
* **解析参数**：分析网页 API 返回的步骤详情，获取当前步骤卡片的名称、当前剧本的达标指标和要求，辅助大模型生成更切合本步骤上下文的回答。

### 2.5 灵活的模型参数配置面板
* 在设置面板中，提供大模型参数管理输入项：
  - **API 接口地址 (URL)**
  - **API 密钥 (API Key)**
  - **模型名称 (Model)**
  - **温度参数 (Temperature)**
  - 提供“测试联通性”按钮，点击后向配置的接口发送测试请求，反馈是否配置成功。

### 2.6 下载与管理 Prompt 及日志
* 提供一键“下载当前人设 Prompt”和“下载当前对话日志”按钮，保存为 `.txt` 或 `.json` 文件。
