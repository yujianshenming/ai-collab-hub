const { contextBridge, ipcRenderer } = require("electron");

const WORKBENCH_TAB_ID = 9999;
const TRAINING_HOST_RE = /hike-teaching-center\.polymas\.com.*ability/i;
const COOKIE_URL = "https://hike-teaching-center.polymas.com/";
const COOKIE_NAME = "ai-poly";
const STORAGE_PREFIX = "pw-ext-storage:";
const POLL_INTERVAL_MS = 1000;
const BRIDGE_FIRST_MESSAGE_TYPES = new Set([
  "GET_CURRENT_TAB_URL",
  "GET_CURRENT_TAB_INFO",
  "GET_AUTH",
  "EXTRACT_TRAIN_TASK_ID",
  "EXTRACT_PAGE_IDS",
  "GET_PLATFORM_CONFIG",
  "API_REQUEST"
]);

let lastKnownUrl = "";
let pollHandle = null;
const runtimeMessageListeners = new Set();
const mainWorldRuntimeListeners = new Set();
let mainWorldBridgeInstalled = false;

function debugLog(event, details = {}) {
  try {
    ipcRenderer.send("workbench:extension-debug-log", { event, details });
  } catch {}
}

debugLog("preload:loaded", { href: window.location?.href || "" });
debugLog("preload:init", {
  contextIsolated: Boolean(process.contextIsolated),
  hasDocumentElement: Boolean(document.documentElement),
  hasChrome: Boolean(window.chrome)
});

function mainWorldBridgeBootstrap() {
  if (window.__workbenchChromeBridgeInstalled) return;
  window.__workbenchChromeBridgeInstalled = true;
  const pending = new Map();
  const listeners = new Set();
  let seq = 0;
  const request = (method, payload) => new Promise((resolve) => {
    const id = "wb_" + Date.now() + "_" + (++seq);
    pending.set(id, resolve);
    window.postMessage({ source: "workbench-main-world-chrome", kind: "request", id, method, payload }, "*");
  });
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data || {};
    if (data.source !== "workbench-preload-chrome") return;
    if (data.kind === "response") {
      const resolve = pending.get(data.id);
      if (resolve) {
        pending.delete(data.id);
        resolve(data.result);
      }
      return;
    }
    if (data.kind === "runtime-message") {
      for (const listener of listeners) {
        try { listener(data.message, data.sender || {}, () => {}); } catch {}
      }
    }
  });
  const withCallback = (promise, callback) => {
    if (typeof callback === "function") promise.then(callback);
    return promise;
  };
  const extensionOrigin = window.location.protocol === "chrome-extension:"
    ? window.location.origin
    : "";
  const extensionId = extensionOrigin
    ? window.location.hostname
    : "workbench-extension-bridge";
  const runtime = {
    id: extensionId,
    getURL(target = "") {
      const baseUrl = extensionOrigin || ("chrome-extension://" + runtime.id);
      return baseUrl + "/" + String(target).replace(/^\/+/, "");
    },
    sendMessage(...args) {
      const callback = typeof args[args.length - 1] === "function" ? args.pop() : null;
      const message = typeof args[0] === "string" ? args[1] : args[0];
      return withCallback(request("runtime.sendMessage", { message: message || {} }), callback);
    },
    onMessage: {
      addListener(listener) {
        if (typeof listener === "function") {
          listeners.add(listener);
          window.postMessage({ source: "workbench-main-world-chrome", kind: "listener", action: "add" }, "*");
        }
      },
      removeListener(listener) {
        listeners.delete(listener);
        window.postMessage({ source: "workbench-main-world-chrome", kind: "listener", action: "remove" }, "*");
      },
      hasListener(listener) {
        return listeners.has(listener);
      }
    }
  };
  const chromeApi = window.chrome || {};
  chromeApi.runtime = runtime;
  chromeApi.tabs = {
      ...(chromeApi.tabs || {}),
      query(queryInfo, callback) {
        return withCallback(request("tabs.query", { queryInfo: queryInfo || {} }), callback);
      },
      get(tabId, callback) {
        return withCallback(request("tabs.get", { tabId }), callback);
      },
      getSelected(windowId, callback) {
        const cb = typeof windowId === "function" ? windowId : callback;
        return withCallback(request("tabs.getSelected", {}), cb);
      },
      sendMessage(tabId, message, callback) {
        return withCallback(request("tabs.sendMessage", { tabId, message }), callback);
      }
    };
  chromeApi.cookies = {
      ...(chromeApi.cookies || {}),
      getAll(details, callback) {
        return withCallback(request("cookies.getAll", { details: details || {} }), callback);
      },
      get(details, callback) {
        return withCallback(request("cookies.get", { details: details || {} }), callback);
      }
    };
  chromeApi.storage = {
      ...(chromeApi.storage || {}),
      local: {
        get(keys, callback) {
          return withCallback(request("storage.local.get", { keys }), callback);
        },
        set(items, callback) {
          return withCallback(request("storage.local.set", { items: items || {} }), callback);
        },
        remove(keys, callback) {
          return withCallback(request("storage.local.remove", { keys }), callback);
        },
        clear(callback) {
          return withCallback(request("storage.local.clear", {}), callback);
        },
        onChanged: {
          addListener() {},
          removeListener() {},
          hasListener() { return false; }
        }
      },
      onChanged: {
        addListener() {},
        removeListener() {},
        hasListener() { return false; }
      }
    };
  chromeApi.scripting = {
      ...(chromeApi.scripting || {}),
      executeScript(details, callback) {
        return withCallback(request("scripting.executeScript", { details: details || {} }), callback);
      }
    };
  window.chrome = chromeApi;
  return true;
}

