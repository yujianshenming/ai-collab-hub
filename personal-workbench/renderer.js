const DEFAULT_TABS = [
  { id: "evaluation", name: "评估", url: "https://www.wl363eval.top/" }
];

// 流水线 5 步统一模型：所有 stepper/进度条/芯片均从此常量派生，禁止散落硬编码
const PIPELINE_STEPS = [
  { key: "prepare",    name: "准备",        desc: "建立任务文件夹" },
  { key: "testing",    name: "本地测试",    desc: "生成 dialogue.json" },
  { key: "evaluating", name: "评估上传",    desc: "评估平台自动注入" },
  { key: "report",     name: "捕获报告",    desc: "自动拦截下载归档" },
  { key: "hermes",     name: "Hermes 诊断", desc: "一键载入产物路径" }
];

// 历史数据中的旧步骤值归一映射到统一 key
function normalizePipelineStep(step) {
  if (step === "analysis") return "report";
  return PIPELINE_STEPS.some((item) => item.key === step) ? step : "testing";
}

function pipelineStepIndex(step) {
  return PIPELINE_STEPS.findIndex((item) => item.key === normalizePipelineStep(step));
}

// 任务中心作为特殊内置视图的伪标签 id
const TASK_CENTER_ID = "__taskcenter__";
const WEEKLY_REPORT_ID = "__weeklyreport__";

function isBuiltinViewId(id) {
  return id === TASK_CENTER_ID || id === WEEKLY_REPORT_ID;
}

const storageKey = "personal_workbench_tabs";
const sidebarStorageKey = "personal_workbench_sidebar_collapsed";
const themeStorageKey = "personal_workbench_theme";
let tabs = readTabs();
let activeTabId = TASK_CENTER_ID;
let rightSplitTabId = null;
let bottomSplitTabId = null;
let terminal;
let fitAddon;

const TERMINAL_THEMES = {
  sky: {
    background: "#ffffff",
    foreground: "#2f3650",
    cursor: "#668ce8",
    selectionBackground: "#dce8ff",
    black: "#3f4963",
    blue: "#668ce8",
    cyan: "#419fba",
    green: "#459b7d",
    magenta: "#8d79cf",
    red: "#d96868",
    white: "#eef4fb",
    yellow: "#c7973c"
  },
  morning: {
    background: "#fffdf7",
    foreground: "#24312e",
    cursor: "#2f887a",
    selectionBackground: "#dcece5",
    black: "#394943",
    blue: "#3b6f91",
    cyan: "#2f887a",
    green: "#39845d",
    magenta: "#80658d",
    red: "#c25f42",
    white: "#f4f1e9",
    yellow: "#b98a31"
  },
  night: {
    background: "#090f18",
    foreground: "#e9f2ff",
    cursor: "#54d8e8",
    selectionBackground: "#24384c",
    black: "#111927",
    blue: "#66a5ff",
    cyan: "#54d8e8",
    green: "#63d5a1",
    magenta: "#9f8cff",
    red: "#ff7d7d",
    white: "#e9f2ff",
    yellow: "#f2c96d"
  }
};

function normalizeWorkbenchTheme(theme) {
  return Object.hasOwn(TERMINAL_THEMES, theme) ? theme : "sky";
}

function terminalThemeFor(theme) {
  return TERMINAL_THEMES[normalizeWorkbenchTheme(theme)];
}

function applyWorkbenchTheme(theme) {
  const normalized = normalizeWorkbenchTheme(theme);
  document.body.dataset.theme = normalized;
  localStorage.setItem(themeStorageKey, normalized);
  if (terminal) terminal.options.theme = terminalThemeFor(normalized);
  return normalized;
}

applyWorkbenchTheme(localStorage.getItem(themeStorageKey) || "sky");
let pointerDrag = null;
let weeklyTasks = [];
let weeklyTasksLoadedSuccessfully = false;
let weeklyReports = [];
let weeklyReportsLoadedSuccessfully = false;
let activeWeeklyReport = null;
let taskTransitionGeneration = 0;
let taskRailCollapsed = false;
let pipelineState = {
  active: false,
  taskId: null,
  activeSubtaskIndex: null,
  step: "idle",
  chatPath: "",
  reportPath: "",
  taskFolder: "",
  uploadQueue: []
};
const tabTerminals = new Map();
const desktopStatusPollers = new Map();

// ===== per-tab 资源清理注册表（缺陷 #3）=====
// DOMNodeRemovedFromDocument 突变事件已被 Chromium 127+ 移除，原三处监听从未触发。
// 现在所有标签级资源（轮询定时器、IPC 监听器、resize 监听器等）注册到这里，
// 删除/重建标签的代码路径显式调用 runTabCleanup 统一释放，main 进程 pty/桌面应用并入同一出口。
const tabCleanupRegistry = new Map();

function registerTabCleanup(tabId, cleanup) {
  if (typeof cleanup !== "function") return;
  if (!tabCleanupRegistry.has(tabId)) tabCleanupRegistry.set(tabId, []);
  tabCleanupRegistry.get(tabId).push(cleanup);
}

function runTabCleanup(tabId) {
  const cleanups = tabCleanupRegistry.get(tabId) || [];
  tabCleanupRegistry.delete(tabId);
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (error) {
      console.warn(`标签 ${tabId} 资源清理失败:`, error);
    }
  }
  // main 进程侧资源（CLI pty、嵌入式桌面应用进程）走同一出口
  window.workbench.cleanupTabResources(tabId);
}

// Category configuration and state
let collapsedCategories = {};
try {
  collapsedCategories = JSON.parse(localStorage.getItem("workbench_collapsed_categories")) || {};
} catch {
  collapsedCategories = {};
}

const CATEGORY_MAP = {
  builtin: { id: "builtin", name: "内置工具" },
  "desktop-app": { id: "desktop-app", name: "桌面应用" },
  "local-web": { id: "local-web", name: "本地项目" },
  "cli-app": { id: "cli-app", name: "命令终端" },
  web: { id: "web", name: "网页浏览" }
};

function getTabCategory(tab) {
  const type = tab.type || "web";
  if (type === "builtin") return "builtin";
  if (type === "desktop-app") return "desktop-app";
  if (type === "local-web") return "local-web";
  if (type === "cli-app") return "cli-app";
  return "web";
}

const elements = {
  tabList: document.querySelector("#tab-list"),
  webviewStack: document.querySelector("#webview-stack"),
  activeTitle: document.querySelector("#active-title"),
  addressInput: document.querySelector("#address-input"),
  tabDialog: document.querySelector("#tab-dialog"),
  tabForm: document.querySelector("#tab-form"),
  settingsDialog: document.querySelector("#settings-dialog"),
  extensionList: document.querySelector("#extension-list"),
  terminalPanel: document.querySelector("#terminal-panel"),
  appShell: document.querySelector(".app-shell"),
  extensionsBar: document.querySelector("#extensions-bar"),
  rightSidebar: document.querySelector("#right-sidebar"),
  rightSidebarResizer: document.querySelector("#right-sidebar-resizer"),
  rightSidebarTitle: document.querySelector("#right-sidebar-title"),
  rightSidebarClose: document.querySelector("#right-sidebar-close"),
  rightSidebarBody: document.querySelector("#right-sidebar-body"),
  bottomSidebar: document.querySelector("#bottom-sidebar"),
  bottomSidebarResizer: document.querySelector("#bottom-sidebar-resizer"),
  bottomSidebarTitle: document.querySelector("#bottom-sidebar-title"),
  bottomSidebarClose: document.querySelector("#bottom-sidebar-close"),
  bottomSidebarBody: document.querySelector("#bottom-sidebar-body"),
  workspace: document.querySelector(".workspace"),
  crumbSub: document.querySelector("#crumb-sub"),
  addressBar: document.querySelector("#address-bar"),
  reloadButton: document.querySelector("#reload-button"),
  menuMorePop: document.querySelector("#menu-more-pop"),
  menuMoreButton: document.querySelector("#menu-more-button"),
  menuSettingsButton: document.querySelector("#menu-settings-button"),
  menuReloadButton: document.querySelector("#menu-reload-button"),
  navTaskCenter: document.querySelector("#nav-task-center"),
  navWeeklyReport: document.querySelector("#nav-weekly-report"),
  taskCenterBadge: document.querySelector("#task-center-badge"),
  taskCenterView: document.querySelector("#task-center-view"),
  weeklyReportView: document.querySelector("#weekly-report-view"),
  reportGenerate: document.querySelector("#report-generate"),
  reportSave: document.querySelector("#report-save"),
  reportCopyTable: document.querySelector("#report-copy-table"),
  reportCopy: document.querySelector("#report-copy"),
  reportPeriod: document.querySelector("#report-period"),
  reportTitle: document.querySelector("#report-title"),
  reportAuthor: document.querySelector("#report-author"),
  reportRange: document.querySelector("#report-range"),
  reportSaveState: document.querySelector("#report-save-state"),
  reportRowCount: document.querySelector("#report-row-count"),
  reportRowsBody: document.querySelector("#report-rows-body"),
  reportAddRow: document.querySelector("#report-add-row"),
  reportAddNonquantified: document.querySelector("#report-add-nonquantified"),
  reportNonquantifiedList: document.querySelector("#report-nonquantified-list"),
  reportAddIssue: document.querySelector("#report-add-issue"),
  reportIssuesList: document.querySelector("#report-issues-list"),
  reportPreview: document.querySelector("#report-preview"),
  reportExportHtml: document.querySelector("#report-export-html"),
  reportExportMarkdown: document.querySelector("#report-export-markdown"),
  reportExportDocx: document.querySelector("#report-export-docx"),
  reportPeriodPrev: document.querySelector("#report-period-prev"),
  reportPeriodNext: document.querySelector("#report-period-next"),
  reportSaveDefaultAuthor: document.querySelector("#report-save-default-author"),
  reportHistoryList: document.querySelector("#report-history-list"),
  reportHistoryCount: document.querySelector("#report-history-count"),
  prefReportAuthor: document.querySelector("#pref-report-author"),
  prefReportTitlePattern: document.querySelector("#pref-report-title-pattern"),
  homeWeekSub: document.querySelector("#home-week-sub"),
  statTotal: document.querySelector("#stat-total"),
  statRunning: document.querySelector("#stat-running"),
  statPaused: document.querySelector("#stat-paused"),
  statUnsubmitted: document.querySelector("#stat-unsubmitted"),
  statCompleted: document.querySelector("#stat-completed"),
  focusCard: document.querySelector("#focus-card"),
  taskGridActive: document.querySelector("#task-grid-active"),
  sectionActive: document.querySelector("#section-active"),
  sectionUnsubmitted: document.querySelector("#section-unsubmitted"),
  sectionDone: document.querySelector("#section-done"),
  taskGridUnsubmitted: document.querySelector("#task-grid-unsubmitted"),
  taskGridDone: document.querySelector("#task-grid-done"),
  taskSearch: document.querySelector("#task-search"),
  taskFilterChips: document.querySelector("#task-filter-chips"),
  taskSchoolFilter: document.querySelector("#task-school-filter"),
  btnImportTodo: document.querySelector("#btn-import-todo"),
  taskDialog: document.querySelector("#task-dialog"),
  taskFormTitle: document.querySelector("#task-form-title"),
  taskForm: document.querySelector("#task-form"),
  taskStatus: document.querySelector("#task-status"),
  finishTaskDialog: document.querySelector("#finish-task-dialog"),
  finishTaskSubmitted: document.querySelector("#finish-task-submitted"),
  finishTaskUnsubmitted: document.querySelector("#finish-task-unsubmitted"),
  finishTaskCancel: document.querySelector("#finish-task-cancel"),
  finishTaskCancelX: document.querySelector("#finish-task-cancel-x"),
  deleteTaskDialog: document.querySelector("#delete-task-dialog"),
  deleteTaskDesc: document.querySelector("#delete-task-desc"),
  deleteTaskConfirm: document.querySelector("#delete-task-confirm"),
  deleteTaskCancel: document.querySelector("#delete-task-cancel"),
  deleteTaskCancelX: document.querySelector("#delete-task-cancel-x"),
  addNewTask: document.querySelector("#btn-add-new-task"),
  sbTerminal: document.querySelector("#sb-terminal"),
  sbTaskChip: document.querySelector("#sb-task-chip"),
  sbTaskChipText: document.querySelector("#sb-task-chip-text"),
  taskRail: document.querySelector("#task-rail"),
  railHandle: document.querySelector("#rail-handle"),
  railHandleText: document.querySelector("#rail-handle-text"),
  railRingBar: document.querySelector("#rail-ring-bar"),
  railCollapse: document.querySelector("#rail-collapse"),
  railTitle: document.querySelector("#rail-title"),
  railStepBadge: document.querySelector("#rail-step-badge"),
  railOwner: document.querySelector("#rail-owner"),
  railSteps: document.querySelector("#rail-steps"),
  railArtifacts: document.querySelector("#rail-artifacts"),
  railCards: document.querySelector("#rail-cards"),
  railCardsStream: document.querySelector("#rail-cards-stream"),
  railCardsReparse: document.querySelector("#rail-cards-reparse"),
  railHermes: document.querySelector("#rail-hermes"),
  railPause: document.querySelector("#rail-pause"),
  railFinish: document.querySelector("#rail-finish"),
  filePickDialog: document.querySelector("#file-pick-dialog"),
  filePickList: document.querySelector("#file-pick-list"),
  filePickInject: document.querySelector("#file-pick-inject"),
  filePickSystem: document.querySelector("#file-pick-system"),
  filePickCancel: document.querySelector("#file-pick-cancel"),
  filePickClose: document.querySelector("#file-pick-close"),
  menuPrefsButton: document.querySelector("#menu-prefs-button"),
  prefsDialog: document.querySelector("#prefs-dialog"),
  prefsForm: document.querySelector("#prefs-form"),
  prefsFeedback: document.querySelector("#prefs-feedback"),
  prefTheme: document.querySelector("#pref-theme"),
  prefCropSide: document.querySelector("#pref-crop-side"),
  prefCropPixels: document.querySelector("#pref-crop-pixels"),
  prefTodoPath: document.querySelector("#pref-todo-path"),
  prefTodoChange: document.querySelector("#pref-todo-change"),
  prefPlatformMap: document.querySelector("#pref-platform-map"),
  prefInjectField: document.querySelector("#pref-inject-field"),
  prefInjectValue: document.querySelector("#pref-inject-value"),
  prefInjectRun: document.querySelector("#pref-inject-run"),
  importPreviewDialog: document.querySelector("#import-preview-dialog"),
  importPreviewSummary: document.querySelector("#import-preview-summary"),
  importPreviewGroups: document.querySelector("#import-preview-groups"),
  importPreviewApply: document.querySelector("#import-preview-apply"),
  importPreviewCancel: document.querySelector("#import-preview-cancel"),
  importPreviewCancelX: document.querySelector("#import-preview-cancel-x"),
  btnWritebackTodo: document.querySelector("#btn-writeback-todo"),
  writebackPreviewDialog: document.querySelector("#writeback-preview-dialog"),
  writebackPreviewSummary: document.querySelector("#writeback-preview-summary"),
  writebackPreviewGroups: document.querySelector("#writeback-preview-groups"),
  writebackPreviewApply: document.querySelector("#writeback-preview-apply"),
  writebackPreviewCancel: document.querySelector("#writeback-preview-cancel"),
  writebackPreviewCancelX: document.querySelector("#writeback-preview-cancel-x")
};

// 缺陷②：E2E 在真实 userData 上跑测留下的残留标签（*harness* 命名、XSS 注入名）。
// 只匹配测试特征名，用户自建标签不受影响。
function isTestResidueTab(tab) {
  const name = String(tab?.name || "");
  return /harness/i.test(name) || /<[a-z!\/]|onerror\s*=|__xss/i.test(name);
}

function readTabs() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (!Array.isArray(saved) || !saved.length) return DEFAULT_TABS;
    const cleaned = saved.filter((tab) => !isTestResidueTab(tab));
    if (cleaned.length !== saved.length) {
      localStorage.setItem(storageKey, JSON.stringify(cleaned));
      console.warn(`已清理 ${saved.length - cleaned.length} 个测试残留标签`);
    }
    return cleaned.length ? cleaned : DEFAULT_TABS;
  } catch {
    return DEFAULT_TABS;
  }
}

function saveTabs() {
  localStorage.setItem(storageKey, JSON.stringify(tabs));
  window.workbench.updateTabsList(tabs);
}

function normalizeUrl(value) {
  const trimmed = value.trim();
  if (/^(https?|file):\/\//i.test(trimmed)) return trimmed;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(trimmed)) return `http://${trimmed}`;
  if (/^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/.*)?$/.test(trimmed)) return `http://${trimmed}`;
  if (/^([a-z0-9-]+\.)+[a-z0-9-]+(:\d+)?(\/.*)?$/i.test(trimmed) && !/\s/.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return `https://www.baidu.com/s?wd=${encodeURIComponent(trimmed)}`;
}

function iconForTab(name) {
  // H2：首字母可能是 < & 等字符，进 innerHTML 前转义，杜绝标签名注入 DOM
  return escapeHtml((String(name || "").trim()[0] || "W").toUpperCase());
}

function renderTabs() {
  elements.tabList.replaceChildren();

  // Group tabs by category
  const groups = {
    builtin: [],
    "desktop-app": [],
    "local-web": [],
    "cli-app": [],
    web: []
  };

  for (const tab of tabs) {
    const cat = getTabCategory(tab);
    groups[cat].push(tab);
    
    // Make sure viewport exists
    if (!document.querySelector(`.tab-viewport[data-id="${tab.id}"]`)) {
      createTabViewport(tab);
    }
  }

  // Render group sections
  for (const catId of Object.keys(CATEGORY_MAP)) {
    const catTabs = groups[catId];
    if (catTabs.length === 0) continue; // Hide empty categories

    const section = document.createElement("div");
    section.className = `category-section${collapsedCategories[catId] ? " collapsed" : ""}`;
    section.dataset.category = catId;

    const header = document.createElement("div");
    header.className = "category-header";
    header.innerHTML = `
      <span class="category-toggle-icon"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></span>
      <span class="category-title">${CATEGORY_MAP[catId].name}</span>
      <span class="category-badge">${catTabs.length}</span>
    `;

    header.addEventListener("click", () => {
      collapsedCategories[catId] = !collapsedCategories[catId];
      localStorage.setItem("workbench_collapsed_categories", JSON.stringify(collapsedCategories));
      renderTabs();
    });

    const itemsContainer = document.createElement("div");
    itemsContainer.className = "category-items";

    for (const tab of catTabs) {
      const item = document.createElement("div");
      item.className = `tab-item${tab.id === activeTabId ? " active" : ""}${tab.id === rightSplitTabId || tab.id === bottomSplitTabId ? " split-active" : ""}`;
      item.dataset.id = tab.id;
      item.innerHTML = `
        <button class="tab-main" type="button">
          <span class="tab-icon">${iconForTab(tab.name)}</span>
          <span>${escapeHtml(tab.name)}</span>
        </button>
        <button class="tab-menu" type="button" aria-label="编辑 ${escapeHtml(tab.name)}" title="编辑标签">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
        </button>
      `;
      item.querySelector(".tab-menu").addEventListener("click", (e) => {
        e.stopPropagation();
        openTabDialog(tab);
      });
      item.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || event.target.closest(".tab-menu")) return;
        item.setPointerCapture(event.pointerId);
        setWebviewPointerEvents(false);
        pointerDrag = { id: tab.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, active: false };
      });
      itemsContainer.append(item);
    }

    section.append(header, itemsContainer);
    elements.tabList.append(section);
  }

  // Cleanup viewports for deleted tabs
  document.querySelectorAll(".tab-viewport[data-id]").forEach((viewport) => {
    if (!tabs.some((tab) => tab.id === viewport.dataset.id)) {
      runTabCleanup(viewport.dataset.id);
      viewport.remove();
    }
  });

  updateSidebarPulse();

  // Activate active tab（任务中心是合法的特殊视图）
  // 缺陷①修复：尾部重激活属于布局同步，不代表用户意图，禁止 auto-expand——
  // 否则折叠活动标签所在分类时会被这里立刻展开回去（折叠点击"失效"）。
  const validActiveTabId = isBuiltinViewId(activeTabId) || tabs.some((tab) => tab.id === activeTabId)
    ? activeTabId
    : tabs[0]?.id;
  if (validActiveTabId) {
    activateTab(validActiveTabId, { autoExpand: false });
  }
}

// 流程当前停留的标签页（评估上传 → 评估平台标签；Hermes 诊断 → Hermes 标签）
function pipelineFocusTabId() {
  if (!pipelineState.active) return null;
  const step = normalizePipelineStep(pipelineState.step);
  if (step === "evaluating") {
    const evalTab = tabs.find((tab) => tab.id === "evaluation") || findTabByUrlPart("wl363eval");
    return evalTab?.id || null;
  }
  if (step === "hermes") {
    return findTabByUrlPart("hermes")?.id || null;
  }
  return null;
}

function updateSidebarPulse() {
  const focusTabId = pipelineFocusTabId();
  document.querySelectorAll(".tab-item").forEach((item) => {
    const existing = item.querySelector(".running-pulse");
    if (item.dataset.id === focusTabId) {
      if (!existing) {
        const dot = document.createElement("span");
        dot.className = "running-pulse";
        dot.title = "任务流程正在此页进行";
        item.append(dot);
      }
    } else if (existing) {
      existing.remove();
    }
  });
}

function clearDragState() {
  document.querySelectorAll(".tab-item").forEach((item) => {
    item.classList.remove("dragging", "swap-target");
    item.style.transform = "";
  });
  document.querySelector("#split-drag-overlay")?.classList.remove("show");
  document.querySelector("#split-drag-overlay-bottom")?.classList.remove("show");
}

function setWebviewPointerEvents(enabled) {
  document.querySelectorAll("webview").forEach((webview) => {
    webview.style.pointerEvents = enabled ? "auto" : "none";
  });
}

// 向 guest 页补发 pointerup/mouseup，避免网页内拖拽移出 chrome 后“粘住”
let lastGuestPointerReleaseAt = 0;
function releaseGuestPointerCapture() {
  const now = Date.now();
  if (now - lastGuestPointerReleaseAt < 120) return;
  lastGuestPointerReleaseAt = now;
  document.querySelectorAll("webview").forEach((webview) => {
    webview.executeJavaScript(`(() => {
      try {
        const opts = { bubbles: true, cancelable: true, view: window, buttons: 0, button: 0, clientX: 0, clientY: 0 };
        const targets = [window, document, document.activeElement, document.body].filter(Boolean);
        for (const target of targets) {
          try { target.dispatchEvent(new PointerEvent("pointerup", opts)); } catch {}
          try { target.dispatchEvent(new MouseEvent("mouseup", opts)); } catch {}
          try { target.dispatchEvent(new PointerEvent("pointercancel", opts)); } catch {}
        }
      } catch {}
    })();`).catch(() => {});
  });
}

// 活动分屏/终端/扩展宽度拖动的统一结束回调（防止 pointerup 丢失后 webview 永久不可点）
let activeResizeEnd = null;

function endAllResizes() {
  const ender = activeResizeEnd;
  activeResizeEnd = null;
  if (typeof ender === "function") {
    try { ender(); } catch (error) {
      console.error("结束面板拖动失败:", error);
    }
  }
  elements.appShell?.classList.remove("resizing");
  elements.workspace?.classList.remove("resizing");
  document.querySelectorAll(".tab-extension-panel.resizing, .tab-extension-resizer.resizing").forEach((node) => {
    node.classList.remove("resizing");
  });
  setWebviewPointerEvents(true);
}

// 结束标签拖拽：commit=true 走投放/排序；false 仅清理残留状态
function endPointerDrag({ commit = false, event = null } = {}) {
  if (!pointerDrag) {
    setWebviewPointerEvents(true);
    return;
  }
  const drag = pointerDrag;
  pointerDrag = null;
  try {
    const dragItem = document.querySelector(`.tab-item[data-id="${drag.id}"]`);
    if (dragItem && drag.pointerId !== undefined && dragItem.hasPointerCapture?.(drag.pointerId)) {
      dragItem.releasePointerCapture(drag.pointerId);
    }
  } catch (error) {
    console.error("释放标签拖拽指针失败:", error);
  }
  setWebviewPointerEvents(true);

  if (commit) {
    try {
      if (drag.active) {
        const clientX = event?.clientX ?? -1;
        const clientY = event?.clientY ?? -1;
        const isRightSide = clientX > window.innerWidth * 0.7;
        const isBottomSide = clientY > window.innerHeight * 0.75 && clientX <= window.innerWidth * 0.7;
        if (isRightSide) {
          toggleRightSidebar(true, drag.id);
        } else if (isBottomSide) {
          toggleBottomSidebar(true, drag.id);
        } else if (clientX > 238) {
          if (rightSplitTabId === drag.id) toggleRightSidebar(false);
          else if (bottomSplitTabId === drag.id) toggleBottomSidebar(false);
          activateTab(drag.id);
        } else {
          const draggedIndex = drag.draggedIndex;
          const insertIndex = drag.insertIndex;
          if (typeof draggedIndex === "number" && typeof insertIndex === "number" && draggedIndex !== insertIndex) {
            const draggedTab = tabs.find((t) => t.id === drag.id);
            if (draggedTab) {
              const category = getTabCategory(draggedTab);
              const indices = [];
              tabs.forEach((t, idx) => {
                if (getTabCategory(t) === category) indices.push(idx);
              });
              const categoryTabs = indices.map((idx) => tabs[idx]);
              if (draggedIndex < categoryTabs.length && insertIndex < categoryTabs.length) {
                const [movedTab] = categoryTabs.splice(draggedIndex, 1);
                categoryTabs.splice(insertIndex, 0, movedTab);
                indices.forEach((originalIdx, i) => {
                  tabs[originalIdx] = categoryTabs[i];
                });
                saveTabs();
                renderTabs();
              }
            }
          }
        }
      } else {
        activateTab(drag.id);
      }
    } catch (error) {
      console.error("释放拖拽操作执行失败:", error);
    }
  }
  clearDragState();
}

function forceEndAllPointerInteractions({ commitDrag = false, event = null } = {}) {
  endAllResizes();
  endPointerDrag({ commit: commitDrag, event });
  releaseGuestPointerCapture();
}

function isLocalLoopbackUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return ["localhost", "127.0.0.1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function swapTabs(id1, id2) {
  const idx1 = tabs.findIndex((t) => t.id === id1);
  const idx2 = tabs.findIndex((t) => t.id === id2);
  if (idx1 < 0 || idx2 < 0 || idx1 === idx2) return false;
  const temp = tabs[idx1];
  tabs[idx1] = tabs[idx2];
  tabs[idx2] = temp;
  saveTabs();
  return true;
}

