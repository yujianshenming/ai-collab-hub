const DEFAULT_TABS = [
  { id: "evaluation", name: "评估", url: "https://www.wl363eval.top/" }
];

const storageKey = "personal_workbench_tabs";
const sidebarStorageKey = "personal_workbench_sidebar_collapsed";
let tabs = readTabs();
let activeTabId = localStorage.getItem("personal_workbench_active") || tabs[0].id;
let terminal;
let fitAddon;
let currentLine = "";
let pointerDrag = null;
let suppressTabClickUntil = 0;

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
  rightSidebarTitle: document.querySelector("#right-sidebar-title"),
  rightSidebarClose: document.querySelector("#right-sidebar-close"),
  rightSidebarWebview: document.querySelector("#right-sidebar-webview")
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
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function iconForTab(name) {
  return (name.trim()[0] || "W").toUpperCase();
}

function renderTabs() {
  elements.tabList.replaceChildren();

  for (const tab of tabs) {
    const item = document.createElement("div");
    item.className = `tab-item${tab.id === activeTabId ? " active" : ""}`;
    item.dataset.id = tab.id;
    item.innerHTML = `
      <button class="tab-main" type="button">
        <span class="tab-icon">${iconForTab(tab.name)}</span>
        <span>${tab.name}</span>
      </button>
      <button class="tab-menu" type="button" aria-label="编辑 ${tab.name}" title="编辑标签">•••</button>
    `;
    item.querySelector(".tab-main").addEventListener("click", () => {
      if (Date.now() >= suppressTabClickUntil) activateTab(tab.id);
    });
    item.querySelector(".tab-menu").addEventListener("click", () => openTabDialog(tab));
    item.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest(".tab-menu")) return;
      item.setPointerCapture(event.pointerId);
      setWebviewPointerEvents(false);
      pointerDrag = { id: tab.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, active: false };
    });
    elements.tabList.append(item);

    if (!document.querySelector(`webview[data-id="${tab.id}"]`)) {
      createWebview(tab);
    }
  }

  document.querySelectorAll("webview[data-id]").forEach((webview) => {
    if (!tabs.some((tab) => tab.id === webview.dataset.id)) webview.remove();
  });

  activateTab(tabs.some((tab) => tab.id === activeTabId) ? activeTabId : tabs[0].id);
}

function clearDragState() {
  document.querySelectorAll(".tab-item").forEach((item) => item.classList.remove("dragging", "drag-over"));
}

function setWebviewPointerEvents(enabled) {
  document.querySelectorAll("webview").forEach((webview) => {
    webview.style.pointerEvents = enabled ? "auto" : "none";
  });
}

function reorderTab(draggedId, targetId) {
  const draggedIndex = tabs.findIndex((tab) => tab.id === draggedId);
  const targetIndex = tabs.findIndex((tab) => tab.id === targetId);
  if (draggedIndex < 0 || targetIndex < 0 || draggedIndex === targetIndex) return false;
  const [draggedTab] = tabs.splice(draggedIndex, 1);
  tabs.splice(targetIndex, 0, draggedTab);
  saveTabs();
  return true;
}

function createWebview(tab) {
  const webview = document.createElement("webview");
  webview.dataset.id = tab.id;
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
  webview.addEventListener("page-title-updated", (event) => {
    if (tab.id === activeTabId && event.title) elements.activeTitle.textContent = tab.name;
  });
  elements.webviewStack.append(webview);
}

function activeWebview() {
  return document.querySelector(`webview[data-id="${activeTabId}"]`);
}

function activateTab(id) {
  activeTabId = id;
  localStorage.setItem("personal_workbench_active", id);
  const tab = tabs.find((candidate) => candidate.id === id);
  if (!tab) return;

  document.querySelectorAll(".tab-item").forEach((item) => item.classList.toggle("active", item.dataset.id === id));
  document.querySelectorAll("webview[data-id]").forEach((webview) => webview.classList.toggle("active", webview.dataset.id === id));
  elements.activeTitle.textContent = tab.name;
  elements.addressInput.value = activeWebview()?.getURL?.() || tab.url;
}

function updateAddressFromWebview(webview) {
  if (webview.dataset.id === activeTabId) elements.addressInput.value = webview.getURL();
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
  terminal.onData((data) => {
    if (data.startsWith("\x1b")) return;
    for (const character of data.replace(/\r\n/g, "\r")) {
      if (character === "\r" || character === "\n") {
        terminal.write("\r\n");
        window.workbench.sendTerminalInput(`${currentLine}\r\n`);
        currentLine = "";
      } else if (character === "\x7f" || character === "\x08") {
        if (currentLine.length > 0) {
          currentLine = currentLine.slice(0, -1);
          terminal.write("\b \b");
        }
      } else if (character === "\x03") {
        currentLine = "";
        terminal.write("^C\r\n");
        window.workbench.sendTerminalInput(character);
      } else {
        currentLine += character;
        terminal.write(character);
      }
    }
  });
  window.workbench.onTerminalData((data) => terminal.write(data));
}

