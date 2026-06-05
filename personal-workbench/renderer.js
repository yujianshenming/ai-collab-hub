const DEFAULT_TABS = [
  { id: "evaluation", name: "评估", url: "https://www.wl363eval.top/" }
];

const storageKey = "personal_workbench_tabs";
const sidebarStorageKey = "personal_workbench_sidebar_collapsed";
let tabs = readTabs();
let activeTabId = localStorage.getItem("personal_workbench_active") || tabs[0].id;
let splitTabId = null;
let terminal;
let fitAddon;
let pointerDrag = null;

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
  terminalToggle: document.querySelector("#terminal-toggle"),
  appShell: document.querySelector(".app-shell"),
  extensionsBar: document.querySelector("#extensions-bar"),
  rightSidebar: document.querySelector("#right-sidebar"),
  rightSidebarResizer: document.querySelector("#right-sidebar-resizer"),
  rightSidebarTitle: document.querySelector("#right-sidebar-title"),
  rightSidebarClose: document.querySelector("#right-sidebar-close")
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

  for (const tab of tabs) {
    const item = document.createElement("div");
    item.className = `tab-item${tab.id === activeTabId ? " active" : ""}${tab.id === splitTabId ? " split-active" : ""}`;
    item.dataset.id = tab.id;
    item.innerHTML = `
      <button class="tab-main" type="button">
        <span class="tab-icon">${iconForTab(tab.name)}</span>
        <span>${tab.name}</span>
      </button>
      <button class="tab-menu" type="button" aria-label="编辑 ${tab.name}" title="编辑标签">•••</button>
    `;
    item.querySelector(".tab-menu").addEventListener("click", () => openTabDialog(tab));
    item.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest(".tab-menu")) return;
      item.setPointerCapture(event.pointerId);
      setWebviewPointerEvents(false);
      pointerDrag = { id: tab.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, active: false };
    });
    elements.tabList.append(item);

    if (!document.querySelector(`.tab-viewport[data-id="${tab.id}"]`)) {
      createTabViewport(tab);
    }
  }

  document.querySelectorAll(".tab-viewport[data-id]").forEach((viewport) => {
    if (!tabs.some((tab) => tab.id === viewport.dataset.id)) viewport.remove();
  });

  activateTab(tabs.some((tab) => tab.id === activeTabId) ? activeTabId : tabs[0].id);
}

function clearDragState() {
  document.querySelectorAll(".tab-item").forEach((item) => {
    item.classList.remove("dragging", "swap-target");
    item.style.transform = "";
  });
  document.querySelector("#split-drag-overlay")?.classList.remove("show");
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

  const webview = document.createElement("webview");
  webview.className = "tab-webview";
  webview.src = tab.url;
  webview.partition = "persist:personal-workbench";
  webview.setAttribute("allowpopups", "false");

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
  webview.addEventListener("dom-ready", () => fitWebviewZoom());
  webview.addEventListener("page-title-updated", (event) => {
    if (tab.id === activeTabId && event.title) elements.activeTitle.textContent = tab.name;
  });

  const extPanel = document.createElement("div");
  extPanel.className = "tab-extension-panel";
  extPanel.innerHTML = `
    <div class="tab-extension-resizer" title="拖动调整扩展宽度"></div>
    <div class="tab-extension-header">
      <span class="tab-extension-title">扩展程序</span>
      <button class="icon-button tab-extension-close" type="button" aria-label="关闭扩展">×</button>
    </div>
    <div class="tab-extension-body"></div>
  `;
  extPanel.querySelector(".tab-extension-close").addEventListener("click", () => {
    extPanel.classList.remove("open");
    extPanel.style.removeProperty("--tab-ext-width");
    const extWebview = extPanel.querySelector("webview");
    if (extWebview) extWebview.src = "about:blank";
  });

  const resizer = extPanel.querySelector(".tab-extension-resizer");
  resizer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    elements.appShell.classList.add("resizing");
    extPanel.classList.add("resizing");
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
      setWebviewPointerEvents(true);
      resizer.removeEventListener("pointermove", onMove);
      resizer.removeEventListener("pointerup", onUp);
      resizer.removeEventListener("pointercancel", onUp);
    };
    
    resizer.addEventListener("pointermove", onMove);
    resizer.addEventListener("pointerup", onUp);
    resizer.addEventListener("pointercancel", onUp);
  });

  viewport.append(webview);
  viewport.append(extPanel);
  elements.webviewStack.append(viewport);
}