function createTabViewport(tab, { deferWeb = true } = {}) {
  const viewport = document.createElement("div");
  viewport.className = "tab-viewport";
  viewport.dataset.id = tab.id;

  const type = tab.type || "web";

  if ((type === "web" || type === "local-web") && deferWeb) {
    viewport.dataset.webDeferred = "true";
    const placeholder = document.createElement("div");
    placeholder.className = "webview-placeholder";
    placeholder.textContent = "正在启动网页工作区…";
    viewport.append(placeholder);
  } else if (type === "web" || type === "local-web") {
    if (type === "local-web" && tab.localPath) {
      window.workbench.registerLocalApp(tab.id, tab.localPath);
    }

    const webview = document.createElement("webview");
    webview.className = "tab-webview";
    webview.src = tab.url || "";
    webview.partition = "persist:personal-workbench";
    webview.setAttribute("allowpopups", "false");
    webview.setAttribute("webpreferences", "contextIsolation=no");

    webview.addEventListener("did-start-loading", () => {
      if (tab.id === activeTabId) elements.reloadButton.classList.add("loading");
    });
    webview.addEventListener("did-stop-loading", () => {
      if (tab.id === activeTabId) {
        elements.reloadButton.classList.remove("loading");
        updateAddressFromWebview(webview);
      }
    });
    webview.addEventListener("did-navigate", () => updateAddressFromWebview(webview));
    webview.addEventListener("did-navigate-in-page", () => updateAddressFromWebview(webview));
    webview.addEventListener("dom-ready", () => {
      fitWebviewZoom();
      const currentUrl = webview.getURL() || tab.url || "";
      if (isRegisteredLocalAppUrl(tab, currentUrl)) {
        window.workbench.getSessionToken().then((token) => {
          webview.executeJavaScript(`window.__workbenchSessionToken = ${JSON.stringify(token)};`).catch(() => {});
        });
      }
    });
    webview.addEventListener("page-title-updated", (event) => {
      if (tab.id === activeTabId && event.title) elements.activeTitle.textContent = tab.name;
    });

    const extPanel = document.createElement("div");
    extPanel.className = "tab-extension-panel";
    extPanel.innerHTML = `
      <div class="tab-extension-content">
        <div class="tab-extension-header">
          <span class="tab-extension-title">扩展程序</span>
          <button class="icon-button tab-extension-close" type="button" aria-label="关闭扩展">×</button>
        </div>
        <div class="tab-extension-body"></div>
      </div>
    `;
    extPanel.querySelector(".tab-extension-close").addEventListener("click", () => {
      extPanel.classList.remove("open");
      extPanel.style.removeProperty("--tab-ext-width");
      extPanel.querySelector(".tab-extension-body")?.replaceChildren();
    });

    const resizer = document.createElement("div");
    resizer.className = "tab-extension-resizer";
    resizer.title = "拖动调整扩展宽度";
    resizer.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      endAllResizes();
      resizer.setPointerCapture(event.pointerId);
      elements.appShell.classList.add("resizing");
      extPanel.classList.add("resizing");
      resizer.classList.add("resizing");
      setWebviewPointerEvents(false);

      const startX = event.clientX;
      const startWidth = extPanel.getBoundingClientRect().width || 320;

      const onMove = (moveEvent) => {
        if (moveEvent.buttons === 0) {
          onUp();
          return;
        }
        const deltaX = startX - moveEvent.clientX;
        const width = Math.max(240, Math.min(window.innerWidth * 0.6, startWidth + deltaX));
        extPanel.style.setProperty("--tab-ext-width", `${width}px`);
      };

      const onUp = () => {
        if (activeResizeEnd === onUp) activeResizeEnd = null;
        try {
          if (resizer.hasPointerCapture(event.pointerId)) {
            resizer.releasePointerCapture(event.pointerId);
          }
        } catch {}
        elements.appShell.classList.remove("resizing");
        extPanel.classList.remove("resizing");
        resizer.classList.remove("resizing");
        setWebviewPointerEvents(true);
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
      };

      activeResizeEnd = onUp;
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    });

    viewport.append(webview);
    viewport.append(resizer);
    viewport.append(extPanel);

  } else if (type === "desktop-app") {
    const embedMode = !!tab.embedMode;
    
    if (embedMode) {
      viewport.innerHTML = `
        <div class="desktop-dashboard embedded" style="width: 100%; height: 100%; position: relative; padding: 0; background: #fafafa;">
          <div class="desktop-embed-container" style="width: 100%; height: 100%; position: relative; overflow: hidden;">
            <div class="desktop-embed-placeholder" style="width: 100%; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--text-secondary); background: #f8fafc; font-size: 13.5px; gap: 12px;">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.6;">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                <line x1="8" y1="21" x2="16" y2="21"></line>
                <line x1="12" y1="17" x2="12" y2="21"></line>
              </svg>
              <span>程序未启动。点击下方控制条的“启动”按钮将窗口嵌套至此。</span>
            </div>
          </div>
          <div class="desktop-embed-control-overlay" style="position: absolute; bottom: 20px; right: 20px; z-index: 10000; pointer-events: auto;">
            <div class="desktop-card mini-card" style="padding: 12px 18px; border-radius: 12px; box-shadow: 0 10px 30px rgba(15,23,42,0.12); display: flex; align-items: center; gap: 14px; background: rgba(255,255,255,0.9); backdrop-filter: blur(8px); border: 1px solid var(--border-color);">
               <span class="desktop-indicator stopped" style="width: 8px; height: 8px; border-radius: 50%; display: inline-block;"></span>
               <strong style="font-size: 13px; color: var(--text-primary); margin: 0;">${escapeHtml(tab.name)}</strong>
               <span class="desktop-status-text" style="font-size: 12px; color: var(--text-secondary);">已停止</span>
               <span class="desktop-pid-text" style="font-size: 12px; font-family: monospace; color: var(--text-secondary); display: none;"></span>
               <button class="primary-button launch-btn" type="button" style="padding: 5px 12px; font-size: 12px; border-radius: 8px; margin: 0; height: auto;">启动</button>
               <button class="danger-button kill-btn" type="button" style="padding: 5px 12px; font-size: 12px; border-radius: 8px; display: none; margin: 0; height: auto;">关闭</button>
            </div>
          </div>
        </div>
      `;
    } else {
      viewport.innerHTML = `
        <div class="desktop-dashboard">
          <div class="desktop-card">
            <div class="desktop-header">
              <div class="desktop-title-wrap">
                <span class="desktop-indicator stopped"></span>
                <h3>${escapeHtml(tab.name)}</h3>
              </div>
              <span class="desktop-status-text">已停止</span>
            </div>
            <div class="desktop-body">
              <div class="desktop-info-row">
                <strong>程序文件路径:</strong>
                <span>${escapeHtml(tab.exePath)}</span>
              </div>
              <div class="desktop-info-row">
                <strong>程序运行工作目录:</strong>
                <span>${escapeHtml(tab.exeCwd || "默认程序目录")}</span>
              </div>
              <div class="desktop-info-row">
                <strong>运行状态:</strong>
                <span class="desktop-pid-text">-</span>
              </div>
              <div class="desktop-actions">
                <button class="primary-button launch-btn">启动应用</button>
                <button class="danger-button kill-btn" style="display: none;">强制关闭</button>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    const indicator = viewport.querySelector(".desktop-indicator");
    const statusText = viewport.querySelector(".desktop-status-text");
    const pidText = viewport.querySelector(".desktop-pid-text");
    const launchBtn = viewport.querySelector(".launch-btn");
    const killBtn = viewport.querySelector(".kill-btn");
    const placeholder = viewport.querySelector(".desktop-embed-placeholder");

    const updateStatusUI = (status) => {
      if (status.running) {
        indicator.className = "desktop-indicator running";
        statusText.textContent = "正在运行";
        pidText.textContent = `PID: ${status.pid}`;
        if (embedMode) pidText.style.display = "inline";
        launchBtn.style.display = "none";
        killBtn.style.display = "inline-block";
        if (placeholder) placeholder.style.display = "none";
      } else {
        indicator.className = "desktop-indicator stopped";
        statusText.textContent = "已停止";
        pidText.textContent = "-";
        if (embedMode) pidText.style.display = "none";
        launchBtn.style.display = "inline-block";
        killBtn.style.display = "none";
        if (placeholder) placeholder.style.display = "flex";
      }
    };

    const syncEmbeddedWindowSize = () => {
      if (!embedMode) return;
      const container = viewport.querySelector(".desktop-embed-container");
      if (!container) return;
      const rect = container.getBoundingClientRect();
      window.workbench.resizeEmbeddedWindow(tab.id, {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height
      });
    };

    window.workbench.getDesktopAppStatus(tab.id).then(updateStatusUI);

    const unsub = window.workbench.onDesktopAppStatusChange(tab.id, updateStatusUI);
    
    let unsubBound;
    if (embedMode) {
      unsubBound = window.workbench.onDesktopAppEmbeddedBound(tab.id, (res) => {
        if (res.success) {
          setTimeout(syncEmbeddedWindowSize, 500);
        } else {
          showToast(`窗口嵌套失败: ${res.error}`, "error");
        }
      });
    }

    registerTabCleanup(tab.id, () => {
      unsub();
      if (unsubBound) unsubBound();
      if (desktopStatusPollers.has(tab.id)) {
        clearInterval(desktopStatusPollers.get(tab.id));
        desktopStatusPollers.delete(tab.id);
      }
    });

    launchBtn.addEventListener("click", async () => {
      launchBtn.disabled = true;
      let rect = null;
      if (embedMode) {
        const container = viewport.querySelector(".desktop-embed-container");
        const r = container.getBoundingClientRect();
        rect = { x: r.left, y: r.top, width: r.width, height: r.height };
      }
      
      const res = await window.workbench.launchDesktopApp(tab.id, tab.exePath, tab.exeCwd, embedMode, rect);
      launchBtn.disabled = false;
      if (res.success) {
        updateStatusUI({ running: true, pid: res.pid });
        showToast("程序启动成功", "success");
        if (embedMode) {
          setTimeout(syncEmbeddedWindowSize, 1000);
        }
      } else {
        showToast(`程序启动失败: ${res.error}`, "error");
      }
    });

    killBtn.addEventListener("click", async () => {
      killBtn.disabled = true;
      const res = await window.workbench.killDesktopApp(tab.id);
      killBtn.disabled = false;
      if (res.success) {
        updateStatusUI({ running: false, pid: null });
        showToast("程序已强制关闭", "success");
      } else {
        showToast(`关闭失败: ${res.error}`, "error");
      }
    });

    const pollInterval = setInterval(async () => {
      const status = await window.workbench.getDesktopAppStatus(tab.id);
      updateStatusUI(status);
      if (status.running && embedMode) {
        syncEmbeddedWindowSize();
      }
    }, 2000);
    desktopStatusPollers.set(tab.id, pollInterval);

    if (tab.autoLaunch) {
      let rect = null;
      if (embedMode) {
        const autoLaunchTimer = setTimeout(() => {
          if (!viewport.isConnected || !tabs.some((candidate) => candidate.id === tab.id)) return;
          const container = viewport.querySelector(".desktop-embed-container");
          const r = container?.getBoundingClientRect();
          if (r) {
            rect = { x: r.left, y: r.top, width: r.width, height: r.height };
          }
          window.workbench.launchDesktopApp(tab.id, tab.exePath, tab.exeCwd, embedMode, rect).then((res) => {
            if (res.success) updateStatusUI({ running: true, pid: res.pid });
          });
        }, 500);
        registerTabCleanup(tab.id, () => clearTimeout(autoLaunchTimer));
      } else {
        window.workbench.launchDesktopApp(tab.id, tab.exePath, tab.exeCwd, embedMode, rect).then((res) => {
          if (res.success) updateStatusUI({ running: true, pid: res.pid });
        });
      }
    }

  } else if (type === "cli-app") {
    viewport.innerHTML = `
      <div class="cli-terminal-wrap">
        <div class="cli-terminal-container"></div>
      </div>
    `;

    const termContainer = viewport.querySelector(".cli-terminal-container");
    const cliTerm = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"Cascadia Code", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.35,
      theme: {
        background: "#ffffff",
        foreground: "#17324d",
        cursor: "#3b82f6",
        selectionBackground: "#dbeafe",
        black: "#334155",
        blue: "#2563eb",
        cyan: "#0891b2",
        green: "#059669",
        magenta: "#7c3aed",
        red: "#dc2626",
        white: "#e2e8f0",
        yellow: "#d97706"
      }
    });

    const cliFitAddon = new FitAddon.FitAddon();
    cliTerm.loadAddon(cliFitAddon);

    const cliStartTimer = setTimeout(() => {
      if (!viewport.isConnected || !tabs.some((candidate) => candidate.id === tab.id)) return;
      cliTerm.open(termContainer);
      cliFitAddon.fit();
      
      window.workbench.startCliTerminal(tab.id, tab.command, tab.cwd, {
        cols: cliTerm.cols,
        rows: cliTerm.rows
      });

      cliTerm.onData((data) => {
        window.workbench.sendCliTerminalInput(tab.id, data);
      });
    }, 100);

    const unsubData = window.workbench.onCliTerminalData(tab.id, (data) => {
      cliTerm.write(data);
    });

    tabTerminals.set(tab.id, { terminal: cliTerm, fitAddon: cliFitAddon });

    registerTabCleanup(tab.id, () => {
      clearTimeout(cliStartTimer);
      unsubData();
      tabTerminals.delete(tab.id);
      cliTerm.dispose();
    });

  } else if (type === "builtin") {
    const builtinType = tab.builtinType || "markdown";
    if (builtinType === "markdown") {
      viewport.innerHTML = `
        <div class="markdown-editor-container">
          <div class="md-toolbar">
            <button class="md-btn md-bold" title="粗体" type="button"><b>B</b></button>
            <button class="md-btn md-italic" title="斜体" type="button"><i>I</i></button>
            <button class="md-btn md-header" title="标题" type="button">H</button>
            <button class="md-btn md-code" title="代码块" type="button">&lt;/&gt;</button>
            <button class="md-btn md-link" title="链接" type="button">🔗</button>
            <button class="md-btn md-image" title="图片" type="button">🖼️</button>
            <span class="md-toolbar-spacer"></span>
            <span class="md-saved-status">自动保存已启用</span>
          </div>
          <div class="md-work-area">
            <textarea class="md-textarea" placeholder="在此输入 Markdown 内容..."></textarea>
            <div class="md-preview-pane"></div>
          </div>
        </div>
      `;

      const textarea = viewport.querySelector(".md-textarea");
      const preview = viewport.querySelector(".md-preview-pane");

      const storageKey = `personal_workbench_builtin_md_${tab.id}`;
      textarea.value = localStorage.getItem(storageKey) || `# ${tab.name}\n\n开始编写你的文档吧...`;

      const parseMarkdown = (md) => {
        let html = md
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        
        html = html.replace(/^### (.*$)/gim, "<h3>$1</h3>");
        html = html.replace(/^## (.*$)/gim, "<h2>$1</h2>");
        html = html.replace(/^# (.*$)/gim, "<h1>$1</h1>");
        
        html = html.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
        html = html.replace(/\*(.*?)\*/g, "<em>$1</em>");
        html = html.replace(/`(.*?)`/g, "<code>$1</code>");
        html = html.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank">$1</a>');
        html = html.replace(/!\[(.*?)\]\((.*?)\)/g, '<img src="$2" alt="$1" style="max-width:100%;" />');
        html = html.replace(/\n\n/g, "</p><p>");
        html = html.replace(/\n/g, "<br>");

        return `<p>${html}</p>`;
      };

      const updatePreview = () => {
        const val = textarea.value;
        localStorage.setItem(storageKey, val);
        preview.innerHTML = parseMarkdown(val);
      };

      textarea.addEventListener("input", updatePreview);
      updatePreview();

      const insertAtCursor = (before, after) => {
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const text = textarea.value;
        const selected = text.substring(start, end);
        textarea.value = text.substring(0, start) + before + selected + after + text.substring(end);
        textarea.focus();
        textarea.selectionStart = start + before.length;
        textarea.selectionEnd = start + before.length + selected.length;
        updatePreview();
      };

      viewport.querySelector(".md-bold").addEventListener("click", () => insertAtCursor("**", "**"));
      viewport.querySelector(".md-italic").addEventListener("click", () => insertAtCursor("*", "*"));
      viewport.querySelector(".md-header").addEventListener("click", () => insertAtCursor("## ", ""));
      viewport.querySelector(".md-code").addEventListener("click", () => insertAtCursor("\n```\n", "\n```\n"));
      viewport.querySelector(".md-link").addEventListener("click", () => insertAtCursor("[链接文字](", ")"));
      viewport.querySelector(".md-image").addEventListener("click", () => insertAtCursor("![描述](", ")"));

    } else if (builtinType === "whiteboard") {
      viewport.innerHTML = `
        <div class="whiteboard-container">
          <div class="wb-toolbar">
            <input type="color" class="wb-color-picker" value="#3b82f6" title="选择画笔颜色" />
            <select class="wb-brush-size" title="画笔粗细">
              <option value="2">细画笔</option>
              <option value="5" selected>中画笔</option>
              <option value="10">粗画笔</option>
              <option value="20">特粗画笔</option>
            </select>
            <button class="wb-btn wb-tool-draw active" title="画笔模式" type="button">✏️</button>
            <button class="wb-btn wb-tool-erase" title="橡皮擦" type="button">🧹</button>
            <button class="wb-btn wb-clear" title="清空画板" type="button">🗑️</button>
            <span class="wb-toolbar-spacer"></span>
            <button class="wb-btn wb-download primary-button" title="导出为图片" type="button">保存图片</button>
          </div>
          <div class="wb-canvas-wrap">
            <canvas class="wb-canvas"></canvas>
          </div>
        </div>
      `;

      const canvas = viewport.querySelector(".wb-canvas");
      const ctx = canvas.getContext("2d");
      const colorPicker = viewport.querySelector(".wb-color-picker");
      const brushSize = viewport.querySelector(".wb-brush-size");
      const drawBtn = viewport.querySelector(".wb-tool-draw");
      const eraseBtn = viewport.querySelector(".wb-tool-erase");
      const clearBtn = viewport.querySelector(".wb-clear");
      const downloadBtn = viewport.querySelector(".wb-download");

      let isDrawing = false;
      let lastX = 0;
      let lastY = 0;
      let isEraser = false;

      const resizeCanvas = () => {
        const rect = canvas.parentElement.getBoundingClientRect();
        const temp = document.createElement("canvas");
        temp.width = canvas.width;
        temp.height = canvas.height;
        const tempCtx = temp.getContext("2d");
        tempCtx.drawImage(canvas, 0, 0);

        canvas.width = rect.width;
        canvas.height = rect.height;

        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.drawImage(temp, 0, 0);
      };

      setTimeout(() => {
        resizeCanvas();
        window.addEventListener("resize", resizeCanvas);
      }, 100);

      const startDrawing = (e) => {
        isDrawing = true;
        const rect = canvas.getBoundingClientRect();
        const clientX = e.clientX || e.touches?.[0]?.clientX;
        const clientY = e.clientY || e.touches?.[0]?.clientY;
        lastX = clientX - rect.left;
        lastY = clientY - rect.top;
      };

      const draw = (e) => {
        if (!isDrawing) return;
        const rect = canvas.getBoundingClientRect();
        const clientX = e.clientX || e.touches?.[0]?.clientX;
        const clientY = e.clientY || e.touches?.[0]?.clientY;
        const x = clientX - rect.left;
        const y = clientY - rect.top;

        ctx.beginPath();
        ctx.moveTo(lastX, lastY);
        ctx.lineTo(x, y);

        ctx.strokeStyle = isEraser ? "#ffffff" : colorPicker.value;
        ctx.lineWidth = Number(brushSize.value);
        ctx.stroke();

        lastX = x;
        lastY = y;
      };

      const stopDrawing = () => {
        isDrawing = false;
      };

      canvas.addEventListener("mousedown", startDrawing);
      canvas.addEventListener("mousemove", draw);
      canvas.addEventListener("mouseup", stopDrawing);
      canvas.addEventListener("mouseout", stopDrawing);

      canvas.addEventListener("touchstart", startDrawing);
      canvas.addEventListener("touchmove", draw);
      canvas.addEventListener("touchend", stopDrawing);

      drawBtn.addEventListener("click", () => {
        isEraser = false;
        drawBtn.classList.add("active");
        eraseBtn.classList.remove("active");
      });

      eraseBtn.addEventListener("click", () => {
        isEraser = true;
        eraseBtn.classList.add("active");
        drawBtn.classList.remove("active");
      });

      clearBtn.addEventListener("click", () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      });

      downloadBtn.addEventListener("click", () => {
        const link = document.createElement("a");
        link.download = `whiteboard-${Date.now()}.png`;
        link.href = canvas.toDataURL("image/png");
        link.click();
      });

      registerTabCleanup(tab.id, () => {
        window.removeEventListener("resize", resizeCanvas);
      });
    }
  }

  elements.webviewStack.append(viewport);
  return viewport;
}

function isRegisteredLocalAppUrl(tab, rawUrl) {
  if (tab?.type !== "local-web") return false;
  try {
    const parsed = new URL(String(rawUrl || ""));
    if (!["localhost", "127.0.0.1"].includes(parsed.hostname) || parsed.port !== "38924") return false;
    return parsed.pathname.startsWith(`/local-apps/${encodeURIComponent(tab.id)}/`);
  } catch {
    return false;
  }
}

function ensureTabViewportLoaded(tabId) {
  const viewport = document.querySelector(`.tab-viewport[data-id="${tabId}"]`);
  if (!viewport?.dataset.webDeferred) return viewport;
  const tab = tabs.find((candidate) => candidate.id === tabId);
  if (!tab) return viewport;

  const loadedViewport = createTabViewport(tab, { deferWeb: false });
  viewport.remove();
  return loadedViewport;
}

function activeWebview() {
  return document.querySelector(`.tab-viewport[data-id="${activeTabId}"] .tab-webview`);
}

let isActivatingTab = false;
function activateTab(id, { autoExpand = true } = {}) {
  if (isActivatingTab) return;
  isActivatingTab = true;
  try {
    const isTaskCenter = id === TASK_CENTER_ID;
    const isWeeklyReport = id === WEEKLY_REPORT_ID;
    const isBuiltinView = isTaskCenter || isWeeklyReport;
    if (isBuiltinView) {
      rightSplitTabId = null;
      bottomSplitTabId = null;
    } else {
      if (rightSplitTabId === id) {
        rightSplitTabId = isBuiltinViewId(activeTabId) ? null : activeTabId;
      } else if (bottomSplitTabId === id) {
        bottomSplitTabId = isBuiltinViewId(activeTabId) ? null : activeTabId;
      }

      // Prevent duplicate references
      if (rightSplitTabId && rightSplitTabId === bottomSplitTabId) {
        bottomSplitTabId = null;
      }
    }

    activeTabId = id;
    localStorage.setItem("personal_workbench_active", id);
    const tab = isBuiltinView ? null : tabs.find((candidate) => candidate.id === id);
    if (!isBuiltinView && !tab) return;

    // Auto-expand category if collapsed（仅限用户主动切换标签的调用路径）
    if (tab && autoExpand) {
      const category = getTabCategory(tab);
      if (collapsedCategories[category]) {
        collapsedCategories[category] = false;
        localStorage.setItem("workbench_collapsed_categories", JSON.stringify(collapsedCategories));
        renderTabs();
      }
    }

    // 网页标签首次进入主视图或分屏时才创建 webview，避免启动时加载所有后台页面。
    for (const visibleTabId of [activeTabId, rightSplitTabId, bottomSplitTabId]) {
      if (visibleTabId && !isBuiltinViewId(visibleTabId)) ensureTabViewportLoaded(visibleTabId);
    }

    elements.workspace.classList.toggle("task-center-active", isTaskCenter);
    elements.workspace.classList.toggle("weekly-report-active", isWeeklyReport);
    elements.navTaskCenter?.classList.toggle("active", isTaskCenter);
    elements.navWeeklyReport?.classList.toggle("active", isWeeklyReport);
    document.querySelectorAll(".tab-item").forEach((item) => {
      item.classList.toggle("active", !isBuiltinView && item.dataset.id === id);
      item.classList.toggle("split-active", item.dataset.id === rightSplitTabId || item.dataset.id === bottomSplitTabId);
    });

    // Move viewports to their correct parent containers
    document.querySelectorAll(".tab-viewport[data-id]").forEach((viewport) => {
      const vpId = viewport.dataset.id;
      if (vpId === activeTabId) {
        viewport.classList.add("active");
        if (viewport.parentElement !== elements.webviewStack) {
          elements.webviewStack.append(viewport);
        }
      } else if (vpId === rightSplitTabId) {
        viewport.classList.add("active");
        if (viewport.parentElement !== elements.rightSidebarBody) {
          elements.rightSidebarBody.append(viewport);
        }
      } else if (vpId === bottomSplitTabId) {
        viewport.classList.add("active");
        if (viewport.parentElement !== elements.bottomSidebarBody) {
          elements.bottomSidebarBody.append(viewport);
        }
      } else {
        viewport.classList.remove("active");
        if (viewport.parentElement !== elements.webviewStack) {
          elements.webviewStack.append(viewport);
        }
      }
    });

    updateTopbarForActive(tab);
    if (isTaskCenter) {
      renderTaskCenter();
    }
    if (isWeeklyReport) {
      renderWeeklyReportCenter();
    }
    updateActiveTabInfo();
    fitWebviewZoom();

    // If CLI app, fit and focus it
    if (tab && tab.type === "cli-app") {
      setTimeout(() => {
        const termObj = tabTerminals.get(id);
        if (termObj) {
          termObj.fitAddon.fit();
          termObj.terminal.focus();
          window.workbench.resizeCliTerminal(id, {
            cols: termObj.terminal.cols,
            rows: termObj.terminal.rows
          });
        }
      }, 100);
    }

    // Toggle visibility of embedded desktop applications
    const visibleIds = [activeTabId, rightSplitTabId, bottomSplitTabId].filter(Boolean);
    tabs.forEach((candidate) => {
      if (candidate.type === "desktop-app" && candidate.embedMode) {
        const isVisible = visibleIds.includes(candidate.id);
        window.workbench.toggleEmbeddedWindowVisibility(candidate.id, isVisible);
        if (isVisible) {
          setTimeout(() => {
            const viewport = document.querySelector(`.tab-viewport[data-id="${candidate.id}"]`);
            const container = viewport?.querySelector(".desktop-embed-container");
            if (container) {
              const rect = container.getBoundingClientRect();
              window.workbench.resizeEmbeddedWindow(candidate.id, {
                x: rect.left,
                y: rect.top,
                width: rect.width,
                height: rect.height
              });
            }
          }, 200);
        }
      }
    });
  } finally {
    isActivatingTab = false;
  }
}

// 顶栏面包屑与地址栏显隐：任务中心隐藏地址栏，webview 标签显示地址栏
function updateTopbarForActive(tab = null) {
  if (!tab) {
    if (activeTabId === WEEKLY_REPORT_ID) {
      elements.activeTitle.textContent = "周报中心";
      elements.crumbSub.textContent = activeWeeklyReport?.title || "工作内容归档";
      elements.addressBar.style.display = "none";
      return;
    }
    const total = weeklyTasks.length;
    const running = weeklyTasks.filter((task) => task.status === "running" || task.status === "evaluating").length;
    elements.activeTitle.textContent = "任务中心";
    elements.crumbSub.textContent = `本周 ${total} 项 · 进行中 ${running} 项`;
    elements.addressBar.style.display = "none";
    return;
  }
  elements.activeTitle.textContent = tab.name;
  const isWebTab = tab.type === "web" || tab.type === "local-web" || !tab.type;
  elements.crumbSub.textContent = CATEGORY_MAP[getTabCategory(tab)]?.name || "";
  elements.addressBar.style.display = isWebTab ? "flex" : "none";
  if (isWebTab) {
    let currentUrl = tab.url || "";
    try {
      currentUrl = activeWebview()?.getURL?.() || tab.url || "";
    } catch (error) {
      console.warn("获取 Webview URL 失败:", error);
    }
    elements.addressInput.value = currentUrl;
  }
}

function fitWebviewZoom() {
  document.querySelectorAll(".tab-viewport[data-id]").forEach((viewport) => {
    const webview = viewport.querySelector(".tab-webview");
    if (!webview) return;
    try {
      webview.setZoomFactor?.(1.0);
      webview.executeJavaScript?.("window.dispatchEvent(new Event('resize'));").catch(() => {});
    } catch (error) {
      console.warn("设置 Zoom 失败（Webview 实例尚未就绪）：", error);
    }
  });
}

function updateAddressFromWebview(webview) {
  const tabId = webview.closest(".tab-viewport")?.dataset.id;
  if (tabId === activeTabId) {
    try {
      elements.addressInput.value = webview.getURL();
      updateActiveTabInfo();
    } catch (error) {
      console.warn("更新地址栏失败:", error);
    }
  }
}

function updateActiveTabInfo() {
  if (isBuiltinViewId(activeTabId)) {
    window.workbench.updateActiveTabInfo({
      url: "",
      title: activeTabId === WEEKLY_REPORT_ID ? "周报中心" : "任务中心"
    });
    return;
  }
  const tab = tabs.find((candidate) => candidate.id === activeTabId);
  let activeUrl = "";
  try {
    activeUrl = activeWebview()?.getURL?.() || tab?.url || "";
  } catch (error) {
    activeUrl = tab?.url || "";
  }
  window.workbench.updateActiveTabInfo({
    url: activeUrl,
    title: tab?.name || ""
  });
}

function navigateToAddress() {
  const webview = activeWebview();
  if (webview) webview.loadURL(normalizeUrl(elements.addressInput.value));
}

function switchTabFormType(type) {
  document.querySelectorAll(".form-group-type").forEach((group) => {
    group.style.display = group.dataset.type === type ? "block" : "none";
  });
}

function openTabDialog(tab = null) {
  document.querySelector("#tab-dialog-title").textContent = tab ? "编辑标签页" : "添加标签页";
  document.querySelector("#tab-id").value = tab?.id || "";
  document.querySelector("#tab-name").value = tab?.name || "";

  const type = tab?.type || "web";
  document.querySelector("#tab-type").value = type;

  document.querySelector("#tab-url").value = tab?.url || "";
  document.querySelector("#tab-local-path").value = tab?.localPath || "";
  document.querySelector("#tab-exe-path").value = tab?.exePath || "";
  document.querySelector("#tab-exe-cwd").value = tab?.exeCwd || "";
  document.querySelector("#tab-exe-autolaunch").checked = !!tab?.autoLaunch;
  document.querySelector("#tab-exe-embed").checked = !!tab?.embedMode;
  document.querySelector("#tab-cli-command").value = tab?.command || "";
  document.querySelector("#tab-cli-cwd").value = tab?.cwd || "";
  document.querySelector("#tab-builtin-type").value = tab?.builtinType || "markdown";

  switchTabFormType(type);

  document.querySelector("#delete-tab-button").hidden = !tab;
  const index = tab ? tabs.findIndex((candidate) => candidate.id === tab.id) : -1;
  document.querySelector("#move-up-tab-button").hidden = index <= 0;
  document.querySelector("#move-down-tab-button").hidden = index < 0 || index >= tabs.length - 1;
  elements.tabDialog.showModal();
  document.querySelector("#tab-name").focus();
}

function initTerminal() {
  terminal = new Terminal({
    cursorBlink: true,
    convertEol: true,
    fontFamily: '"Cascadia Code", Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.35,
    theme: terminalThemeFor(document.body.dataset.theme)
  });
  fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(document.querySelector("#terminal-container"));
  terminal.onData((data) => window.workbench.sendTerminalInput(data));
  window.workbench.onTerminalData((data) => terminal.write(data));
}

function toggleTerminal(force) {
  const open = typeof force === "boolean" ? force : !elements.terminalPanel.classList.contains("open");
  elements.terminalPanel.classList.toggle("open", open);
  elements.sbTerminal?.classList.toggle("on", open);
  if (open) {
    setTimeout(() => {
      fitAddon.fit();
      window.workbench.startTerminal({ cols: terminal.cols, rows: terminal.rows });
      terminal.focus();
    }, 220);
  }
}

function extensionRow(entry = {}) {
  const row = document.createElement("div");
  row.className = "extension-row";
  row.innerHTML = `
    <label class="check-label"><input class="extension-enabled" type="checkbox" ${entry.enabled === false ? "" : "checked"} />启用</label>
    <input class="extension-id" type="text" value="${escapeHtml(entry.id || "")}" placeholder="扩展 ID" />
    <input class="extension-path" type="text" value="${escapeHtml(entry.path || "")}" placeholder="或本地目录路径" />
    <button class="icon-button remove-extension" type="button" aria-label="删除扩展">×</button>
  `;
  row.querySelector(".remove-extension").addEventListener("click", () => row.remove());
  elements.extensionList.append(row);
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[character]);
}

function taskTypeLabel(type) {
  return {
    "capability-setup": "能力训练搭建",
    "capability-edit": "能力训练修改",
    "capability-acceptance": "能力训练验收",
    "grading-setup": "作业批阅搭建",
    "grading-acceptance": "作业批阅验收",
    "grading-edit": "作业批阅修改"
  }[type] || type || "未分类";
}

// 任务中心搜索：匹配 school / course / owner / note / taskType 中文标签
function matchesTaskQuery(task, query, typeLabelFn = taskTypeLabel) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    task?.school,
    task?.course,
    task?.owner,
    task?.note,
    typeLabelFn(task?.taskType)
  ].map((value) => String(value || "").toLowerCase()).join("\n");
  return haystack.includes(needle);
}

// 任务中心筛选：默认隐藏 archived；status=archived 时仅显示归档
// status: all | pending | running | paused | unsubmitted | completed | archived
function filterTasks(tasks, { query = "", status = "all", school = "" } = {}, typeLabelFn = taskTypeLabel) {
  const statusFilter = String(status || "all");
  const schoolFilter = String(school || "").trim();
  const showArchivedOnly = statusFilter === "archived";
  return (Array.isArray(tasks) ? tasks : []).filter((task) => {
    const archived = Boolean(task?.archived);
    if (showArchivedOnly) {
      if (!archived) return false;
    } else if (archived) {
      return false;
    }
    if (!showArchivedOnly && statusFilter !== "all") {
      if (statusFilter === "running") {
        if (!(task.status === "running" || task.status === "evaluating")) return false;
      } else if (task.status !== statusFilter) {
        return false;
      }
    }
    if (schoolFilter && schoolFilter !== "all" && String(task.school || "") !== schoolFilter) {
      return false;
    }
    return matchesTaskQuery(task, query, typeLabelFn);
  });
}

window.matchesTaskQuery = matchesTaskQuery;
window.filterTasks = filterTasks;
window.taskTypeLabel = taskTypeLabel;

// ============ 任务产物徽章（纯函数，无副作用，供测试注入） ============

function basenameFromPath(filePath) {
  const raw = String(filePath || "").replace(/\\/g, "/");
  const parts = raw.split("/");
  return parts[parts.length - 1] || "";
}

function isChatArtifactName(name) {
  const lower = String(name || "");
  return /^(dialogue|dialog|chat(?:[_ -]?log)?)(?:[_ -]?\d+)?\.(json|txt|md)$/i.test(lower)
    || /^dialogue/i.test(lower);
}

function isReportArtifactName(name) {
  const lower = String(name || "");
  return /^(eval(?:uation)?[_ -]?report|report)(?:[_ -]?\d+)?\.(pdf|html?)$/i.test(lower)
    || /^eval_report/i.test(lower);
}

