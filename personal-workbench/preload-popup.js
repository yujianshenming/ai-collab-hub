const { ipcRenderer } = require("electron");

function activeTab(callback) {
  const promise = ipcRenderer.invoke("workbench:get-active-tab-info").then((tabInfo) => ({
      id: 9999,
      url: tabInfo.url,
      title: tabInfo.title,
      active: true
    }));
  if (typeof callback === "function") promise.then(callback);
  return promise;
}

const mockTabs = {
  query(_queryInfo, callback) {
    const promise = activeTab();
    if (typeof callback === "function") promise.then((tab) => callback([tab]));
    return promise.then((tab) => [tab]);
  },
  getSelected(windowId, callback) {
    const cb = typeof windowId === "function" ? windowId : callback;
    return activeTab(cb);
  }
};

function patchChromeTabs(chromeApi) {
  if (!chromeApi) return;
  try {
    chromeApi.tabs = chromeApi.tabs || {};
    chromeApi.tabs.query = mockTabs.query;
    chromeApi.tabs.getSelected = mockTabs.getSelected;
  } catch {
    try {
      Object.defineProperty(chromeApi, "tabs", {
        value: { ...(chromeApi.tabs || {}), ...mockTabs },
        configurable: true
      });
    } catch {}
  }
}

if (window.chrome) {
  patchChromeTabs(window.chrome);
} else {
  let realChrome;
  Object.defineProperty(window, "chrome", {
    get() {
      return realChrome || { tabs: mockTabs };
    },
    set(value) {
      realChrome = value;
      patchChromeTabs(realChrome);
    },
    configurable: true
  });
}