function installMainWorldBridge() {
  if (mainWorldBridgeInstalled) return;
  const installed = contextBridge.executeInMainWorld({ func: mainWorldBridgeBootstrap });
  mainWorldBridgeInstalled = true;
  debugLog("main-world:bridge-installed", {
    method: "contextBridge.executeInMainWorld",
    installed: Boolean(installed)
  });
}

if (process.contextIsolated) {
  try {
    installMainWorldBridge();
  } catch (error) {
    debugLog("main-world:bridge-error", {
      message: error?.message || String(error),
      hasDocumentElement: Boolean(document.documentElement)
    });
  }
}

ipcRenderer
  .invoke("workbench:get-session-token")
  .then((token) => {
    window.__workbenchSessionToken = token;
  })
  .catch(() => {});

function parseSendMessageArgs(args) {
  if (!args.length) return { message: {}, callback: null };
  if (typeof args[0] === "string" && typeof args[1] === "object") {
    const callback = typeof args[2] === "function" ? args[2] : null;
    return { message: args[1] || {}, callback };
  }
  const callback = typeof args[1] === "function" ? args[1] : typeof args[0] === "function" ? args[0] : null;
  const message = typeof args[0] === "object" ? args[0] : {};
  return { message, callback };
}

function postMainWorldResponse(id, result) {
  window.postMessage({ source: "workbench-preload-chrome", kind: "response", id, result }, "*");
}

function postMainWorldRuntimeMessage(message) {
  window.postMessage({
    source: "workbench-preload-chrome",
    kind: "runtime-message",
    message,
    sender: { id: WORKBENCH_TAB_ID }
  }, "*");
}

async function handleRuntimeSendMessage(message = {}) {
  const messageType = String(message?.type || "");
  const handler = messageType ? bridgeHandlers[messageType] : null;
  debugLog("runtime:send-message", {
    messageType,
    hasHandler: Boolean(handler),
    bridgeFirst: Boolean(handler && BRIDGE_FIRST_MESSAGE_TYPES.has(messageType)),
    source: "main-world"
  });
  if (handler) return handler(message.payload);
  return { success: false, error: `Unsupported message type: ${messageType || "unknown"}` };
}