function isCardsArtifactName(name) {
  return /^cards\.md$/i.test(String(name || ""));
}

// 根据已有路径 + 文件夹文件列表推导三类产物徽章（chat / report / cards）
function taskArtifactsFromPathsAndFiles(paths = {}, files = []) {
  const list = Array.isArray(files) ? files : [];
  const normalized = list.map((entry) => {
    if (typeof entry === "string") {
      return { name: basenameFromPath(entry), path: entry };
    }
    const name = String(entry?.name || basenameFromPath(entry?.path) || "");
    return { name, path: String(entry?.path || ""), mtime: entry?.mtime, size: entry?.size };
  });

  const chatFile = normalized.find((entry) => isChatArtifactName(entry.name));
  const reportFile = normalized.find((entry) => isReportArtifactName(entry.name));
  const cardsFile = normalized.find((entry) => isCardsArtifactName(entry.name));

  const chatPath = String(paths.chatLogPath || "") || chatFile?.path || "";
  const reportPath = String(paths.reportPath || "") || reportFile?.path || "";
  const cardsPath = cardsFile?.path || "";

  return {
    chat: {
      ready: Boolean(chatPath),
      path: chatPath,
      name: basenameFromPath(chatPath) || chatFile?.name || "dialogue.json"
    },
    report: {
      ready: Boolean(reportPath),
      path: reportPath,
      name: basenameFromPath(reportPath) || reportFile?.name || "eval_report.pdf"
    },
    cards: {
      ready: Boolean(cardsPath),
      path: cardsPath,
      name: cardsFile?.name || "cards.md"
    }
  };
}

window.taskArtifactsFromPathsAndFiles = taskArtifactsFromPathsAndFiles;
window.isChatArtifactName = isChatArtifactName;
window.isReportArtifactName = isReportArtifactName;
window.isCardsArtifactName = isCardsArtifactName;

// ============ 待做任务.txt 解析（纯函数，无副作用，供测试注入） ============

// 任务类型关键词 → 内部枚举（含 V3.2 新增的 grading-edit）
const TODO_TYPE_MAP = [
  ["能力训练搭建", "capability-setup"],
  ["能力训练修改", "capability-edit"],
  ["能力训练验收", "capability-acceptance"],
  ["作业批阅搭建", "grading-setup"],
  ["作业批阅验收", "grading-acceptance"],
  ["作业批阅修改", "grading-edit"]
];
const TODO_WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const TODO_IMPORT_FIELDS = ["quantity", "status", "owner", "weekday", "subtasks", "note"];
const TODO_IMPORT_FIELD_LABELS = {
  quantity: "数量",
  status: "状态",
  owner: "负责人",
  weekday: "星期",
  subtasks: "子任务",
  note: "备注"
};
let importPreviewState = null;

// 括号备注 → 子任务标记：{ 编号: "done"|"unconfirmed" }；无法识别返回 null
function parseSubtaskNote(text) {
  const marks = {};
  let matched = false;
  const splitNums = (raw) => raw.split(/[/、,，\s]+/).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
  const doneMatch = text.match(/已完成任务([\d/、,，\s]+)/) || text.match(/任务([\d/、,，\s]+)已完成/);
  if (doneMatch) {
    for (const n of splitNums(doneMatch[1])) marks[n] = "done";
    matched = true;
  }
  const unconfirmedMatch = text.match(/任务([\d/、,，\s]+)待确认/) || text.match(/待确认任务([\d/、,，\s]+)/);
  if (unconfirmedMatch) {
    for (const n of splitNums(unconfirmedMatch[1])) marks[n] = "unconfirmed";
    matched = true;
  }
  return matched ? marks : null;
}

// 行模式：学校《课程》 [任务类型] [N个] [状态(可带括号备注)] [负责人] [星期]
// 返回 { tasks: [...], unparsed: [原文行] }；字段间空格数量容错
function parseTodoLines(text) {
  const tasks = [];
  const unparsed = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const head = line.match(/^(.+?)《([^》]+)》(.*)$/);
    if (!head) {
      unparsed.push(line);
      continue;
    }
    const school = head[1].trim();
    const course = head[2].trim();
    let rest = head[3];

    let taskType = "";
    for (const [keyword, value] of TODO_TYPE_MAP) {
      if (rest.includes(keyword)) {
        taskType = value;
        rest = rest.replace(keyword, " ");
        break;
      }
    }

    let quantity = 1;
    const quantityMatch = rest.match(/(\d+)个/);
    if (quantityMatch) {
      quantity = Math.max(1, Number(quantityMatch[1]));
      rest = rest.replace(quantityMatch[0], " ");
    }

    let status = "pending";
    let note = "";
    let subtaskMarks = null;
    const statusMatch = rest.match(/(已完成|未完成|未提交)\s*(（[^）]*）|\([^)]*\))?/);
    if (statusMatch) {
      status = statusMatch[1] === "已完成" ? "completed" : statusMatch[1] === "未提交" ? "unsubmitted" : "pending";
      if (statusMatch[2]) {
        const inner = statusMatch[2].slice(1, -1).trim();
        subtaskMarks = parseSubtaskNote(inner);
        if (!subtaskMarks) note = inner;
      }
      rest = rest.replace(statusMatch[0], " ");
    }

    let weekday = "";
    const weekdayMatch = rest.match(/周[一二三四五六日]/);
    if (weekdayMatch) {
      weekday = weekdayMatch[0];
      rest = rest.replace(weekdayMatch[0], " ");
    }

    const owner = rest.trim().split(/\s+/).filter(Boolean)[0] || "";
    tasks.push({ school, course, taskType, quantity, status, owner, weekday, note, subtaskMarks });
  }
  return { tasks, unparsed };
}
window.parseTodoLines = parseTodoLines;

// ============ 待做任务.txt 写回（纯函数，无副作用，与上方解析器互为逆运算） ============

const TODO_STATUS_TEXT = { pending: "未完成", unsubmitted: "未提交", completed: "已完成" };

// 工作台扩展状态（running/evaluating/paused）txt 中无对应词，统一落回「未完成」
function normalizeWriteBackStatus(status) {
  return ["completed", "unsubmitted"].includes(status) ? status : "pending";
}

// subtasks → 括号备注文本；与 parseSubtaskNote / normalizeImportedTodoTask 的默认值约定互逆：
// completed/unsubmitted 默认全 done、其余默认全 pending，与默认一致时不写括号
function todoNoteFromSubtasks(subtasks, quantity, status) {
  const list = normalizeSubtasks(subtasks, quantity);
  const done = list.filter((item) => item.status === "done").map((item) => item.index);
  const unconfirmed = list.filter((item) => item.status === "unconfirmed").map((item) => item.index);
  const defaultAllDone = ["completed", "unsubmitted"].includes(status);
  if (defaultAllDone && done.length === list.length && !unconfirmed.length) return "";
  if (!defaultAllDone && !done.length && !unconfirmed.length) return "";
  const segments = [];
  if (done.length) segments.push(`已完成任务${done.join("/")}`);
  if (unconfirmed.length) segments.push(`任务${unconfirmed.join("/")}待确认`);
  return segments.join("，");
}

// 行尾字段序列化：数量 状态（括号备注） 负责人 星期（行首之外的全部可写字段）
function serializeTodoTail(task) {
  const quantity = Math.max(1, Number(task.quantity) || 1);
  const status = normalizeWriteBackStatus(task.status);
  const subtaskNote = todoNoteFromSubtasks(task.subtasks, quantity, status);
  // 子任务标记与纯文本备注互斥（解析器只能二选一），有标记时标记优先
  const noteText = subtaskNote || String(task.note || "").trim();
  const parts = [`${quantity}个`, `${TODO_STATUS_TEXT[status]}${noteText ? `（${noteText}）` : ""}`];
  const owner = String(task.owner || "").trim();
  if (owner) parts.push(owner);
  if (TODO_WEEKDAYS.includes(task.weekday)) parts.push(task.weekday);
  return parts.join(" ");
}

// 工作台任务 → 完整 txt 行（「仅工作台」任务追加时使用，按 §0 样例格式生成）
function serializeTodoLine(task) {
  const typeKeyword = TODO_TYPE_MAP.find(([, value]) => value === task.taskType)?.[0] || "";
  const head = `${String(task.school || "").trim()}《${String(task.course || "").trim()}》${typeKeyword}`;
  return `${head} ${serializeTodoTail(task)}`;
}

// 单行合并：行首「学校《课程》任务类型」从原行原样保留；语义无变化时原行一字不动
function mergeTodoLine(rawLine, task, parsedTask) {
  const incoming = normalizeImportedTodoTask(parsedTask);
  if (serializeTodoTail(incoming) === serializeTodoTail(task)) return rawLine;
  const headMatch = rawLine.match(/^(\s*.+?《[^》]+》)/);
  if (!headMatch) return serializeTodoLine(task);
  let head = headMatch[1];
  const typeKeyword = TODO_TYPE_MAP.find(([, value]) => value === task.taskType)?.[0] || "";
  if (typeKeyword) {
    const afterHead = rawLine.slice(head.length);
    const leadingSpaces = afterHead.match(/^\s*/)[0];
    if (afterHead.slice(leadingSpaces.length).startsWith(typeKeyword)) {
      head = rawLine.slice(0, head.length + leadingSpaces.length + typeKeyword.length);
    } else {
      head += typeKeyword;
    }
  }
  return `${head} ${serializeTodoTail(task)}`;
}

// 写回合并主函数：匹配键 = 学校+课程+任务类型 三元组；
// 只改写匹配且语义有变化的行，未匹配/无法解析行一字不动；
// appendTasks（用户勾选的「仅工作台」任务）按样例格式追加到文件末尾；
// 输出保留原文件 BOM 与换行符风格（CRLF/LF）
function mergeTodoFile(text, tasks, appendTasks = []) {
  const source = String(text || "");
  const hasBom = source.charCodeAt(0) === 0xfeff;
  const body = hasBom ? source.slice(1) : source;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const taskByKey = new Map((tasks || []).map((task) => [todoImportKey(task), task]));
  const matchedKeys = new Set();
  const entries = body.split(/\r?\n/).map((rawLine) => {
    const parsedTask = parseTodoLines(rawLine).tasks[0];
    const key = parsedTask ? todoImportKey(parsedTask) : "";
    const workbenchTask = parsedTask && !matchedKeys.has(key) ? taskByKey.get(key) : null;
    if (!workbenchTask) {
      return { oldLine: rawLine, newLine: rawLine, matched: false, changed: false };
    }
    matchedKeys.add(key);
    const newLine = mergeTodoLine(rawLine, workbenchTask, parsedTask);
    return { oldLine: rawLine, newLine, matched: true, changed: newLine !== rawLine, task: workbenchTask };
  });
  const onlyInWorkbench = (tasks || []).filter((task) => !matchedKeys.has(todoImportKey(task)));
  const appendLines = (appendTasks || []).map((task) => serializeTodoLine(task));
  let lines = entries.map((entry) => entry.newLine);
  if (appendLines.length) {
    // 保留文件结尾空行：追加内容插在末尾连续空行之前
    let insertAt = lines.length;
    while (insertAt > 0 && lines[insertAt - 1] === "") insertAt -= 1;
    lines = [...lines.slice(0, insertAt), ...appendLines, ...lines.slice(insertAt)];
  }
  const finalText = (hasBom ? "\uFEFF" : "") + lines.join(eol);
  return { entries, onlyInWorkbench, appendLines, text: finalText, eol, hasBom };
}

window.serializeTodoLine = serializeTodoLine;
window.mergeTodoFile = mergeTodoFile;

// ============ cards.md 卡片包解析（纯函数，无副作用，自包含，供测试注入） ============

// 卡片五项字段标签（顺序即卡片舱展示顺序）
const CARD_FIELD_DEFS = [
  ["name", ["卡片名称"]],
  ["rounds", ["建议轮次"]],
  ["stageDescription", ["阶段描述"]],
  ["opening", ["开场白"]],
  ["prompt", ["提示词"]]
];
// 总任务级字段标签（长名在前，避免「任务描述」抢先命中「总任务描述」）
const CARD_META_DEFS = [
  ["taskName", ["总任务名称", "任务名称"]],
  ["taskDescription", ["总任务描述", "任务描述"]],
  ["coverDescription", ["封面图文字描述", "封面图描述", "封面图"]]
];

// 去掉行首 markdown 装饰（标题井号/引用/列表符/序号/粗体），返回纯文本
function stripCardDecorations(line) {
  return String(line || "")
    .trim()
    .replace(/^[#>]+\s*/, "")
    .replace(/^[-*•]\s+/, "")
    .replace(/^\d+[.、)]\s*/, "")
    .replace(/^\*\*/, "")
    .replace(/\*\*$/, "")
    .trim();
}

// 标签行匹配：标签后必须紧跟 ：/:（允许粗体闭合符），返回标签后的内联内容；不匹配返回 null
function matchCardLabel(line, labels) {
  const cleaned = stripCardDecorations(line);
  for (const label of labels) {
    if (!cleaned.startsWith(label)) continue;
    const rest = cleaned.slice(label.length).replace(/^\*\*/, "").trimStart();
    if (rest === "") return "";
    if (/^[：:]/.test(rest)) return rest.replace(/^[：:]\s*/, "").trim();
  }
  return null;
}

// 卡片标题锚点：`## 卡片一：xxx` / `卡片1 · xxx` 这类标题行，返回卡片名（可为空串）；不匹配返回 null
function matchCardHeading(line) {
  const cleaned = stripCardDecorations(line);
  const match = cleaned.match(/^卡片\s*[一二三四五六七八九十0-9]{1,3}\s*(?:[：:·.\-—]\s*(.*))?$/);
  if (!match) return null;
  return (match[1] || "").replace(/\*\*$/, "").trim();
}

// 整段截取区锚点：评价标准 / 测试人格
function matchSectionAnchor(line) {
  const cleaned = stripCardDecorations(line).replace(/[：:]\s*$/, "");
  if (/^评价标准$/.test(cleaned)) return "evaluation";
  if (/^测试人格$/.test(cleaned)) return "testPersona";
  return null;
}

// Hermes 产出 cards.md → 结构化卡片包：
// { taskMeta: { taskName?, taskDescription?, coverDescription? },
//   cards: [{ name, rounds, stageDescription, opening, prompt }],
//   evaluation, testPersona, unparsed: [] }
// 规则：卡片名称标签或「## 卡片N」标题开新卡；字段内容延续到下一标签/锚点；
// 提示词优先取 ``` 代码块内原文（不含围栏）；评价标准/测试人格整段截取不拆分；
// 围栏内不识别任何锚点；无法归类的内容进 unparsed，不阻塞已解析部分。
function parseCardsDocument(text) {
  const result = { taskMeta: {}, cards: [], evaluation: "", testPersona: "", unparsed: [] };
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");

  let currentCard = null;
  let field = null;            // { type: "card"|"meta"|"section", key } 当前累积目标
  let fieldLines = [];
  let promptFenced = false;    // 提示词是否处于 ``` 围栏捕获中
  let inFence = false;         // 全局围栏状态（围栏内不识别锚点）
  let unparsedBuffer = [];

  const flushUnparsed = () => {
    const block = unparsedBuffer.join("\n").trim();
    if (block) result.unparsed.push(block);
    unparsedBuffer = [];
  };
  const flushField = () => {
    if (!field) return;
    const content = fieldLines.join("\n").replace(/^\n+|\n+$/g, "").trimEnd();
    if (field.type === "card" && currentCard) {
      if (content || !currentCard[field.key]) currentCard[field.key] = content || currentCard[field.key] || "";
    } else if (field.type === "meta") {
      if (content) result.taskMeta[field.key] = content;
    } else if (field.type === "section") {
      if (content) result[field.key] = content;
    }
    field = null;
    fieldLines = [];
    promptFenced = false;
  };
  const startCard = (name) => {
    flushField();
    flushUnparsed();
    currentCard = { name: name || "", rounds: "", stageDescription: "", opening: "", prompt: "" };
    result.cards.push(currentCard);
  };

  for (const rawLine of lines) {
    const fenceLine = /^\s*```/.test(rawLine);

    // —— 围栏处理 ——
    if (fenceLine) {
      if (field?.type === "card" && field.key === "prompt" && !fieldLines.some((item) => item.trim())) {
        // 提示词字段的第一个围栏：进入纯净捕获模式，围栏本身不进内容
        promptFenced = true;
        inFence = true;
        fieldLines = [];
        continue;
      }
      if (promptFenced) {
        // 提示词围栏闭合：字段完成，围栏不进内容
        inFence = false;
        flushField();
        continue;
      }
      inFence = !inFence;
      if (field) fieldLines.push(rawLine);
      else unparsedBuffer.push(rawLine);
      continue;
    }
    if (inFence) {
      // 围栏内内容原样累积，不做任何锚点识别
      if (field) fieldLines.push(rawLine);
      else unparsedBuffer.push(rawLine);
      continue;
    }

    // —— 锚点识别（围栏外） ——
    const sectionKey = matchSectionAnchor(rawLine);
    if (sectionKey) {
      flushField();
      flushUnparsed();
      field = { type: "section", key: sectionKey };
      fieldLines = [];
      continue;
    }

    const headingName = matchCardHeading(rawLine);
    if (headingName !== null) {
      startCard(headingName);
      continue;
    }

    let matchedLabel = false;
    for (const [key, labels] of CARD_FIELD_DEFS) {
      const inline = matchCardLabel(rawLine, labels);
      if (inline === null) continue;
      matchedLabel = true;
      if (key === "name") {
        // 卡片名称标签 = 开新卡锚点；但若当前卡刚由标题锚点开出且尚无任何字段内容，
        // 视为同一张卡的名称补充（`## 卡片一：xxx` + `卡片名称：xxx` 连用是常见格式）
        const cardIsBlank = currentCard && !currentCard.rounds && !currentCard.stageDescription
          && !currentCard.opening && !currentCard.prompt && !field;
        if (cardIsBlank) {
          currentCard.name = inline || currentCard.name;
        } else {
          startCard(inline);
        }
      } else if (currentCard) {
        flushField();
        field = { type: "card", key };
        fieldLines = inline ? [inline] : [];
      } else {
        matchedLabel = false;
      }
      break;
    }
    if (matchedLabel) continue;

    if (!currentCard && field?.type !== "section") {
      let matchedMeta = false;
      for (const [key, labels] of CARD_META_DEFS) {
        const inline = matchCardLabel(rawLine, labels);
        if (inline === null) continue;
        flushField();
        flushUnparsed();
        field = { type: "meta", key };
        fieldLines = inline ? [inline] : [];
        matchedMeta = true;
        break;
      }
      if (matchedMeta) continue;
    }

    // —— 普通内容行 ——
    if (field) {
      fieldLines.push(rawLine);
    } else if (rawLine.trim() && !/^-{3,}$/.test(rawLine.trim())) {
      unparsedBuffer.push(rawLine);
    } else if (!rawLine.trim() && unparsedBuffer.length) {
      unparsedBuffer.push(rawLine);
    }
  }
  flushField();
  flushUnparsed();

  return result;
}

window.parseCardsDocument = parseCardsDocument;

// 子任务标记 + 数量 → subtasks 数组（index 从 1 起，未标记默认 pending）
function subtasksFromMarks(quantity, marks) {
  const list = [];
  for (let index = 1; index <= Math.max(1, Number(quantity) || 1); index += 1) {
    list.push({ index, status: marks?.[index] || "pending" });
  }
  return list;
}

function todoImportKey(task) {
  return [task.school, task.course, task.taskType].map((part) => String(part || "").trim()).join("\u0001");
}

function normalizeImportedTodoTask(task) {
  const quantity = Math.max(1, Number(task.quantity) || 1);
  const defaultMarks = task.subtaskMarks || (["completed", "unsubmitted"].includes(task.status)
    ? Object.fromEntries(Array.from({ length: quantity }, (_item, index) => [index + 1, "done"]))
    : {});
  return {
    school: task.school || "",
    course: task.course || "",
    taskType: typeof task.taskType === "string" ? task.taskType : "",
    quantity,
    status: task.status || "pending",
    owner: task.owner || "",
    weekday: TODO_WEEKDAYS.includes(task.weekday) ? task.weekday : "",
    note: task.note || "",
    subtasks: subtasksFromMarks(quantity, defaultMarks)
  };
}

function subtaskSummary(subtasks) {
  const list = normalizeSubtasks(subtasks, subtasks?.length || 1);
  const done = list.filter((item) => item.status === "done").map((item) => item.index);
  const unconfirmed = list.filter((item) => item.status === "unconfirmed").map((item) => item.index);
  const parts = [`${done.length}/${list.length} 已完成`];
  if (done.length) parts.push(`完成 ${done.join("/")}`);
  if (unconfirmed.length) parts.push(`待确认 ${unconfirmed.join("/")}`);
  return parts.join("，");
}

function importFieldDisplayValue(field, value) {
  if (field === "status") return taskStatusLabel(value);
  if (field === "subtasks") return subtaskSummary(value);
  if (field === "weekday") return value || "未设置";
  if (field === "note") return value || "无";
  return String(value ?? "");
}

function importFieldComparableValue(field, value) {
  if (field === "subtasks") return JSON.stringify(normalizeSubtasks(value, value?.length || 1));
  return JSON.stringify(value ?? "");
}

function todoImportDiffs(existing, incoming) {
  return TODO_IMPORT_FIELDS
    .filter((field) => importFieldComparableValue(field, existing[field]) !== importFieldComparableValue(field, incoming[field]))
    .map((field) => ({
      field,
      label: TODO_IMPORT_FIELD_LABELS[field],
      from: importFieldDisplayValue(field, existing[field]),
      to: importFieldDisplayValue(field, incoming[field])
    }));
}

function buildTodoImportPreview(parsedTasks, unparsed) {
  const existingByKey = new Map(weeklyTasks.map((task) => [todoImportKey(task), task]));
  const groups = { added: [], updated: [], unchanged: [], unparsed: unparsed || [] };
  parsedTasks.map(normalizeImportedTodoTask).forEach((incoming) => {
    const existing = existingByKey.get(todoImportKey(incoming));
    if (!existing) {
      groups.added.push({ task: incoming, selected: true });
      return;
    }
    const diffs = todoImportDiffs(normalizeWeeklyTask(existing), incoming);
    if (diffs.length) groups.updated.push({ task: incoming, existingId: existing.id, diffs, selected: true });
    else groups.unchanged.push({ task: incoming, existingId: existing.id, selected: false });
  });
  return groups;
}

function setTodoPathDisplay(pathValue) {
  if (elements.prefTodoPath) elements.prefTodoPath.textContent = pathValue || "未设置";
}

function importPreviewTaskTitle(task) {
  const typeLabel = task.taskType ? taskTypeLabel(task.taskType) : "未匹配类型";
  return `${task.school}《${task.course}》 ${typeLabel}`;
}

// 任务舱状态接线总入口：横幅已删除，统一驱动 任务舱 + 状态栏芯片 + 侧边栏脉冲点 + 任务中心
function updateTaskRail(task = null) {
  let activeUpdate;
  if (!task) {
    activeUpdate = window.workbench.updateActiveTaskInfo({});
  } else {
    activeUpdate = window.workbench.updateActiveTaskInfo({
      school: task.school || "",
      course: task.course || "",
      taskType: task.taskType || "",
      taskTypeLabel: taskTypeLabel(task.taskType),
      taskId: task.id || "",
      step: pipelineState.step || task.step || "testing",
      folderPath: pipelineState.taskFolder || task.taskFolder || ""
    });
  }
  activeUpdate = Promise.resolve(activeUpdate).catch((error) => {
    console.warn("同步活动任务状态失败:", error);
    return { success: false };
  });
  renderTaskRail(task);
  updateStatusbarChip(task);
  updateSidebarPulse();
  renderTaskCenter();
  return activeUpdate;
}

const RAIL_RING_CIRCUMFERENCE = 50.27;

function railStepsHtml(currentStep) {
  const currentIndex = pipelineStepIndex(currentStep);
  return PIPELINE_STEPS.map((step, index) => {
    const state = index < currentIndex ? "done" : (index === currentIndex ? "now" : "");
    const dot = index < currentIndex ? svgIcon("check", 11) : String(index + 1);
    const desc = step.desc.replace(/(dialogue\.json|eval_report\.pdf)/g, "<code>$1</code>");
    return `
      <div class="rail-step ${state}">
        <div class="rs-dot">${dot}</div>
        <div>
          <div class="rs-name">${escapeHtml(step.name)}</div>
          <div class="rs-desc">${desc}</div>
        </div>
      </div>`;
  }).join("");
}

function isImageFile(name) {
  return /\.(png|jpe?g|webp)$/i.test(name);
}

function isTaskDocFile(name) {
  return /\.(docx?|pdf|md|txt)$/i.test(name) && !/^dialogue\.json$/i.test(name) && !/^eval_report/i.test(name);
}

