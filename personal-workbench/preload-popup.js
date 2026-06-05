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

const mockCookies = {
  getAll(details = {}, callback) {
    const promise = ipcRenderer.invoke("workbench:get-cookies", details).then((list) => list || []);
    if (typeof callback === "function") promise.then(callback);
    return promise;
  },
  get(details = {}, callback) {
    const promise = ipcRenderer.invoke("workbench:get-cookies", details).then((list) => list?.[0] || null);
    if (typeof callback === "function") promise.then(callback);
    return promise;
  }
};

function patchChromeApis(chromeApi) {
  if (!chromeApi) return;
  try {
    chromeApi.tabs = chromeApi.tabs || {};
    chromeApi.tabs.query = mockTabs.query;
    chromeApi.tabs.getSelected = mockTabs.getSelected;
    chromeApi.cookies = chromeApi.cookies || {};
    chromeApi.cookies.getAll = mockCookies.getAll;
    chromeApi.cookies.get = mockCookies.get;
  } catch {
    try {
      Object.defineProperty(chromeApi, "tabs", {
        value: { ...(chromeApi.tabs || {}), ...mockTabs },
        configurable: true
      });
      Object.defineProperty(chromeApi, "cookies", {
        value: { ...(chromeApi.cookies || {}), ...mockCookies },
        configurable: true
      });
    } catch {}
  }
}

if (window.chrome) {
  patchChromeApis(window.chrome);
} else {
  let realChrome;
  Object.defineProperty(window, "chrome", {
    get() {
      return realChrome || { tabs: mockTabs, cookies: mockCookies };
    },
    set(value) {
      realChrome = value;
      patchChromeApis(realChrome);
    },
    configurable: true
  });
}