window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  const data = event.data || {};
  if (data.source !== "workbench-main-world-chrome") return;
  if (data.kind === "listener") {
    if (data.action === "add") {
      mainWorldRuntimeListeners.add("main-world");
      debugLog("runtime:on-message-add", { listenerCount: mainWorldRuntimeListeners.size, source: "main-world" });
      getCurrentTabUrl()
        .then((url) => {
          if (url) postMainWorldRuntimeMessage({ type: "TAB_URL_CHANGED", payload: { tabId: WORKBENCH_TAB_ID, url } });
        })
        .catch(() => {});
    } else if (data.action === "remove") {
      mainWorldRuntimeListeners.clear();
      debugLog("runtime:on-message-remove", { listenerCount: mainWorldRuntimeListeners.size, source: "main-world" });
    }
    return;
  }
  if (data.kind !== "request" || !data.id) return;
  try {
    const payload = data.payload || {};
    let result;
    switch (data.method) {
      case "runtime.sendMessage":
        result = await handleRuntimeSendMessage(payload.message || {});
        break;
      case "tabs.query":
        result = await mockTabs.query(payload.queryInfo || {});
        break;
      case "tabs.get":
        result = await mockTabs.get(payload.tabId);
        break;
      case "tabs.getSelected":
        result = await activeTab();
        break;
      case "tabs.sendMessage":
        debugLog("tabs:send-message", { tabId: payload.tabId, messageType: payload.message?.type || "", source: "main-world" });
        result = { success: false, error: "tabs.sendMessage is not connected in workbench popup bridge" };
        break;
      case "cookies.getAll":
        result = await mockCookies.getAll(payload.details || {});
        break;
      case "cookies.get":
        result = await mockCookies.get(payload.details || {});
        break;
      case "storage.local.get":
        result = await createStorageLocal().get(payload.keys);
        break;
      case "storage.local.set":
        result = await createStorageLocal().set(payload.items || {});
        break;
      case "storage.local.remove":
        result = undefined;
        break;
      case "storage.local.clear":
        result = undefined;
        break;
      case "scripting.executeScript":
        debugLog("scripting:execute-script", {
          tabId: payload.details?.target?.tabId,
          files: payload.details?.files || [],
          hasFunc: typeof payload.details?.func === "function",
          source: "main-world"
        });
        result = [];
        break;
      default:
        result = { success: false, error: `Unsupported bridge method: ${data.method}` };
    }
    postMainWorldResponse(data.id, result);
  } catch (error) {
    postMainWorldResponse(data.id, { success: false, error: error?.message || String(error) });
  }
});

async function activeTab(callback) {
  const promise = ipcRenderer.invoke("workbench:get-active-tab-info").then((tabInfo) => {
    const url = String(tabInfo?.url || "");
    const title = String(tabInfo?.title || "");
    return {
      id: WORKBENCH_TAB_ID,
      url,
      title,
      active: true
    };
  });
  if (typeof callback === "function") promise.then(callback);
  return promise;
}

function normalizeLocalStorageGet(keys) {
  if (keys == null) return {};
  if (Array.isArray(keys)) {
    return keys.reduce((acc, key) => {
      acc[key] = undefined;
      return acc;
    }, {});
  }
  if (typeof keys === "string") return { [keys]: undefined };
  if (typeof keys === "object") return { ...keys };
  return {};
}