function fileKindSvg(name) {
  const bodies = {
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
    json: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M10 13a1.5 1.5 0 0 0 0 3"/><path d="M14 13a1.5 1.5 0 0 1 0 3"/>',
    pdf: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/>',
    word: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13l1.5 5L12 13l2.5 5L16 13"/>',
    other: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'
  };
  const kind = isImageFile(name) ? "image"
    : /\.json$/i.test(name) ? "json"
    : /\.pdf$/i.test(name) ? "pdf"
    : /\.docx?$/i.test(name) ? "word"
    : "other";
  return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${bodies[kind]}</svg>`;
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatFileTime(mtime) {
  const date = new Date(mtime);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function railActionButton({ title, svg, onClick, danger = false }) {
  const button = document.createElement("button");
  button.className = `ra-act${danger ? " danger" : ""}`;
  button.type = "button";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = svg;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

async function runTaskFileAction(action, file) {
  if (action === "copy") {
    try {
      await navigator.clipboard.writeText(file.path);
      showToast("绝对路径已复制", "success");
    } catch {
      showToast("复制路径失败", "error");
    }
    return;
  }
  if (action === "crop") {
    const result = await window.workbench.cropImage(file.path);
    if (result?.ok) {
      const outName = String(result.path || "").split(/[\\/]/).pop() || file.name;
      const converted = /\.webp$/i.test(file.name) && /\.png$/i.test(outName);
      showToast(converted ? `裁切完成并覆盖为 ${outName}` : `裁切完成并已覆盖 ${outName}`, "success");
    } else {
      showToast(`裁切失败：${result?.error || "未知错误"}`, "error");
    }
    refreshRailTray();
    return;
  }
  if (action === "rename") {
    const nextName = window.prompt("重命名为：", file.name);
    if (nextName === null) return;
    const trimmed = String(nextName).trim();
    if (!trimmed) {
      showToast("文件名不能为空", "error");
      return;
    }
    if (trimmed === file.name) return;
    if (/[\\/:*?"<>|]/.test(trimmed) || trimmed === "." || trimmed === "..") {
      showToast("文件名含非法字符", "error");
      return;
    }
    const result = await window.workbench.taskFileAction("rename", file.path, { newName: trimmed });
    if (result?.ok) {
      showToast(`已重命名为 ${result.name || trimmed}`, "success");
      refreshRailTray();
    } else {
      showToast(`重命名失败：${result?.error || "未知错误"}`, "error");
    }
    return;
  }
  if (action === "delete" && !window.confirm(`确认删除 ${file.name}？此操作不可恢复。`)) return;
  const result = await window.workbench.taskFileAction(action, file.path);
  const ok = result === true || result?.ok === true;
  if (!ok) {
    showToast(result?.error ? `文件操作失败：${result.error}` : "文件操作失败（文件可能已不存在）", "error");
  } else if (action === "delete") {
    showToast(`已删除 ${file.name}`, "success");
  }
  if (action === "delete") refreshRailTray();
}

// 托盘文件行：图标 + 名称 + 大小/时间 + 悬停操作区
function railFileRow(file, { badge = "", waiting = false } = {}) {
  const row = document.createElement("div");
  row.className = `rail-artifact ${waiting ? "waiting" : "ready"}`;
  row.innerHTML = `
    <span class="ra-ico">${fileKindSvg(file.name)}</span>
    <span class="ra-info">
      <span class="ra-name">${escapeHtml(file.name)}</span>
      <span class="ra-sub">${escapeHtml(file.sub)}</span>
    </span>
  `;
  if (badge) {
    const badgeEl = document.createElement("span");
    badgeEl.className = "ra-badge";
    badgeEl.textContent = badge;
    row.append(badgeEl);
  }
  if (!waiting) {
    const actions = document.createElement("span");
    actions.className = "ra-actions";
    actions.append(
      railActionButton({
        title: "打开",
        svg: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
        onClick: () => runTaskFileAction("open", file)
      }),
      railActionButton({
        title: "在资源管理器中定位",
        svg: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
        onClick: () => runTaskFileAction("reveal", file)
      }),
      railActionButton({
        title: "复制绝对路径",
        svg: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
        onClick: () => runTaskFileAction("copy", file)
      }),
      railActionButton({
        title: "重命名",
        svg: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>',
        onClick: () => runTaskFileAction("rename", file)
      })
    );
    if (isImageFile(file.name)) {
      actions.append(railActionButton({
        title: "裁切去水印",
        svg: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>',
        onClick: () => runTaskFileAction("crop", file)
      }));
    }
    actions.append(
      railActionButton({
        title: "删除",
        svg: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
        onClick: () => runTaskFileAction("delete", file),
        danger: true
      })
    );
    row.append(actions);
  }
  return row;
}

let railTrayToken = 0;

// 任务文件托盘：关键产物置顶（含就绪/等待徽章），其余文件按修改时间倒序
async function renderRailTray(task) {
  const folder = pipelineState.taskFolder || task.taskFolder || "";
  const token = ++railTrayToken;
  let files = [];
  if (folder) {
    try {
      files = (await window.workbench.listTaskFiles(folder)) || [];
    } catch (error) {
      console.warn("读取任务文件托盘失败:", error);
    }
  }
  if (token !== railTrayToken || !elements.railArtifacts) return;

  const docFile = files.find((file) => isTaskDocFile(file.name));
  const chatFile = files.find((file) => /^dialogue\.json$/i.test(file.name));
  const reportFile = files.find((file) => /^eval_report/i.test(file.name));
  const keyPaths = new Set([docFile, chatFile, reportFile].filter(Boolean).map((file) => file.path));

  elements.railArtifacts.replaceChildren();
  const pinned = [
    { file: docFile, placeholder: "任务文档", waitSub: folder ? "任务文件夹内未检测到文档" : "任务文件夹未创建" },
    { file: chatFile, placeholder: "dialogue.json", waitSub: "本地测试下载后归档" },
    { file: reportFile, placeholder: "eval_report.pdf", waitSub: "评估平台报告自动拦截" }
  ];
  for (const item of pinned) {
    if (item.file) {
      elements.railArtifacts.append(railFileRow(
        { ...item.file, sub: `${formatFileSize(item.file.size)} · ${formatFileTime(item.file.mtime)}` },
        { badge: "就绪" }
      ));
    } else {
      elements.railArtifacts.append(railFileRow(
        { name: item.placeholder, sub: item.waitSub },
        { badge: "等待", waiting: true }
      ));
    }
  }

  const rest = files
    .filter((file) => !keyPaths.has(file.path))
    .sort((a, b) => b.mtime - a.mtime);
  for (const file of rest) {
    elements.railArtifacts.append(railFileRow(
      { ...file, sub: `${formatFileSize(file.size)} · ${formatFileTime(file.mtime)}` }
    ));
  }

  // 卡片舱：托盘识别到 cards.md 自动解析（mtime 未变不重渲）
  const cardsFile = files.find((file) => /^cards\.md$/i.test(file.name));
  syncRailCards(task, cardsFile || null);
}

// 托盘单独刷新（fs.watch 推送 / 文件操作后调用，不重渲整个任务舱）
function refreshRailTray() {
  if (!pipelineState.active) return;
  const task = weeklyTasks.find((candidate) => candidate.id === pipelineState.taskId);
  if (task) renderRailTray(task);
}

// ===== 卡片舱（V3.4 P0）：cards.md → 逐字段一键复制 =====
const CARD_FIELD_LABEL_TEXT = {
  name: "卡片名称",
  rounds: "建议轮次",
  stageDescription: "阶段描述",
  opening: "开场白",
  prompt: "提示词"
};
let railCardsState = { taskId: null, parsed: null, mtime: 0, missing: true, error: "" };
let railCardsStreamOn = false;

// cards.md 同步：mtime 未变不重渲（保留折叠/高亮状态）；force = 手动「重新解析」
async function syncRailCards(task, cardsFile, force = false) {
  if (!elements.railCards) return;
  if (!cardsFile) {
    if (railCardsState.taskId === task.id && railCardsState.missing && !force) return;
    railCardsState = { taskId: task.id, parsed: null, mtime: 0, missing: true, error: "" };
    renderRailCards(task);
    return;
  }
  if (!force && railCardsState.taskId === task.id && railCardsState.parsed && railCardsState.mtime === cardsFile.mtime) return;
  let result = null;
  try {
    result = await window.workbench.readTaskTextFile(cardsFile.path);
  } catch (error) {
    console.error("读取 cards.md 失败:", error);
  }
  if (!result?.ok) {
    railCardsState = { taskId: task.id, parsed: null, mtime: 0, missing: false, error: result?.error || "读取失败" };
  } else {
    railCardsState = { taskId: task.id, parsed: parseCardsDocument(result.text), mtime: cardsFile.mtime, missing: false, error: "" };
  }
  renderRailCards(task);
}

function cardFieldCopied(task, key) {
  return Boolean(task?.cardCopied?.[key]);
}

async function copyCardField(task, key, text, row, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    console.error("复制字段失败:", error);
    showToast("复制失败，请重试", "error");
    return;
  }
  const original = button.textContent;
  button.textContent = "✓";
  button.classList.add("ok");
  setTimeout(() => {
    button.textContent = original;
    button.classList.remove("ok");
  }, 2000);
  row.classList.add("copied");
  // 已复制状态持久化到任务数据（重启不丢，任务结束时清空）
  const copied = { ...(task.cardCopied || {}), [key]: true };
  await updateTaskFields(task.id, { cardCopied: copied });
  updateCardStreamHighlight(true);
}

// 流式模式：高亮第一个未复制字段；复制后推进；全部完成提示
function updateCardStreamHighlight(announceDone = false) {
  if (!elements.railCards) return;
  const rows = [...elements.railCards.querySelectorAll(".rc-row")];
  rows.forEach((row) => row.classList.remove("stream-now"));
  if (!railCardsStreamOn || !rows.length) return;
  const next = rows.find((row) => !row.classList.contains("copied"));
  if (!next) {
    if (announceDone) showToast("全部字段已复制完成，可以去平台逐项粘贴收尾了", "success");
    return;
  }
  const wrap = next.closest("details");
  if (wrap) wrap.open = true;
  next.classList.add("stream-now");
  next.scrollIntoView({ block: "center", behavior: "smooth" });
}

// 单个字段行：字段名 + 单行预览 + （开场白字符徽章） + 复制按钮
function railCardFieldRow(task, key, label, text) {
  const row = document.createElement("div");
  row.className = `rc-row${cardFieldCopied(task, key) ? " copied" : ""}`;
  row.dataset.key = key;

  const labelEl = document.createElement("span");
  labelEl.className = "rc-label";
  labelEl.textContent = label;

  const preview = document.createElement("span");
  preview.className = "rc-preview";
  preview.textContent = text ? text.replace(/\s+/g, " ").trim() : "（空）";
  preview.title = text ? "完整内容以复制为准（预览单行截断）" : "该字段未解析到内容";

  row.append(labelEl, preview);

  if (label === CARD_FIELD_LABEL_TEXT.opening && text) {
    const badge = document.createElement("span");
    badge.className = `rc-badge${text.length > 200 ? " over" : ""}`;
    badge.textContent = `${text.length} 字`;
    badge.title = text.length > 200 ? "超过平台 200 字符限制" : "平台限制 200 字符";
    row.append(badge);
  }

  const copyBtn = document.createElement("button");
  copyBtn.className = "rc-copy";
  copyBtn.type = "button";
  copyBtn.textContent = "复制";
  copyBtn.disabled = !text;
  copyBtn.addEventListener("click", () => copyCardField(task, key, text, row, copyBtn));
  row.append(copyBtn);
  return row;
}

function renderRailCards(task) {
  if (!elements.railCards) return;
  elements.railCards.replaceChildren();

  if (railCardsState.error) {
    const errorEl = document.createElement("div");
    errorEl.className = "rc-guide error";
    errorEl.textContent = `cards.md 读取失败：${railCardsState.error}`;
    elements.railCards.append(errorEl);
    return;
  }
  if (railCardsState.missing || !railCardsState.parsed) {
    const guide = document.createElement("div");
    guide.className = "rc-guide";
    guide.textContent = "将 Hermes 产出保存为 cards.md 到任务文件夹，卡片舱将自动解析为逐字段复制清单。";
    elements.railCards.append(guide);
    return;
  }

  const parsed = railCardsState.parsed;

  // 总任务级字段（任务描述/封面图描述/评价标准/测试人格）置顶
  const metaRows = [
    ["meta:taskName", "任务名称", parsed.taskMeta.taskName],
    ["meta:taskDescription", "任务描述", parsed.taskMeta.taskDescription],
    ["meta:coverDescription", "封面图描述", parsed.taskMeta.coverDescription],
    ["meta:evaluation", "评价标准", parsed.evaluation],
    ["meta:testPersona", "测试人格", parsed.testPersona]
  ].filter(([, , text]) => text);
  if (metaRows.length) {
    const metaWrap = document.createElement("div");
    metaWrap.className = "rc-meta";
    for (const [key, label, text] of metaRows) {
      metaWrap.append(railCardFieldRow(task, key, label, text));
    }
    elements.railCards.append(metaWrap);
  }

  parsed.cards.forEach((card, index) => {
    const wrap = document.createElement("details");
    wrap.className = "rc-card";
    if (index === 0) wrap.open = true;
    const summary = document.createElement("summary");
    summary.textContent = `卡片${index + 1} · ${card.name || "未命名"}`;
    const fields = document.createElement("div");
    fields.className = "rc-fields";
    for (const fieldKey of Object.keys(CARD_FIELD_LABEL_TEXT)) {
      fields.append(railCardFieldRow(task, `card:${index}:${fieldKey}`, CARD_FIELD_LABEL_TEXT[fieldKey], card[fieldKey]));
    }
    wrap.append(summary, fields);
    elements.railCards.append(wrap);
  });

  if (!parsed.cards.length && !metaRows.length) {
    const empty = document.createElement("div");
    empty.className = "rc-guide";
    empty.textContent = "cards.md 中未识别到卡片字段，请检查格式（卡片名称/建议轮次/阶段描述/开场白/提示词）。";
    elements.railCards.append(empty);
  }

  if (parsed.unparsed.length) {
    const unparsedWrap = document.createElement("details");
    unparsedWrap.className = "rc-unparsed";
    const summary = document.createElement("summary");
    summary.textContent = `未识别内容 ${parsed.unparsed.length} 段（不阻塞已解析卡片）`;
    unparsedWrap.append(summary);
    for (const block of parsed.unparsed) {
      const pre = document.createElement("pre");
      pre.textContent = block;
      unparsedWrap.append(pre);
    }
    elements.railCards.append(unparsedWrap);
  }

  updateCardStreamHighlight();
}

// 任务舱渲染：展开态主体 + 收起态把手；无活动任务时整体隐藏
function renderTaskRail(task = null) {
  const active = Boolean(task && pipelineState.active);
  elements.appShell.classList.toggle("rail-open", active && !taskRailCollapsed);
  elements.appShell.classList.toggle("rail-collapsed", active && taskRailCollapsed);
  if (!active) return;

  const index = pipelineStepIndex(pipelineState.step);
  const stepNumber = index + 1;
  const stepName = PIPELINE_STEPS[index]?.name || "";

  elements.railTitle.textContent = `${task.school || ""} · ${task.course || ""}`;
  elements.railStepBadge.textContent = `步骤 ${stepNumber}/${PIPELINE_STEPS.length} · ${stepName}`;
  elements.railOwner.textContent = `负责人 ${task.owner || "未指定"}`;
  elements.railSteps.innerHTML = railStepsHtml(pipelineState.step);
  renderRailTray(task);

  const reportReady = Boolean(pipelineState.reportPath || task.reportPath);
  elements.railHermes.disabled = !reportReady;
  elements.railHermes.title = reportReady ? "将产物路径载入 Hermes 输入框" : "捕获报告后激活";

  elements.railRingBar.style.strokeDashoffset =
    String(RAIL_RING_CIRCUMFERENCE * (1 - stepNumber / PIPELINE_STEPS.length));
  elements.railHandleText.textContent = `任务 ${stepNumber}/${PIPELINE_STEPS.length}`;
}

function expandTaskRail() {
  if (!pipelineState.active) return;
  if (window.innerWidth <= 1050 && elements.appShell.classList.contains("right-sidebar-open")) {
    toggleRightSidebar(false);
  }
  taskRailCollapsed = false;
  renderTaskRail(weeklyTasks.find((candidate) => candidate.id === pipelineState.taskId) || null);
}

function collapseTaskRail() {
  taskRailCollapsed = true;
  renderTaskRail(weeklyTasks.find((candidate) => candidate.id === pipelineState.taskId) || null);
}

// 学校名缩写：去掉常见后缀，保留前 6 个字符
function schoolShortName(school = "") {
  const trimmed = school.replace(/(职业技术学院|职业学院|大学|学院)$/, "") || school;
  return trimmed.slice(0, 6);
}

function updateStatusbarChip(task = null) {
  const active = Boolean(task && pipelineState.active);
  elements.sbTaskChip.hidden = !active;
  if (!active) {
    elements.sbTaskChipText.textContent = "";
    return;
  }
  const index = pipelineStepIndex(pipelineState.step);
  const stepName = PIPELINE_STEPS[index]?.name || "";
  elements.sbTaskChipText.textContent =
    `${schoolShortName(task.school)} · ${task.course || ""} — ${stepName} ${index + 1}/${PIPELINE_STEPS.length}`;
}

// 结束询问改为居中 dialog 三出口：已提交（completed）/ 未提交（unsubmitted）/ 取消（任务继续运行）
function finishActiveTask() {
  if (!pipelineState.active || !pipelineState.taskId) return;
  const task = weeklyTasks.find((candidate) => candidate.id === pipelineState.taskId);
  const activeIndex = pipelineState.activeSubtaskIndex;
  if (task && activeIndex) {
    const label = `子任务 ${activeIndex}/${Math.max(1, Number(task.quantity) || 1)}`;
    const description = elements.finishTaskDialog?.querySelector(".helper-text");
    if (description) description.textContent = `${label} 已完成测试，是否已提交平台？仅结束当前子任务，其他子任务保持原状态。`;
  }
  elements.finishTaskDialog?.showModal();
}

async function completeActiveTask(submitted) {
  const taskId = pipelineState.taskId;
  const task = weeklyTasks.find((candidate) => candidate.id === taskId);
  if (!task) return;
  const folderPath = pipelineState.taskFolder || task.taskFolder || "";
  const activeSubtaskIndex = pipelineState.activeSubtaskIndex || nextRunnableSubtaskIndex(task);
  const subtasks = taskSubtasks(task);
  if (!activeSubtaskIndex || !subtasks.some((subtask) => subtask.index === activeSubtaskIndex)) return;
  taskTransitionGeneration += 1;
  const previousTask = JSON.parse(JSON.stringify(task));
  const nextSubtasks = updateSubtaskStatus(task, activeSubtaskIndex, submitted ? "done" : "unconfirmed");
  const allSubtasksDone = nextSubtasks.every((subtask) => subtask.status === "done");
  // 单个任务沿用原有“未提交”终态；多个子任务只有全部完成才清理总任务。
  const terminal = allSubtasksDone || (!submitted && nextSubtasks.length === 1);
  Object.assign(task, {
    status: allSubtasksDone ? "completed" : (terminal ? "unsubmitted" : "paused"),
    cleanupPending: Boolean(folderPath && terminal),
    cardCopied: terminal ? {} : task.cardCopied,
    subtasks: nextSubtasks
  });
  if (!folderPath && terminal) {
    task.chatLogPath = "";
    task.reportPath = "";
    task.taskFolder = "";
  }
  try {
    await persistWeeklyTasks();
  } catch (error) {
    Object.assign(task, previousTask);
    console.error("保存任务结束状态失败:", error);
    showToast("无法保存任务结束状态，临时文件未清理", "error");
    return;
  }
  pipelineState = { active: false, taskId: null, activeSubtaskIndex: null, step: "idle", chatPath: "", reportPath: "", taskFolder: "", uploadQueue: [] };
  await updateTaskRail(null);

  if (!terminal) {
    showToast(`子任务 ${activeSubtaskIndex} 已${submitted ? "完成" : "标记为待确认"}，其他子任务仍可单独执行`, "success");
    return;
  }

  const cleaned = !folderPath || await window.workbench.cleanupTaskFolder(folderPath).catch(() => false);
  if (!cleaned) {
    showToast("任务已结束；临时文件清理失败，应用下次启动会重试", "error");
    return;
  }
  const savedTask = weeklyTasks.find((candidate) => candidate.id === taskId);
  if (savedTask) {
    Object.assign(savedTask, {
      cleanupPending: false,
      chatLogPath: "",
      reportPath: "",
      taskFolder: ""
    });
    try {
      await persistWeeklyTasks();
    } catch (error) {
      console.error("确认临时文件清理状态失败:", error);
      showToast("临时文件已清理；状态将在下次启动时自动核对", "error");
      return;
    }
  }
  showToast(submitted ? "任务已完成，临时文件已清理" : "任务已标记为未提交，临时文件已清理", "success");
}

function taskStatusLabel(status) {
  return {
    pending: "待处理",
    running: "进行中",
    evaluating: "评估中",
    paused: "已暂停",
    unsubmitted: "未提交",
    completed: "已完成"
  }[status] || "待处理";
}

// 任务表单：居中 dialog（复用原字段与校验）
function openTaskForm(task = null) {
  resetTaskForm();
  if (task) {
    document.querySelector("#task-id").value = task.id;
    document.querySelector("#task-school").value = task.school || "";
    document.querySelector("#task-course").value = task.course || "";
    document.querySelector("#task-type").value = task.taskType || "capability-setup";
    elements.taskStatus.value = ["pending", "paused", "unsubmitted", "completed"].includes(task.status)
      ? task.status
      : "pending";
    document.querySelector("#task-quantity").value = Number(task.quantity) || 1;
    document.querySelector("#task-owner").value = task.owner || "";
    elements.taskFormTitle.textContent = "编辑任务";
  }
  elements.taskDialog.showModal();
  document.querySelector("#task-school").focus();
}

function closeTaskForm() {
  elements.taskDialog.close();
  resetTaskForm();
}

function resetTaskForm() {
  elements.taskForm?.reset();
  document.querySelector("#task-id").value = "";
  elements.taskStatus.value = "pending";
  document.querySelector("#task-quantity").value = "1";
  document.querySelector("#task-type").value = "capability-setup";
  if (elements.taskFormTitle) elements.taskFormTitle.textContent = "添加任务";
}

// 子任务清单与 quantity 联动：长度不足补 pending，超出截断；index 重排为 1..N
function normalizeSubtasks(subtasks, quantity) {
  const count = Math.max(1, Number(quantity) || 1);
  const source = Array.isArray(subtasks) ? subtasks : [];
  const list = [];
  for (let index = 1; index <= count; index += 1) {
    const status = source[index - 1]?.status;
    list.push({ index, status: ["pending", "running", "done", "unconfirmed"].includes(status) ? status : "pending" });
  }
  return list;
}

function normalizeWeeklyTask(task = {}) {
  const quantity = Math.max(1, Number(task.quantity) || 1);
  return {
    id: task.id || `task-${Date.now()}`,
    school: task.school || "",
    course: task.course || "",
    // 允许空字符串（txt 导入未匹配到类型时留空，预览中标黄提醒）
    taskType: typeof task.taskType === "string" ? task.taskType : "capability-setup",
    quantity,
    status: task.status || "pending",
    owner: task.owner || "",
    weekday: TODO_WEEKDAYS.includes(task.weekday) ? task.weekday : "",
    note: task.note || "",
    subtasks: normalizeSubtasks(task.subtasks, quantity),
    chatLogPath: task.chatLogPath || "",
    reportPath: task.reportPath || "",
    taskFolder: task.taskFolder || "",
    step: normalizePipelineStep(task.step),
    cleanupPending: Boolean(task.cleanupPending),
    deletePending: Boolean(task.deletePending),
    // 归档：仅影响任务中心默认列表与写回，不改 status / 产物路径
    archived: Boolean(task.archived),
    // 卡片舱「已复制」状态（V3.4）：fieldKey → true，任务结束时清空
    cardCopied: task.cardCopied && typeof task.cardCopied === "object" ? task.cardCopied : {}
  };
}

function markAllSubtasksDone(subtasks, quantity) {
  return normalizeSubtasks(subtasks, quantity).map((subtask) => ({ ...subtask, status: "done" }));
}

function weekdayRank(weekday) {
  const index = TODO_WEEKDAYS.indexOf(weekday);
  return index >= 0 ? index : TODO_WEEKDAYS.length;
}

function sortTasksByWeekday(tasks) {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((a, b) => weekdayRank(a.task.weekday) - weekdayRank(b.task.weekday) || a.index - b.index)
    .map((entry) => entry.task);
}

function nextSubtaskStatus(status) {
  return status === "pending" ? "done" : status === "done" ? "unconfirmed" : status === "unconfirmed" ? "pending" : "running";
}

function subtaskStatusLabel(status) {
  return {
    pending: "待做",
    running: "进行中",
    done: "已完成",
    unconfirmed: "待确认"
  }[status] || "待做";
}

function taskSubtasks(task) {
  return normalizeSubtasks(task?.subtasks, task?.quantity);
}

function runningSubtaskIndex(task) {
  return taskSubtasks(task).find((subtask) => subtask.status === "running")?.index || null;
}

function nextRunnableSubtaskIndex(task) {
  const subtasks = taskSubtasks(task);
  return runningSubtaskIndex(task)
    || subtasks.find((subtask) => ["pending", "unconfirmed"].includes(subtask.status))?.index
    || null;
}

function updateSubtaskStatus(task, index, status) {
  return taskSubtasks(task).map((subtask) =>
    subtask.index === index ? { ...subtask, status } : subtask
  );
}

function subtasksForTaskStatus(subtasks, previousStatus, nextStatus) {
  const normalized = normalizeSubtasks(subtasks, subtasks?.length);
  if (nextStatus === "completed") return normalized.map((subtask) => ({ ...subtask, status: "done" }));
  if (nextStatus === "pending" && ["completed", "unsubmitted"].includes(previousStatus)) {
    return normalized.map((subtask) => ({ ...subtask, status: "pending" }));
  }
  if (!["paused", "running", "evaluating"].includes(nextStatus)) {
    return normalized.map((subtask) => subtask.status === "running" ? { ...subtask, status: "pending" } : subtask);
  }
  return normalized;
}

async function persistWeeklyTasks() {
  if (!weeklyTasksLoadedSuccessfully) {
    throw new Error("Task data was not loaded successfully; refusing to overwrite it");
  }
  weeklyTasks = await window.workbench.writeWeeklyTasks(weeklyTasks.map(normalizeWeeklyTask));
  renderTaskCenter();
}

async function loadWeeklyTasks() {
  try {
    weeklyTasks = (await window.workbench.readWeeklyTasks()).map(normalizeWeeklyTask);
    weeklyTasksLoadedSuccessfully = true;
    let reconciled = false;
    const retainedTasks = [];
    for (const task of weeklyTasks) {
      if (task.deletePending) {
        const cleaned = !task.taskFolder
          || await window.workbench.cleanupTaskFolder(task.taskFolder).catch(() => false);
        if (cleaned) {
          reconciled = true;
          continue;
        }
      }
      if (task.cleanupPending) {
        const cleaned = !task.taskFolder
          || await window.workbench.cleanupTaskFolder(task.taskFolder).catch(() => false);
        if (cleaned) {
          task.cleanupPending = false;
          task.chatLogPath = "";
          task.reportPath = "";
          task.taskFolder = "";
          reconciled = true;
        }
      }
      if (["running", "evaluating"].includes(task.status)) {
        task.status = "paused";
        reconciled = true;
      }
      retainedTasks.push(task);
    }
    weeklyTasks = retainedTasks;
    if (reconciled) await persistWeeklyTasks();
  } catch (error) {
    weeklyTasksLoadedSuccessfully = false;
    console.error("读取任务列表失败:", error);
    weeklyTasks = [];
    showToast("读取任务列表失败", "error");
  }
  renderTaskCenter();
}

function getIsoWeekNumber(date = new Date()) {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNumber = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return Math.ceil(((target - yearStart) / 86400000 + 1) / 7);
}

// 任务当前进度：返回 { index, label, ratio, barClass }
const REPORT_STATUS_LABELS = {
  pending: "未开始",
  running: "进行中",
  evaluating: "进行中",
  paused: "已暂停",
  unsubmitted: "已完成，未提交",
  completed: "已完成"
};

let weeklyReportDirty = false;

function reportItemId(prefix = "item") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

let weeklyReportDefaults = { author: "", titlePattern: "" };

function normalizeWeeklyReportDefaults(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    author: String(source.author || "").trim().slice(0, 80),
    titlePattern: String(source.titlePattern || "").trim().slice(0, 120)
  };
}

function applyReportTitlePattern(periodKey, pattern = "") {
  const key = String(periodKey || currentReportPeriod());
  const monday = dateFromReportPeriod(key);
  const weekOfMonth = Math.floor((monday.getUTCDate() - 1) / 7) + 1;
  const year = monday.getUTCFullYear();
  const month = monday.getUTCMonth() + 1;
  const isoWeek = String(getIsoWeekNumber(monday)).padStart(2, "0");
  const trimmed = String(pattern || "").trim();
  if (!trimmed) return `M${month}W${weekOfMonth}周报`;
  return trimmed
    .replaceAll("{period}", key)
    .replaceAll("{year}", String(year))
    .replaceAll("{isoWeek}", isoWeek)
    .replaceAll("{month}", String(month))
    .replaceAll("{weekOfMonth}", String(weekOfMonth));
}

function shiftReportPeriod(periodKey, deltaWeeks = 0) {
  const monday = dateFromReportPeriod(periodKey);
  monday.setUTCDate(monday.getUTCDate() + Number(deltaWeeks || 0) * 7);
  return currentReportPeriod(new Date(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate()));
}

async function loadWeeklyReportDefaults() {
  try {
    const prefs = await window.workbench.getWorkbenchPrefs();
    weeklyReportDefaults = normalizeWeeklyReportDefaults(prefs?.weeklyReportDefaults);
  } catch (error) {
    weeklyReportDefaults = { author: "", titlePattern: "" };
    console.error("读取周报默认偏好失败:", error);
  }
  return weeklyReportDefaults;
}

async function saveWeeklyReportDefaults(partial = {}) {
  const next = normalizeWeeklyReportDefaults({ ...weeklyReportDefaults, ...partial });
  const prefs = await window.workbench.setWorkbenchPrefs({ weeklyReportDefaults: next });
  weeklyReportDefaults = normalizeWeeklyReportDefaults(prefs?.weeklyReportDefaults || next);
  return weeklyReportDefaults;
}

function currentReportPeriod(date = new Date()) {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNumber = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNumber);
  return `${target.getUTCFullYear()}-W${String(getIsoWeekNumber(date)).padStart(2, "0")}`;
}

function dateFromReportPeriod(periodKey) {
  const match = /^(\d{4})-W(\d{2})$/.exec(String(periodKey || ""));
  if (!match) return new Date();
  const year = Number(match[1]);
  const week = Number(match[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1 + (week - 1) * 7);
  return monday;
}

function reportTitleForPeriod(periodKey) {
  return applyReportTitlePattern(periodKey, weeklyReportDefaults.titlePattern);
}

function reportDateRangeForPeriod(periodKey) {
  const monday = dateFromReportPeriod(periodKey);
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  const format = (date) => `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
  return `${format(monday)} - ${format(sunday)}`;
}

function normalizeReportRow(row = {}) {
  return {
    id: row.id || reportItemId("row"),
    sourceTaskId: row.sourceTaskId || "",
    course: String(row.course || ""),
    school: String(row.school || ""),
    taskName: String(row.taskName || ""),
    progress: String(row.progress || "0%"),
    quantity: String(row.quantity || "1"),
    status: String(row.status || "未开始"),
    note: String(row.note || "")
  };
}

function normalizeWeeklyReport(report = {}) {
  const periodKey = /^\d{4}-W\d{2}$/.test(String(report.periodKey || ""))
    ? String(report.periodKey)
    : currentReportPeriod();
  return {
    id: report.id || `report-${periodKey}`,
    periodKey,
    title: String(report.title || reportTitleForPeriod(periodKey)),
    author: String(report.author || ""),
    dateRange: String(report.dateRange || reportDateRangeForPeriod(periodKey)),
    rows: Array.isArray(report.rows) ? report.rows.map(normalizeReportRow) : [],
    nonQuantified: Array.isArray(report.nonQuantified)
      ? report.nonQuantified.map((item) => ({ id: item.id || reportItemId("note"), text: String(item.text || "") }))
      : [],
    issues: Array.isArray(report.issues)
      ? report.issues.map((item) => ({ id: item.id || reportItemId("issue"), text: String(item.text || "") }))
      : [],
    createdAt: report.createdAt || new Date().toISOString(),
    updatedAt: report.updatedAt || new Date().toISOString()
  };
}

function newWeeklyReport(periodKey = currentReportPeriod()) {
  return normalizeWeeklyReport({
    id: `report-${periodKey}`,
    periodKey,
    title: reportTitleForPeriod(periodKey),
    author: weeklyReportDefaults.author || "",
    dateRange: reportDateRangeForPeriod(periodKey)
  });
}

window.applyReportTitlePattern = applyReportTitlePattern;
window.shiftReportPeriod = shiftReportPeriod;
window.normalizeWeeklyReportDefaults = normalizeWeeklyReportDefaults;

function taskReportProgress(task) {
  const subtasks = taskSubtasks(task);
  const done = subtasks.filter((subtask) => subtask.status === "done").length;
  return `${Math.round((done / Math.max(1, subtasks.length)) * 100)}%`;
}

function reportRowFromTask(task, existingRow = null) {
  return normalizeReportRow({
    id: existingRow?.id || reportItemId("row"),
    sourceTaskId: task.id,
    course: task.course,
    school: task.school,
    taskName: taskTypeLabel(task.taskType),
    progress: taskReportProgress(task),
    quantity: task.quantity,
    status: existingRow?.status || REPORT_STATUS_LABELS[task.status] || "未开始",
    note: existingRow?.note || task.note || ""
  });
}

function generateReportRowsFromTasks(report) {
  const existingByTaskId = new Map(
    report.rows.filter((row) => row.sourceTaskId).map((row) => [row.sourceTaskId, row])
  );
  const generated = weeklyTasks.map((task) => reportRowFromTask(task, existingByTaskId.get(task.id)));
  const manualRows = report.rows.filter((row) => !row.sourceTaskId);
  return [...generated, ...manualRows];
}

function markWeeklyReportDirty() {
  weeklyReportDirty = true;
  if (elements.reportSaveState) elements.reportSaveState.textContent = "未保存";
}

function reportCellStyle() {
  return "border:1px solid #d7dee6;padding:7px 8px;vertical-align:top;";
}

const WEEKLY_REPORT_TABLE_HEADINGS = [
  "课程名称",
  "学校名称",
  "任务名称",
  "任务进度",
  "任务数量",
  "任务状态",
  "本周建议情况描述"
];

function weeklyReportTableHtml(report) {
  const safeReport = normalizeWeeklyReport(report);
  const rows = safeReport.rows.length
    ? safeReport.rows.map((row) => [row.course, row.school, row.taskName, row.progress, row.quantity, row.status, row.note])
    : [["暂无量化任务", "", "", "", "", "", ""]];
  return `<table data-workbench-weekly-report-table="true" style="width:100%;border-collapse:collapse;table-layout:fixed;">
    <thead><tr>${WEEKLY_REPORT_TABLE_HEADINGS.map((heading) => `<th style="${reportCellStyle()}background:#f3f6f8;text-align:left;font-weight:700;">${heading}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((row) => `<tr>${row.map((value) => `<td style="${reportCellStyle()}">${escapeHtml(value)}</td>`).join("")}</tr>`).join("")}</tbody>
  </table>`;
}

function weeklyReportTablePlainText(report) {
  const safeReport = normalizeWeeklyReport(report);
  const rows = safeReport.rows.length
    ? safeReport.rows.map((row) => [row.course, row.school, row.taskName, row.progress, row.quantity, row.status, row.note])
    : [["暂无量化任务", "", "", "", "", "", ""]];
  return [WEEKLY_REPORT_TABLE_HEADINGS, ...rows].map((row) => row.join("\t")).join("\n");
}

function weeklyReportHtmlBody(report) {
  const safeReport = normalizeWeeklyReport(report);
  const rows = safeReport.rows.length
    ? safeReport.rows.map((row) => `
      <tr>
        <td style="${reportCellStyle()}">${escapeHtml(row.course)}</td>
        <td style="${reportCellStyle()}">${escapeHtml(row.school)}</td>
        <td style="${reportCellStyle()}">${escapeHtml(row.taskName)}</td>
        <td style="${reportCellStyle()}">${escapeHtml(row.progress)}</td>
        <td style="${reportCellStyle()}">${escapeHtml(row.quantity)}</td>
        <td style="${reportCellStyle()}">${escapeHtml(row.status)}</td>
        <td style="${reportCellStyle()}">${escapeHtml(row.note)}</td>
      </tr>`).join("")
    : `<tr><td colspan="7" style="${reportCellStyle()}color:#7a8795;">暂无量化任务</td></tr>`;
  const listHtml = (items, emptyText) => items.length
    ? `<ol style="margin:8px 0 0 22px;padding:0;">${items.map((item) => `<li style="margin:5px 0;">${escapeHtml(item.text)}</li>`).join("")}</ol>`
    : `<p style="margin:8px 0;color:#7a8795;">${emptyText}</p>`;

  return `<div style="font-family:Arial,'Microsoft YaHei',sans-serif;color:#24313b;line-height:1.65;font-size:14px;">
    <h1 style="margin:0 0 4px;font-size:26px;line-height:1.3;">${escapeHtml(safeReport.title)}</h1>
    <p style="margin:0 0 8px;color:#7a8795;">${escapeHtml(safeReport.dateRange)}</p>
    <p style="margin:0 0 5px;font-size:18px;font-weight:700;">${escapeHtml(safeReport.author || "未填写姓名")}</p>
    <h2 style="margin:18px 0 7px;font-size:18px;">一、本周工作内容</h2>
    <p style="margin:0 0 8px;color:#5e6b77;">更新至下周一前的状态，包含本周涉及的历史遗留和新增任务。</p>
    <table style="width:100%;border-collapse:collapse;table-layout:fixed;">
      <thead><tr>
        ${["课程名称", "学校名称", "任务名称", "任务进度", "任务数量", "任务状态", "本周建议情况描述"].map((heading) => `<th style="${reportCellStyle()}background:#f3f6f8;text-align:left;font-weight:700;">${heading}</th>`).join("")}
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <h3 style="margin:18px 0 0;font-size:16px;">其他无法量化的部分</h3>
    ${listHtml(safeReport.nonQuantified, "暂无补充事项")}
    <h2 style="margin:20px 0 7px;font-size:18px;">二、产品需求 / Bug / 卡点 / 疑问</h2>
    <p style="margin:0;color:#5e6b77;">记录用户反馈、交付卡点、平台问题和具有价值的后续想法。</p>
    ${listHtml(safeReport.issues, "暂无需求、Bug 或疑问")}
  </div>`;
}

function weeklyReportHtmlDocument(report) {
  const safeReport = normalizeWeeklyReport(report);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(safeReport.title)}</title></head><body style="margin:24px;background:#fff;">${weeklyReportHtmlBody(safeReport)}</body></html>`;
}

