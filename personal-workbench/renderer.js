const DEFAULT_TABS = [
  { id: "evaluation", name: "评估", url: "https://www.wl363eval.top/" }
];

const storageKey = "personal_workbench_tabs";
const sidebarStorageKey = "personal_workbench_sidebar_collapsed";
let tabs = readTabs();
let activeTabId = localStorage.getItem("personal_workbench_active") || tabs[0].id;
let rightSplitTabId = null;
let bottomSplitTabId = null;
let terminal;
let fitAddon;
let pointerDrag = null;
let weeklyTasks = [];
let taskViewMode = "list";
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
  taskPanel: document.querySelector("#task-manager-panel"),
  taskPanelOverlay: document.querySelector("#task-panel-overlay"),
  taskListView: document.querySelector("#task-list-view"),
  taskFormView: document.querySelector("#task-form"),
  taskFormTitle: document.querySelector("#task-form-title"),
  taskForm: document.querySelector("#task-form"),
  taskTableBody: document.querySelector("#task-table-body"),
  addNewTask: document.querySelector("#btn-add-new-task"),
  menuTaskButton: document.querySelector("#menu-task-button"),
  menuTerminalButton: document.querySelector("#menu-terminal-button"),
  menuSettingsButton: document.querySelector("#menu-settings-button"),
  menuReloadButton: document.querySelector("#menu-reload-button"),
  activeTaskBanner: document.querySelector("#active-task-banner"),
  activeTaskText: document.querySelector("#active-task-text"),
  activeTaskFinish: document.querySelector("#active-task-finish"),
  activeTaskHermes: document.querySelector("#active-task-hermes")
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
      <span class="category-toggle-icon">▼</span>
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
        <button class="tab-menu" type="button" aria-label="编辑 ${tab.name}" title="编辑标签">•••</button>
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

  // Activate active tab
  const validActiveTabId = tabs.some((tab) => tab.id === activeTabId) ? activeTabId : tabs[0]?.id;
  if (validActiveTabId) {
    activateTab(validActiveTabId);
  }
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
      if (tab.id === activeTabId) document.querySelector("#reload-button").textContent = "×";
    });
    webview.addEventListener("did-stop-loading", () => {
      if (tab.id === activeTabId) {
        document.querySelector("#reload-button").textContent = "↻";
        updateAddressFromWebview(webview);
      }
    });
    webview.addEventListener("did-navigate", () => updateAddressFromWebview(webview));
    webview.addEventListener("did-navigate-in-page", () => updateAddressFromWebview(webview));
    webview.addEventListener("dom-ready", () => {
      fitWebviewZoom();
      window.workbench.getSessionToken().then((token) => {
        webview.executeJavaScript(`window.__workbenchSessionToken = "${token}";`).catch(() => {});
      });
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
    if (rightSplitTabId === id) {
      rightSplitTabId = activeTabId;
    } else if (bottomSplitTabId === id) {
      bottomSplitTabId = activeTabId;
    }

    // Prevent duplicate references
    if (rightSplitTabId === bottomSplitTabId) {
      bottomSplitTabId = null;
    }

    activeTabId = id;
    localStorage.setItem("personal_workbench_active", id);
    const tab = tabs.find((candidate) => candidate.id === id);
    if (!tab) return;

    // Auto-expand category if collapsed
    const category = getTabCategory(tab);
    if (collapsedCategories[category]) {
      collapsedCategories[category] = false;
      localStorage.setItem("workbench_collapsed_categories", JSON.stringify(collapsedCategories));
      renderTabs();
    }

    document.querySelectorAll(".tab-item").forEach((item) => {
      item.classList.toggle("active", item.dataset.id === id);
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

    elements.activeTitle.textContent = tab.name;
    let currentUrl = tab.url || "";
    if (tab.type === "web" || tab.type === "local-web" || !tab.type) {
      try {
        currentUrl = activeWebview()?.getURL?.() || tab.url || "";
      } catch (error) {
        console.warn("获取 Webview URL 失败:", error);
      }
    }
    elements.addressInput.value = currentUrl;
    updateActiveTabInfo();
    fitWebviewZoom();

    // If CLI app, fit and focus it
    if (tab.type === "cli-app") {
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

function updateActiveTaskMenu(task = null) {
  if (!task) {
    window.workbench.updateActiveTaskInfo({});
    elements.activeTaskBanner.hidden = true;
    elements.activeTaskText.textContent = "";
    elements.activeTaskHermes.hidden = true;
    return;
  }
  elements.activeTaskText.textContent = `🏃 正在进行任务: ${task.school || ""} - ${task.course || ""} (${taskTypeLabel(task.taskType)})`;
  elements.activeTaskBanner.hidden = false;
  window.workbench.updateActiveTaskInfo({
    school: task.school || "",
    course: task.course || "",
    taskType: task.taskType || "",
    taskTypeLabel: taskTypeLabel(task.taskType),
    folderPath: pipelineState.taskFolder || task.taskFolder || ""
  });
}

async function finishActiveTask() {
  const taskId = pipelineState.taskId;
  const folderPath = pipelineState.taskFolder;
  pipelineState = { active: false, taskId: null, step: "idle", chatPath: "", reportPath: "", taskFolder: "", uploadQueue: [] };
  updateActiveTaskMenu(null);
  if (taskId) await updateTaskFields(taskId, { status: "completed", chatLogPath: "", reportPath: "", taskFolder: "" });
  if (folderPath) await window.workbench.cleanupTaskFolder(folderPath);
  showToast("任务已结束，临时文件已清理", "success");
}

function taskStatusLabel(status) {
  return {
    pending: "待处理",
    running: "进行中",
    evaluating: "评估中",
    completed: "已完成"
  }[status] || "待处理";
}

function switchTaskModalView(mode) {
  taskViewMode = mode === "form" ? "form" : "list";
  elements.taskListView?.classList.toggle("hidden", taskViewMode !== "list");
  elements.taskFormView?.classList.toggle("hidden", taskViewMode !== "form");
}

async function openTaskPanel() {
  if (elements.taskPanel?.classList.contains("open")) {
    closeTaskPanel();
    return;
  }
  
  // Record trigger element
  if (elements.taskPanel) {
    elements.taskPanel.dataset.triggerId = document.activeElement?.id || "";
  }
  
  await loadWeeklyTasks();
  switchTaskModalView("list");
  
  elements.taskPanel?.classList.add("open");
  elements.taskPanelOverlay?.classList.add("open");
  
  // Disable webview pointer events to prevent interaction leakage
  setWebviewPointerEvents(false);
  
  // Accessibility focus trap: focus close button
  const closeBtn = elements.taskPanel?.querySelector(".task-close");
  closeBtn?.focus();
}

function closeTaskPanel() {
  elements.taskPanel?.classList.remove("open");
  elements.taskPanelOverlay?.classList.remove("open");
  
  if (elements.taskPanel) {
    elements.taskPanel.style.transform = "";
  }
  
  // Re-enable webview pointer events
  setWebviewPointerEvents(true);
  
  // Restore focus
  if (elements.taskPanel) {
    const triggerId = elements.taskPanel.dataset.triggerId;
    if (triggerId) {
      const triggerEl = document.getElementById(triggerId);
      triggerEl?.focus();
    }
  }
  
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
    taskFolder: task.taskFolder || ""
  };
}

async function persistWeeklyTasks() {
  weeklyTasks = await window.workbench.writeWeeklyTasks(weeklyTasks.map(normalizeWeeklyTask));
  renderWeeklyTasks();
}

async function loadWeeklyTasks() {
  try {
    weeklyTasks = (await window.workbench.readWeeklyTasks()).map(normalizeWeeklyTask);
  } catch (error) {
    console.error("读取任务列表失败:", error);
    weeklyTasks = [];
    showToast("读取任务列表失败", "error");
  }
  renderWeeklyTasks();
}

function taskArtifactSummary(task) {
  const parts = [];
  if (task.chatLogPath) parts.push("对话");
  if (task.reportPath) parts.push("报告");
  return parts.join(" / ") || "-";
}

function renderWeeklyTasks() {
  if (!elements.taskTableBody) return;
  elements.taskTableBody.replaceChildren();

  if (!weeklyTasks.length) {
    const row = document.createElement("tr");
    row.innerHTML = `<td class="task-empty" colspan="7">暂无任务。点击下方按钮添加本周任务。</td>`;
    elements.taskTableBody.append(row);
    return;
  }

  for (const task of weeklyTasks) {
    const row = document.createElement("tr");
    row.dataset.id = task.id;
    row.innerHTML = `
      <td>
        <strong>${escapeHtml(task.school)}</strong>
        <span>${escapeHtml(task.course)}</span>
      </td>
      <td>${escapeHtml(taskTypeLabel(task.taskType))}</td>
      <td>${Number(task.quantity) || 1}</td>
      <td><span class="task-status status-${escapeHtml(task.status || "pending")}">${escapeHtml(taskStatusLabel(task.status || "pending"))}</span></td>
      <td>${escapeHtml(task.owner)}</td>
      <td><span class="task-path" title="${escapeHtml([task.chatLogPath, task.reportPath].filter(Boolean).join("\\n"))}">${escapeHtml(taskArtifactSummary(task))}</span></td>
      <td>
        <div class="task-actions">
          <button class="secondary-button task-run" type="button">执行</button>
          <button class="secondary-button task-edit" type="button">编辑</button>
          <button class="danger-button task-delete" type="button">删除</button>
        </div>
      </td>
    `;
    row.querySelector(".task-run").addEventListener("click", () => startTaskAutomation(task.id));
    row.querySelector(".task-edit").addEventListener("click", () => editWeeklyTask(task.id));
    row.querySelector(".task-delete").addEventListener("click", () => deleteWeeklyTask(task.id));
    elements.taskTableBody.append(row);
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
    taskFolder: existing.taskFolder || ""
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
  document.querySelector("#task-id").value = task.id;
  document.querySelector("#task-school").value = task.school || "";
  document.querySelector("#task-course").value = task.course || "";
  document.querySelector("#task-type").value = task.taskType || "capability-setup";
  document.querySelector("#task-quantity").value = Number(task.quantity) || 1;
  document.querySelector("#task-owner").value = task.owner || "";
  if (elements.taskFormTitle) elements.taskFormTitle.textContent = "编辑任务";
  switchTaskModalView("form");
}

async function deleteWeeklyTask(id) {
  const task = weeklyTasks.find((candidate) => candidate.id === id);
  weeklyTasks = weeklyTasks.filter((task) => task.id !== id);
  const folderPath = pipelineState.taskId === id ? pipelineState.taskFolder : task?.taskFolder || "";
  if (pipelineState.taskId === id) {
    pipelineState = { active: false, taskId: null, step: "idle", chatPath: "", reportPath: "", taskFolder: "", uploadQueue: [] };
    updateActiveTaskMenu(null);
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
    if (!pipelineState.active || !pipelineState.uploadQueue.length) return;
    const nextPath = pipelineState.uploadQueue.shift();
    if (!nextPath) return;
    event.preventDefault();
    event.callback([nextPath]);
  });
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
  updateActiveTaskMenu(task);
  closeTaskPanel();
  showToast(`已开始任务：${task.school || ""} ${task.course || ""}。测试完成后下载对话文件即可继续。`, "success");
}

async function handleDownloadCompleted(download) {
  if (!pipelineState.active || !pipelineState.taskId) return;

  if (download.type === "chat") {
    pipelineState.chatPath = download.path;
    pipelineState.step = "evaluating";
    await updateTaskFields(pipelineState.taskId, { status: "evaluating", chatLogPath: download.path });
    activateOrCreateTab("evaluation", "评估", "https://www.wl363eval.top/");
    setTimeout(() => runEvaluationUpload(), 1200);
    return;
  }

  if (download.type === "report") {
    pipelineState.reportPath = download.path;
    pipelineState.step = "analysis";
    await updateTaskFields(pipelineState.taskId, { status: "completed", reportPath: download.path });
    elements.activeTaskHermes.hidden = false;
    showToast("评估报告已保存，可加载至 Hermes 后确认发送。", "success");
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
elements.menuTaskButton?.addEventListener("click", openTaskPanel);
elements.menuTerminalButton?.addEventListener("click", () => toggleTerminal());
elements.menuSettingsButton?.addEventListener("click", openSettings);
elements.menuReloadButton?.addEventListener("click", () => activeWebview()?.reload?.());
document.querySelectorAll("[data-command]").forEach((button) => {
  button.addEventListener("click", () => document.execCommand(button.dataset.command));
});
elements.activeTaskFinish?.addEventListener("click", () => finishActiveTask());
elements.activeTaskHermes?.addEventListener("click", () => runHermesPrompt());
window.workbench.onMenuToggleTasks(openTaskPanel);
window.workbench.onMenuToggleTerminal(() => toggleTerminal());
window.workbench.onMenuOpenSettings(openSettings);
elements.addNewTask?.addEventListener("click", () => {
  resetTaskForm();
  switchTaskModalView("form");
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
document.querySelectorAll(".task-close").forEach((button) => button.addEventListener("click", closeTaskPanel));
document.querySelectorAll(".task-cancel").forEach((button) => button.addEventListener("click", () => {
  resetTaskForm();
  switchTaskModalView("list");
}));

elements.taskForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const task = taskFromForm();
  if (!task.school || !task.course) {
    showToast("请填写学校和课程", "error");
    return;
  }
  await upsertWeeklyTask(task);
  resetTaskForm();
  showToast("任务已保存", "success");
  switchTaskModalView("list");
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

// Close task panel on escape key
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && elements.taskPanel?.classList.contains("open")) {
    const activeDialog = document.querySelector("dialog[open]");
    if (!activeDialog) {
      closeTaskPanel();
      event.preventDefault();
    }
  }
});

// Close task panel on overlay click
elements.taskPanelOverlay?.addEventListener("click", closeTaskPanel);

document.addEventListener("click", (event) => {
  const panel = elements.taskPanel;
  if (!panel?.classList.contains("open")) return;

  const taskButton = elements.menuTaskButton;
  const target = event.target;
  if (panel.contains(target) || taskButton?.contains(target)) return;

  closeTaskPanel();
});

initTerminal();
renderTabs();
window.workbench.updateTabsList(tabs);
setSidebarCollapsed(localStorage.getItem(sidebarStorageKey) === "true");
loadWeeklyTasks();
window.workbench.onDownloadCompleted(handleDownloadCompleted);
window.workbench.getExtensions().then(({ results }) => renderExtensionsInTopbar(results));