function activeWebview() {
  return document.querySelector(`.tab-viewport[data-id="${activeTabId}"] .tab-webview`);
}

function activateTab(id) {
  if (splitTabId === id) {
    splitTabId = activeTabId;
  }
  activeTabId = id;
  localStorage.setItem("personal_workbench_active", id);
  const tab = tabs.find((candidate) => candidate.id === id);
  if (!tab) return;

  document.querySelectorAll(".tab-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.id === id);
    item.classList.toggle("split-active", item.dataset.id === splitTabId);
  });

  // Move viewports to their correct parent containers
  document.querySelectorAll(".tab-viewport[data-id]").forEach((viewport) => {
    const vpId = viewport.dataset.id;
    if (vpId === activeTabId) {
      viewport.classList.add("active");
      if (viewport.parentElement !== elements.webviewStack) {
        elements.webviewStack.append(viewport);
      }
    } else if (vpId === splitTabId) {
      viewport.classList.add("active");
      const rightBody = document.querySelector("#right-sidebar-body");
      if (viewport.parentElement !== rightBody) {
        rightBody.append(viewport);
      }
    } else {
      viewport.classList.remove("active");
      if (viewport.parentElement !== elements.webviewStack) {
        elements.webviewStack.append(viewport);
      }
    }
  });

  elements.activeTitle.textContent = tab.name;
  let currentUrl = tab.url;
  try {
    currentUrl = activeWebview()?.getURL?.() || tab.url;
  } catch (error) {
    console.warn("获取 Webview URL 失败:", error);
  }
  elements.addressInput.value = currentUrl;
  updateActiveTabInfo();
  fitWebviewZoom();
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

function openTabDialog(tab = null) {
  document.querySelector("#tab-dialog-title").textContent = tab ? "编辑标签页" : "添加标签页";
  document.querySelector("#tab-id").value = tab?.id || "";
  document.querySelector("#tab-name").value = tab?.name || "";
  document.querySelector("#tab-url").value = tab?.url || "";
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
  elements.terminalToggle.setAttribute("aria-expanded", String(open));
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
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[character]);
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
    splitTabId = tabId;
    elements.appShell.classList.add("right-sidebar-open");
    if (activeTabId === splitTabId) {
      const otherTab = tabs.find(t => t.id !== splitTabId);
      if (otherTab) activeTabId = otherTab.id;
    }
    document.querySelector("#right-sidebar-title").textContent = tabs.find(t => t.id === splitTabId)?.name || "分屏视图";
  } else {
    splitTabId = null;
    elements.appShell.classList.remove("right-sidebar-open");
    document.documentElement.style.removeProperty("--right-sidebar-width");
  }
  
  // Re-run activateTab to update viewport DOM locations
  activateTab(activeTabId);
  
  setTimeout(() => {
    fitAddon?.fit();
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
document.querySelector("#settings-button").addEventListener("click", openSettings);
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
elements.terminalToggle.addEventListener("click", () => toggleTerminal());
document.querySelector("#terminal-close").addEventListener("click", () => toggleTerminal(false));
elements.rightSidebarClose.addEventListener("click", () => toggleRightSidebar(false));

document.querySelectorAll(".dialog-close").forEach((button) => button.addEventListener("click", () => elements.tabDialog.close()));
document.querySelectorAll(".settings-close").forEach((button) => button.addEventListener("click", () => elements.settingsDialog.close()));

elements.tabForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const id = document.querySelector("#tab-id").value;
  const data = {
    id: id || `tab-${Date.now()}`,
    name: document.querySelector("#tab-name").value.trim(),
    url: normalizeUrl(document.querySelector("#tab-url").value)
  };
  const existing = tabs.findIndex((tab) => tab.id === id);
  if (existing >= 0) {
    tabs[existing] = data;
    document.querySelector(`webview[data-id="${id}"]`)?.remove();
  } else {
    tabs.push(data);
  }
  saveTabs();
  activeTabId = data.id;
  elements.tabDialog.close();
  renderTabs();
});