function weeklyReportPlainText(report) {
  const safeReport = normalizeWeeklyReport(report);
  const lines = [safeReport.title, safeReport.author || "未填写姓名", "", "一、本周工作内容", "课程名称\t学校名称\t任务名称\t任务进度\t任务数量\t任务状态\t本周建议情况描述"];
  safeReport.rows.forEach((row) => lines.push([row.course, row.school, row.taskName, row.progress, row.quantity, row.status, row.note].join("\t")));
  lines.push("", "其他无法量化的部分");
  safeReport.nonQuantified.forEach((item, index) => lines.push(`${index + 1}. ${item.text}`));
  lines.push("", "二、产品需求 / Bug / 卡点 / 疑问");
  safeReport.issues.forEach((item, index) => lines.push(`${index + 1}. ${item.text}`));
  return lines.join("\n");
}

function markdownReportCell(value) {
  return String(value || "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function weeklyReportMarkdown(report) {
  const safeReport = normalizeWeeklyReport(report);
  const lines = [`# ${safeReport.title}`, `作者：${safeReport.author || "未填写姓名"}`, `周期：${safeReport.dateRange}`, "", "## 一、本周工作内容", "", "| 课程名称 | 学校名称 | 任务名称 | 任务进度 | 任务数量 | 任务状态 | 本周建议情况描述 |", "| --- | --- | --- | --- | --- | --- | --- |"];
  if (safeReport.rows.length) {
    safeReport.rows.forEach((row) => lines.push(`| ${[row.course, row.school, row.taskName, row.progress, row.quantity, row.status, row.note].map(markdownReportCell).join(" | ")} |`));
  } else {
    lines.push("| 暂无量化任务 |  |  |  |  |  |  |");
  }
  lines.push("", "### 其他无法量化的部分");
  safeReport.nonQuantified.forEach((item, index) => lines.push(`${index + 1}. ${item.text}`));
  if (!safeReport.nonQuantified.length) lines.push("暂无补充事项");
  lines.push("", "## 二、产品需求 / Bug / 卡点 / 疑问");
  safeReport.issues.forEach((item, index) => lines.push(`${index + 1}. ${item.text}`));
  if (!safeReport.issues.length) lines.push("暂无需求、Bug 或疑问");
  return lines.join("\n");
}

function renderWeeklyReportPreview() {
  if (!elements.reportPreview || !activeWeeklyReport) return;
  elements.reportPreview.innerHTML = weeklyReportHtmlBody(activeWeeklyReport);
}

function renderReportTextList(container, items, listName, emptyText) {
  if (!container) return;
  if (!items.length) {
    container.innerHTML = `<div class="report-empty-line">${escapeHtml(emptyText)}</div>`;
    return;
  }
  container.innerHTML = items.map((item, index) => `
    <div class="report-text-row" data-report-list="${listName}" data-report-index="${index}">
      <span class="report-list-index">${index + 1}.</span>
      <textarea data-report-field="text" rows="2" placeholder="填写内容">${escapeHtml(item.text)}</textarea>
      <button class="report-remove-button" data-report-action="remove-${listName}" type="button" title="删除此项" aria-label="删除第 ${index + 1} 项">删除</button>
    </div>`).join("");
}

function renderReportHistoryList() {
  if (!elements.reportHistoryList) return;
  const saved = [...weeklyReports]
    .map((report) => normalizeWeeklyReport(report))
    .sort((a, b) => String(b.periodKey).localeCompare(String(a.periodKey)));
  if (elements.reportHistoryCount) {
    elements.reportHistoryCount.textContent = `${saved.length} 周`;
  }
  if (!saved.length) {
    elements.reportHistoryList.innerHTML = '<div class="report-history-empty">还没有已保存的周报。编辑后点「保存草稿」会出现在这里。</div>';
    return;
  }
  const activeKey = activeWeeklyReport?.periodKey || "";
  elements.reportHistoryList.innerHTML = saved.map((report) => `
    <button class="report-history-item${report.periodKey === activeKey ? " active" : ""}" type="button" data-report-period="${escapeHtml(report.periodKey)}" title="${escapeHtml(report.title)}">
      <strong>${escapeHtml(report.periodKey)}</strong>
      <span>${escapeHtml(report.title || "未命名周报")}</span>
      <em>${escapeHtml(report.author || "未填姓名")} · ${report.rows.length} 项</em>
    </button>`).join("");
}

function renderWeeklyReportCenter() {
  if (!elements.weeklyReportView || !activeWeeklyReport) return;
  const report = normalizeWeeklyReport(activeWeeklyReport);
  activeWeeklyReport = report;
  elements.reportPeriod.value = report.periodKey;
  elements.reportTitle.value = report.title;
  elements.reportAuthor.value = report.author;
  elements.reportRange.value = report.dateRange;
  elements.reportSaveState.textContent = weeklyReportDirty ? "未保存" : "已保存";
  elements.reportRowCount.textContent = `${report.rows.length} 项`;
  renderReportHistoryList();
  if (!report.rows.length) {
    elements.reportRowsBody.innerHTML = `
      <tr class="report-empty-row">
        <td colspan="8">
          <div class="report-empty-line">暂无工作内容行。可「从任务生成」或点击下方「手动添加一行」。</div>
        </td>
      </tr>`;
  } else {
    elements.reportRowsBody.innerHTML = report.rows.map((row, index) => `
    <tr data-report-row-index="${index}">
      <td><input data-report-field="course" type="text" value="${escapeHtml(row.course)}" placeholder="课程名称"></td>
      <td><input data-report-field="school" type="text" value="${escapeHtml(row.school)}" placeholder="学校名称"></td>
      <td><input data-report-field="taskName" type="text" value="${escapeHtml(row.taskName)}" placeholder="任务名称"></td>
      <td><input data-report-field="progress" type="text" value="${escapeHtml(row.progress)}" placeholder="100%"></td>
      <td><input data-report-field="quantity" type="number" min="0" step="1" value="${escapeHtml(row.quantity)}" placeholder="1"></td>
      <td><input data-report-field="status" type="text" value="${escapeHtml(row.status)}" placeholder="任务状态"></td>
      <td><textarea data-report-field="note" rows="2" placeholder="本周建设情况">${escapeHtml(row.note)}</textarea></td>
      <td class="report-row-actions">
        <button class="report-remove-button" data-report-action="remove-row" type="button" title="删除此行" aria-label="删除第 ${index + 1} 行">删除</button>
      </td>
    </tr>`).join("");
  }
  renderReportTextList(elements.reportNonquantifiedList, report.nonQuantified, "nonquantified", "暂无补充事项，点击 + 添加");
  renderReportTextList(elements.reportIssuesList, report.issues, "issues", "暂无需求、Bug 或疑问，点击 + 添加");
  renderWeeklyReportPreview();
  updateTopbarForActive(null);
}

async function persistWeeklyReport() {
  if (!weeklyReportsLoadedSuccessfully) {
    throw new Error("Weekly report data was not loaded successfully; refusing to overwrite it");
  }
  if (!activeWeeklyReport) return;
  activeWeeklyReport = normalizeWeeklyReport({ ...activeWeeklyReport, updatedAt: new Date().toISOString() });
  const existingIndex = weeklyReports.findIndex((report) => report.periodKey === activeWeeklyReport.periodKey);
  if (existingIndex >= 0) weeklyReports[existingIndex] = activeWeeklyReport;
  else weeklyReports.push(activeWeeklyReport);
  weeklyReports = await window.workbench.writeWeeklyReports(weeklyReports.map(normalizeWeeklyReport));
  weeklyReportDirty = false;
  renderWeeklyReportCenter();
}

async function loadWeeklyReports() {
  try {
    await loadWeeklyReportDefaults();
    const rawReports = await window.workbench.readWeeklyReports();
    const reportsByPeriod = new Map();
    (Array.isArray(rawReports) ? rawReports : []).forEach((report) => {
      const normalized = normalizeWeeklyReport(report);
      const current = reportsByPeriod.get(normalized.periodKey);
      if (!current || String(normalized.updatedAt) >= String(current.updatedAt)) reportsByPeriod.set(normalized.periodKey, normalized);
    });
    weeklyReports = [...reportsByPeriod.values()];
    weeklyReportsLoadedSuccessfully = true;
    const periodKey = currentReportPeriod();
    activeWeeklyReport = weeklyReports.find((report) => report.periodKey === periodKey) || newWeeklyReport(periodKey);
    weeklyReportDirty = false;
    renderWeeklyReportCenter();
  } catch (error) {
    weeklyReportsLoadedSuccessfully = false;
    weeklyReports = [];
    activeWeeklyReport = newWeeklyReport();
    weeklyReportDirty = false;
    console.error("读取周报列表失败:", error);
    showToast("读取周报列表失败", "error");
  }
}

function reportInputChanged(field, value) {
  if (!activeWeeklyReport) return;
  activeWeeklyReport[field] = String(value || "");
  markWeeklyReportDirty();
  renderWeeklyReportPreview();
  updateTopbarForActive(null);
}

async function switchWeeklyReportPeriod(periodKey) {
  if (!/^\d{4}-W\d{2}$/.test(periodKey)) return;
  if (activeWeeklyReport?.periodKey === periodKey) return;
  if (weeklyReportDirty) await persistWeeklyReport();
  activeWeeklyReport = weeklyReports.find((report) => report.periodKey === periodKey) || newWeeklyReport(periodKey);
  weeklyReportDirty = false;
  renderWeeklyReportCenter();
}

async function copyWeeklyReportToClipboard() {
  if (!activeWeeklyReport) return;
  const result = await window.workbench.copyWeeklyReport({
    text: weeklyReportPlainText(activeWeeklyReport),
    html: weeklyReportHtmlBody(activeWeeklyReport)
  });
  if (!result?.success) throw new Error(result?.error || "复制周报失败");
  showToast("周报已复制，可直接粘贴到企业微信文档", "success");
}

async function copyWeeklyReportTableToClipboard() {
  if (!activeWeeklyReport) return;
  const result = await window.workbench.copyWeeklyReport({
    text: weeklyReportTablePlainText(activeWeeklyReport),
    html: weeklyReportTableHtml(activeWeeklyReport)
  });
  if (!result?.success) throw new Error(result?.error || "复制周报表格失败");
  showToast("表格已复制，可粘贴到目标表格的首个单元格", "success");
}

async function exportWeeklyReport(format) {
  if (!activeWeeklyReport) return;
  const isMarkdown = format === "markdown";
  const result = await window.workbench.exportWeeklyReport({
    format,
    content: format === "docx"
      ? ""
      : isMarkdown ? weeklyReportMarkdown(activeWeeklyReport) : weeklyReportHtmlDocument(activeWeeklyReport),
    report: activeWeeklyReport,
    filename: `${activeWeeklyReport.periodKey}-${activeWeeklyReport.title}`
  });
  if (result?.success) showToast(`已导出 ${format === "docx" ? "Word 文档" : isMarkdown ? "Markdown" : "HTML"}`, "success");
  else if (!result?.canceled) throw new Error(result?.error || "导出周报失败");
}

function setupWeeklyReportEvents() {
  elements.navWeeklyReport?.addEventListener("click", () => activateTab(WEEKLY_REPORT_ID));
  elements.reportGenerate?.addEventListener("click", () => {
    if (!activeWeeklyReport) return;
    const hadRows = Array.isArray(activeWeeklyReport.rows) && activeWeeklyReport.rows.length > 0;
    activeWeeklyReport.rows = generateReportRowsFromTasks(activeWeeklyReport);
    markWeeklyReportDirty();
    renderWeeklyReportCenter();
    showToast(
      hadRows
        ? `已从 ${weeklyTasks.length} 项任务刷新，手动备注已保留`
        : `已从 ${weeklyTasks.length} 项任务生成周报初稿`,
      "success"
    );
  });
  elements.reportSave?.addEventListener("click", async () => {
    try {
      await persistWeeklyReport();
      showToast("周报草稿已保存", "success");
    } catch (error) {
      console.error("保存周报失败:", error);
      showToast("保存周报失败", "error");
    }
  });
  elements.reportCopy?.addEventListener("click", async () => {
    try {
      await copyWeeklyReportToClipboard();
    } catch (error) {
      console.error("复制周报失败:", error);
      showToast("复制周报失败", "error");
    }
  });
  elements.reportCopyTable?.addEventListener("click", async () => {
    try {
      await copyWeeklyReportTableToClipboard();
    } catch (error) {
      console.error("复制周报表格失败:", error);
      showToast("复制周报表格失败", "error");
    }
  });
  elements.reportExportHtml?.addEventListener("click", async () => {
    try {
      await exportWeeklyReport("html");
    } catch (error) {
      console.error("导出 HTML 失败:", error);
      showToast("导出 HTML 失败", "error");
    }
  });
  elements.reportExportMarkdown?.addEventListener("click", async () => {
    try {
      await exportWeeklyReport("markdown");
    } catch (error) {
      console.error("导出 Markdown 失败:", error);
      showToast("导出 Markdown 失败", "error");
    }
  });
  elements.reportExportDocx?.addEventListener("click", async () => {
    try {
      await exportWeeklyReport("docx");
    } catch (error) {
      console.error("导出 Word 文档失败:", error);
      showToast("导出 Word 文档失败", "error");
    }
  });
  elements.reportPeriod?.addEventListener("change", async () => {
    const nextPeriod = elements.reportPeriod.value;
    try {
      await switchWeeklyReportPeriod(nextPeriod);
    } catch (error) {
      elements.reportPeriod.value = activeWeeklyReport?.periodKey || currentReportPeriod();
      showToast("切换周报周期前保存失败", "error");
    }
  });
  async function jumpWeeklyReportByWeeks(delta) {
    const base = activeWeeklyReport?.periodKey || currentReportPeriod();
    try {
      await switchWeeklyReportPeriod(shiftReportPeriod(base, delta));
    } catch (error) {
      console.error("切换周报周期失败:", error);
      showToast("切换周报周期前保存失败", "error");
    }
  }
  elements.reportPeriodPrev?.addEventListener("click", () => jumpWeeklyReportByWeeks(-1));
  elements.reportPeriodNext?.addEventListener("click", () => jumpWeeklyReportByWeeks(1));
  elements.reportHistoryList?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-report-period]");
    if (!button) return;
    try {
      await switchWeeklyReportPeriod(button.dataset.reportPeriod);
    } catch (error) {
      console.error("切换历史周报失败:", error);
      showToast("切换历史周报前保存失败", "error");
    }
  });
  elements.reportSaveDefaultAuthor?.addEventListener("click", async () => {
    const author = String(elements.reportAuthor?.value || activeWeeklyReport?.author || "").trim();
    try {
      await saveWeeklyReportDefaults({ author });
      if (elements.prefReportAuthor) elements.prefReportAuthor.value = weeklyReportDefaults.author;
      showToast(author ? `已将「${author}」设为新建周报默认姓名` : "已清空周报默认姓名", "success");
    } catch (error) {
      console.error("保存周报默认姓名失败:", error);
      showToast("保存周报默认姓名失败", "error");
    }
  });
  [
    [elements.reportTitle, "title"],
    [elements.reportAuthor, "author"],
    [elements.reportRange, "dateRange"]
  ].forEach(([input, field]) => input?.addEventListener("input", () => reportInputChanged(field, input.value)));
  elements.reportAddRow?.addEventListener("click", () => {
    if (!activeWeeklyReport) return;
    activeWeeklyReport.rows.push(normalizeReportRow({ id: reportItemId("row") }));
    markWeeklyReportDirty();
    renderWeeklyReportCenter();
  });
  elements.reportAddNonquantified?.addEventListener("click", () => {
    if (!activeWeeklyReport) return;
    activeWeeklyReport.nonQuantified.push({ id: reportItemId("note"), text: "" });
    markWeeklyReportDirty();
    renderWeeklyReportCenter();
  });
  elements.reportAddIssue?.addEventListener("click", () => {
    if (!activeWeeklyReport) return;
    activeWeeklyReport.issues.push({ id: reportItemId("issue"), text: "" });
    markWeeklyReportDirty();
    renderWeeklyReportCenter();
  });
  elements.weeklyReportView?.addEventListener("input", (event) => {
    const field = event.target.closest("[data-report-field]");
    if (!field || !activeWeeklyReport) return;
    const row = field.closest("[data-report-row-index]");
    if (row) {
      const index = Number(row.dataset.reportRowIndex);
      const key = field.dataset.reportField;
      if (activeWeeklyReport.rows[index] && key in activeWeeklyReport.rows[index]) activeWeeklyReport.rows[index][key] = field.value;
    } else {
      const item = field.closest("[data-report-list]");
      if (!item) return;
      const index = Number(item.dataset.reportIndex);
      const list = item.dataset.reportList === "issues" ? activeWeeklyReport.issues : activeWeeklyReport.nonQuantified;
      if (list[index] && field.dataset.reportField === "text") list[index].text = field.value;
    }
    markWeeklyReportDirty();
    renderWeeklyReportPreview();
  });
  elements.weeklyReportView?.addEventListener("click", (event) => {
    const actionButton = event.target.closest("[data-report-action]");
    const action = actionButton?.dataset.reportAction;
    if (!action || !activeWeeklyReport) return;
    event.preventDefault();
    if (action === "remove-row") {
      const row = actionButton.closest("[data-report-row-index]");
      const index = Number(row?.dataset.reportRowIndex);
      if (!Number.isInteger(index) || index < 0 || index >= activeWeeklyReport.rows.length) return;
      activeWeeklyReport.rows.splice(index, 1);
    } else if (action === "remove-nonquantified" || action === "remove-issues") {
      const item = actionButton.closest("[data-report-list]");
      const list = action === "remove-issues" ? activeWeeklyReport.issues : activeWeeklyReport.nonQuantified;
      const index = Number(item?.dataset.reportIndex);
      if (!Number.isInteger(index) || index < 0 || index >= list.length) return;
      list.splice(index, 1);
    } else {
      return;
    }
    markWeeklyReportDirty();
    renderWeeklyReportCenter();
  });
}

function taskProgressInfo(task) {
  const isActiveTask = pipelineState.active && pipelineState.taskId === task.id;
  if (!isActiveTask && !["running", "evaluating"].includes(task.status)) {
    const subtasks = normalizeSubtasks(task.subtasks, task.quantity);
    const done = subtasks.filter((subtask) => subtask.status === "done").length;
    return {
      label: `子任务 ${done}/${subtasks.length} 完成`,
      ratio: done / subtasks.length,
      barClass: done === subtasks.length ? "full" : (task.status === "paused" ? "warn" : "")
    };
  }
  const step = isActiveTask ? pipelineState.step : task.step;
  const index = pipelineStepIndex(step);
  const stepNumber = index + 1;
  const activeSubtask = isActiveTask ? pipelineState.activeSubtaskIndex : runningSubtaskIndex(task);
  return {
    label: `${activeSubtask ? `子任务 ${activeSubtask}/${Math.max(1, Number(task.quantity) || 1)} · ` : ""}${stepNumber}/${PIPELINE_STEPS.length} ${PIPELINE_STEPS[index]?.name || ""}`,
    ratio: stepNumber / PIPELINE_STEPS.length,
    barClass: task.status === "paused" ? "warn" : ""
  };
}

