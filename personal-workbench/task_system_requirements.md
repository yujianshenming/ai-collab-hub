# 任务系统下拉菜单交互优化需求文档

为了解决当前工作台中任务面板遮挡其他按钮（如顶栏的“终端”等）以及优化下拉交互体验，本文件详细规范了需要对代码进行的具体修改。

---

## 1. 痛点与问题分析

1. **关闭状态下的顶栏按钮遮挡**：
   - **原因**：`.task-panel` 默认处于关闭状态时使用 `transform: translateY(-100%)` 移出屏幕。然而，虽然它在视觉上不可见，但由于未设置 `visibility: hidden` 或 `pointer-events: none`，且它的 `z-index: 100` 极高，因此它在物理上仍然悬浮在 `top: 34px` 以上的区域（正好重叠在高度为 `34px` 的顶栏上）。这导致鼠标在顶栏上悬停或点击时，所有的指针事件都被不可见的任务面板拦截，从而无法点击“终端”等其他顶栏按钮。
2. **面板展开时无法点击外部收回**：
   - **原因**：当前的遮罩层 `.task-panel-overlay` 的 `top` 设为 `34px`，避开了顶栏。这样点击顶栏的“终端”等按钮时不会触发遮罩层的关闭事件。并且，原先没有监听全局 `document` 级别的点击事件。
3. **多余的拖拽交互**：
   - 用户期望的交互是：**点击“任务”按钮自动下拉/滑出，再次点击或点击面板外部自动收回**，类似于手机的下拉菜单，但不需要手动下拉拖拽。当前的拖拽手柄 `.task-panel-handle` 是多余的。

---

## 2. 期望的交互与技术方案

请 Codex 按照以下步骤修改代码：

### 2.1 CSS 优化 (`style.css`)

1. **避免关闭时拦截鼠标事件**：
   为 `.task-panel` 增加默认的隐藏属性，并在 `.task-panel.open` 时启用。为了让滑出/滑入的动画依然能够流畅播放，需要利用 CSS 对 `visibility` 属性的过渡支持。
   
   修改 `.task-panel` 及 `.task-panel.open`：
   ```css
   .task-panel {
     position: absolute;
     top: 34px;
     left: 0;
     right: 0;
     max-height: 80vh;
     background-color: rgba(255, 255, 255, 0.96);
     border-bottom: 1px solid var(--border-color);
     box-shadow: 0 15px 35px rgba(15, 23, 42, 0.08);
     backdrop-filter: blur(20px);
     z-index: 100;
     transform: translateY(-100%);
     /* 增加对 visibility 的 transition 支持 */
     transition: transform 350ms cubic-bezier(0.16, 1, 0.3, 1), visibility 350ms;
     overflow: hidden;
     display: flex;
     flex-direction: column;
     
     /* 新增：默认隐藏且不拦截事件 */
     visibility: hidden;
     pointer-events: none;
   }
   
   .task-panel.open {
     transform: translateY(0);
     /* 新增：打开时可见且允许事件 */
     visibility: visible;
     pointer-events: auto;
   }
   ```

2. **隐藏/停用拖拽手柄**：
   通过 CSS 隐藏 `.task-panel-handle` 元素。
   ```css
   .task-panel-handle {
     display: none !important;
   }
   ```

---

### 2.2 JavaScript 交互优化 (`renderer.js`)

1. **停用并清理拖拽事件**：
   在 `renderer.js` 中，注销或删除在底部调用的 `initTaskPanelDrag();`。如果可以，也可直接删除或注释掉整个 `initTaskPanelDrag()` 函数的定义。

2. **点击面板外部自动收回**：
   在 `renderer.js` 中，添加一个全局的 `document` 点击事件监听器。当点击事件发生在任务面板外部时，如果面板是打开状态，则自动将其关闭。
   
   在 `renderer.js` 的事件绑定区域（例如靠近 `elements.taskPanelOverlay?.addEventListener("click", closeTaskPanel);` 的地方）添加如下代码：
   ```javascript
   // 点击面板外部（包括顶栏其他按钮、侧边栏、终端等）时自动收回
   document.addEventListener("click", (event) => {
     const panel = document.getElementById("task-manager-panel");
     const taskBtn = document.getElementById("menu-task-button");
     
     if (panel && panel.classList.contains("open")) {
       // 如果点击目标既不在面板内，也不是任务按钮本身（或其子元素），则收起面板
       if (!panel.contains(event.target) && event.target !== taskBtn && !taskBtn.contains(event.target)) {
         closeTaskPanel();
       }
     }
   });
   ```

---

## 3. 验收标准
1. 点击“任务”按钮，面板平滑滑下展示。
2. 再次点击“任务”按钮，面板平滑收回。
3. 面板展开时，点击界面上任何其他区域（顶栏的“终端”按钮、侧边栏、背景遮罩等），面板平滑收起。特别地，点击“终端”按钮不仅能收回面板，还应该能直接触发终端的打开/切换。
4. 当面板关闭时，鼠标经过顶栏按钮（编辑、视图、终端等）能够正常显示悬停效果，且点击它们可以正常触发功能，没有任何遮挡和事件拦截。
5. 面板底部不再显示拖动条，且不再支持拖动操作。