document.querySelector("#delete-tab-button").addEventListener("click", () => {
  const id = document.querySelector("#tab-id").value;
  if (!id || tabs.length === 1) return;
  tabs = tabs.filter((tab) => tab.id !== id);
  document.querySelector(`webview[data-id="${id}"]`)?.remove();
  activeTabId = tabs[0].id;
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
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", onUp);
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onUp);
}

resizer.addEventListener("pointerdown", beginTerminalResize);
terminalHeader.addEventListener("pointerdown", beginTerminalResize);

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
  };
  const onUp = () => {
    if (elements.rightSidebarResizer.hasPointerCapture(event.pointerId)) {
      elements.rightSidebarResizer.releasePointerCapture(event.pointerId);
    }
    elements.appShell.classList.remove("resizing");
    setWebviewPointerEvents(true);
    elements.rightSidebarResizer.removeEventListener("pointermove", onMove);
    elements.rightSidebarResizer.removeEventListener("pointerup", onUp);
    elements.rightSidebarResizer.removeEventListener("pointercancel", onUp);
  };
  elements.rightSidebarResizer.addEventListener("pointermove", onMove);
  elements.rightSidebarResizer.addEventListener("pointerup", onUp);
  elements.rightSidebarResizer.addEventListener("pointercancel", onUp);
}

elements.rightSidebarResizer.addEventListener("pointerdown", beginRightSidebarResize);

window.addEventListener("resize", () => {
  fitAddon?.fit();
  fitWebviewZoom();
  window.workbench.resizeTerminal({ cols: terminal.cols, rows: terminal.rows });
});
document.addEventListener("pointermove", (event) => {
  if (!pointerDrag) return;
  
  if (!pointerDrag.active) {
    if (Math.hypot(event.clientX - pointerDrag.startX, event.clientY - pointerDrag.startY) < 6) return;
    
    // Initialize drag parameters on first movement
    pointerDrag.active = true;
    const items = [...elements.tabList.querySelectorAll(".tab-item")];
    const dragItem = elements.tabList.querySelector(`.tab-item[data-id="${pointerDrag.id}"]`);
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
  const overlay = document.querySelector("#split-drag-overlay");
  
  if (isRightSide) {
    // Show split overlay, clear shifts
    overlay?.classList.add("show");
    pointerDrag.items.forEach((item) => {
      if (item.dataset.id !== pointerDrag.id) {
        item.style.transform = "";
      }
    });
  } else {
    overlay?.classList.remove("show");
    
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
      if (isRightSide) {
        toggleRightSidebar(true, pointerDrag.id);
      } else {
        const draggedIndex = pointerDrag.draggedIndex;
        const insertIndex = pointerDrag.insertIndex;
        if (typeof draggedIndex === "number" && typeof insertIndex === "number" && draggedIndex !== insertIndex) {
          const [movedTab] = tabs.splice(draggedIndex, 1);
          tabs.splice(insertIndex, 0, movedTab);
          saveTabs();
          renderTabs();
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
initTerminal();
renderTabs();
setSidebarCollapsed(localStorage.getItem(sidebarStorageKey) === "true");
window.workbench.getExtensions().then(({ results }) => renderExtensionsInTopbar(results));
