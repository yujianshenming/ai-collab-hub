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

const storageKey = "personal_workbench_tabs";
const sidebarStorageKey = "personal_workbench_sidebar_collapsed";
let tabs = readTabs();
let activeTabId = TASK_CENTER_ID;
let rightSplitTabId = null;
let bottomSplitTabId = null;
let terminal;
let fitAddon;
let pointerDrag = null;
let weeklyTasks = [];
let taskRailCollapsed = false;
let pipelineState = {
  active: false,
  taskId: null,
  step: "idle",
  chatPath: "",
  reportPath: "",
  taskFolder: "",
  uploadQueue: []
};
const tabTerminals = new Map();
const desktopStatusPollers = new Map();

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
  taskCenterBadge: document.querySelector("#task-center-badge"),
  taskCenterView: document.querySelector("#task-center-view"),
  homeWeekSub: document.querySelector("#home-week-sub"),
  statTotal: document.querySelector("#stat-total"),
  statRunning: document.querySelector("#stat-running"),
  statPaused: document.querySelector("#stat-paused"),
  statCompleted: document.querySelector("#stat-completed"),
  focusCard: document.querySelector("#focus-card"),
  taskGridActive: document.querySelector("#task-grid-active"),
  taskGridDone: document.querySelector("#task-grid-done"),
  taskDialog: document.querySelector("#task-dialog"),
  taskFormTitle: document.querySelector("#task-form-title"),
  taskForm: document.querySelector("#task-form"),
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
  railHermes: document.querySelector("#rail-hermes"),
  railPause: document.querySelector("#rail-pause"),
  railFinish: document.querySelector("#rail-finish"),
  filePickDialog: document.querySelector("#file-pick-dialog"),
  filePickList: document.querySelector("#file-pick-list"),
  filePickInject: document.querySelector("#file-pick-inject"),
  filePickSystem: document.querySelector("#file-pick-system"),
  filePickCancel: document.querySelector("#file-pick-cancel"),
  filePickClose: document.querySelector("#file-pick-close")
};