function readLocalStorageValue(key, fallback) {
  const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${key}`);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function createStorageLocal(originalStorageLocal) {
  const onChanged = originalStorageLocal?.onChanged || {
    addListener() {},
    removeListener() {},
    hasListener() { return false; }
  };
  const get = (keys, callback) => {
    const defaults = normalizeLocalStorageGet(keys);
    const result = Object.keys(defaults).reduce((acc, key) => {
      acc[key] = readLocalStorageValue(key, defaults[key]);
      return acc;
    }, {});
    debugLog("storage:local-get", { keys: Object.keys(defaults) });
    if (typeof callback === "function") callback(result);
    return Promise.resolve(result);
  };

  const set = (items, callback) => {
    const payload = items && typeof items === "object" ? items : {};
    for (const [key, value] of Object.entries(payload)) {
      window.localStorage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(value));
    }
    debugLog("storage:local-set", { keys: Object.keys(payload) });
    if (typeof callback === "function") callback();
    return Promise.resolve();
  };

  if (originalStorageLocal) {
    return {
      ...originalStorageLocal,
      get,
      set,
      onChanged
    };
  }

  return { get, set, onChanged };
}

const mockTabs = {
  query(queryInfo = {}, callback) {
    const promise = activeTab().then((tab) => {
      const tabs = tab?.url ? [tab] : [];
      debugLog("tabs:query", {
        queryKeys: queryInfo && typeof queryInfo === "object" ? Object.keys(queryInfo) : [],
        count: tabs.length,
        url: tab?.url || ""
      });
      return tabs;
    });
    if (typeof callback === "function") promise.then(callback);
    return promise;
  },
  getSelected(windowId, callback) {
    const cb = typeof windowId === "function" ? windowId : callback;
    return activeTab(cb);
  },
  get(tabId, callback) {
    const promise = activeTab().then((tab) => {
      if (tabId == null || tabId === WORKBENCH_TAB_ID) return tab;
      return { ...tab, id: Number(tabId) || WORKBENCH_TAB_ID };
    });
    if (typeof callback === "function") promise.then(callback);
    return promise;
  }
};

const mockCookies = {
  getAll(details = {}, callback) {
    const promise = ipcRenderer.invoke("workbench:get-cookies", details).then((list) => {
      debugLog("cookies:get-all", {
        url: details?.url || "",
        name: details?.name || "",
        count: Array.isArray(list) ? list.length : 0,
        cookieNames: Array.isArray(list) ? list.map((cookie) => cookie.name) : []
      });
      return list || [];
    });
    if (typeof callback === "function") promise.then(callback);
    return promise;
  },
  get(details = {}, callback) {
    const promise = ipcRenderer.invoke("workbench:get-cookies", details).then((list) => {
      debugLog("cookies:get", {
        url: details?.url || "",
        name: details?.name || "",
        found: Boolean(list?.[0])
      });
      return list?.[0] || null;
    });
    if (typeof callback === "function") promise.then(callback);
    return promise;
  }
};

async function getCurrentTabUrl() {
  const tab = await activeTab();
  const url = tab?.url || "";
  debugLog("bridge:get-current-tab-url", { url });
  return url;
}

async function getCurrentTabInfo() {
  const tab = await activeTab();
  const url = String(tab?.url || "");
  return {
    success: true,
    data: {
      url,
      tabId: tab?.id ?? WORKBENCH_TAB_ID,
      isZhihuishu: TRAINING_HOST_RE.test(url)
    }
  };
}

async function getAuth() {
  try {
    const authorization = await mockCookies.get({ url: COOKIE_URL, name: COOKIE_NAME });
    const cookies = await mockCookies.getAll({ url: COOKIE_URL });
    return {
      success: true,
      data: {
        authorization: authorization?.value || null,
        cookies: cookies.map((item) => `${item.name}=${item.value}`).join("; ")
      }
    };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
}

async function extractTrainTaskId(payload) {
  try {
    let candidateUrl = typeof payload === "string" ? payload : payload?.url;
    if (!candidateUrl) candidateUrl = await getCurrentTabUrl();
    if (!candidateUrl) {
      debugLog("bridge:extract-train-task-id", { ok: false, reason: "no-url" });
      return { success: false, error: "No URL available" };
    }
    const parsed = new URL(candidateUrl);
    let taskId = parsed.searchParams.get("trainTaskId");
    if (!taskId && parsed.hostname === "hike-teaching-center.polymas.com") {
      const parts = parsed.pathname.split("/").filter(Boolean);
      const lastPart = parts.at(-1) || "";
      if (/^[A-Za-z0-9_-]{12,}$/.test(lastPart)) taskId = lastPart;
    }
    debugLog("bridge:extract-train-task-id", {
      ok: Boolean(taskId),
      url: candidateUrl,
      taskIdPreview: taskId ? `${taskId.slice(0, 10)}...` : ""
    });
    return taskId
      ? { success: true, data: taskId }
      : { success: false, error: "trainTaskId not found in URL" };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
}

async function extractPageIds(payload) {
  try {
    let candidateUrl = typeof payload === "string" ? payload : payload?.url;
    if (!candidateUrl) candidateUrl = await getCurrentTabUrl();
    if (!candidateUrl) return { success: false, error: "No URL available" };
    const parsed = new URL(candidateUrl);
    const trainTaskId = parsed.searchParams.get("trainTaskId") || null;
    let courseId = parsed.searchParams.get("courseId") || parsed.searchParams.get("course_id") || null;
    if (!courseId && parsed.pathname) {
      const match = parsed.pathname.match(/\/course\/([^/]+)/i) || parsed.pathname.match(/\/courseId[=\/]([^/&]+)/i);
      if (match) courseId = match[1];
    }
    return { success: true, data: { trainTaskId, courseId } };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
}

async function apiRequest(payload = {}) {
  try {
    return await ipcRenderer.invoke("workbench:extension-api-request", payload);
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
}

function extractStepBoundary(payload) {
  let steps = [];
  if (Array.isArray(payload)) steps = payload;
  else if (Array.isArray(payload?.data)) steps = payload.data;
  else if (payload?.data) {
    const data = payload.data;
    steps = data.steps || data.list || data.scriptStepList || data.scriptSteps || [];
  } else {
    steps = payload?.steps || payload?.list || payload?.scriptStepList || payload?.result?.list || payload?.result?.scriptStepList || [];
  }

  const stepType = (step) =>
    step?.type || step?.nodeType || step?.stepType || step?.stepDetailDTO?.nodeType || step?.stepDetailDTO?.stepType || "";
  const stepId = (step) =>
    step?.id || step?.stepId || step?.scriptStepId || step?.stepDetailDTO?.stepId || "";
  const start = steps.find((step) => stepType(step) === "SCRIPT_START");
  const end = steps.find((step) => stepType(step) === "SCRIPT_END");
  return { startNodeId: start ? stepId(start) : "", endNodeId: end ? stepId(end) : "" };
}

async function getPlatformConfig() {
  try {
    const tabInfo = await getCurrentTabInfo();
    if (!tabInfo.success || !tabInfo.data?.url) {
      return { success: false, error: "无法获取当前标签页" };
    }
    const pageIds = await extractPageIds({ url: tabInfo.data.url });
    if (!pageIds.success || !pageIds.data) {
      return { success: false, error: pageIds.error || "无法解析 trainTaskId" };
    }

    const auth = await getAuth();
    const stepResponse = pageIds.data.trainTaskId
      ? await apiRequest({
        endpoint: "/teacher-course/abilityTrain/queryScriptStepList",
        method: "POST",
        body: {
          trainTaskId: pageIds.data.trainTaskId,
          courseId: pageIds.data.courseId || "",
          trainSubType: "ability"
        }
      })
      : null;
    const boundary = stepResponse?.success ? extractStepBoundary(stepResponse.data) : { startNodeId: "", endNodeId: "" };

    return {
      success: true,
      data: {
        url: tabInfo.data.url,
        cookie: auth.success ? auth.data?.cookies || "" : "",
        jwt: auth.success ? auth.data?.authorization || "" : "",
        startNodeId: boundary.startNodeId,
        endNodeId: boundary.endNodeId,
        trainTaskId: pageIds.data.trainTaskId || "",
        courseId: pageIds.data.courseId || ""
      }
    };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
}

const bridgeHandlers = {
  GET_CURRENT_TAB_URL: getCurrentTabUrl,
  GET_CURRENT_TAB_INFO: getCurrentTabInfo,
  GET_AUTH: getAuth,
  EXTRACT_TRAIN_TASK_ID: extractTrainTaskId,
  EXTRACT_PAGE_IDS: extractPageIds,
  GET_PLATFORM_CONFIG: getPlatformConfig,
  API_REQUEST: apiRequest
};

function emitRuntimeMessage(message) {
  debugLog("runtime:emit-message", {
    messageType: message?.type || "",
    listenerCount: runtimeMessageListeners.size,
    mainWorldListenerCount: mainWorldRuntimeListeners.size
  });
  if (mainWorldRuntimeListeners.size > 0) postMainWorldRuntimeMessage(message);
  for (const listener of runtimeMessageListeners) {
    try {
      listener(message, { id: WORKBENCH_TAB_ID }, () => {});
    } catch (error) {
      console.warn("扩展消息监听器执行失败:", error?.message || String(error));
    }
  }
}

function startUrlPolling() {
  if (pollHandle) return;
  getCurrentTabUrl()
    .then((url) => {
      if (!url) return;
      lastKnownUrl = url;
      emitRuntimeMessage({ type: "TAB_URL_CHANGED", payload: { tabId: WORKBENCH_TAB_ID, url } });
    })
    .catch(() => {});
  pollHandle = window.setInterval(async () => {
    try {
      const url = await getCurrentTabUrl();
      if (url && url !== lastKnownUrl) {
        lastKnownUrl = url;
        emitRuntimeMessage({ type: "TAB_URL_CHANGED", payload: { tabId: WORKBENCH_TAB_ID, url } });
      }
    } catch {}
  }, POLL_INTERVAL_MS);
}

function patchChromeApis(chromeApi) {
  if (!chromeApi) return;
  debugLog("preload:patch-chrome", {
    hasRuntime: Boolean(chromeApi.runtime),
    hasRuntimeSendMessage: typeof chromeApi.runtime?.sendMessage === "function"
  });

  const originalTabs = chromeApi.tabs || {};
  chromeApi.tabs = {
    ...originalTabs,
    query: mockTabs.query,
    getSelected: mockTabs.getSelected,
    get: mockTabs.get,
    sendMessage: (...args) => {
      debugLog("tabs:send-message", { tabId: args[0], messageType: args[1]?.type || "" });
      const callback = typeof args[args.length - 1] === "function" ? args[args.length - 1] : null;
      if (callback) callback({ success: false, error: "tabs.sendMessage is not connected in workbench popup bridge" });
      return Promise.resolve({ success: false, error: "tabs.sendMessage is not connected in workbench popup bridge" });
    }
  };

  const originalCookies = chromeApi.cookies || {};
  chromeApi.cookies = {
    ...originalCookies,
    getAll: mockCookies.getAll,
    get: mockCookies.get
  };

  chromeApi.storage = chromeApi.storage || {};
  chromeApi.storage.local = createStorageLocal(chromeApi.storage.local);

  const originalRuntime = chromeApi.runtime || {};
  const originalSendMessage = typeof originalRuntime.sendMessage === "function"
    ? originalRuntime.sendMessage.bind(originalRuntime)
    : null;
  const originalOnMessage = originalRuntime.onMessage || {};
  const originalAddListener = typeof originalOnMessage.addListener === "function"
    ? originalOnMessage.addListener.bind(originalOnMessage)
    : null;
  const originalRemoveListener = typeof originalOnMessage.removeListener === "function"
    ? originalOnMessage.removeListener.bind(originalOnMessage)
    : null;
  const extensionOrigin = window.location.protocol === "chrome-extension:"
    ? window.location.origin
    : "";
  const fallbackRuntimeId = extensionOrigin
    ? window.location.hostname
    : "workbench-extension-bridge";

  const runtime = {
    ...originalRuntime,
    id: originalRuntime.id || fallbackRuntimeId,
    getURL: originalRuntime.getURL || ((target = "") => {
      const baseUrl = extensionOrigin || `chrome-extension://${runtime.id}`;
      return `${baseUrl}/${String(target).replace(/^\/+/, "")}`;
    }),
    sendMessage: (...args) => {
      const { message, callback } = parseSendMessageArgs(args);
      const messageType = String(message?.type || "");
      const handler = messageType ? bridgeHandlers[messageType] : null;
      debugLog("runtime:send-message", {
        messageType,
        hasHandler: Boolean(handler),
        bridgeFirst: Boolean(handler && BRIDGE_FIRST_MESSAGE_TYPES.has(messageType)),
        hasOriginalSendMessage: Boolean(originalSendMessage)
      });
      if (handler && BRIDGE_FIRST_MESSAGE_TYPES.has(messageType)) {
        debugLog("runtime:bridge-first", { messageType });
        const promise = Promise.resolve(handler(message.payload));
        if (callback) promise.then(callback);
        return promise;
      }
      if (originalSendMessage) {
        debugLog("runtime:original-send-message", { messageType });
        return originalSendMessage(...args);
      }
      if (handler) {
        debugLog("runtime:bridge-fallback", { messageType });
        const promise = Promise.resolve(handler(message.payload));
        if (callback) promise.then(callback);
        return promise;
      }
      const fallback = { success: false, error: `Unsupported message type: ${messageType || "unknown"}` };
      if (callback) callback(fallback);
      return Promise.resolve(fallback);
    },
    onMessage: {
      ...originalOnMessage,
      addListener(listener) {
        if (typeof listener === "function") {
          runtimeMessageListeners.add(listener);
          debugLog("runtime:on-message-add", { listenerCount: runtimeMessageListeners.size });
          getCurrentTabUrl()
            .then((url) => {
              if (url) listener({ type: "TAB_URL_CHANGED", payload: { tabId: WORKBENCH_TAB_ID, url } }, { id: WORKBENCH_TAB_ID }, () => {});
            })
            .catch(() => {});
        }
        if (originalAddListener) {
          try { originalAddListener(listener); } catch {}
        }
      },
      removeListener(listener) {
        runtimeMessageListeners.delete(listener);
        debugLog("runtime:on-message-remove", { listenerCount: runtimeMessageListeners.size });
        if (originalRemoveListener) {
          try { originalRemoveListener(listener); } catch {}
        }
      }
    }
  };

  chromeApi.runtime = runtime;
  chromeApi.scripting = chromeApi.scripting || {
    executeScript(details = {}, callback) {
      debugLog("scripting:execute-script", {
        tabId: details?.target?.tabId,
        files: details?.files || [],
        hasFunc: typeof details?.func === "function"
      });
      const result = [];
      if (typeof callback === "function") callback(result);
      return Promise.resolve(result);
    }
  };
  debugLog("preload:chrome-ready", {
    hasRuntime: typeof chromeApi.runtime?.sendMessage === "function",
    hasTabs: typeof chromeApi.tabs?.query === "function",
    hasStorage: typeof chromeApi.storage?.local?.get === "function",
    hasCookies: typeof chromeApi.cookies?.getAll === "function",
    hasScripting: typeof chromeApi.scripting?.executeScript === "function"
  });
  startUrlPolling();
}

if (window.chrome) {
  patchChromeApis(window.chrome);
} else {
  let realChrome;
  Object.defineProperty(window, "chrome", {
    get() {
      if (!realChrome) {
        realChrome = {};
        patchChromeApis(realChrome);
      }
      return realChrome;
    },
    set(value) {
      realChrome = value || {};
      patchChromeApis(realChrome);
    },
    configurable: true
  });
}