function svgIcon(name, size = 14) {
  const bodies = {
    check: '<polyline points="20 6 9 17 4 12"/>',
    dots: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${bodies[name] || ""}</svg>`;
}

function pipelineStepperHtml(currentStep) {
  const currentIndex = pipelineStepIndex(currentStep);
  return `<div class="pipeline">${PIPELINE_STEPS.map((step, index) => {
    const state = index < currentIndex ? "done" : (index === currentIndex ? "now" : "");
    const dot = index < currentIndex ? svgIcon("check", 12) : String(index + 1);
    return `
      <div class="pl-step ${state}">
        <div class="pl-dot">${dot}</div>
        <div class="pl-name">${escapeHtml(step.name)}</div>
        <div class="pl-sub">${escapeHtml(step.desc)}</div>
      </div>`;
  }).join("")}</div>`;
}

function renderFocusCard() {
  const card = elements.focusCard;
  const task = pipelineState.active ? weeklyTasks.find((candidate) => candidate.id === pipelineState.taskId) : null;
  if (!task) {
    card.hidden = true;
    card.replaceChildren();
    return;
  }
  const folder = pipelineState.taskFolder || task.taskFolder || "";
  card.innerHTML = `
    <div class="focus-head">
      <span class="live-dot"></span>
      <h2>${escapeHtml(task.school)} · ${escapeHtml(task.course)}</h2>
      <span class="chip">${escapeHtml(taskTypeLabel(task.taskType))} × ${Number(task.quantity) || 1}</span>
      <div class="actions">
        <button class="btn btn-ghost btn-sm focus-pause" type="button">暂停</button>
        <button class="btn btn-ghost btn-sm focus-detail" type="button">查看详情</button>
      </div>
    </div>
    <div class="focus-meta">负责人 ${escapeHtml(task.owner || "未指定")} · 任务文件夹 <code>${escapeHtml(folder || "尚未创建")}</code></div>
    ${pipelineStepperHtml(pipelineState.step)}
  `;
  card.querySelector(".focus-pause").addEventListener("click", () => pauseTaskAutomation(task.id));
  card.querySelector(".focus-detail").addEventListener("click", () => {
    if (folder) window.workbench.openTaskFolder(folder);
  });
  card.hidden = false;
}

function closeAllCardMenus() {
  document.querySelectorAll(".tc-menu-pop.open").forEach((pop) => pop.classList.remove("open"));
}

// V3.2 P3-#3：记录当前展开子任务 popover 的任务 id。切换子任务状态会触发整卡重渲染，
// 重建后的 popover 是全新元素（无 .open），导致 popover 闪关。renderTaskCenter 末尾据此恢复。
let openSubtaskPopoverTaskId = null;

function closeAllSubtaskPopovers() {
  openSubtaskPopoverTaskId = null;
  document.querySelectorAll(".subtask-popover.open").forEach((pop) => pop.classList.remove("open"));
}

async function updateTaskSubtaskStatus(taskId, subtaskIndex, status) {
  const task = weeklyTasks.find((candidate) => candidate.id === taskId);
  if (!task) return;
  const subtasks = normalizeSubtasks(task.subtasks, task.quantity).map((subtask) =>
    subtask.index === subtaskIndex ? { ...subtask, status } : subtask
  );
  await updateTaskFields(taskId, { subtasks });
}

// 任务中心筛选状态（仅影响网格，不影响统计卡 / pipeline / 任务舱）
const taskCenterFilters = {
  query: "",
  status: "all",
  school: ""
};
let taskSearchDebounceTimer = null;

function getVisibleTasks() {
  return filterTasks(weeklyTasks, taskCenterFilters);
}

function uniqueTaskSchools(tasks = weeklyTasks) {
  const schools = [];
  const seen = new Set();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const school = String(task?.school || "").trim();
    if (!school || seen.has(school)) continue;
    seen.add(school);
    schools.push(school);
  }
  return schools.sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function syncTaskFilterControls() {
  if (elements.taskSearch && elements.taskSearch.value !== taskCenterFilters.query) {
    elements.taskSearch.value = taskCenterFilters.query;
  }
  if (elements.taskFilterChips) {
    elements.taskFilterChips.querySelectorAll("[data-status-filter]").forEach((chip) => {
      const active = chip.dataset.statusFilter === taskCenterFilters.status;
      chip.classList.toggle("active", active);
      chip.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }
  if (elements.taskSchoolFilter) {
    const schools = uniqueTaskSchools();
    const current = taskCenterFilters.school;
    const options = ['<option value="">全部学校</option>']
      .concat(schools.map((school) => `<option value="${escapeHtml(school)}">${escapeHtml(school)}</option>`));
    elements.taskSchoolFilter.innerHTML = options.join("");
    elements.taskSchoolFilter.value = schools.includes(current) ? current : "";
    if (!schools.includes(current)) taskCenterFilters.school = "";
  }
}

async function setTaskArchived(taskId, archived) {
  const updated = await updateTaskFields(taskId, { archived: Boolean(archived) });
  if (!updated) return;
  showToast(archived ? "任务已归档" : "已取消归档", "success");
}

// 任务产物徽章缓存：只存展示结果，不新增持久化字段
const taskArtifactCache = new Map();
const taskArtifactRefreshTimers = new Map();

function emptyTaskArtifacts(task = {}) {
  return taskArtifactsFromPathsAndFiles({
    chatLogPath: task.chatLogPath || "",
    reportPath: task.reportPath || ""
  }, []);
}

function getTaskArtifacts(task) {
  const cached = taskArtifactCache.get(task?.id);
  if (cached?.badges) return cached.badges;
  return emptyTaskArtifacts(task);
}

function artifactSigFromFiles(files = []) {
  return (Array.isArray(files) ? files : [])
    .map((file) => `${file.name || ""}:${file.mtime || 0}:${file.size || 0}`)
    .sort()
    .join("|");
}

function renderArtifactChipsHtml(artifacts) {
  const items = [
    { key: "chat", label: "对话", badge: artifacts.chat },
    { key: "report", label: "报告", badge: artifacts.report },
    { key: "cards", label: "卡片", badge: artifacts.cards }
  ];
  return items.map((item) => {
    const ready = Boolean(item.badge?.ready);
    const title = ready
      ? `打开${item.label}：${item.badge.name || item.label}`
      : `${item.label}尚未就绪`;
    return `<button type="button" class="file-chip ${ready ? "ready" : "missing"}" data-artifact="${item.key}" ${ready ? "" : "disabled"} title="${escapeHtml(title)}">${escapeHtml(item.label)}</button>`;
  }).join("");
}

function bindArtifactChipClicks(card, task) {
  card.querySelectorAll(".file-chip.ready[data-artifact]").forEach((chip) => {
    chip.addEventListener("click", async (event) => {
      event.stopPropagation();
      const artifacts = getTaskArtifacts(task);
      const key = chip.dataset.artifact;
      const badge = artifacts[key];
      if (!badge?.ready) return;
      if (badge.path) {
        const result = await window.workbench.taskFileAction("open", badge.path);
        if (!(result === true || result?.ok === true)) showToast(`无法打开${chip.textContent}`, "error");
        return;
      }
      if (task.taskFolder) {
        window.workbench.openTaskFolder(task.taskFolder);
        return;
      }
      showToast("产物路径不可用", "error");
    });
  });
}

function patchTaskCardArtifacts(taskId, artifacts) {
  const card = elements.taskCenterView?.querySelector(`.task-card[data-id="${CSS.escape(taskId)}"]`);
  if (!card) return;
  const host = card.querySelector(".tc-files");
  if (!host) return;
  host.innerHTML = renderArtifactChipsHtml(artifacts);
  const task = weeklyTasks.find((candidate) => candidate.id === taskId);
  if (task) bindArtifactChipClicks(card, task);
}

function scheduleArtifactRefresh(taskId, { force = false } = {}) {
  if (!taskId) return;
  const existing = taskArtifactRefreshTimers.get(taskId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    taskArtifactRefreshTimers.delete(taskId);
    refreshTaskArtifacts(taskId, { force }).catch((error) => {
      console.warn("刷新任务产物徽章失败:", error);
    });
  }, 180);
  taskArtifactRefreshTimers.set(taskId, timer);
}

function scheduleVisibleArtifactRefresh() {
  for (const task of weeklyTasks) {
    if (!task?.taskFolder || task.archived) continue;
    scheduleArtifactRefresh(task.id);
  }
}

async function refreshTaskArtifacts(taskId, { force = false } = {}) {
  const task = weeklyTasks.find((candidate) => candidate.id === taskId);
  if (!task || task.archived || !task.taskFolder) return null;
  let files = [];
  try {
    files = (await window.workbench.listTaskFiles(task.taskFolder)) || [];
  } catch (error) {
    console.warn("listTaskFiles 失败:", error);
    return null;
  }
  // 任务可能在等待期间被删除/归档
  const current = weeklyTasks.find((candidate) => candidate.id === taskId);
  if (!current || current.archived || !current.taskFolder) return null;

  const sig = artifactSigFromFiles(files);
  const cached = taskArtifactCache.get(taskId);
  if (!force && cached && cached.sig === sig && cached.folder === current.taskFolder) {
    return cached.badges;
  }

  const badges = taskArtifactsFromPathsAndFiles({
    chatLogPath: current.chatLogPath || "",
    reportPath: current.reportPath || ""
  }, files);
  taskArtifactCache.set(taskId, {
    sig,
    folder: current.taskFolder,
    badges
  });
  patchTaskCardArtifacts(taskId, badges);

  // 路径为空且发现标准文件时写回；已有路径不覆盖
  const pathPatch = {};
  if (!current.chatLogPath && badges.chat.ready && badges.chat.path) {
    pathPatch.chatLogPath = badges.chat.path;
  }
  if (!current.reportPath && badges.report.ready && badges.report.path) {
    pathPatch.reportPath = badges.report.path;
  }
  if (Object.keys(pathPatch).length) {
    await updateTaskFields(taskId, pathPatch);
  }
  return badges;
}

function handleTaskFolderChanged(payload = {}) {
  refreshRailTray();
  const folderPath = String(payload?.folderPath || pipelineState.taskFolder || "");
  if (!folderPath) return;
  const related = weeklyTasks.filter((task) =>
    !task.archived
    && task.taskFolder
    && pathLikeEqual(task.taskFolder, folderPath)
  );
  // 若 payload 仅给活动夹，也刷新当前活动任务
  if (!related.length && pipelineState.taskId) {
    scheduleArtifactRefresh(pipelineState.taskId, { force: true });
    return;
  }
  related.forEach((task) => scheduleArtifactRefresh(task.id, { force: true }));
}

function pathLikeEqual(a, b) {
  const normalize = (value) => String(value || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return normalize(a) === normalize(b);
}

function taskCardElement(task) {
  const card = document.createElement("div");
  card.className = `task-card${task.status === "completed" ? " completed" : ""}${task.status === "unsubmitted" ? " unsubmitted" : ""}${task.archived ? " archived" : ""}`;
  card.dataset.id = task.id;
  const progress = taskProgressInfo(task);
  const subtasks = taskSubtasks(task);
  const subtaskRows = subtasks.map((subtask) => {
    const active = pipelineState.active && pipelineState.taskId === task.id && pipelineState.activeSubtaskIndex === subtask.index;
    let action = "";
    if (subtask.status === "running") {
      action = active
        ? '<button class="subtask-action finish" type="button" data-subtask-action="finish">结束</button>'
        : '<button class="subtask-action" type="button" data-subtask-action="resume">继续</button>';
    } else if (["pending", "unconfirmed"].includes(subtask.status)) {
      action = '<button class="subtask-action" type="button" data-subtask-action="start">开始</button>';
    }
    return `
    <div class="subtask-row" data-index="${subtask.index}" data-status="${escapeHtml(subtask.status)}">
      <span>子任务 ${subtask.index}</span>
      <span class="subtask-controls">
        <b class="subtask-state ${escapeHtml(subtask.status)}">${escapeHtml(subtaskStatusLabel(subtask.status))}</b>
        ${action}
      </span>
    </div>`;
  }).join("");
  const artifacts = getTaskArtifacts(task);
  const chipsHtml = renderArtifactChipsHtml(artifacts);
  const weekdayHtml = task.weekday ? `<span>交付 <b>${escapeHtml(task.weekday)}</b></span>` : "";
  const noteHtml = task.note ? `<div class="tc-note">备注：${escapeHtml(task.note)}</div>` : "";
  const archiveMenuLabel = task.archived ? "取消归档" : "归档";

  let mainAction = "";
  if (task.status === "paused") {
    mainAction = `<button class="btn btn-teal btn-sm task-resume" type="button">${runningSubtaskIndex(task) ? "继续" : "开始下一项"}</button>`;
  } else if (task.status === "unsubmitted") {
    mainAction = '<button class="btn btn-teal btn-sm task-mark-completed" type="button">标记已完成</button>';
  } else if (task.status === "completed") {
    mainAction = '<button class="btn btn-ghost btn-sm task-open-folder" type="button">打开产物文件夹</button>';
  } else {
    mainAction = '<button class="btn btn-cta btn-sm task-run" type="button">执行</button>';
  }

  card.innerHTML = `
    <div class="tc-top">
      <div class="tc-title">
        <strong>${escapeHtml(task.school)}</strong>
        <span>${escapeHtml(task.course)} · ${escapeHtml(taskTypeLabel(task.taskType))}</span>
      </div>
      <span class="tc-status task-status status-${escapeHtml(task.status || "pending")}">${escapeHtml(taskStatusLabel(task.status || "pending"))}</span>
    </div>
    <div class="tc-meta"><span>负责人 <b>${escapeHtml(task.owner || "未指定")}</b></span><span>数量 <b>${Number(task.quantity) || 1}</b></span>${weekdayHtml}</div>
    ${noteHtml}
    <button class="tc-progress" type="button" title="点击维护子任务进度">
      <div class="tc-bar ${progress.barClass}"><i style="width:${Math.round(progress.ratio * 100)}%"></i></div>
      <span>${escapeHtml(progress.label)}</span>
    </button>
    <div class="subtask-popover" aria-label="子任务清单">${subtaskRows}</div>
    <div class="tc-files">${chipsHtml}</div>
    <div class="tc-foot">
      ${mainAction}
      <span class="spacer"></span>
      <div class="tc-menu-wrap">
        <button class="icon-button tc-menu-toggle" type="button" title="更多操作" aria-label="更多操作">${svgIcon("dots")}</button>
        <div class="tc-menu-pop">
          ${["completed", "unsubmitted"].includes(task.status) ? '<button class="task-reopen" type="button">重新打开任务</button>' : ""}
          <button class="task-edit" type="button">编辑任务与状态</button>
          <button class="task-archive" type="button">${archiveMenuLabel}</button>
          <button class="task-delete danger" type="button">删除</button>
        </div>
      </div>
    </div>
  `;

  card.querySelector(".task-run")?.addEventListener("click", () => startTaskAutomation(task.id));
  card.querySelector(".task-resume")?.addEventListener("click", () => {
    const activeIndex = runningSubtaskIndex(task);
    if (activeIndex) resumeTaskAutomation(task.id);
    else startTaskAutomation(task.id, nextRunnableSubtaskIndex(task));
  });
  card.querySelector(".task-mark-completed")?.addEventListener("click", () =>
    updateTaskFields(task.id, { status: "completed", subtasks: markAllSubtasksDone(task.subtasks, task.quantity) })
      .then(() => showToast("任务已标记为已完成", "success"))
  );
  card.querySelector(".task-open-folder")?.addEventListener("click", () => {
    if (task.taskFolder) {
      window.workbench.openTaskFolder(task.taskFolder);
    } else {
      showToast("该任务没有记录产物文件夹", "error");
    }
  });
  bindArtifactChipClicks(card, task);
  const menuPop = card.querySelector(".tc-menu-pop");
  card.querySelector(".tc-menu-toggle").addEventListener("click", () => {
    const willOpen = !menuPop.classList.contains("open");
    closeAllCardMenus();
    closeAllSubtaskPopovers();
    menuPop.classList.toggle("open", willOpen);
  });
  const subtaskPopover = card.querySelector(".subtask-popover");
  card.querySelector(".tc-progress")?.addEventListener("click", () => {
    const willOpen = !subtaskPopover.classList.contains("open");
    closeAllCardMenus();
    closeAllSubtaskPopovers();
    subtaskPopover.classList.toggle("open", willOpen);
    openSubtaskPopoverTaskId = willOpen ? task.id : null;
  });
  card.querySelectorAll(".subtask-row").forEach((row) => {
    row.querySelector(".subtask-action")?.addEventListener("click", async (event) => {
      event.stopPropagation();
      const index = Number(row.dataset.index);
      const action = event.currentTarget.dataset.subtaskAction;
      if (action === "finish") {
        if (pipelineState.active && pipelineState.taskId === task.id && pipelineState.activeSubtaskIndex === index) finishActiveTask();
        return;
      }
      if (action === "resume") {
        await resumeTaskAutomation(task.id);
        return;
      }
      if (action === "start") await startTaskAutomation(task.id, index);
    });
  });
  card.querySelector(".task-reopen")?.addEventListener("click", () => {
    closeAllCardMenus();
    reopenWeeklyTask(task.id);
  });
  card.querySelector(".task-edit").addEventListener("click", () => {
    closeAllCardMenus();
    editWeeklyTask(task.id);
  });
  card.querySelector(".task-archive")?.addEventListener("click", () => {
    closeAllCardMenus();
    setTaskArchived(task.id, !task.archived);
  });
  card.querySelector(".task-delete").addEventListener("click", () => {
    closeAllCardMenus();
    deleteWeeklyTask(task.id);
  });
  return card;
}

// 任务中心首页整体渲染：统计卡 + 聚焦卡 + 任务卡片网格 + 角标/芯片
function renderTaskCenter() {
  if (!elements.taskCenterView) return;

  // 统计卡始终使用全局计数，不受筛选影响
  const total = weeklyTasks.length;
  const running = weeklyTasks.filter((task) => task.status === "running" || task.status === "evaluating").length;
  const paused = weeklyTasks.filter((task) => task.status === "paused").length;
  const unsubmitted = weeklyTasks.filter((task) => task.status === "unsubmitted").length;
  const completed = weeklyTasks.filter((task) => task.status === "completed").length;

  elements.statTotal.textContent = String(total);
  elements.statRunning.textContent = String(running);
  elements.statPaused.textContent = String(paused);
  if (elements.statUnsubmitted) elements.statUnsubmitted.textContent = String(unsubmitted);
  elements.statCompleted.textContent = String(completed);
  elements.homeWeekSub.textContent = `${new Date().getFullYear()} 年第 ${getIsoWeekNumber()} 周 · 任务文档目录已挂载`;

  const pendingCount = total - completed;
  elements.taskCenterBadge.hidden = pendingCount <= 0;
  elements.taskCenterBadge.textContent = String(pendingCount);

  syncTaskFilterControls();
  renderFocusCard();

  const visibleTasks = getVisibleTasks();
  const statusFilter = taskCenterFilters.status || "all";
  const archivedOnly = statusFilter === "archived";
  const isFiltered = Boolean(taskCenterFilters.query || statusFilter !== "all" || taskCenterFilters.school);

  // 进行中/评估中默认只出现在聚焦卡；网格展示 待处理+已暂停 / 未提交 / 已完成
  // 指定状态 chip 时把可见集直接落到对应分区；归档模式单独一区
  let activeGroup = [];
  let unsubmittedGroup = [];
  let doneGroup = [];
  if (archivedOnly) {
    doneGroup = sortTasksByWeekday(visibleTasks);
  } else if (statusFilter === "pending" || statusFilter === "paused" || statusFilter === "running") {
    activeGroup = sortTasksByWeekday(visibleTasks);
  } else if (statusFilter === "unsubmitted") {
    unsubmittedGroup = visibleTasks;
  } else if (statusFilter === "completed") {
    doneGroup = visibleTasks;
  } else {
    activeGroup = sortTasksByWeekday(visibleTasks.filter((task) => task.status === "pending" || task.status === "paused"));
    unsubmittedGroup = visibleTasks.filter((task) => task.status === "unsubmitted");
    doneGroup = visibleTasks.filter((task) => task.status === "completed");
  }

  const activeLabel = {
    all: "待处理 / 已暂停",
    pending: "待处理",
    running: "进行中",
    paused: "已暂停"
  }[statusFilter] || "待处理 / 已暂停";

  if (elements.sectionActive) {
    elements.sectionActive.textContent = activeLabel;
    elements.sectionActive.hidden = archivedOnly || statusFilter === "unsubmitted" || statusFilter === "completed";
  }
  if (elements.sectionDone) {
    elements.sectionDone.textContent = archivedOnly ? "已归档" : "已完成";
    elements.sectionDone.hidden = statusFilter === "pending" || statusFilter === "paused" || statusFilter === "running" || statusFilter === "unsubmitted";
  }

  const showActiveGrid = !(archivedOnly || statusFilter === "unsubmitted" || statusFilter === "completed");
  elements.taskGridActive.replaceChildren();
  elements.taskGridActive.hidden = !showActiveGrid;
  if (showActiveGrid) {
    if (activeGroup.length) {
      activeGroup.forEach((task) => elements.taskGridActive.append(taskCardElement(task)));
    } else {
      const empty = document.createElement("div");
      empty.className = "task-grid-empty";
      empty.textContent = isFiltered
        ? "没有符合筛选条件的任务。"
        : "暂无待处理任务。点击右上角「添加任务」开始。";
      elements.taskGridActive.append(empty);
    }
  }

  if (elements.sectionUnsubmitted && elements.taskGridUnsubmitted) {
    const showUnsubmitted = !archivedOnly && (statusFilter === "unsubmitted" || (statusFilter === "all" && unsubmittedGroup.length > 0));
    elements.sectionUnsubmitted.hidden = !showUnsubmitted;
    elements.taskGridUnsubmitted.hidden = !showUnsubmitted;
    elements.taskGridUnsubmitted.replaceChildren();
    if (showUnsubmitted) {
      if (unsubmittedGroup.length) {
        unsubmittedGroup.forEach((task) => elements.taskGridUnsubmitted.append(taskCardElement(task)));
      } else {
        const empty = document.createElement("div");
        empty.className = "task-grid-empty";
        empty.textContent = "没有符合筛选条件的未提交任务。";
        elements.taskGridUnsubmitted.append(empty);
      }
    }
  }

  const showDoneGrid = archivedOnly || statusFilter === "completed" || statusFilter === "all";
  elements.taskGridDone.replaceChildren();
  if (elements.sectionDone) elements.sectionDone.hidden = !showDoneGrid;
  elements.taskGridDone.hidden = !showDoneGrid;
  if (showDoneGrid) {
    if (doneGroup.length) {
      doneGroup.forEach((task) => elements.taskGridDone.append(taskCardElement(task)));
    } else {
      const empty = document.createElement("div");
      empty.className = "task-grid-empty";
      if (archivedOnly) empty.textContent = "没有已归档的任务。";
      else empty.textContent = isFiltered ? "没有符合筛选条件的已完成任务。" : "本周还没有已完成的任务。";
      elements.taskGridDone.append(empty);
    }
  }

  if (activeTabId === TASK_CENTER_ID) {
    updateTopbarForActive(null);
  }

  // V3.2 P3-#3：重渲染后恢复之前展开的子任务 popover，避免切状态时闪关
  if (openSubtaskPopoverTaskId) {
    const card = elements.taskCenterView.querySelector(`.task-card[data-id="${openSubtaskPopoverTaskId}"]`);
    const popover = card?.querySelector(".subtask-popover");
    if (popover) popover.classList.add("open");
    else openSubtaskPopoverTaskId = null;
  }

  // 异步回扫可见任务产物徽章（不阻塞渲染；归档任务跳过）
  scheduleVisibleArtifactRefresh();
}

function taskFromForm() {
  const id = document.querySelector("#task-id").value || `task-${Date.now()}`;
  const existing = weeklyTasks.find((task) => task.id === id) || {};
  const status = ["pending", "paused", "unsubmitted", "completed"].includes(elements.taskStatus.value)
    ? elements.taskStatus.value
    : (existing.status || "pending");
  const existingSubtasks = normalizeSubtasks(existing.subtasks, Math.max(1, Number(document.querySelector("#task-quantity").value) || 1));
  const subtasks = subtasksForTaskStatus(existingSubtasks, existing.status, status);
  return {
    id,
    school: document.querySelector("#task-school").value.trim(),
    course: document.querySelector("#task-course").value.trim(),
    taskType: document.querySelector("#task-type").value,
    quantity: Math.max(1, Number(document.querySelector("#task-quantity").value) || 1),
    status,
    owner: document.querySelector("#task-owner").value.trim(),
    weekday: existing.weekday || "",
    note: existing.note || "",
    subtasks,
    chatLogPath: existing.chatLogPath || "",
    reportPath: existing.reportPath || "",
    taskFolder: existing.taskFolder || "",
    step: existing.step || "testing",
    cleanupPending: Boolean(existing.cleanupPending),
    deletePending: Boolean(existing.deletePending),
    archived: Boolean(existing.archived),
    cardCopied: existing.cardCopied && typeof existing.cardCopied === "object" ? existing.cardCopied : {}
  };
}

async function upsertWeeklyTask(task) {
  const index = weeklyTasks.findIndex((candidate) => candidate.id === task.id);
  if (index >= 0) weeklyTasks[index] = task;
  else weeklyTasks.push(task);
  await persistWeeklyTasks();
}

function editWeeklyTask(id) {
  const task = weeklyTasks.find((candidate) => candidate.id === id);
  if (!task) return;
  openTaskForm(task);
}

// 重新打开已完成/未提交任务：仅回退状态到待处理；任务文件夹与产物（chatLogPath/reportPath）全部保留
async function reopenWeeklyTask(id) {
  const task = weeklyTasks.find((candidate) => candidate.id === id);
  if (!task || !["completed", "unsubmitted"].includes(task.status)) return;
  await updateTaskFields(id, {
    status: "pending",
    subtasks: taskSubtasks(task).map((subtask) => ({ ...subtask, status: "pending" }))
  });
  showToast("任务已重新打开", "success");
}

// M4：删除任务改走确认 dialog（与结束任务三出口同风格），避免单击误删任务记录与产物
let pendingDeleteTaskId = null;
function deleteWeeklyTask(id) {
  const task = weeklyTasks.find((candidate) => candidate.id === id);
  if (!task) return;
  pendingDeleteTaskId = id;
  if (elements.deleteTaskDesc) {
    elements.deleteTaskDesc.textContent =
      `确认删除「${task.school || ""} ${task.course || ""}」？删除任务记录将一并清理其临时任务文件夹（产物不可恢复），此操作无法撤销。`;
  }
  elements.deleteTaskDialog?.showModal();
}

async function performDeleteWeeklyTask(id) {
  const task = weeklyTasks.find((candidate) => candidate.id === id);
  if (!task) return;
  const folderPath = pipelineState.taskId === id ? pipelineState.taskFolder : task?.taskFolder || "";
  const previousDeletePending = task.deletePending;
  task.deletePending = true;
  try {
    await persistWeeklyTasks();
  } catch (error) {
    task.deletePending = previousDeletePending;
    console.error("保存任务删除标记失败:", error);
    showToast("无法保存删除操作，任务和临时文件均已保留", "error");
    return;
  }
  taskTransitionGeneration += 1;
  if (pipelineState.taskId === id) {
    pipelineState = { active: false, taskId: null, activeSubtaskIndex: null, step: "idle", chatPath: "", reportPath: "", taskFolder: "", uploadQueue: [] };
    await updateTaskRail(null);
  }
  const cleaned = !folderPath || await window.workbench.cleanupTaskFolder(folderPath).catch(() => false);
  if (!cleaned) {
    showToast("任务已标记删除；临时文件清理失败，下次启动会重试", "error");
    return;
  }
  weeklyTasks = weeklyTasks.filter((candidate) => candidate.id !== id);
  try {
    await persistWeeklyTasks();
  } catch (error) {
    console.error("确认任务删除状态失败:", error);
    showToast("任务临时文件已清理；记录将在下次启动时自动移除", "error");
    return;
  }
  showToast("任务已删除", "success");
}

async function updateTaskFields(id, fields) {
  const task = weeklyTasks.find((candidate) => candidate.id === id);
  if (!task) return null;
  Object.assign(task, fields);
  await persistWeeklyTasks();
  return weeklyTasks.find((candidate) => candidate.id === id) || null;
}

function renderImportPreviewGroup(key, title, rows, { collapsed = false, selectable = true } = {}) {
  const section = document.createElement("section");
  section.className = "import-group";
  let container = section;
  if (collapsed) {
    // 无变化组默认折叠：<details> 不带 open，点 summary 展开
    const details = document.createElement("details");
    details.innerHTML = `<summary><h3>${escapeHtml(title)} <span>${rows.length}</span></h3></summary>`;
    section.append(details);
    container = details;
  } else {
    section.innerHTML = `<h3>${escapeHtml(title)} <span>${rows.length}</span></h3>`;
  }
  const list = document.createElement("div");
  list.className = "import-list";
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "import-empty";
    empty.textContent = "暂无";
    list.append(empty);
  } else {
    rows.forEach((row, index) => {
      const task = row.task;
      const item = document.createElement("label");
      item.className = `import-row${!task.taskType ? " warning" : ""}`;
      // 无变化组禁用勾选：导入它们没有意义，避免误操作
      const checkbox = selectable
        ? `<input type="checkbox" data-group="${key}" data-index="${index}" ${row.selected ? "checked" : ""} />`
        : '<input type="checkbox" disabled />';
      const diffs = row.diffs?.length
        ? `<div class="import-diffs">${row.diffs.map((diff) => `<span><b>${escapeHtml(diff.label)}</b> ${escapeHtml(diff.from)} → ${escapeHtml(diff.to)}</span>`).join("")}</div>`
        : "";
      const warning = task.taskType ? "" : '<span class="import-warning">类型未匹配，导入后显示为未分类</span>';
      item.innerHTML = `
        ${checkbox}
        <span class="import-row-body">
          <strong>${escapeHtml(importPreviewTaskTitle(task))}</strong>
          <small>${escapeHtml(taskStatusLabel(task.status))} · ${Number(task.quantity) || 1}个 · ${escapeHtml(task.owner || "未指定")}${task.weekday ? ` · ${escapeHtml(task.weekday)}` : ""}</small>
          ${warning}
          ${diffs}
        </span>
      `;
      list.append(item);
    });
  }
  container.append(list);
  return section;
}

function renderImportPreview() {
  if (!importPreviewState || !elements.importPreviewGroups) return;
  const { added, updated, unchanged, unparsed } = importPreviewState;
  elements.importPreviewSummary.textContent =
    `新增 ${added.length} 条，更新 ${updated.length} 条，无变化 ${unchanged.length} 条，无法解析 ${unparsed.length} 条。新增和更新默认勾选。`;
  elements.importPreviewGroups.replaceChildren(
    renderImportPreviewGroup("added", "新增", added),
    renderImportPreviewGroup("updated", "更新", updated),
    renderImportPreviewGroup("unchanged", "无变化", unchanged, { collapsed: true, selectable: false }),
    renderUnparsedImportGroup(unparsed)
  );
  elements.importPreviewGroups.querySelectorAll('input[type="checkbox"][data-group]').forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const rows = importPreviewState?.[checkbox.dataset.group];
      const row = rows?.[Number(checkbox.dataset.index)];
      if (row) row.selected = checkbox.checked;
    });
  });
  const selectedCount = [...added, ...updated, ...unchanged].filter((row) => row.selected).length;
  elements.importPreviewApply.disabled = selectedCount <= 0;
  elements.importPreviewApply.textContent = selectedCount > 0 ? `导入所选 (${selectedCount})` : "导入所选";
  elements.importPreviewGroups.querySelectorAll('input[type="checkbox"][data-group]').forEach((checkbox) => {
    checkbox.addEventListener("change", renderImportPreview);
  });
}

function renderUnparsedImportGroup(lines) {
  const section = document.createElement("section");
  section.className = "import-group";
  section.innerHTML = `<h3>无法解析 <span>${lines.length}</span></h3>`;
  const list = document.createElement("div");
  list.className = "import-list";
  if (!lines.length) {
    const empty = document.createElement("div");
    empty.className = "import-empty";
    empty.textContent = "暂无";
    list.append(empty);
  } else {
    lines.forEach((line) => {
      const item = document.createElement("div");
      item.className = "import-row import-row-unparsed";
      item.textContent = line;
      list.append(item);
    });
  }
  section.append(list);
  return section;
}

function openImportPreview(parsed) {
  importPreviewState = buildTodoImportPreview(parsed.tasks, parsed.unparsed);
  renderImportPreview();
  elements.importPreviewDialog?.showModal();
}

async function applyTodoImportSelection() {
  if (!importPreviewState) return;
  let addedCount = 0;
  let updatedCount = 0;
  const now = Date.now();
  importPreviewState.added.filter((row) => row.selected).forEach((row, index) => {
    weeklyTasks.push(normalizeWeeklyTask({ ...row.task, id: `task-${now}-${index}` }));
    addedCount += 1;
  });
  importPreviewState.updated.filter((row) => row.selected).forEach((row) => {
    const target = weeklyTasks.find((task) => task.id === row.existingId);
    if (!target) return;
    for (const field of TODO_IMPORT_FIELDS) target[field] = row.task[field];
    updatedCount += 1;
  });
  await persistWeeklyTasks();
  elements.importPreviewDialog?.close();
  importPreviewState = null;
  showToast(`导入完成：新增 ${addedCount} 条，更新 ${updatedCount} 条`, "success");
}

function todoReadErrorMessage(error) {
  return {
    "not-configured": "请先选择待做任务.txt",
    "not-found": "待做任务.txt 不存在，请重新选择",
    encoding: "文件编码不是 UTF-8，请用记事本另存为 UTF-8 后再导入"
  }[error] || error || "读取待做任务失败";
}

async function handleTodoImport() {
  try {
    const prefs = await window.workbench.getWorkbenchPrefs();
    if (!prefs?.todoFilePath) {
      const picked = await window.workbench.pickTodoFile();
      if (!picked) return;
      setTodoPathDisplay(picked);
    }
    const result = await window.workbench.readTodoFile();
    if (!result?.ok) {
      showToast(todoReadErrorMessage(result?.error), "error");
      return;
    }
    setTodoPathDisplay(result.path || "");
    openImportPreview(parseTodoLines(result.text));
  } catch (error) {
    console.error("导入待做任务失败:", error);
    showToast("导入待做任务失败", "error");
  }
}

// ===== 任务状态写回待做任务.txt（仅手动触发） =====
let writebackState = null;

function renderWritebackChangedGroup(entries) {
  const changed = entries.filter((entry) => entry.changed);
  const section = document.createElement("section");
  section.className = "import-group";
  section.innerHTML = `<h3>变更 <span>${changed.length}</span></h3>`;
  const list = document.createElement("div");
  list.className = "import-list";
  if (!changed.length) {
    const empty = document.createElement("div");
    empty.className = "import-empty";
    empty.textContent = "暂无";
    list.append(empty);
  } else {
    for (const entry of changed) {
      const item = document.createElement("div");
      item.className = "import-row wb-diff-row";
      item.innerHTML = `
        <span class="import-row-body">
          <small class="wb-diff-old">${escapeHtml(entry.oldLine)}</small>
          <small class="wb-diff-new">${escapeHtml(entry.newLine)}</small>
        </span>
      `;
      list.append(item);
    }
  }
  section.append(list);
  return section;
}

function renderWritebackUnchangedGroup(entries) {
  const unchanged = entries.filter((entry) => !entry.changed && entry.oldLine.trim());
  const section = document.createElement("section");
  section.className = "import-group";
  const details = document.createElement("details");
  details.className = "wb-unchanged";
  details.innerHTML = `<summary>无变化 <span>${unchanged.length}</span>（含未匹配/无法解析行，原样保留）</summary>`;
  const list = document.createElement("div");
  list.className = "import-list";
  for (const entry of unchanged) {
    const item = document.createElement("div");
    item.className = "import-row import-row-unparsed";
    item.textContent = entry.oldLine;
    list.append(item);
  }
  if (!unchanged.length) {
    const empty = document.createElement("div");
    empty.className = "import-empty";
    empty.textContent = "暂无";
    list.append(empty);
  }
  details.append(list);
  section.append(details);
  return section;
}

function renderWritebackOnlyGroup(onlyInWorkbench, appendSelected) {
  const section = document.createElement("section");
  section.className = "import-group";
  section.innerHTML = `<h3>仅工作台 <span>${onlyInWorkbench.length}</span>（默认不写回，勾选后追加到文件末尾）</h3>`;
  const list = document.createElement("div");
  list.className = "import-list";
  if (!onlyInWorkbench.length) {
    const empty = document.createElement("div");
    empty.className = "import-empty";
    empty.textContent = "暂无";
    list.append(empty);
  } else {
    onlyInWorkbench.forEach((task, index) => {
      const item = document.createElement("label");
      item.className = "import-row";
      item.innerHTML = `
        <input type="checkbox" data-append-index="${index}" ${appendSelected.has(index) ? "checked" : ""} />
        <span class="import-row-body">
          <strong>${escapeHtml(importPreviewTaskTitle(task))}</strong>
          <small>${escapeHtml(serializeTodoLine(task))}</small>
        </span>
      `;
      list.append(item);
    });
  }
  section.append(list);
  return section;
}

function renderWritebackPreview() {
  if (!writebackState || !elements.writebackPreviewGroups) return;
  const { merge, appendSelected } = writebackState;
  const changedCount = merge.entries.filter((entry) => entry.changed).length;
  elements.writebackPreviewSummary.textContent =
    `变更 ${changedCount} 行，仅工作台 ${merge.onlyInWorkbench.length} 条（已勾选 ${appendSelected.size}）。确认前将自动备份 待做任务.txt.bak。`;
  elements.writebackPreviewGroups.replaceChildren(
    renderWritebackChangedGroup(merge.entries),
    renderWritebackUnchangedGroup(merge.entries),
    renderWritebackOnlyGroup(merge.onlyInWorkbench, appendSelected)
  );
  elements.writebackPreviewGroups.querySelectorAll("input[data-append-index]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const index = Number(checkbox.dataset.appendIndex);
      if (checkbox.checked) appendSelected.add(index);
      else appendSelected.delete(index);
      renderWritebackPreview();
    });
  });
  elements.writebackPreviewApply.disabled = changedCount <= 0 && appendSelected.size <= 0;
  elements.writebackPreviewApply.textContent =
    changedCount + appendSelected.size > 0 ? `确认写回 (${changedCount + appendSelected.size})` : "确认写回";
}

// 写回待做任务时排除已归档任务（不改文件中原有匹配行，也不追加归档项）
function activeTasksForWriteback(tasks = weeklyTasks) {
  return (Array.isArray(tasks) ? tasks : []).filter((task) => !task?.archived);
}

async function handleTodoWriteback() {
  try {
    const result = await window.workbench.readTodoFile();
    if (!result?.ok) {
      showToast(todoReadErrorMessage(result?.error), "error");
      return;
    }
    const activeTasks = activeTasksForWriteback();
    writebackState = {
      sourceText: result.text,
      merge: mergeTodoFile(result.text, activeTasks),
      appendSelected: new Set()
    };
    renderWritebackPreview();
    elements.writebackPreviewDialog?.showModal();
  } catch (error) {
    console.error("写回预览失败:", error);
    showToast("写回预览失败", "error");
  }
}

async function applyTodoWriteback() {
  if (!writebackState) return;
  const { sourceText, merge, appendSelected } = writebackState;
  const appendTasks = merge.onlyInWorkbench.filter((_task, index) => appendSelected.has(index));
  const finalMerge = mergeTodoFile(sourceText, activeTasksForWriteback(), appendTasks);
  const changedCount = finalMerge.entries.filter((entry) => entry.changed).length;
  try {
    const result = await window.workbench.writeTodoFile(finalMerge.text);
    if (!result?.ok) {
      showToast(`写回失败：${todoReadErrorMessage(result?.error)}`, "error");
      return;
    }
    elements.writebackPreviewDialog?.close();
    showToast(`写回完成：变更 ${changedCount} 行，追加 ${appendTasks.length} 行，备份已生成 .bak`, "success");
  } catch (error) {
    console.error("写回待做任务失败:", error);
    showToast("写回待做任务失败", "error");
  }
}

async function changeTodoFilePath() {
  try {
    const picked = await window.workbench.pickTodoFile();
    if (!picked) return;
    setTodoPathDisplay(picked);
    showToast("待做任务路径已更新", "success");
  } catch (error) {
    console.error("选择待做任务失败:", error);
    showToast("选择待做任务失败", "error");
  }
}

// 上传拦截（缺陷 #2 重做）：main 进程经 CDP 拦截 fileChooser 后推送 upload:choose-files，
// 这里决定注入来源：评估流水线队列优先 → 工作台浮层 → 异常时降级系统选择器
async function resolveUploadRequest(requestId, paths) {
  try {
    const result = await window.workbench.resolveUploadFiles(requestId, paths);
    if (paths.length && !result?.ok) {
      showToast(`文件注入失败：${result?.error || "未知错误"}，请改用系统选择器重试`, "error");
    }
  } catch (error) {
    console.error("上传注入回传失败:", error);
    showToast("文件注入失败，请重新点击上传按钮", "error");
  }
}

async function handleUploadChooseFiles({ requestId } = {}) {
  if (requestId === undefined) return;
  // 拦截开关由 main 按活动任务状态切换；若状态竞态导致无活动任务仍被拦截，降级系统选择器
  if (!pipelineState.active) {
    try {
      const paths = await window.workbench.pickSystemFiles();
      await resolveUploadRequest(requestId, Array.isArray(paths) ? paths : []);
    } catch (error) {
      console.error("降级系统选择器失败:", error);
      await resolveUploadRequest(requestId, []);
    }
    return;
  }
  // 评估流水线自动注入优先（行为与 V3.1 一致，不弹浮层）
  if (pipelineState.uploadQueue.length) {
    const nextPath = pipelineState.uploadQueue.shift();
    await resolveUploadRequest(requestId, nextPath ? [nextPath] : []);
    return;
  }
  if (pendingFilePick) {
    // 已有未完成的选择请求，直接取消新请求防止回调悬挂
    await resolveUploadRequest(requestId, []);
    return;
  }
  openFilePickOverlay((paths) => resolveUploadRequest(requestId, paths));
}

// ===== 全局上传注入浮层 =====
let pendingFilePick = null;
let filePickSelection = new Set();

function resolveFilePick(paths) {
  const callback = pendingFilePick;
  pendingFilePick = null;
  if (callback) {
    try { callback(paths); } catch (error) { console.warn("文件注入回调失败:", error); }
  }
  if (elements.filePickDialog.open) elements.filePickDialog.close();
}

function updateFilePickInjectButton() {
  elements.filePickInject.disabled = !filePickSelection.size;
  elements.filePickInject.textContent = filePickSelection.size
    ? `注入所选文件 (${filePickSelection.size})`
    : "注入所选文件";
}

async function openFilePickOverlay(callback) {
  pendingFilePick = callback;
  filePickSelection = new Set();
  updateFilePickInjectButton();
  elements.filePickList.replaceChildren();

  const folder = pipelineState.taskFolder || "";
  let files = [];
  if (folder) {
    try {
      files = (await window.workbench.listTaskFiles(folder)) || [];
    } catch (error) {
      console.warn("读取任务文件失败:", error);
    }
  }
  if (!pendingFilePick) return;

  if (files.length) {
    for (const file of files.sort((a, b) => b.mtime - a.mtime)) {
      const row = document.createElement("button");
      row.className = "fp-row";
      row.type = "button";
      row.innerHTML = `
        <span class="fp-check" aria-hidden="true">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </span>
        <span class="ra-ico">${fileKindSvg(file.name)}</span>
        <span class="ra-info">
          <span class="ra-name">${escapeHtml(file.relPath || file.name)}</span>
          <span class="ra-sub">${escapeHtml(`${formatFileSize(file.size)} · ${formatFileTime(file.mtime)}`)}</span>
        </span>
      `;
      row.addEventListener("click", () => {
        if (filePickSelection.has(file.path)) {
          filePickSelection.delete(file.path);
          row.classList.remove("selected");
        } else {
          filePickSelection.add(file.path);
          row.classList.add("selected");
        }
        updateFilePickInjectButton();
      });
      elements.filePickList.append(row);
    }
  } else {
    const empty = document.createElement("div");
    empty.className = "fp-empty";
    empty.textContent = "任务文件夹暂无文件。可改用系统选择器。";
    elements.filePickList.append(empty);
  }

  setWebviewPointerEvents(false);
  elements.filePickDialog.showModal();
}

function findTabByUrlPart(part) {
  return tabs.find((tab) => String(tab.url || "").toLowerCase().includes(part));
}

function activateOrCreateTab(id, name, url) {
  const existing = tabs.find((tab) => tab.id === id) || tabs.find((tab) => tab.url === url);
  if (existing) {
    activateTab(existing.id);
    return;
  }
  tabs.push({ id, name, url });
  saveTabs();
  activeTabId = id;
  renderTabs();
}

async function startTaskAutomation(id, subtaskIndex = null) {
  if (pipelineState.active) {
    showToast("当前已有正在运行的任务，请先暂停或结束当前任务。", "error");
    return;
  }
  const task = weeklyTasks.find((candidate) => candidate.id === id);
  if (!task) return;
  const requestedSubtaskIndex = subtaskIndex !== null && Number.isInteger(Number(subtaskIndex)) ? Number(subtaskIndex) : null;
  const targetSubtaskIndex = requestedSubtaskIndex || nextRunnableSubtaskIndex(task);
  const subtasks = taskSubtasks(task);
  const targetSubtask = subtasks.find((subtask) => subtask.index === targetSubtaskIndex);
  const existingRunningIndex = runningSubtaskIndex(task);
  if (existingRunningIndex && existingRunningIndex !== targetSubtaskIndex) {
    showToast(`子任务 ${existingRunningIndex} 尚未结束，请先继续或结束它`, "error");
    return;
  }
  if (!targetSubtask || !["pending", "unconfirmed"].includes(targetSubtask.status)) {
    showToast("没有可开始的子任务，请先检查子任务状态", "error");
    return;
  }
  const previousStatus = task.status;
  const previousStep = task.step;
  const previousSubtasks = subtasks;
  const nextSubtasks = updateSubtaskStatus(task, targetSubtaskIndex, "running");
  const transitionGeneration = ++taskTransitionGeneration;
  // 缺陷 #7：执行先落 prepare（1/5），任务文件夹创建成功后才推进 testing（2/5）
  pipelineState = {
    active: true,
    taskId: id,
    activeSubtaskIndex: targetSubtaskIndex,
    step: "prepare",
    chatPath: task.chatLogPath || "",
    reportPath: task.reportPath || "",
    taskFolder: "",
    uploadQueue: []
  };
  try {
    await updateTaskFields(id, { status: "running", step: "prepare", subtasks: nextSubtasks });
  } catch (error) {
    Object.assign(task, { status: previousStatus, step: previousStep, subtasks: previousSubtasks });
    pipelineState = { active: false, taskId: null, activeSubtaskIndex: null, step: "idle", chatPath: "", reportPath: "", taskFolder: "", uploadQueue: [] };
    await updateTaskRail(null);
    console.error("保存任务启动状态失败:", error);
    showToast("无法保存任务启动状态，任务尚未开始", "error");
    return;
  }
  taskRailCollapsed = false;
  await updateTaskRail(weeklyTasks.find((candidate) => candidate.id === id) || task);
  let taskFolder = "";
  try {
    taskFolder = await window.workbench.prepareTaskFolder(task);
  } catch (error) {
    console.error("创建任务文件夹失败:", error);
  }
  if (transitionGeneration !== taskTransitionGeneration || !pipelineState.active || pipelineState.taskId !== id) {
    if (taskFolder) await window.workbench.cleanupTaskFolder(taskFolder).catch(() => false);
    return;
  }
  if (!taskFolder) {
    pipelineState = { active: false, taskId: null, activeSubtaskIndex: null, step: "idle", chatPath: "", reportPath: "", taskFolder: "", uploadQueue: [] };
    const currentTask = weeklyTasks.find((candidate) => candidate.id === id);
    if (currentTask) Object.assign(currentTask, { status: previousStatus, step: previousStep, subtasks: previousSubtasks });
    try { await persistWeeklyTasks(); } catch (error) { console.error("回滚任务启动状态失败:", error); }
    await updateTaskRail(null);
    showToast("任务文件夹创建失败，流程停留在「准备」步骤，请重试。", "error");
    return;
  }
  pipelineState.taskFolder = taskFolder;
  pipelineState.step = "testing";
  let activeTask;
  try {
    activeTask = await updateTaskFields(id, { taskFolder, step: "testing" });
  } catch (error) {
    await window.workbench.cleanupTaskFolder(taskFolder).catch(() => false);
    pipelineState = { active: false, taskId: null, activeSubtaskIndex: null, step: "idle", chatPath: "", reportPath: "", taskFolder: "", uploadQueue: [] };
    const currentTask = weeklyTasks.find((candidate) => candidate.id === id);
    if (currentTask) Object.assign(currentTask, { status: previousStatus, step: previousStep, taskFolder: "", subtasks: previousSubtasks });
    try { await persistWeeklyTasks(); } catch (rollbackError) { console.error("回滚任务文件夹状态失败:", rollbackError); }
    await updateTaskRail(null);
    console.error("保存任务文件夹状态失败:", error);
    showToast("任务启动状态保存失败，已停止本次任务", "error");
    return;
  }
  await updateTaskRail(activeTask);
  showToast(`已开始子任务 ${targetSubtaskIndex}：${task.school || ""} ${task.course || ""}。测试完成后下载对话文件即可继续。`, "success");
}

async function pauseTaskAutomation(id) {
  taskTransitionGeneration += 1;
  const task = weeklyTasks.find((candidate) => candidate.id === id);
  if (!task) return;

  if (pipelineState.active && pipelineState.taskId === id) {
    task.chatLogPath = pipelineState.chatPath || "";
    task.reportPath = pipelineState.reportPath || "";
    task.taskFolder = pipelineState.taskFolder || "";
    task.step = pipelineState.step || "testing";
  }

  task.status = "paused";
  pipelineState = { active: false, taskId: null, activeSubtaskIndex: null, step: "idle", chatPath: "", reportPath: "", taskFolder: "", uploadQueue: [] };
  await updateTaskRail(null);
  try {
    await persistWeeklyTasks();
  } catch (error) {
    console.error("保存任务暂停状态失败:", error);
    showToast("任务已暂停，但状态保存失败；重启后会自动核对", "error");
    return;
  }
  showToast(`任务已暂停：${task.school || ""} ${task.course || ""}`, "success");
}

async function resumeTaskAutomation(id) {
  const task = weeklyTasks.find((candidate) => candidate.id === id);
  if (!task) return;
  const previousStatus = task.status;
  const activeSubtaskIndex = nextRunnableSubtaskIndex(task);
  if (!activeSubtaskIndex) {
    showToast("该任务没有待继续的子任务", "error");
    return;
  }
  if (taskSubtasks(task).find((subtask) => subtask.index === activeSubtaskIndex)?.status !== "running") {
    await startTaskAutomation(id, activeSubtaskIndex);
    return;
  }

  if (pipelineState.active) {
    showToast("当前已有正在运行的任务，请先暂停或结束当前任务。", "error");
    return;
  }

  const transitionGeneration = ++taskTransitionGeneration;
  let activation;
  try {
    activation = await window.workbench.activateTaskFolder({
      id,
      folderPath: task.taskFolder || "",
      step: task.step || "testing"
    });
  } catch {
    activation = { success: false };
  }
  if (!activation?.success) {
    showToast("任务文件夹已丢失或无效，无法恢复任务", "error");
    return;
  }
  if (transitionGeneration !== taskTransitionGeneration || pipelineState.active) return;

  const assignment = await window.workbench.updateActiveTaskInfo({
    taskId: id,
    step: task.step || "testing",
    folderPath: activation.folderPath
  }).catch(() => ({ success: false }));
  if (!assignment?.success || !assignment.folderPath) {
    showToast("任务文件夹无法在主进程激活，请重试", "error");
    return;
  }
  if (transitionGeneration !== taskTransitionGeneration || pipelineState.active) {
    await window.workbench.updateActiveTaskInfo({}).catch(() => {});
    return;
  }

  pipelineState = {
    active: true,
    taskId: id,
    activeSubtaskIndex,
    step: task.step || "testing",
    chatPath: task.chatLogPath || "",
    reportPath: task.reportPath || "",
    taskFolder: activation.folderPath,
    uploadQueue: []
  };

  const nextStatus = pipelineState.step === "evaluating" ? "evaluating" : "running";
  taskRailCollapsed = false;
  let activeTask;
  try {
    activeTask = await updateTaskFields(id, { status: nextStatus });
  } catch (error) {
    task.status = previousStatus;
    pipelineState = { active: false, taskId: null, activeSubtaskIndex: null, step: "idle", chatPath: "", reportPath: "", taskFolder: "", uploadQueue: [] };
    await updateTaskRail(null);
    console.error("保存任务恢复状态失败:", error);
    showToast("无法保存任务恢复状态，任务保持暂停", "error");
    return;
  }
  await updateTaskRail(activeTask);
  showToast(`任务已恢复执行：${task.school || ""} ${task.course || ""}`, "success");
}

async function handleDownloadCompleted(download) {
  if (download.state && download.state !== "completed") {
    const label = download.state === "cancelled" ? "下载已取消" : "下载失败或中断";
    showToast(`${label}: ${download.filename || download.originalFilename || "未知文件"}`, "error");
    return;
  }

  const matchesActiveTask = pipelineState.active
    && pipelineState.taskId
    && (!download.taskId || download.taskId === pipelineState.taskId);
  if (download.captured && download.taskId && !matchesActiveTask) {
    const targetTask = weeklyTasks.find((task) => task.id === download.taskId);
    if (targetTask && download.type === "chat") {
      if (!["prepare", "testing"].includes(targetTask.step)) {
        showToast(`已忽略原任务的过期对话下载: ${download.filename}`, "error");
        return;
      }
      await updateTaskFields(download.taskId, {
        status: "paused",
        chatLogPath: download.path,
        step: "evaluating"
      });
      scheduleArtifactRefresh(download.taskId, { force: true });
    } else if (targetTask && download.type === "report") {
      if (targetTask.step !== "evaluating") {
        showToast(`已忽略原任务的过期报告下载: ${download.filename}`, "error");
        return;
      }
      await updateTaskFields(download.taskId, {
        status: "completed",
        reportPath: download.path,
        step: "report"
      });
      scheduleArtifactRefresh(download.taskId, { force: true });
    }
    showToast(`下载已归档到原任务文件夹: ${download.filename}`, "success");
    return;
  }
  if (!pipelineState.active || !pipelineState.taskId) {
    const destination = download.captured ? "任务文件夹" : "系统下载文件夹";
    showToast(`已下载到${destination}: ${download.filename}`, "success");
    return;
  }

  if (download.type === "generic") {
    if (download.captured) {
      showToast(`已捕获到任务文件夹: ${download.filename}`, "success");
      scheduleArtifactRefresh(pipelineState.taskId, { force: true });
    }
    return;
  }

  if (download.type === "chat") {
    if (!["prepare", "testing"].includes(pipelineState.step)) {
      showToast(`已忽略当前步骤不再需要的对话下载: ${download.filename}`, "error");
      return;
    }
    pipelineState.chatPath = download.path;
    pipelineState.step = "evaluating";
    const task = await updateTaskFields(pipelineState.taskId, { status: "evaluating", chatLogPath: download.path, step: "evaluating" });
    updateTaskRail(task);
    scheduleArtifactRefresh(pipelineState.taskId, { force: true });
    activateOrCreateTab("evaluation", "评估", "https://www.wl363eval.top/");
    setTimeout(() => runEvaluationUpload(), 1200);
    return;
  }

  if (download.type === "report") {
    if (pipelineState.step !== "evaluating") {
      showToast(`已忽略当前步骤不再需要的报告下载: ${download.filename}`, "error");
      return;
    }
    pipelineState.reportPath = download.path;
    pipelineState.step = "report";
    const task = await updateTaskFields(pipelineState.taskId, { status: "completed", reportPath: download.path, step: "report" });
    updateTaskRail(task);
    scheduleArtifactRefresh(pipelineState.taskId, { force: true });
    // 前台始终 toast；后台系统通知由 main 在窗口未聚焦时发出
    showToast("评估报告已保存，可在任务舱「加载至 Hermes」后确认发送。", "success");
  }
}

function runEvaluationUpload() {
  const webview = activeWebview();
  if (!webview || !pipelineState.chatPath) return;
  pipelineState.uploadQueue = [pipelineState.chatPath];
  // M1：上传控件 click 未触发拦截时 uploadQueue 会残留，导致之后任意网页点上传被静默注入
  // dialogue.json 而非弹浮层。设超时兜底：到点仍未消费则清空队列。
  const queuePath = pipelineState.chatPath;
  const clearStaleQueue = () => {
    if (pipelineState.uploadQueue[0] === queuePath) pipelineState.uploadQueue = [];
  };
  const failTimer = setTimeout(clearStaleQueue, 8000);
  webview.executeJavaScript(`
    (() => {
      const input = document.querySelector('input[type="file"]');
      input?.click();
      const submit = document.querySelector('button[type="submit"], input[type="submit"], .submit, .send-btn');
      if (submit) setTimeout(() => submit.click(), 700);
      return { fileInputs: input ? 1 : 0, submitted: Boolean(submit) };
    })();
  `).then((result) => {
    if (!result?.fileInputs) {
      clearTimeout(failTimer);
      clearStaleQueue();
      showToast("评估页没有检测到文件上传控件，请手动上传后继续。", "error");
    }
  }).catch((error) => {
    clearTimeout(failTimer);
    clearStaleQueue();
    console.error("自动上传评估文件失败:", error);
    showToast("自动上传评估文件失败，请检查页面是否已加载完成。", "error");
  });
}

function runHermesPrompt() {
  const hermesTab = findTabByUrlPart("hermes");
  if (!hermesTab) {
    showToast("报告已记录。未找到 Hermes 标签页，请打开后粘贴自动分析提示。", "success");
    return;
  }
  if (pipelineState.active) {
    pipelineState.step = "hermes";
    updateTaskRail(weeklyTasks.find((candidate) => candidate.id === pipelineState.taskId) || null);
  }
  activateTab(hermesTab.id);
  const promptText = [
    `测试对话记录地址：${pipelineState.chatPath || ""}`,
    `评估报告地址：${pipelineState.reportPath || ""}`,
    "请读取上述本地文件路径后进行诊断分析。"
  ].join("\n");
  setTimeout(() => {
    const webview = activeWebview();
    webview?.executeJavaScript(`
      (() => {
        const text = ${JSON.stringify(promptText)};
        const input = document.querySelector('textarea, [contenteditable="true"], #prompt-input');
        if (!input) return false;
        if (input.isContentEditable) input.textContent = text;
        else input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })();
    `).then((ok) => {
      if (ok) showToast("已加载至 Hermes 输入框，请确认后手动发送。", "success");
      else showToast("Hermes 页面未检测到输入框，请手动粘贴分析提示。", "error");
    }).catch((error) => {
      console.error("Hermes 自动填充失败:", error);
      showToast("Hermes 自动填充失败，请手动粘贴分析提示。", "error");
    });
  }, 900);
}

async function openSettings() {
  elements.extensionList.replaceChildren();
  const { entries, results } = await window.workbench.getExtensions();
  if (entries.length) entries.forEach(extensionRow);
  else extensionRow();
  renderExtensionResults(results);
  renderExtensionsInTopbar(results);
  elements.settingsDialog.showModal();
}

function renderExtensionResults(results) {
  document.querySelector("#extension-result").innerHTML = results.length
    ? results.map((result) => `
        <div class="extension-status-card ${result.ok ? "success" : "error"}">
          <span class="extension-status-dot"></span>
          <strong>${escapeHtml(result.name || result.id || result.path)}</strong>
          ${result.version ? `<span>v${escapeHtml(result.version)}</span>` : ""}
          <span>${escapeHtml(result.message)}</span>
        </div>
      `).join("")
    : "<span class=\"extension-empty\">尚未加载扩展。</span>";
}

function renderExtensionsInTopbar(results) {
  elements.extensionsBar.replaceChildren();
  for (const extension of results.filter((result) => result.ok && result.popupPage)) {
    const button = document.createElement("button");
    button.className = "icon-button extension-trigger-button";
    button.type = "button";
    button.title = extension.name;
    button.setAttribute("aria-label", `打开扩展 ${extension.name}`);

    if (extension.iconDataUrl) {
      const image = document.createElement("img");
      image.src = extension.iconDataUrl;
      image.alt = "";
      button.append(image);
    } else {
      const initial = document.createElement("span");
      initial.textContent = extension.name?.[0] || "E";
      button.append(initial);
    }

    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const popupUrl = `chrome-extension://${extension.id}/${extension.popupPage.replace(/^\/+/, "")}`;
      toggleTabExtension(activeTabId, extension.name, popupUrl);
    });
    elements.extensionsBar.append(button);
  }
}