function toggleTerminal(force) {
  const open = typeof force === "boolean" ? force : !elements.terminalPanel.classList.contains("open");
  elements.terminalPanel.classList.toggle("open", open);
  elements.terminalToggle.setAttribute("aria-expanded", String(open));
  if (open) {
    window.workbench.startTerminal();
    setTimeout(() => {
      fitAddon.fit();
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
      const isOpen = elements.appShell.classList.contains("right-sidebar-open")
        && elements.rightSidebarWebview.src === popupUrl;
      toggleRightSidebar(!isOpen, popupUrl, extension.name);
    });
    elements.extensionsBar.append(button);
  }
}

function toggleRightSidebar(open, url = "", title = "") {
  elements.appShell.classList.toggle("right-sidebar-open", open);
  if (open) {
    elements.rightSidebarTitle.textContent = title || "扩展程序";
    elements.rightSidebarWebview.src = url;
  } else {
    elements.rightSidebarWebview.src = "about:blank";
  }
  setTimeout(() => fitAddon?.fit(), 230);
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
document.querySelector("#back-button").addEventListener("click", () => activeWebview()?.canGoBack() && activeWebview().goBack());
document.querySelector("#forward-button").addEventListener("click", () => activeWebview()?.canGoForward() && activeWebview().goForward());
document.querySelector("#reload-button").addEventListener("click", () => {
  const webview = activeWebview();
  if (!webview) return;
  webview.isLoading() ? webview.stop() : webview.reload();
});
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
  const entries = [...document.querySelectorAll(".extension-row")].map((row) => ({
    enabled: row.querySelector(".extension-enabled").checked,
    id: row.querySelector(".extension-id").value.trim(),
    path: row.querySelector(".extension-path").value.trim()
  })).filter((entry) => entry.id || entry.path);
  const results = await window.workbench.saveExtensions(entries);
  renderExtensionResults(results);
  renderExtensionsInTopbar(results);
});

const resizer = document.querySelector("#terminal-resizer");
const terminalHeader = document.querySelector(".terminal-header");

function beginTerminalResize(event) {
  if (event.button !== 0 || event.target.closest("button")) return;
  event.preventDefault();
  const handle = event.currentTarget;
  handle.setPointerCapture(event.pointerId);
  setWebviewPointerEvents(false);
  const startY = event.clientY;
  const startHeight = elements.terminalPanel.getBoundingClientRect().height;
  const onMove = (moveEvent) => {
    const height = Math.max(180, Math.min(window.innerHeight * 0.7, startHeight + startY - moveEvent.clientY));
    document.documentElement.style.setProperty("--terminal-height", `${height}px`);
    fitAddon.fit();
  };
  const onUp = () => {
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
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

window.addEventListener("resize", () => fitAddon?.fit());
document.addEventListener("pointermove", (event) => {
  if (!pointerDrag) return;
  if (!pointerDrag.active && Math.hypot(event.clientX - pointerDrag.startX, event.clientY - pointerDrag.startY) < 6) return;
  pointerDrag.active = true;
  document.querySelector(`.tab-item[data-id="${pointerDrag.id}"]`)?.classList.add("dragging");
  document.querySelectorAll(".tab-item.drag-over").forEach((item) => item.classList.remove("drag-over"));
  document.elementFromPoint(event.clientX, event.clientY)?.closest(".tab-item")?.classList.add("drag-over");
});
document.addEventListener("pointerup", (event) => {
  if (!pointerDrag) return;
  const dragItem = document.querySelector(`.tab-item[data-id="${pointerDrag.id}"]`);
  if (dragItem?.hasPointerCapture(pointerDrag.pointerId)) dragItem.releasePointerCapture(pointerDrag.pointerId);
  setWebviewPointerEvents(true);
  if (pointerDrag.active) {
    const targetId = document.elementFromPoint(event.clientX, event.clientY)?.closest(".tab-item")?.dataset.id;
    if (targetId && reorderTab(pointerDrag.id, targetId)) renderTabs();
    suppressTabClickUntil = Date.now() + 250;
  }
  pointerDrag = null;
  clearDragState();
});
document.addEventListener("pointercancel", () => {
  setWebviewPointerEvents(true);
  pointerDrag = null;
  clearDragState();
});
initTerminal();
renderTabs();
setSidebarCollapsed(localStorage.getItem(sidebarStorageKey) === "true");
window.workbench.getExtensions().then(({ results }) => renderExtensionsInTopbar(results));
