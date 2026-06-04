const DEFAULT_TABS = [
  { id: "evaluation", name: "评估", url: "https://www.wl363eval.top/" }
];

const storageKey = "personal_workbench_tabs";
let tabs = readTabs();
let activeTabId = localStorage.getItem("personal_workbench_active") || tabs[0].id;
let terminal;
let fitAddon;
let currentLine = "";

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
  terminalToggle: document.querySelector("#terminal-toggle")
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
    item.querySelector(".tab-main").addEventListener("click", () => activateTab(tab.id));
    item.querySelector(".tab-menu").addEventListener("click", () => openTabDialog(tab));
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
});

const resizer = document.querySelector("#terminal-resizer");
resizer.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  resizer.setPointerCapture(event.pointerId);
  const startY = event.clientY;
  const startHeight = elements.terminalPanel.getBoundingClientRect().height;
  const onMove = (moveEvent) => {
    const height = Math.max(180, Math.min(window.innerHeight * 0.7, startHeight + startY - moveEvent.clientY));
    document.documentElement.style.setProperty("--terminal-height", `${height}px`);
    fitAddon.fit();
  };
  const onUp = () => {
    resizer.removeEventListener("pointermove", onMove);
    resizer.removeEventListener("pointerup", onUp);
  };
  resizer.addEventListener("pointermove", onMove);
  resizer.addEventListener("pointerup", onUp);
});

window.addEventListener("resize", () => fitAddon?.fit());
initTerminal();
renderTabs();