function toggleTabExtension(tabId, name, url) {
  const viewport = document.querySelector(`.tab-viewport[data-id="${tabId}"]`);
  const extPanel = viewport?.querySelector(".tab-extension-panel");
  const extBody = viewport?.querySelector(".tab-extension-body");
  const extTitle = viewport?.querySelector(".tab-extension-title");
  // 缺陷 #4：任务中心/桌面应用/CLI 等非 web 标签没有扩展面板结构，guard + toast，不崩不静默
  if (!viewport || !extPanel || !extBody || !extTitle) {
    showToast("当前标签页不支持扩展面板", "error");
    return;
  }

  // Check if this extension is already open
  const existingWebview = extBody.querySelector("webview");
  const isOpen = extPanel.classList.contains("open") && existingWebview && existingWebview.src === url;

  if (isOpen) {
    // Close it
    extPanel.classList.remove("open");
    extPanel.style.removeProperty("--tab-ext-width");
    extBody.replaceChildren();
  } else {
    // Open it
    extTitle.textContent = name;
    extPanel.classList.add("open");

    // Clear and create/re-use webview
    extBody.replaceChildren();
    const extWebview = document.createElement("webview");
    const extensionId = new URL(url).hostname;
    const allowedExtensionPrefix = `chrome-extension://${extensionId}/`;
    const isAllowedExtensionUrl = (candidate) => String(candidate || "").startsWith(allowedExtensionPrefix);
    extWebview.className = "tab-extension-webview";
    extWebview.src = url;
    extWebview.partition = "persist:personal-workbench";
    extWebview.preload = "./preload-popup.js";
    extWebview.setAttribute("webpreferences", "contextIsolation=no");
    extWebview.addEventListener("will-navigate", (event) => {
      if (isAllowedExtensionUrl(event.url)) return;
      event.preventDefault();
      showToast("已阻止扩展面板跳转到外部页面", "error");
    });
    extWebview.addEventListener("did-navigate", (event) => {
      if (!isAllowedExtensionUrl(event.url)) extWebview.src = url;
    });
    extWebview.addEventListener("dom-ready", () => {
      console.info(`[扩展面板] ${name} 已就绪: ${url}`);
    });
    extWebview.addEventListener("console-message", (event) => {
      const message = `[扩展面板:${name}] ${event.message}`;
      if (event.level >= 2) {
        console.error(message);
      } else {
        console.info(message);
      }
    });
    extWebview.addEventListener("did-fail-load", (event) => {
      const detail = `${event.errorCode || ""} ${event.errorDescription || "扩展页面加载失败"}`.trim();
      console.error(`[扩展面板:${name}] 加载失败: ${detail}`);
      showToast(`扩展面板加载失败：${name}`, "error");
    });
    extBody.append(extWebview);
  }

  setTimeout(() => {
    fitWebviewZoom();
  }, 230);
}

function toggleRightSidebar(open, tabId = null) {
  if (open && tabId) {
    if (tabs.length < 2) {
      showToast("至少需要两个标签页才能开启分屏", "error");
      return;
    }
    rightSplitTabId = tabId;
    if (bottomSplitTabId === tabId) {
      bottomSplitTabId = null;
      elements.workspace.classList.remove("bottom-sidebar-open");
    }
    if (window.innerWidth <= 1050 && pipelineState.active && !taskRailCollapsed) {
      taskRailCollapsed = true;
      renderTaskRail(weeklyTasks.find((task) => task.id === pipelineState.taskId) || null);
    }
    elements.appShell.classList.add("right-sidebar-open");
    if (activeTabId === rightSplitTabId) {
      const otherTab = tabs.find(t => t.id !== rightSplitTabId && t.id !== bottomSplitTabId);
      if (otherTab) activeTabId = otherTab.id;
    }
    elements.rightSidebarTitle.textContent = tabs.find(t => t.id === rightSplitTabId)?.name || "分屏视图";
  } else {
    rightSplitTabId = null;
    elements.appShell.classList.remove("right-sidebar-open");
    document.documentElement.style.removeProperty("--right-sidebar-width");
  }
  
  // Re-run activateTab to update viewport DOM locations
  activateTab(activeTabId);
  
  setTimeout(() => {
    if (typeof fitAddon?.fit === "function") fitAddon.fit();
    fitWebviewZoom();
  }, 230);
}

function toggleBottomSidebar(open, tabId = null) {
  if (open && tabId) {
    const requiredTabs = rightSplitTabId ? 3 : 2;
    if (tabs.length < requiredTabs) {
      showToast(`当前分屏需要至少 ${requiredTabs} 个标签页`, "error");
      return;
    }
    bottomSplitTabId = tabId;
    if (rightSplitTabId === tabId) {
      rightSplitTabId = null;
      elements.appShell.classList.remove("right-sidebar-open");
    }
    elements.workspace.classList.add("bottom-sidebar-open");
    if (activeTabId === bottomSplitTabId) {
      const otherTab = tabs.find(t => t.id !== bottomSplitTabId && t.id !== rightSplitTabId);
      if (otherTab) activeTabId = otherTab.id;
    }
    elements.bottomSidebarTitle.textContent = tabs.find(t => t.id === bottomSplitTabId)?.name || "底部分屏视图";
  } else {
    bottomSplitTabId = null;
    elements.workspace.classList.remove("bottom-sidebar-open");
    document.documentElement.style.removeProperty("--bottom-sidebar-height");
  }
  
  // Re-run activateTab to update viewport DOM locations
  activateTab(activeTabId);
  
  setTimeout(() => {
    if (typeof fitAddon?.fit === "function") fitAddon.fit();
    fitWebviewZoom();
  }, 230);
}

function setSidebarCollapsed(collapsed) {
  elements.appShell.classList.toggle("sidebar-collapsed", collapsed);
  document.querySelector("#sidebar-toggle").setAttribute("aria-expanded", String(!collapsed));
  localStorage.setItem(sidebarStorageKey, String(collapsed));
}

function moveTab(direction) {
  const id = document.querySelector("#tab-id").value;
  const index = tabs.findIndex((tab) => tab.id === id);
  const targetIndex = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || targetIndex < 0 || targetIndex >= tabs.length) return;
  [tabs[index], tabs[targetIndex]] = [tabs[targetIndex], tabs[index]];
  saveTabs();
  elements.tabDialog.close();
  renderTabs();
  activateTab(id);
}

document.querySelector("#add-tab-button").addEventListener("click", () => openTabDialog());
elements.menuSettingsButton?.addEventListener("click", () => {
  elements.menuMorePop.classList.remove("open");
  openSettings();
});
elements.menuReloadButton?.addEventListener("click", () => {
  elements.menuMorePop.classList.remove("open");
  activeWebview()?.reload?.();
});
function setPrefsFeedback(message = "", type = "") {
  if (!elements.prefsFeedback) return;
  elements.prefsFeedback.textContent = message;
  elements.prefsFeedback.dataset.type = type;
  const isError = type === "error";
  elements.prefsFeedback.setAttribute("role", isError ? "alert" : "status");
  elements.prefsFeedback.setAttribute("aria-live", isError ? "assertive" : "polite");
}