function readTabs() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    return Array.isArray(saved) && saved.length ? saved : DEFAULT_TABS;
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
  return (name.trim()[0] || "W").toUpperCase();
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
          <span>${tab.name}</span>
        </button>
        <button class="tab-menu" type="button" aria-label="编辑 ${tab.name}" title="编辑标签">
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
    if (!tabs.some((tab) => tab.id === viewport.dataset.id)) viewport.remove();
  });

  updateSidebarPulse();

  // Activate active tab（任务中心是合法的特殊视图）
  const validActiveTabId = activeTabId === TASK_CENTER_ID || tabs.some((tab) => tab.id === activeTabId)
    ? activeTabId
    : tabs[0]?.id;
  if (validActiveTabId) {
    activateTab(validActiveTabId);
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

function createTabViewport(tab) {
  const viewport = document.createElement("div");
  viewport.className = "tab-viewport";
  viewport.dataset.id = tab.id;

  const type = tab.type || "web";

  if (type === "web" || type === "local-web") {
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
      if (type === "local-web" || isLocalLoopbackUrl(currentUrl)) {
        window.workbench.getSessionToken().then((token) => {
          webview.executeJavaScript(`window.__workbenchSessionToken = ${JSON.stringify(token)};`).catch(() => {});
        });
      }
    });
    setupWebviewUploadInterceptor(webview);
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
      const extWebview = extPanel.querySelector("webview");
      if (extWebview) extWebview.src = "about:blank";
    });

    const resizer = document.createElement("div");
    resizer.className = "tab-extension-resizer";
    resizer.title = "拖动调整扩展宽度";
    resizer.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      resizer.setPointerCapture(event.pointerId);
      elements.appShell.classList.add("resizing");
      extPanel.classList.add("resizing");
      resizer.classList.add("resizing");
      setWebviewPointerEvents(false);
      
      const startX = event.clientX;
      const startWidth = extPanel.getBoundingClientRect().width || 320;
      
      const onMove = (moveEvent) => {
        const deltaX = startX - moveEvent.clientX;
        const width = Math.max(240, Math.min(window.innerWidth * 0.6, startWidth + deltaX));
        extPanel.style.setProperty("--tab-ext-width", `${width}px`);
      };
      
      const onUp = () => {
        if (resizer.hasPointerCapture(event.pointerId)) {
          resizer.releasePointerCapture(event.pointerId);
        }
        elements.appShell.classList.remove("resizing");
        extPanel.classList.remove("resizing");
        resizer.classList.remove("resizing");
        setWebviewPointerEvents(true);
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
      };
      
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

    viewport.addEventListener("DOMNodeRemovedFromDocument", () => {
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
        setTimeout(() => {
          const container = viewport.querySelector(".desktop-embed-container");
          const r = container?.getBoundingClientRect();
          if (r) {
            rect = { x: r.left, y: r.top, width: r.width, height: r.height };
          }
          window.workbench.launchDesktopApp(tab.id, tab.exePath, tab.exeCwd, embedMode, rect).then((res) => {
            if (res.success) updateStatusUI({ running: true, pid: res.pid });
          });
        }, 500);
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

    setTimeout(() => {
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

    viewport.addEventListener("DOMNodeRemovedFromDocument", () => {
      unsubData();
      tabTerminals.delete(tab.id);
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

      viewport.addEventListener("DOMNodeRemovedFromDocument", () => {
        window.removeEventListener("resize", resizeCanvas);
      });
    }
  }

  elements.webviewStack.append(viewport);
}

function activeWebview() {
  return document.querySelector(`.tab-viewport[data-id="${activeTabId}"] .tab-webview`);
}

let isActivatingTab = false;
function activateTab(id) {
  if (isActivatingTab) return;
  isActivatingTab = true;
  try {
    const isTaskCenter = id === TASK_CENTER_ID;
    if (!isTaskCenter) {
      if (rightSplitTabId === id) {
        rightSplitTabId = activeTabId === TASK_CENTER_ID ? null : activeTabId;
      } else if (bottomSplitTabId === id) {
        bottomSplitTabId = activeTabId === TASK_CENTER_ID ? null : activeTabId;
      }

      // Prevent duplicate references
      if (rightSplitTabId && rightSplitTabId === bottomSplitTabId) {
        bottomSplitTabId = null;
      }
    }

    activeTabId = id;
    localStorage.setItem("personal_workbench_active", id);
    const tab = isTaskCenter ? null : tabs.find((candidate) => candidate.id === id);
    if (!isTaskCenter && !tab) return;

    // Auto-expand category if collapsed
    if (tab) {
      const category = getTabCategory(tab);
      if (collapsedCategories[category]) {
        collapsedCategories[category] = false;
        localStorage.setItem("workbench_collapsed_categories", JSON.stringify(collapsedCategories));
        renderTabs();
      }
    }

    elements.workspace.classList.toggle("task-center-active", isTaskCenter);
    elements.navTaskCenter?.classList.toggle("active", isTaskCenter);
    document.querySelectorAll(".tab-item").forEach((item) => {
      item.classList.toggle("active", !isTaskCenter && item.dataset.id === id);
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
    const total = weeklyTasks.length;
    const running = weeklyTasks.filter((task) => task.status === "running" || task.status === "evaluating").length;
    elements.activeTitle.textContent = "任务中心";
    elements.crumbSub.textContent = `本周 ${total} 项 · 进行中 ${running} 项`;
    elements.addressBar.style.display = "";
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
  if (activeTabId === TASK_CENTER_ID) {
    window.workbench.updateActiveTabInfo({ url: "", title: "任务中心" });
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
    "grading-acceptance": "作业批阅验收"
  }[type] || type || "未分类";
}

// 任务舱状态接线总入口：横幅已删除，统一驱动 任务舱 + 状态栏芯片 + 侧边栏脉冲点 + 任务中心
function updateTaskRail(task = null) {
  if (!task) {
    window.workbench.updateActiveTaskInfo({});
  } else {
    window.workbench.updateActiveTaskInfo({
      school: task.school || "",
      course: task.course || "",
      taskType: task.taskType || "",
      taskTypeLabel: taskTypeLabel(task.taskType),
      folderPath: pipelineState.taskFolder || task.taskFolder || ""
    });
  }
  renderTaskRail(task);
  updateStatusbarChip(task);
  updateSidebarPulse();
  renderTaskCenter();
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
  if (action === "delete" && !window.confirm(`确认删除 ${file.name}？此操作不可恢复。`)) return;
  const ok = await window.workbench.taskFileAction(action, file.path);
  if (!ok) {
    showToast("文件操作失败（文件可能已不存在）", "error");
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
}

// 托盘单独刷新（fs.watch 推送 / 文件操作后调用，不重渲整个任务舱）
function refreshRailTray() {
  if (!pipelineState.active) return;
  const task = weeklyTasks.find((candidate) => candidate.id === pipelineState.taskId);
  if (task) renderRailTray(task);
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

async function finishActiveTask() {
  const taskId = pipelineState.taskId;
  const folderPath = pipelineState.taskFolder;
  pipelineState = { active: false, taskId: null, step: "idle", chatPath: "", reportPath: "", taskFolder: "", uploadQueue: [] };
  updateTaskRail(null);
  if (taskId) await updateTaskFields(taskId, { status: "completed", chatLogPath: "", reportPath: "", taskFolder: "" });
  if (folderPath) await window.workbench.cleanupTaskFolder(folderPath);
  showToast("任务已结束，临时文件已清理", "success");
}

function taskStatusLabel(status) {
  return {
    pending: "待处理",
    running: "进行中",
    evaluating: "评估中",
    paused: "已暂停",
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
  document.querySelector("#task-quantity").value = "1";
  document.querySelector("#task-type").value = "capability-setup";
  if (elements.taskFormTitle) elements.taskFormTitle.textContent = "添加任务";
}

function normalizeWeeklyTask(task = {}) {
  return {
    id: task.id || `task-${Date.now()}`,
    school: task.school || "",
    course: task.course || "",
    taskType: task.taskType || "capability-setup",
    quantity: Math.max(1, Number(task.quantity) || 1),
    status: task.status || "pending",
    owner: task.owner || "",
    chatLogPath: task.chatLogPath || "",
    reportPath: task.reportPath || "",
    taskFolder: task.taskFolder || "",
    step: normalizePipelineStep(task.step)
  };
}

async function persistWeeklyTasks() {
  weeklyTasks = await window.workbench.writeWeeklyTasks(weeklyTasks.map(normalizeWeeklyTask));
  renderTaskCenter();
}

async function loadWeeklyTasks() {
  try {
    weeklyTasks = (await window.workbench.readWeeklyTasks()).map(normalizeWeeklyTask);
  } catch (error) {
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
function taskProgressInfo(task) {
  if (task.status === "completed") {
    return { label: `${PIPELINE_STEPS.length}/${PIPELINE_STEPS.length} 全部完成`, ratio: 1, barClass: "full" };
  }
  if (task.status === "pending") {
    return { label: `0/${PIPELINE_STEPS.length} 未开始`, ratio: 0, barClass: "" };
  }
  const isActiveTask = pipelineState.active && pipelineState.taskId === task.id;
  const step = isActiveTask ? pipelineState.step : task.step;
  const index = pipelineStepIndex(step);
  const stepNumber = index + 1;
  return {
    label: `${stepNumber}/${PIPELINE_STEPS.length} ${PIPELINE_STEPS[index]?.name || ""}`,
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

function taskCardElement(task) {
  const card = document.createElement("div");
  card.className = `task-card${task.status === "completed" ? " completed" : ""}`;
  card.dataset.id = task.id;
  const progress = taskProgressInfo(task);
  const chips = [];
  if (task.chatLogPath) chips.push('<span class="file-chip">dialogue.json</span>');
  if (task.reportPath) chips.push('<span class="file-chip">eval_report.pdf</span>');
  const chipsHtml = chips.length ? chips.join("") : '<span class="file-chip empty">尚无产物</span>';

  let mainAction = "";
  if (task.status === "paused") {
    mainAction = '<button class="btn btn-teal btn-sm task-resume" type="button">继续</button>';
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
    <div class="tc-meta"><span>负责人 <b>${escapeHtml(task.owner || "未指定")}</b></span><span>数量 <b>${Number(task.quantity) || 1}</b></span></div>
    <div class="tc-progress">
      <div class="tc-bar ${progress.barClass}"><i style="width:${Math.round(progress.ratio * 100)}%"></i></div>
      <span>${escapeHtml(progress.label)}</span>
    </div>
    <div class="tc-files">${chipsHtml}</div>
    <div class="tc-foot">
      ${mainAction}
      <span class="spacer"></span>
      <div class="tc-menu-wrap">
        <button class="icon-button tc-menu-toggle" type="button" title="更多操作" aria-label="更多操作">${svgIcon("dots")}</button>
        <div class="tc-menu-pop">
          <button class="task-edit" type="button">编辑</button>
          <button class="task-delete danger" type="button">删除</button>
        </div>
      </div>
    </div>
  `;

  card.querySelector(".task-run")?.addEventListener("click", () => startTaskAutomation(task.id));
  card.querySelector(".task-resume")?.addEventListener("click", () => resumeTaskAutomation(task.id));
  card.querySelector(".task-open-folder")?.addEventListener("click", () => {
    if (task.taskFolder) {
      window.workbench.openTaskFolder(task.taskFolder);
    } else {
      showToast("该任务没有记录产物文件夹", "error");
    }
  });
  const menuPop = card.querySelector(".tc-menu-pop");
  card.querySelector(".tc-menu-toggle").addEventListener("click", () => {
    const willOpen = !menuPop.classList.contains("open");
    closeAllCardMenus();
    menuPop.classList.toggle("open", willOpen);
  });
  card.querySelector(".task-edit").addEventListener("click", () => {
    closeAllCardMenus();
    editWeeklyTask(task.id);
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

  const total = weeklyTasks.length;
  const running = weeklyTasks.filter((task) => task.status === "running" || task.status === "evaluating").length;
  const paused = weeklyTasks.filter((task) => task.status === "paused").length;
  const completed = weeklyTasks.filter((task) => task.status === "completed").length;

  elements.statTotal.textContent = String(total);
  elements.statRunning.textContent = String(running);
  elements.statPaused.textContent = String(paused);
  elements.statCompleted.textContent = String(completed);
  elements.homeWeekSub.textContent = `${new Date().getFullYear()} 年第 ${getIsoWeekNumber()} 周 · 任务文档目录已挂载`;

  const pendingCount = total - completed;
  elements.taskCenterBadge.hidden = pendingCount <= 0;
  elements.taskCenterBadge.textContent = String(pendingCount);

  renderFocusCard();

  // 进行中/评估中任务只出现在聚焦卡；网格仅展示 待处理+已暂停 / 已完成
  const activeGroup = weeklyTasks.filter((task) => task.status === "pending" || task.status === "paused");
  const doneGroup = weeklyTasks.filter((task) => task.status === "completed");

  elements.taskGridActive.replaceChildren();
  if (activeGroup.length) {
    activeGroup.forEach((task) => elements.taskGridActive.append(taskCardElement(task)));
  } else {
    const empty = document.createElement("div");
    empty.className = "task-grid-empty";
    empty.textContent = "暂无待处理任务。点击右上角「添加任务」开始。";
    elements.taskGridActive.append(empty);
  }

  elements.taskGridDone.replaceChildren();
  if (doneGroup.length) {
    doneGroup.forEach((task) => elements.taskGridDone.append(taskCardElement(task)));
  } else {
    const empty = document.createElement("div");
    empty.className = "task-grid-empty";
    empty.textContent = "本周还没有已完成的任务。";
    elements.taskGridDone.append(empty);
  }

  if (activeTabId === TASK_CENTER_ID) {
    updateTopbarForActive(null);
  }
}

function taskFromForm() {
  const id = document.querySelector("#task-id").value || `task-${Date.now()}`;
  const existing = weeklyTasks.find((task) => task.id === id) || {};
  return {
    id,
    school: document.querySelector("#task-school").value.trim(),
    course: document.querySelector("#task-course").value.trim(),
    taskType: document.querySelector("#task-type").value,
    quantity: Math.max(1, Number(document.querySelector("#task-quantity").value) || 1),
    status: existing.status || "pending",
    owner: document.querySelector("#task-owner").value.trim(),
    chatLogPath: existing.chatLogPath || "",
    reportPath: existing.reportPath || "",
    taskFolder: existing.taskFolder || "",
    step: existing.step || "testing"
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

async function deleteWeeklyTask(id) {
  const task = weeklyTasks.find((candidate) => candidate.id === id);
  weeklyTasks = weeklyTasks.filter((task) => task.id !== id);
  const folderPath = pipelineState.taskId === id ? pipelineState.taskFolder : task?.taskFolder || "";
  if (pipelineState.taskId === id) {
    pipelineState = { active: false, taskId: null, step: "idle", chatPath: "", reportPath: "", taskFolder: "", uploadQueue: [] };
    updateTaskRail(null);
  }
  if (folderPath) await window.workbench.cleanupTaskFolder(folderPath);
  await persistWeeklyTasks();
}

async function updateTaskFields(id, fields) {
  const task = weeklyTasks.find((candidate) => candidate.id === id);
  if (!task) return null;
  Object.assign(task, fields);
  await persistWeeklyTasks();
  return task;
}

function setupWebviewUploadInterceptor(webview) {
  webview.addEventListener("select-file-dialog", (event) => {
    // 无活动任务：不拦截，保持系统选择器原行为
    if (!pipelineState.active) return;
    // 评估流水线自动注入优先（现有行为不变，不弹浮层）
    if (pipelineState.uploadQueue.length) {
      const nextPath = pipelineState.uploadQueue.shift();
      if (!nextPath) return;
      event.preventDefault();
      event.callback([nextPath]);
      return;
    }
    event.preventDefault();
    if (pendingFilePick) {
      // 已有未完成的选择请求，直接取消新请求防止回调悬挂
      event.callback([]);
      return;
    }
    openFilePickOverlay(event.callback);
  });
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
  return tabs.find((tab) => tab.url.toLowerCase().includes(part));
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

async function startTaskAutomation(id) {
  if (pipelineState.active) {
    showToast("当前已有正在运行的任务，请先暂停或结束当前任务。", "error");
    return;
  }
  const task = weeklyTasks.find((candidate) => candidate.id === id);
  if (!task) return;
  const taskFolder = await window.workbench.prepareTaskFolder(task);
  pipelineState = {
    active: true,
    taskId: id,
    step: "testing",
    chatPath: task.chatLogPath || "",
    reportPath: task.reportPath || "",
    taskFolder,
    uploadQueue: []
  };
  await updateTaskFields(id, { status: "running", taskFolder });
  taskRailCollapsed = false;
  updateTaskRail(task);
  showToast(`已开始任务：${task.school || ""} ${task.course || ""}。测试完成后下载对话文件即可继续。`, "success");
}

async function pauseTaskAutomation(id) {
  const task = weeklyTasks.find((candidate) => candidate.id === id);
  if (!task) return;

  if (pipelineState.active && pipelineState.taskId === id) {
    task.chatLogPath = pipelineState.chatPath || "";
    task.reportPath = pipelineState.reportPath || "";
    task.taskFolder = pipelineState.taskFolder || "";
    task.step = pipelineState.step || "testing";
  }

  task.status = "paused";
  pipelineState = { active: false, taskId: null, step: "idle", chatPath: "", reportPath: "", taskFolder: "", uploadQueue: [] };
  updateTaskRail(null);
  await persistWeeklyTasks();
  showToast(`任务已暂停：${task.school || ""} ${task.course || ""}`, "success");
}

async function resumeTaskAutomation(id) {
  const task = weeklyTasks.find((candidate) => candidate.id === id);
  if (!task) return;

  if (pipelineState.active) {
    showToast("当前已有正在运行的任务，请先暂停或结束当前任务。", "error");
    return;
  }

  pipelineState = {
    active: true,
    taskId: id,
    step: task.step || "testing",
    chatPath: task.chatLogPath || "",
    reportPath: task.reportPath || "",
    taskFolder: task.taskFolder || "",
    uploadQueue: []
  };

  const nextStatus = pipelineState.step === "evaluating" ? "evaluating" : "running";
  await updateTaskFields(id, { status: nextStatus });
  taskRailCollapsed = false;
  updateTaskRail(task);
  showToast(`任务已恢复执行：${task.school || ""} ${task.course || ""}`, "success");
}

async function handleDownloadCompleted(download) {
  if (!pipelineState.active || !pipelineState.taskId) return;

  if (download.type === "generic") {
    if (download.captured) showToast(`已捕获到任务文件夹: ${download.filename}`, "success");
    return;
  }

  if (download.type === "chat") {
    pipelineState.chatPath = download.path;
    pipelineState.step = "evaluating";
    const task = await updateTaskFields(pipelineState.taskId, { status: "evaluating", chatLogPath: download.path, step: "evaluating" });
    updateTaskRail(task);
    activateOrCreateTab("evaluation", "评估", "https://www.wl363eval.top/");
    setTimeout(() => runEvaluationUpload(), 1200);
    return;
  }

  if (download.type === "report") {
    pipelineState.reportPath = download.path;
    pipelineState.step = "report";
    const task = await updateTaskFields(pipelineState.taskId, { status: "completed", reportPath: download.path, step: "report" });
    updateTaskRail(task);
    showToast("评估报告已保存，可在任务舱「加载至 Hermes」后确认发送。", "success");
  }
}

function runEvaluationUpload() {
  const webview = activeWebview();
  if (!webview || !pipelineState.chatPath) return;
  pipelineState.uploadQueue = [pipelineState.chatPath];
  webview.executeJavaScript(`
    (() => {
      const input = document.querySelector('input[type="file"]');
      input?.click();
      const submit = document.querySelector('button[type="submit"], input[type="submit"], .submit, .send-btn');
      if (submit) setTimeout(() => submit.click(), 700);
      return { fileInputs: input ? 1 : 0, submitted: Boolean(submit) };
    })();
  `).then((result) => {
    if (!result?.fileInputs) showToast("评估页没有检测到文件上传控件，请手动上传后继续。", "error");
  }).catch((error) => {
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
  ].join("\\n");
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
  if (!viewport) return;
  
  const extPanel = viewport.querySelector(".tab-extension-panel");
  const extBody = viewport.querySelector(".tab-extension-body");
  const extTitle = viewport.querySelector(".tab-extension-title");
  
  // Check if this extension is already open
  const existingWebview = extBody.querySelector("webview");
  const isOpen = extPanel.classList.contains("open") && existingWebview && existingWebview.src === url;
  
  if (isOpen) {
    // Close it
    extPanel.classList.remove("open");
    extPanel.style.removeProperty("--tab-ext-width");
    if (existingWebview) existingWebview.src = "about:blank";
  } else {
    // Open it
    extTitle.textContent = name;
    extPanel.classList.add("open");
    
    // Clear and create/re-use webview
    extBody.replaceChildren();
    const extWebview = document.createElement("webview");
    extWebview.className = "tab-extension-webview";
    extWebview.src = url;
    extWebview.partition = "persist:personal-workbench";
    extWebview.preload = "./preload-popup.js";
    extWebview.setAttribute("webpreferences", "contextIsolation=no");
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
elements.addNewTask?.addEventListener("click", () => openTaskForm());
elements.sbTerminal?.addEventListener("click", () => toggleTerminal());
elements.sbTaskChip?.addEventListener("click", expandTaskRail);
elements.railHandle?.addEventListener("click", expandTaskRail);
elements.railCollapse?.addEventListener("click", collapseTaskRail);
elements.railHermes?.addEventListener("click", () => runHermesPrompt());
elements.railPause?.addEventListener("click", () => {
  if (pipelineState.taskId) pauseTaskAutomation(pipelineState.taskId);
});
elements.railFinish?.addEventListener("click", () => finishActiveTask());
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
    window.workbench.cleanupTabResources(data.id);
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
  
  window.workbench.cleanupTabResources(id);

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
  const handle = event.currentTarget;
  handle.setPointerCapture(event.pointerId);
  elements.appShell.classList.add("resizing");
  setWebviewPointerEvents(false);
  const startY = event.clientY;
  const startHeight = elements.terminalPanel.getBoundingClientRect().height;
  const onMove = (moveEvent) => {
    const height = Math.max(180, Math.min(window.innerHeight * 0.7, startHeight + startY - moveEvent.clientY));
    document.documentElement.style.setProperty("--terminal-height", `${height}px`);
    fitAddon.fit();
    window.workbench.resizeTerminal({ cols: terminal.cols, rows: terminal.rows });
  };
  const onUp = () => {
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    elements.appShell.classList.remove("resizing");
    setWebviewPointerEvents(true);
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
  };
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
  elements.rightSidebarResizer.setPointerCapture(event.pointerId);
  elements.appShell.classList.add("resizing");
  setWebviewPointerEvents(false);
  const startX = event.clientX;
  const startWidth = elements.rightSidebar.getBoundingClientRect().width;
  const onMove = (moveEvent) => {
    const width = Math.max(280, Math.min(window.innerWidth * 0.6, startWidth + startX - moveEvent.clientX));
    document.documentElement.style.setProperty("--right-sidebar-width", `${width}px`);
    fitWebviewZoom();
    updateAllEmbeddedPositions(true);
  };
  const onUp = () => {
    if (elements.rightSidebarResizer.hasPointerCapture(event.pointerId)) {
      elements.rightSidebarResizer.releasePointerCapture(event.pointerId);
    }
    elements.appShell.classList.remove("resizing");
    setWebviewPointerEvents(true);
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    
    updateAllEmbeddedPositions(false);
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onUp);
}

function beginBottomSidebarResize(event) {
  if (event.button !== 0) return;
  event.preventDefault();
  elements.bottomSidebarResizer.setPointerCapture(event.pointerId);
  elements.workspace.classList.add("resizing");
  setWebviewPointerEvents(false);
  const startY = event.clientY;
  const startHeight = elements.bottomSidebar.getBoundingClientRect().height;
  
  const onMove = (moveEvent) => {
    const maxHeight = Math.max(200, window.innerHeight * 0.7);
    const height = Math.max(150, Math.min(maxHeight, startHeight + startY - moveEvent.clientY));
    document.documentElement.style.setProperty("--bottom-sidebar-height", `${height}px`);
    updateAllEmbeddedPositions(true);
  };
  
  const onUp = () => {
    if (elements.bottomSidebarResizer.hasPointerCapture(event.pointerId)) {
      elements.bottomSidebarResizer.releasePointerCapture(event.pointerId);
    }
    elements.workspace.classList.remove("resizing");
    setWebviewPointerEvents(true);
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    
    updateAllEmbeddedPositions(false);
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onUp);
}

elements.rightSidebarResizer.addEventListener("pointerdown", beginRightSidebarResize);
elements.bottomSidebarResizer.addEventListener("pointerdown", beginBottomSidebarResize);

let windowResizeTimeout = null;
window.addEventListener("resize", () => {
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
  if (!pointerDrag) return;
  const dragItem = document.querySelector(`.tab-item[data-id="${pointerDrag.id}"]`);
  if (dragItem?.hasPointerCapture(pointerDrag.pointerId)) dragItem.releasePointerCapture(pointerDrag.pointerId);
  setWebviewPointerEvents(true);

  try {
    if (pointerDrag.active) {
      const isRightSide = event.clientX > window.innerWidth * 0.7;
      const isBottomSide = event.clientY > window.innerHeight * 0.75 && event.clientX <= window.innerWidth * 0.7;
      
      if (isRightSide) {
        toggleRightSidebar(true, pointerDrag.id);
      } else if (isBottomSide) {
        toggleBottomSidebar(true, pointerDrag.id);
      } else if (event.clientX > 238) {
        // Dropped outside sidebar -> Restore split if applicable, then activate
        if (rightSplitTabId === pointerDrag.id) {
          toggleRightSidebar(false);
        } else if (bottomSplitTabId === pointerDrag.id) {
          toggleBottomSidebar(false);
        }
        activateTab(pointerDrag.id);
      } else {
        // Dropped inside sidebar -> Reorder tabs within category
        const draggedIndex = pointerDrag.draggedIndex;
        const insertIndex = pointerDrag.insertIndex;
        if (typeof draggedIndex === "number" && typeof insertIndex === "number" && draggedIndex !== insertIndex) {
          const draggedTab = tabs.find(t => t.id === pointerDrag.id);
          if (draggedTab) {
            const category = getTabCategory(draggedTab);
            const indices = [];
            tabs.forEach((t, idx) => {
              if (getTabCategory(t) === category) {
                indices.push(idx);
              }
            });
            const categoryTabs = indices.map(idx => tabs[idx]);
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
      activateTab(pointerDrag.id);
    }
  } catch (error) {
    console.error("释放拖拽操作执行失败:", error);
  } finally {
    pointerDrag = null;
    clearDragState();
  }
});

document.addEventListener("pointercancel", () => {
  try {
    const dragItem = document.querySelector(`.tab-item[data-id="${pointerDrag?.id}"]`);
    if (dragItem && pointerDrag?.pointerId !== undefined && dragItem.hasPointerCapture(pointerDrag.pointerId)) {
      dragItem.releasePointerCapture(pointerDrag.pointerId);
    }
  } catch (error) {
    console.error("释放指针捕获失败:", error);
  } finally {
    setWebviewPointerEvents(true);
    pointerDrag = null;
    clearDragState();
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
});

initTerminal();
renderTabs();
activateTab(TASK_CENTER_ID);
window.workbench.updateTabsList(tabs);
setSidebarCollapsed(localStorage.getItem(sidebarStorageKey) === "true");
loadWeeklyTasks();
window.workbench.onDownloadCompleted(handleDownloadCompleted);
window.workbench.onTaskFolderChanged(() => refreshRailTray());
window.workbench.getExtensions().then(({ results }) => renderExtensionsInTopbar(results));