// 工作台偏好：裁切方向 + 像素数
elements.menuPrefsButton?.addEventListener("click", async () => {
  elements.menuMorePop.classList.remove("open");
  setPrefsFeedback();
  try {
    const prefs = await window.workbench.getWorkbenchPrefs();
    elements.prefTheme.value = normalizeWorkbenchTheme(prefs?.theme);
    elements.prefCropSide.value = prefs?.cropSide || "bottom";
    elements.prefCropPixels.value = prefs?.cropPixels || 100;
    setTodoPathDisplay(prefs?.todoFilePath || "");
    weeklyReportDefaults = normalizeWeeklyReportDefaults(prefs?.weeklyReportDefaults);
    if (elements.prefReportAuthor) elements.prefReportAuthor.value = weeklyReportDefaults.author;
    if (elements.prefReportTitlePattern) elements.prefReportTitlePattern.value = weeklyReportDefaults.titlePattern;
    if (elements.prefPlatformMap) {
      const map = prefs?.platformFieldMap || {};
      elements.prefPlatformMap.value = Object.keys(map).length ? JSON.stringify(map, null, 2) : "";
    }
  } catch {
    elements.prefTheme.value = normalizeWorkbenchTheme(document.body.dataset.theme);
    elements.prefCropSide.value = "bottom";
    elements.prefCropPixels.value = 100;
    setTodoPathDisplay("");
    weeklyReportDefaults = { author: "", titlePattern: "" };
    if (elements.prefReportAuthor) elements.prefReportAuthor.value = "";
    if (elements.prefReportTitlePattern) elements.prefReportTitlePattern.value = "";
    if (elements.prefPlatformMap) elements.prefPlatformMap.value = "";
  }
  elements.prefsDialog.showModal();
});
document.querySelectorAll(".prefs-close").forEach((button) =>
  button.addEventListener("click", () => elements.prefsDialog.close())
);
elements.prefsForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  // platformFieldMap：空白视为清空；非法 JSON 阻止保存并提示，不污染偏好
  let platformFieldMap = {};
  const rawMap = elements.prefPlatformMap?.value.trim();
  if (rawMap) {
    try {
      const parsed = JSON.parse(rawMap);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("需为对象");
      platformFieldMap = parsed;
    } catch (error) {
      setPrefsFeedback(`平台字段映射 JSON 格式错误：${error.message}`, "error");
      return;
    }
  }
  const weeklyReportDefaultsNext = normalizeWeeklyReportDefaults({
    author: elements.prefReportAuthor?.value || "",
    titlePattern: elements.prefReportTitlePattern?.value || ""
  });
  const savedPrefs = await window.workbench.setWorkbenchPrefs({
    theme: applyWorkbenchTheme(elements.prefTheme.value),
    cropSide: elements.prefCropSide.value,
    cropPixels: Number(elements.prefCropPixels.value),
    platformFieldMap,
    weeklyReportDefaults: weeklyReportDefaultsNext
  });
  weeklyReportDefaults = normalizeWeeklyReportDefaults(savedPrefs?.weeklyReportDefaults || weeklyReportDefaultsNext);
  elements.prefsDialog.close();
  showToast("工作台偏好已保存", "success");
});
// 平台单字段试注入（V3.4 P1）：读取偏好映射 → 取当前激活 webview → 注入指定字段
elements.prefInjectRun?.addEventListener("click", async () => {
  const field = elements.prefInjectField?.value.trim();
  const value = elements.prefInjectValue?.value ?? "";
  if (!field) {
    setPrefsFeedback("请填写要试注入的字段名", "error");
    return;
  }
  let prefs;
  try {
    prefs = await window.workbench.getWorkbenchPrefs();
  } catch {
    setPrefsFeedback("读取偏好失败", "error");
    return;
  }
  const selector = prefs?.platformFieldMap?.[field];
  if (!selector) {
    setPrefsFeedback(`字段「${field}」未在映射中配置选择器`, "error");
    return;
  }
  const webview = activeWebview();
  if (!webview) {
    setPrefsFeedback("当前标签页不是网页，无法注入。请先切换到平台网页标签。", "error");
    return;
  }
  let webContentsId;
  try {
    webContentsId = webview.getWebContentsId();
  } catch {
    setPrefsFeedback("当前网页尚未加载完成，请稍后重试", "error");
    return;
  }
  try {
    const result = await window.workbench.testInjectField(webContentsId, selector, value);
    if (result?.ok) {
      setPrefsFeedback(`试注入成功（${result.kind}）：${field} → ${selector}`, "success");
    } else {
      setPrefsFeedback(`试注入失败：${result?.error || "未知错误"}`, "error");
    }
  } catch (error) {
    console.error("试注入失败:", error);
    setPrefsFeedback("试注入调用失败", "error");
  }
});
document.querySelectorAll("[data-command]").forEach((button) => {
  button.addEventListener("click", () => {
    elements.menuMorePop.classList.remove("open");
    document.execCommand(button.dataset.command);
  });
});
// 「⋯ 更多」popover：click 展开 + 外点关闭（composedPath 判定）
elements.menuMoreButton?.addEventListener("click", () => {
  elements.menuMorePop.classList.toggle("open");
});
window.workbench.onMenuToggleTasks(() => activateTab(TASK_CENTER_ID));
window.workbench.onMenuToggleTerminal(() => toggleTerminal());
window.workbench.onMenuOpenSettings(openSettings);
elements.navTaskCenter?.addEventListener("click", () => activateTab(TASK_CENTER_ID));
setupWeeklyReportEvents();
elements.addNewTask?.addEventListener("click", () => openTaskForm());
elements.btnImportTodo?.addEventListener("click", () => handleTodoImport());
elements.btnWritebackTodo?.addEventListener("click", () => handleTodoWriteback());
// 任务中心筛选：搜索 debounce ~150ms；chip / 学校即时刷新列表
elements.taskSearch?.addEventListener("input", () => {
  clearTimeout(taskSearchDebounceTimer);
  taskSearchDebounceTimer = setTimeout(() => {
    taskCenterFilters.query = elements.taskSearch.value || "";
    renderTaskCenter();
  }, 150);
});
elements.taskFilterChips?.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-status-filter]");
  if (!chip) return;
  taskCenterFilters.status = chip.dataset.statusFilter || "all";
  renderTaskCenter();
});
elements.taskSchoolFilter?.addEventListener("change", () => {
  taskCenterFilters.school = elements.taskSchoolFilter.value || "";
  renderTaskCenter();
});
elements.writebackPreviewApply?.addEventListener("click", () => applyTodoWriteback());
elements.writebackPreviewCancel?.addEventListener("click", () => elements.writebackPreviewDialog?.close());
elements.writebackPreviewCancelX?.addEventListener("click", () => elements.writebackPreviewDialog?.close());
elements.writebackPreviewDialog?.addEventListener("close", () => {
  writebackState = null;
});
elements.prefTodoChange?.addEventListener("click", (event) => {
  event.preventDefault();
  changeTodoFilePath();
});
elements.importPreviewApply?.addEventListener("click", () => applyTodoImportSelection());
elements.importPreviewCancel?.addEventListener("click", () => elements.importPreviewDialog?.close());
elements.importPreviewCancelX?.addEventListener("click", () => elements.importPreviewDialog?.close());
elements.importPreviewDialog?.addEventListener("close", () => {
  importPreviewState = null;
});
elements.sbTerminal?.addEventListener("click", () => toggleTerminal());
elements.sbTaskChip?.addEventListener("click", expandTaskRail);
elements.railHandle?.addEventListener("click", expandTaskRail);
elements.railCollapse?.addEventListener("click", collapseTaskRail);
elements.railHermes?.addEventListener("click", () => runHermesPrompt());
elements.railCardsStream?.addEventListener("change", () => {
  railCardsStreamOn = Boolean(elements.railCardsStream.checked);
  updateCardStreamHighlight();
});
elements.railCardsReparse?.addEventListener("click", async () => {
  if (!pipelineState.active) return;
  const task = weeklyTasks.find((candidate) => candidate.id === pipelineState.taskId);
  const folder = pipelineState.taskFolder || task?.taskFolder || "";
  if (!task || !folder) return;
  let files = [];
  try {
    files = (await window.workbench.listTaskFiles(folder)) || [];
  } catch (error) {
    console.warn("重新解析读取任务文件失败:", error);
  }
  const cardsFile = files.find((file) => /^cards\.md$/i.test(file.name));
  await syncRailCards(task, cardsFile || null, true);
  showToast(cardsFile ? "cards.md 已重新解析" : "任务文件夹内未找到 cards.md", cardsFile ? "success" : "error");
});
elements.railPause?.addEventListener("click", () => {
  if (pipelineState.taskId) pauseTaskAutomation(pipelineState.taskId);
});
elements.railFinish?.addEventListener("click", () => finishActiveTask());
elements.finishTaskSubmitted?.addEventListener("click", () => {
  elements.finishTaskDialog?.close();
  completeActiveTask(true);
});
elements.finishTaskUnsubmitted?.addEventListener("click", () => {
  elements.finishTaskDialog?.close();
  completeActiveTask(false);
});
elements.finishTaskCancel?.addEventListener("click", () => elements.finishTaskDialog?.close());
elements.finishTaskCancelX?.addEventListener("click", () => elements.finishTaskDialog?.close());
elements.deleteTaskConfirm?.addEventListener("click", async () => {
  const id = pendingDeleteTaskId;
  pendingDeleteTaskId = null;
  elements.deleteTaskDialog?.close();
  if (id) await performDeleteWeeklyTask(id);
});
elements.deleteTaskCancel?.addEventListener("click", () => elements.deleteTaskDialog?.close());
elements.deleteTaskCancelX?.addEventListener("click", () => elements.deleteTaskDialog?.close());
elements.deleteTaskDialog?.addEventListener("close", () => { pendingDeleteTaskId = null; });
elements.filePickInject?.addEventListener("click", () => {
  if (filePickSelection.size) resolveFilePick([...filePickSelection]);
});
elements.filePickSystem?.addEventListener("click", async () => {
  try {
    const paths = await window.workbench.pickSystemFiles();
    resolveFilePick(Array.isArray(paths) ? paths : []);
  } catch (error) {
    console.error("系统选择器调用失败:", error);
    resolveFilePick([]);
  }
});
elements.filePickCancel?.addEventListener("click", () => resolveFilePick([]));
elements.filePickClose?.addEventListener("click", () => resolveFilePick([]));
// ESC / dialog 关闭 = 取消本次选择；恢复 webview 指针事件
elements.filePickDialog?.addEventListener("close", () => {
  setWebviewPointerEvents(true);
  if (pendingFilePick) {
    const callback = pendingFilePick;
    pendingFilePick = null;
    try { callback([]); } catch {}
  }
});
document.querySelector("#sidebar-toggle").addEventListener("click", () => {
  setSidebarCollapsed(!elements.appShell.classList.contains("sidebar-collapsed"));
});
document.querySelector("#go-button").addEventListener("click", navigateToAddress);
elements.addressInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") navigateToAddress();
});
document.querySelector("#back-button").addEventListener("click", () => {
  try {
    const webview = activeWebview();
    if (webview && webview.canGoBack()) webview.goBack();
  } catch (error) {
    console.warn("后退失败:", error);
  }
});
document.querySelector("#forward-button").addEventListener("click", () => {
  try {
    const webview = activeWebview();
    if (webview && webview.canGoForward()) webview.goForward();
  } catch (error) {
    console.warn("前进失败:", error);
  }
});
document.querySelector("#reload-button").addEventListener("click", () => {
  try {
    const webview = activeWebview();
    if (!webview) return;
    webview.isLoading() ? webview.stop() : webview.reload();
  } catch (error) {
    console.warn("重新加载失败:", error);
  }
});

document.querySelector("#get-task-id-button").addEventListener("click", () => {
  let url = "";
  try {
    url = elements.addressInput.value || activeWebview()?.getURL?.() || "";
  } catch (error) {
    url = elements.addressInput.value || "";
  }
  if (!url) {
    showToast("当前没有打开的网页网址", "error");
    return;
  }
  try {
    const parsed = new URL(url);
    const id = parsed.searchParams.get("trainTaskId") || parsed.searchParams.get("train_task_id");
    if (id) {
      navigator.clipboard.writeText(id).then(() => {
        showToast(`已复制 trainTaskId: ${id}`, "success");
      }).catch(() => {
        showToast("复制到剪贴板失败，请重试", "error");
      });
    } else {
      showToast("当前网址中未包含 trainTaskId 参数", "error");
    }
  } catch {
    showToast("无法解析当前网址，请确认网址格式是否正确", "error");
  }
});

function showToast(message, type = "success") {
  let container = document.querySelector(".toast-container");
  if (!container) {
    container = document.createElement("div");
    container.className = "toast-container";
    document.body.append(container);
  }
  const toast = document.createElement("div");
  toast.className = `toast-message ${type}`;
  toast.setAttribute("role", type === "error" ? "alert" : "status");
  toast.setAttribute("aria-live", type === "error" ? "assertive" : "polite");
  toast.textContent = message;
  container.append(toast);
  setTimeout(() => toast.classList.add("show"), 10);
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}
document.querySelector("#terminal-close").addEventListener("click", () => toggleTerminal(false));
elements.rightSidebarClose.addEventListener("click", () => toggleRightSidebar(false));
elements.bottomSidebarClose.addEventListener("click", () => toggleBottomSidebar(false));

document.querySelectorAll(".dialog-close").forEach((button) => button.addEventListener("click", () => elements.tabDialog.close()));
document.querySelectorAll(".settings-close").forEach((button) => button.addEventListener("click", () => elements.settingsDialog.close()));
document.querySelectorAll(".task-cancel").forEach((button) => button.addEventListener("click", closeTaskForm));

elements.taskForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const task = taskFromForm();
  if (!task.school || !task.course) {
    showToast("请填写学校和课程", "error");
    return;
  }
  if (pipelineState.active && pipelineState.taskId === task.id) {
    showToast("当前任务正在执行，请先暂停或结束后再修改状态", "error");
    return;
  }
  await upsertWeeklyTask(task);
  closeTaskForm();
  showToast("任务已保存", "success");
});

document.querySelector("#task-reset-button")?.addEventListener("click", resetTaskForm);

elements.tabForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const id = document.querySelector("#tab-id").value || `tab-${Date.now()}`;
  const type = document.querySelector("#tab-type").value;
  
  const data = {
    id,
    name: document.querySelector("#tab-name").value.trim(),
    type
  };

  if (type === "web") {
    data.url = normalizeUrl(document.querySelector("#tab-url").value);
  } else if (type === "local-web") {
    data.localPath = document.querySelector("#tab-local-path").value.trim();
    data.url = `http://127.0.0.1:38924/local-apps/${id}/index.html`;
  } else if (type === "desktop-app") {
    data.exePath = document.querySelector("#tab-exe-path").value.trim();
    data.exeCwd = document.querySelector("#tab-exe-cwd").value.trim();
    data.autoLaunch = document.querySelector("#tab-exe-autolaunch").checked;
    data.embedMode = document.querySelector("#tab-exe-embed").checked;
  } else if (type === "cli-app") {
    data.command = document.querySelector("#tab-cli-command").value.trim();
    data.cwd = document.querySelector("#tab-cli-cwd").value.trim();
  } else if (type === "builtin") {
    data.builtinType = document.querySelector("#tab-builtin-type").value;
  }

  const existing = tabs.findIndex((tab) => tab.id === data.id);
  if (existing >= 0) {
    tabs[existing] = data;
    runTabCleanup(data.id);
    document.querySelector(`.tab-viewport[data-id="${data.id}"]`)?.remove();
  } else {
    tabs.push(data);
  }

  if (type === "local-web" && data.localPath) {
    window.workbench.registerLocalApp(data.id, data.localPath);
  }

  saveTabs();
  activeTabId = data.id;
  elements.tabDialog.close();
  renderTabs();
});

document.querySelector("#delete-tab-button").addEventListener("click", () => {
  const id = document.querySelector("#tab-id").value;
  if (!id || tabs.length === 1) return;
  
  if (rightSplitTabId === id) {
    toggleRightSidebar(false);
  }
  if (bottomSplitTabId === id) {
    toggleBottomSidebar(false);
  }
  
  runTabCleanup(id);

  tabs = tabs.filter((tab) => tab.id !== id);
  document.querySelector(`.tab-viewport[data-id="${id}"]`)?.remove();
  
  if (activeTabId === id) {
    activeTabId = tabs[0].id;
  }
  
  saveTabs();
  elements.tabDialog.close();
  renderTabs();
});
document.querySelector("#move-up-tab-button").addEventListener("click", () => moveTab("up"));
document.querySelector("#move-down-tab-button").addEventListener("click", () => moveTab("down"));

document.querySelector("#add-extension-button").addEventListener("click", () => extensionRow());
document.querySelector("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const entries = [...document.querySelectorAll(".extension-row")].map((row) => ({
      enabled: row.querySelector(".extension-enabled").checked,
      id: row.querySelector(".extension-id").value.trim(),
      path: row.querySelector(".extension-path").value.trim()
    })).filter((entry) => entry.id || entry.path);
    
    const results = await window.workbench.saveExtensions(entries);
    renderExtensionResults(results);
    renderExtensionsInTopbar(results);
    
    // 自动关闭窗口
    elements.settingsDialog.close();
    
    // 弹出 Toast 反馈
    const failCount = results.filter(r => !r.ok).length;
    if (failCount > 0) {
      showToast(`扩展保存成功，但有 ${failCount} 个加载失败！`, "error");
    } else {
      showToast(results.length ? "扩展配置已成功保存并加载！" : "扩展配置已保存（当前无启用扩展）", "success");
    }
  } catch (error) {
    console.error("保存扩展失败:", error);
    showToast(`保存扩展失败: ${error.message || error}`, "error");
  }
});

document.querySelector("#refresh-extensions-button").addEventListener("click", async () => {
  try {
    const results = await window.workbench.refreshExtensions();
    renderExtensionResults(results);
    renderExtensionsInTopbar(results);
    
    const failCount = results.filter(r => !r.ok).length;
    if (failCount > 0) {
      showToast(`扩展重新加载成功，但有 ${failCount} 个加载失败！`, "error");
    } else {
      showToast(results.length ? "所有扩展已重新加载成功！" : "已重新加载（当前无启用扩展）", "success");
    }
  } catch (error) {
    console.error("刷新扩展失败:", error);
    showToast(`刷新扩展失败: ${error.message || error}`, "error");
  }
});

const resizer = document.querySelector("#terminal-resizer");
const terminalHeader = document.querySelector(".terminal-header");

function beginTerminalResize(event) {
  if (event.button !== 0 || event.target.closest("button")) return;
  event.preventDefault();
  endAllResizes();
  const handle = event.currentTarget;
  handle.setPointerCapture(event.pointerId);
  elements.appShell.classList.add("resizing");
  setWebviewPointerEvents(false);
  const startY = event.clientY;
  const startHeight = elements.terminalPanel.getBoundingClientRect().height;
  const onMove = (moveEvent) => {
    if (moveEvent.buttons === 0) {
      onUp();
      return;
    }
    const height = Math.max(180, Math.min(window.innerHeight * 0.7, startHeight + startY - moveEvent.clientY));
    document.documentElement.style.setProperty("--terminal-height", `${height}px`);
    fitAddon.fit();
    window.workbench.resizeTerminal({ cols: terminal.cols, rows: terminal.rows });
  };
  const onUp = () => {
    if (activeResizeEnd === onUp) activeResizeEnd = null;
    try {
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    } catch {}
    elements.appShell.classList.remove("resizing");
    setWebviewPointerEvents(true);
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
  };
  activeResizeEnd = onUp;
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onUp);
}

resizer.addEventListener("pointerdown", beginTerminalResize);
terminalHeader.addEventListener("pointerdown", beginTerminalResize);

let lastResizeTime = 0;
let resizeTimeout = null;

function throttleResizeEmbedded(tabId, rect) {
  const now = Date.now();
  if (now - lastResizeTime > 150) {
    window.workbench.resizeEmbeddedWindow(tabId, rect);
    lastResizeTime = now;
  } else {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      window.workbench.resizeEmbeddedWindow(tabId, rect);
      lastResizeTime = Date.now();
    }, 150);
  }
}

function updateAllEmbeddedPositions(throttled = false) {
  const visibleIds = [activeTabId, rightSplitTabId, bottomSplitTabId].filter(Boolean);
  tabs.forEach((candidate) => {
    if (candidate.type === "desktop-app" && candidate.embedMode && visibleIds.includes(candidate.id)) {
      const viewport = document.querySelector(`.tab-viewport[data-id="${candidate.id}"]`);
      const container = viewport?.querySelector(".desktop-embed-container");
      if (container) {
        const rect = container.getBoundingClientRect();
        const coords = {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height
        };
        if (throttled) {
          throttleResizeEmbedded(candidate.id, coords);
        } else {
          window.workbench.resizeEmbeddedWindow(candidate.id, coords);
        }
      }
    }
  });
}

function beginRightSidebarResize(event) {
  if (event.button !== 0) return;
  event.preventDefault();
  endAllResizes();
  elements.rightSidebarResizer.setPointerCapture(event.pointerId);
  elements.appShell.classList.add("resizing");
  setWebviewPointerEvents(false);
  const startX = event.clientX;
  const startWidth = elements.rightSidebar.getBoundingClientRect().width;
  const onMove = (moveEvent) => {
    if (moveEvent.buttons === 0) {
      onUp();
      return;
    }
    const width = Math.max(280, Math.min(window.innerWidth * 0.6, startWidth + startX - moveEvent.clientX));
    document.documentElement.style.setProperty("--right-sidebar-width", `${width}px`);
    fitWebviewZoom();
    updateAllEmbeddedPositions(true);
  };
  const onUp = () => {
    if (activeResizeEnd === onUp) activeResizeEnd = null;
    try {
      if (elements.rightSidebarResizer.hasPointerCapture(event.pointerId)) {
        elements.rightSidebarResizer.releasePointerCapture(event.pointerId);
      }
    } catch {}
    elements.appShell.classList.remove("resizing");
    setWebviewPointerEvents(true);
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    updateAllEmbeddedPositions(false);
  };
  activeResizeEnd = onUp;
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onUp);
}

function beginBottomSidebarResize(event) {
  if (event.button !== 0) return;
  event.preventDefault();
  endAllResizes();
  elements.bottomSidebarResizer.setPointerCapture(event.pointerId);
  elements.workspace.classList.add("resizing");
  setWebviewPointerEvents(false);
  const startY = event.clientY;
  const startHeight = elements.bottomSidebar.getBoundingClientRect().height;

  const onMove = (moveEvent) => {
    if (moveEvent.buttons === 0) {
      onUp();
      return;
    }
    const maxHeight = Math.max(200, window.innerHeight * 0.7);
    const height = Math.max(150, Math.min(maxHeight, startHeight + startY - moveEvent.clientY));
    document.documentElement.style.setProperty("--bottom-sidebar-height", `${height}px`);
    updateAllEmbeddedPositions(true);
  };

  const onUp = () => {
    if (activeResizeEnd === onUp) activeResizeEnd = null;
    try {
      if (elements.bottomSidebarResizer.hasPointerCapture(event.pointerId)) {
        elements.bottomSidebarResizer.releasePointerCapture(event.pointerId);
      }
    } catch {}
    elements.workspace.classList.remove("resizing");
    setWebviewPointerEvents(true);
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    updateAllEmbeddedPositions(false);
  };
  activeResizeEnd = onUp;
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onUp);
}

elements.rightSidebarResizer.addEventListener("pointerdown", beginRightSidebarResize);
elements.bottomSidebarResizer.addEventListener("pointerdown", beginBottomSidebarResize);

let windowResizeTimeout = null;
window.addEventListener("resize", () => {
  if (window.innerWidth <= 1050
    && elements.appShell.classList.contains("right-sidebar-open")
    && pipelineState.active
    && !taskRailCollapsed) {
    taskRailCollapsed = true;
    renderTaskRail(weeklyTasks.find((task) => task.id === pipelineState.taskId) || null);
  }
  if (typeof fitAddon?.fit === "function") fitAddon.fit();
  fitWebviewZoom();
  window.workbench.resizeTerminal({ cols: terminal.cols, rows: terminal.rows });
  
  clearTimeout(windowResizeTimeout);
  windowResizeTimeout = setTimeout(() => {
    updateAllEmbeddedPositions(false);
  }, 150);

  tabTerminals.forEach((termObj, tId) => {
    try {
      termObj.fitAddon.fit();
      window.workbench.resizeCliTerminal(tId, {
        cols: termObj.terminal.cols,
        rows: termObj.terminal.rows
      });
    } catch {}
  });
});
document.addEventListener("pointermove", (event) => {
  if (!pointerDrag) return;

  // 按键已抬起但 drag 状态残留 → 强制结束
  if (event.buttons === 0) {
    endPointerDrag({ commit: true, event });
    return;
  }

  if (!pointerDrag.active) {
    if (Math.hypot(event.clientX - pointerDrag.startX, event.clientY - pointerDrag.startY) < 6) return;

    // Initialize drag parameters on first movement
    pointerDrag.active = true;
    const dragItem = document.querySelector(`.tab-item[data-id="${pointerDrag.id}"]`);
    const categoryContainer = dragItem ? dragItem.closest(".category-items") : null;
    const items = categoryContainer ? [...categoryContainer.querySelectorAll(".tab-item")] : (dragItem ? [dragItem] : []);
    const draggedIndex = items.indexOf(dragItem);
    const itemRects = items.map(item => item.getBoundingClientRect());
    const itemHeights = itemRects.map(r => r.height);
    const itemGaps = 4; // flex gap in stylesheet
    const shiftY = (itemHeights[draggedIndex] || 44) + itemGaps;

    pointerDrag.items = items;
    pointerDrag.draggedIndex = draggedIndex;
    pointerDrag.itemRects = itemRects;
    pointerDrag.shiftY = shiftY;
    pointerDrag.insertIndex = draggedIndex;
  }

  const dragItem = pointerDrag.items[pointerDrag.draggedIndex];
  if (dragItem) {
    dragItem.classList.add("dragging");
    // Translate the item relative to mouse movement delta
    dragItem.style.transform = `translate(${event.clientX - pointerDrag.startX}px, ${event.clientY - pointerDrag.startY}px) scale(1.02)`;
  }

  const isRightSide = event.clientX > window.innerWidth * 0.7;
  const isBottomSide = event.clientY > window.innerHeight * 0.75 && event.clientX <= window.innerWidth * 0.7;
  const overlayRight = document.querySelector("#split-drag-overlay");
  const overlayBottom = document.querySelector("#split-drag-overlay-bottom");
  
  if (isRightSide) {
    overlayRight?.classList.add("show");
    overlayBottom?.classList.remove("show");
    pointerDrag.items.forEach((item) => {
      if (item.dataset.id !== pointerDrag.id) {
        item.style.transform = "";
      }
    });
  } else if (isBottomSide) {
    overlayBottom?.classList.add("show");
    overlayRight?.classList.remove("show");
    pointerDrag.items.forEach((item) => {
      if (item.dataset.id !== pointerDrag.id) {
        item.style.transform = "";
      }
    });
  } else {
    overlayRight?.classList.remove("show");
    overlayBottom?.classList.remove("show");
    
    // Calculate current insertion index
    let insertIndex = 0;
    for (let i = 0; i < pointerDrag.itemRects.length; i++) {
      const rect = pointerDrag.itemRects[i];
      const middle = rect.top + rect.height / 2;
      if (event.clientY > middle) {
        insertIndex = i;
      }
    }
    pointerDrag.insertIndex = insertIndex;
    
    // Apply smooth shift translations
    for (let i = 0; i < pointerDrag.items.length; i++) {
      const item = pointerDrag.items[i];
      if (item.dataset.id === pointerDrag.id) continue;
      
      if (pointerDrag.draggedIndex < i && i <= insertIndex) {
        // Shift UP
        item.style.transform = `translateY(-${pointerDrag.shiftY}px)`;
      } else if (insertIndex <= i && i < pointerDrag.draggedIndex) {
        // Shift DOWN
        item.style.transform = `translateY(${pointerDrag.shiftY}px)`;
      } else {
        // Reset
        item.style.transform = "";
      }
    }
  }
});

document.addEventListener("pointerup", (event) => {
  if (pointerDrag) endPointerDrag({ commit: true, event });
  else releaseGuestPointerCapture();
});

document.addEventListener("pointercancel", () => {
  forceEndAllPointerInteractions({ commitDrag: false });
});

window.addEventListener("blur", () => {
  forceEndAllPointerInteractions({ commitDrag: false });
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    forceEndAllPointerInteractions({ commitDrag: false });
  }
});

document.addEventListener("lostpointercapture", () => {
  // capture 丢失时若仍有 drag/resize 状态，强制收尾
  if (pointerDrag || activeResizeEnd) {
    forceEndAllPointerInteractions({ commitDrag: false });
  }
});

// Register all local web app folders on startup
tabs.forEach(tab => {
  if (tab.type === "local-web" && tab.localPath) {
    window.workbench.registerLocalApp(tab.id, tab.localPath);
  }
});

document.querySelector("#tab-type").addEventListener("change", (e) => {
  switchTabFormType(e.target.value);
});

document.querySelector("#tab-local-path-browse").addEventListener("click", async () => {
  const path = await window.workbench.selectFolder();
  if (path) document.querySelector("#tab-local-path").value = path;
});

document.querySelector("#tab-exe-path-browse").addEventListener("click", async () => {
  const path = await window.workbench.selectFile();
  if (path) document.querySelector("#tab-exe-path").value = path;
});

document.querySelector("#tab-exe-cwd-browse").addEventListener("click", async () => {
  const path = await window.workbench.selectFolder();
  if (path) document.querySelector("#tab-exe-cwd").value = path;
});

document.querySelector("#tab-cli-cwd-browse").addEventListener("click", async () => {
  const path = await window.workbench.selectFolder();
  if (path) document.querySelector("#tab-cli-cwd").value = path;
});

window.workbench.onDragAddTab((payload) => {
  if (!payload) return;

  let path = "";
  let content = "";
  let isDirectory = false;

  if (typeof payload === "string") {
    path = payload;
  } else if (payload && typeof payload === "object") {
    path = payload.path || "";
    content = payload.content || "";
    isDirectory = !!payload.isDirectory;
  }

  if (!path) return;
  path = path.trim().replace(/^"(.*)"$/, '$1');

  let type = "web";
  let name = "";
  let url = "";
  let localPath = "";
  let exePath = "";
  let command = "";
  let builtinType = "";
  
  const isUrl = /^(https?:\/\/)/i.test(path);
  if (isUrl) {
    type = "web";
    url = path;
    try {
      name = new URL(path).hostname || "网页";
    } catch {
      name = "网页";
    }
  } else {
    const lowercase = path.toLowerCase();
    const basename = path.split(/[\\/]/).pop() || "本地项目";
    name = basename;
    
    if (isDirectory) {
      type = "local-web";
      localPath = path;
      url = `http://127.0.0.1:38924/local-apps/placeholder-id/index.html`;
    } else if (lowercase.endsWith(".exe") || lowercase.endsWith(".bat") || lowercase.endsWith(".cmd")) {
      type = "desktop-app";
      exePath = path;
    } else if (lowercase.endsWith(".html") || lowercase.endsWith(".htm")) {
      type = "local-web";
      const parts = path.split(/[\\/]/);
      parts.pop();
      localPath = parts.join("\\");
      url = `http://127.0.0.1:38924/local-apps/placeholder-id/${basename}`;
    } else {
      type = "builtin";
      builtinType = "markdown";
      localPath = path;
    }
  }

  // 重复性检查：避免重复添加同一个应用/网页/文件
  let existingTab = null;
  if (type === "desktop-app") {
    existingTab = tabs.find(t => t.type === "desktop-app" && (t.exePath || "").toLowerCase() === (exePath || "").toLowerCase());
  } else if (type === "local-web") {
    existingTab = tabs.find(t => t.type === "local-web" && (t.localPath || "").toLowerCase() === (localPath || "").toLowerCase());
  } else if (type === "web") {
    existingTab = tabs.find(t => t.type === "web" && (t.url || "").toLowerCase() === (url || "").toLowerCase());
  } else if (type === "builtin") {
    existingTab = tabs.find(t => t.type === "builtin" && (t.localPath || "").toLowerCase() === (localPath || "").toLowerCase());
  }

  if (existingTab) {
    activeTabId = existingTab.id;
    renderTabs();
    showToast(`已直接激活已有的标签: ${existingTab.name}`, "success");
    return;
  }

  const tabId = `tab-dropped-${Date.now()}`;
  if (type === "local-web" && url.includes("placeholder-id")) {
    url = url.replace("placeholder-id", tabId);
  }

  const newTab = {
    id: tabId,
    name,
    type,
    url,
    localPath,
    exePath,
    embedMode: type === "desktop-app",
    command,
    builtinType
  };

  // 如果拖入的是 markdown 文件内容，将其自动存入对应的 localStorage 键
  if (type === "builtin" && builtinType === "markdown" && content) {
    localStorage.setItem(`personal_workbench_builtin_md_${tabId}`, content);
  }

  if (type === "local-web" && localPath) {
    window.workbench.registerLocalApp(newTab.id, localPath);
  }

  tabs.push(newTab);
  saveTabs();
  activeTabId = newTab.id;
  renderTabs();
  
  showToast(`已成功添加标签: ${name}`, "success");
});

// 全局外点关闭：「⋯ 更多」popover 与任务卡「⋯」菜单（composedPath 判定，覆盖 webview 边界）
document.addEventListener("click", (event) => {
  const path = event.composedPath();
  if (elements.menuMorePop?.classList.contains("open")
    && !path.includes(elements.menuMorePop) && !path.includes(elements.menuMoreButton)) {
    elements.menuMorePop.classList.remove("open");
  }
  const openMenu = document.querySelector(".tc-menu-pop.open");
  if (openMenu && !path.some((node) => node instanceof Element && node.classList?.contains("tc-menu-wrap"))) {
    closeAllCardMenus();
  }
  const openSubtasks = document.querySelector(".subtask-popover.open");
  if (openSubtasks && !path.some((node) => node instanceof Element && (node.classList?.contains("subtask-popover") || node.classList?.contains("tc-progress")))) {
    closeAllSubtaskPopovers();
  }
});

initTerminal();
renderTabs();
activateTab(TASK_CENTER_ID);
window.workbench.updateTabsList(tabs);
setSidebarCollapsed(localStorage.getItem(sidebarStorageKey) === "true");
window.workbench.getWorkbenchPrefs().then((prefs) => {
  applyWorkbenchTheme(prefs?.theme);
}).catch(() => {});
loadWeeklyTasks().then(() => loadWeeklyReports());
window.workbench.onDownloadCompleted(handleDownloadCompleted);
window.workbench.onUploadChooseFiles(handleUploadChooseFiles);
window.workbench.onTaskFolderChanged(handleTaskFolderChanged);
window.workbench.getExtensions().then(({ results }) => renderExtensionsInTopbar(results));
