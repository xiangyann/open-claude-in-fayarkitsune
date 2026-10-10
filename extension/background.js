// Background service worker for Claude MCP in Fayar kitsune extension.
// Handles: WebSocket link to the MCP server, Firefox WebExtension APIs, tool dispatch, window management.

self.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
});

// Must match the MCP server's port (host/mcp-server.js, default 18765).
const SERVER_URL = "ws://127.0.0.1:18765";
const MCP_WINDOW_STORAGE_KEY = "mcpWindowId";

// --- State ---
let serverSocket = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let mcpWindowId = null;
const mcpTabs = new Set();
const consoleMessages = new Map(); // tabId -> [{level, text, timestamp, url}]
const networkRequests = new Map(); // tabId -> [{url, method, status, type, timestamp, requestId}]
const screenshotStore = new Map(); // imageId -> base64
const consoleInterceptors = new Set(); // tabIds with interceptor installed

// --- Keep-alive alarm ---
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    if (!serverSocket) connectToServer();
  }
});

// --- Connection to the MCP server ---
function connectToServer() {
  if (serverSocket) return;
  let ws;
  try {
    ws = new WebSocket(SERVER_URL);
  } catch {
    scheduleReconnect();
    return;
  }
  serverSocket = ws;

  ws.onopen = () => {
    reconnectDelay = 1000;
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "tool_request" && msg.id) {
      handleToolRequest(msg.id, msg.tool, msg.args || {});
    }
  };

  // onerror is always followed by onclose
  ws.onclose = () => {
    if (serverSocket === ws) serverSocket = null;
    scheduleReconnect();
  };
}

// The server only runs while Claude is open, so back off up to 10s between tries.
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToServer();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 10000);
}

function postToServer(msg) {
  if (!serverSocket || serverSocket.readyState !== WebSocket.OPEN) return;
  try {
    serverSocket.send(JSON.stringify(msg));
  } catch {
    // Socket closed
  }
}

function sendResponse(id, result) {
  postToServer({ id, type: "tool_response", result });
}

function sendError(id, error) {
  postToServer({ id, type: "tool_error", error: String(error) });
}

// --- MCP window management (replaces Chrome tab groups) ---
async function saveMcpWindowId(id) {
  try {
    if (id === null) {
      await chrome.storage.local.remove(MCP_WINDOW_STORAGE_KEY);
    } else {
      await chrome.storage.local.set({ [MCP_WINDOW_STORAGE_KEY]: id });
    }
  } catch {}
}

async function ensureMcpWindow(createIfEmpty) {
  if (mcpWindowId !== null) {
    try {
      await chrome.windows.get(mcpWindowId);
      const tabs = await chrome.tabs.query({ windowId: mcpWindowId });
      mcpTabs.clear();
      tabs.forEach((t) => mcpTabs.add(t.id));
      if (tabs.length > 0) return;
    } catch {
      mcpWindowId = null;
      mcpTabs.clear();
      await saveMcpWindowId(null);
    }
  }

  if (!createIfEmpty) return;

  const win = await chrome.windows.create({ focused: true, url: "about:blank" });
  mcpWindowId = win.id;
  mcpTabs.clear();
  win.tabs.forEach((t) => mcpTabs.add(t.id));
  await saveMcpWindowId(mcpWindowId);
}

function formatTabContext(tabs) {
  const available = tabs.map((t) => ({
    tabId: t.id,
    title: t.title || "Untitled",
    url: t.url || "",
  }));

  let text = `Tab Context:\n- Available tabs:\n`;
  for (const t of available) {
    text += `  • tabId ${t.tabId}: "${t.title}" (${t.url})\n`;
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ availableTabs: available, mcpWindowId }) + "\n\n" + text,
      },
    ],
  };
}

async function isInGroup(tabId) {
  if (mcpWindowId === null) return false;
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.windowId === mcpWindowId;
  } catch {
    return false;
  }
}

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  mcpTabs.delete(tabId);
  consoleMessages.delete(tabId);
  networkRequests.delete(tabId);
  consoleInterceptors.delete(tabId);
});

// --- Network monitoring via webRequest ---
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const reqs = networkRequests.get(details.tabId) || [];
    reqs.push({
      url: details.url,
      method: details.method,
      status: 0,
      type: details.type || "Other",
      timestamp: Date.now(),
      requestId: details.requestId,
    });
    if (reqs.length > 1000) reqs.splice(0, reqs.length - 1000);
    networkRequests.set(details.tabId, reqs);
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const reqs = networkRequests.get(details.tabId) || [];
    for (let i = reqs.length - 1; i >= 0; i--) {
      if (reqs[i].requestId === details.requestId) {
        reqs[i].status = details.statusCode;
        const ctHeader = details.responseHeaders?.find(
          (h) => h.name.toLowerCase() === "content-type"
        );
        if (ctHeader) reqs[i].mimeType = ctHeader.value.split(";")[0].trim();
        break;
      }
    }
    networkRequests.set(details.tabId, reqs);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const reqs = networkRequests.get(details.tabId) || [];
    for (let i = reqs.length - 1; i >= 0; i--) {
      if (reqs[i].requestId === details.requestId) {
        reqs[i].status = -1;
        reqs[i].error = details.error;
        break;
      }
    }
    networkRequests.set(details.tabId, reqs);
  },
  { urls: ["<all_urls>"] }
);

// --- Key code mapping ---
const KEY_MAP = {
  enter: "Enter", return: "Enter", tab: "Tab", escape: "Escape", esc: "Escape",
  backspace: "Backspace", delete: "Delete", space: "Space", " ": "Space",
  arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
  f1: "F1", f2: "F2", f3: "F3", f4: "F4", f5: "F5", f6: "F6",
  f7: "F7", f8: "F8", f9: "F9", f10: "F10", f11: "F11", f12: "F12",
};

function parseKeyCombo(keyStr) {
  const parts = keyStr.split("+").map((p) => p.trim().toLowerCase());
  let modifiers = 0;
  let key = "";
  for (const part of parts) {
    if (part === "ctrl" || part === "control") modifiers |= 2;
    else if (part === "alt") modifiers |= 1;
    else if (part === "shift") modifiers |= 8;
    else if (part === "meta" || part === "cmd" || part === "command" || part === "win" || part === "windows") modifiers |= 4;
    else key = KEY_MAP[part] || part;
  }
  return { key, modifiers };
}

function parseModifierString(modStr) {
  if (!modStr) return 0;
  let modifiers = 0;
  const parts = modStr.split("+").map((p) => p.trim().toLowerCase());
  for (const part of parts) {
    if (part === "ctrl" || part === "control") modifiers |= 2;
    else if (part === "alt") modifiers |= 1;
    else if (part === "shift") modifiers |= 8;
    else if (part === "meta" || part === "cmd" || part === "command" || part === "win" || part === "windows") modifiers |= 4;
  }
  return modifiers;
}

// --- Content script communication ---
async function sendContentMessage(tabId, message) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    return response;
  } catch {
    // Content script might not be injected yet, try injecting
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

// --- Resolve ref to coordinates ---
async function resolveRefToCoordinates(tabId, ref) {
  const resp = await sendContentMessage(tabId, { type: "getRefCoordinates", ref });
  if (resp?.result) return [resp.result.x, resp.result.y];
  return null;
}

// --- Screenshot helper ---
// Firefox uses tabs.captureVisibleTab() — the tab must be active in its window.
// scale 1 keeps image pixels equal to CSS pixels, so coordinates read off a
// screenshot match the ones clicks use, even on HiDPI screens.
// rect (optional) is a region in page coordinates, i.e. including scroll offset.
async function takeScreenshot(tabId, { rect, scale = 1 } = {}) {
  const tab = await chrome.tabs.get(tabId);

  // Activate the tab so captureVisibleTab captures the right content
  if (!tab.active) {
    await chrome.tabs.update(tabId, { active: true });
    await sleep(100);
  }

  const capture = async (quality) => {
    const options = { format: "jpeg", quality, scale };
    if (rect) options.rect = rect;
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, options);
    return dataUrl.replace(/^data:image\/jpeg;base64,/, "");
  };

  let base64 = await capture(55);
  if (base64.length > 500000) base64 = await capture(30);

  const imageId = `screenshot_${Date.now()}`;
  screenshotStore.set(imageId, base64);
  const keys = Array.from(screenshotStore.keys());
  while (keys.length > 10) screenshotStore.delete(keys.shift());

  return { base64, imageId };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Console interceptor ---
// Installs a console override in the page's MAIN world to capture log messages.
// Messages before the interceptor is installed are not captured.
async function ensureConsoleInterceptor(tabId) {
  if (consoleInterceptors.has(tabId)) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        if (window.__firefoxConsoleInterceptor) return;
        window.__firefoxConsoleInterceptor = true;
        window.__firefoxConsoleQueue = [];
        const methods = ["log", "info", "warn", "error", "debug"];
        for (const level of methods) {
          const orig = console[level].bind(console);
          console[level] = function (...args) {
            orig(...args);
            window.__firefoxConsoleQueue.push({
              level,
              text: args
                .map((a) => {
                  try {
                    return typeof a === "object" && a !== null
                      ? JSON.stringify(a)
                      : String(a);
                  } catch {
                    return String(a);
                  }
                })
                .join(" "),
              url: location.href,
              timestamp: Date.now(),
            });
            if (window.__firefoxConsoleQueue.length > 1000) {
              window.__firefoxConsoleQueue.splice(
                0,
                window.__firefoxConsoleQueue.length - 1000
              );
            }
          };
        }
      },
    });
    consoleInterceptors.add(tabId);
  } catch {}
}

// --- Tool handlers ---
const toolHandlers = {
  async tabs_context_mcp(args) {
    await ensureMcpWindow(args.createIfEmpty);
    if (mcpWindowId === null) {
      return {
        content: [{ type: "text", text: "No MCP window exists. Use createIfEmpty: true to create one." }],
      };
    }
    const tabs = await chrome.tabs.query({ windowId: mcpWindowId });
    return formatTabContext(tabs);
  },

  async tabs_create_mcp(args) {
    await ensureMcpWindow(true);
    const tab = await chrome.tabs.create({ windowId: mcpWindowId, active: true });
    mcpTabs.add(tab.id);
    const tabs = await chrome.tabs.query({ windowId: mcpWindowId });
    const result = formatTabContext(tabs);
    result.content[0].text = `Created new tab. Tab ID: ${tab.id}\n\n` + result.content[0].text;
    return result;
  },

  async navigate(args) {
    const { url, tabId } = args;
    if (!(await isInGroup(tabId)))
      return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP window.` }] };

    if (url === "back") {
      await chrome.tabs.goBack(tabId);
    } else if (url === "forward") {
      await chrome.tabs.goForward(tabId);
    } else {
      let targetUrl = url;
      if (
        !targetUrl.match(/^https?:\/\//i) &&
        !targetUrl.startsWith("about:") &&
        !targetUrl.startsWith("moz-extension:") &&
        !targetUrl.startsWith("javascript:")
      ) {
        targetUrl = targetUrl.replace(/^[a-z]{1,5}:\/+/i, "");
        targetUrl = "https://" + targetUrl;
      }
      try {
        new URL(targetUrl);
      } catch {
        return { content: [{ type: "text", text: `Invalid URL: "${url}". Could not parse as a valid URL.` }] };
      }
      await chrome.tabs.update(tabId, { url: targetUrl });
      // Console interceptor needs re-install after navigation
      consoleInterceptors.delete(tabId);
    }

    await new Promise((resolve) => {
      const listener = (updatedTabId, info) => {
        if (updatedTabId === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 10000);
    });

    const tab = await chrome.tabs.get(tabId);
    let tabs = [];
    if (mcpWindowId !== null) {
      tabs = await chrome.tabs.query({ windowId: mcpWindowId });
    }
    const loading = tab.status !== "complete" ? " (still loading)" : "";
    const text =
      `Navigated to ${tab.url}${loading}.\n## Pages\n` +
      tabs.map((t, i) => `${i + 1}: ${t.url}${t.id === tabId ? " [selected]" : ""}`).join("\n");

    return { content: [{ type: "text", text }] };
  },

  async computer(args) {
    const { action, tabId } = args;
    if (!(await isInGroup(tabId)))
      return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP window.` }] };

    let coordinate = args.coordinate;
    if (args.ref && !coordinate) {
      const coords = await resolveRefToCoordinates(tabId, args.ref);
      if (!coords)
        return { content: [{ type: "text", text: `Could not resolve ref "${args.ref}" to coordinates.` }] };
      coordinate = coords;
    }

    const modifiers = parseModifierString(args.modifiers);

    switch (action) {
      case "screenshot": {
        const { base64, imageId } = await takeScreenshot(tabId);
        let dims = "";
        try {
          const vpResult = await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: () => window.innerWidth + "x" + window.innerHeight,
          });
          if (vpResult[0]?.result) dims = vpResult[0].result;
        } catch {}
        return {
          content: [
            { type: "text", text: `Successfully captured screenshot (${dims}, jpeg) - ID: ${imageId}` },
            { type: "image", data: base64, mimeType: "image/jpeg" },
          ],
        };
      }

      case "left_click": {
        if (!coordinate)
          return { content: [{ type: "text", text: "coordinate is required for left_click" }] };
        await sendContentMessage(tabId, {
          type: "dispatchMouseClick",
          x: coordinate[0], y: coordinate[1],
          button: "left", clickCount: 1, modifiers,
        });
        return { content: [{ type: "text", text: `Clicked at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "right_click": {
        if (!coordinate)
          return { content: [{ type: "text", text: "coordinate is required for right_click" }] };
        await sendContentMessage(tabId, {
          type: "dispatchMouseClick",
          x: coordinate[0], y: coordinate[1],
          button: "right", clickCount: 1, modifiers,
        });
        return { content: [{ type: "text", text: `Right-clicked at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "double_click": {
        if (!coordinate)
          return { content: [{ type: "text", text: "coordinate is required for double_click" }] };
        await sendContentMessage(tabId, {
          type: "dispatchMouseClick",
          x: coordinate[0], y: coordinate[1],
          button: "left", clickCount: 2, modifiers,
        });
        return { content: [{ type: "text", text: `Double-clicked at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "triple_click": {
        if (!coordinate)
          return { content: [{ type: "text", text: "coordinate is required for triple_click" }] };
        await sendContentMessage(tabId, {
          type: "dispatchMouseClick",
          x: coordinate[0], y: coordinate[1],
          button: "left", clickCount: 3, modifiers,
        });
        return { content: [{ type: "text", text: `Triple-clicked at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "hover": {
        if (!coordinate)
          return { content: [{ type: "text", text: "coordinate is required for hover" }] };
        await sendContentMessage(tabId, {
          type: "dispatchMouseMove",
          x: coordinate[0], y: coordinate[1], modifiers,
        });
        await sleep(200);
        return { content: [{ type: "text", text: `Hovered at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "type": {
        if (!args.text)
          return { content: [{ type: "text", text: "text is required for type action" }] };
        for (const char of args.text) {
          await sendContentMessage(tabId, { type: "insertText", text: char });
          await sleep(10);
        }
        return {
          content: [
            { type: "text", text: `Typed "${args.text.substring(0, 50)}${args.text.length > 50 ? "..." : ""}"` },
          ],
        };
      }

      case "key": {
        if (!args.text)
          return { content: [{ type: "text", text: "text is required for key action" }] };
        const repeat = Math.min(args.repeat || 1, 100);
        const keys = args.text.split(" ").filter(Boolean);
        for (let r = 0; r < repeat; r++) {
          for (const keyStr of keys) {
            const { key, modifiers: keyMod } = parseKeyCombo(keyStr);
            const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
            await sendContentMessage(tabId, {
              type: "dispatchKeyEvent", eventType: "keyDown",
              key, code, modifiers: keyMod,
            });
            await sendContentMessage(tabId, {
              type: "dispatchKeyEvent", eventType: "keyUp",
              key, code, modifiers: keyMod,
            });
            await sleep(30);
          }
        }
        return {
          content: [
            { type: "text", text: `Pressed ${repeat} key${repeat > 1 ? "s" : ""}: ${args.text}` },
          ],
        };
      }

      case "scroll": {
        if (!coordinate)
          return { content: [{ type: "text", text: "coordinate is required for scroll" }] };
        const dir = args.scroll_direction || "down";
        const amount = Math.min(args.scroll_amount || 3, 10);
        const deltaX = dir === "left" ? -amount * 100 : dir === "right" ? amount * 100 : 0;
        const deltaY = dir === "up" ? -amount * 100 : dir === "down" ? amount * 100 : 0;
        const outcome = await sendContentMessage(tabId, {
          type: "dispatchScroll",
          x: coordinate[0], y: coordinate[1],
          deltaX, deltaY, modifiers,
        });
        let note = "";
        if (outcome?.unlocked) note = " (the page had scrolling locked; forced overflow:auto on html/body)";
        if (outcome?.handledByPage) note = " (the page handled the wheel event itself, e.g. a map or carousel)";
        else if (outcome && !outcome.moved) note += " (nothing scrolled: already at the edge, or nothing scrollable here)";
        await sleep(300);
        const { base64 } = await takeScreenshot(tabId);
        return {
          content: [
            { type: "text", text: `Scrolled ${dir} by ${amount} ticks at (${coordinate[0]}, ${coordinate[1]})${note}` },
            { type: "image", data: base64, mimeType: "image/jpeg" },
          ],
        };
      }

      case "scroll_to": {
        if (!coordinate && !args.ref)
          return { content: [{ type: "text", text: "coordinate or ref is required for scroll_to" }] };
        if (args.ref) {
          await sendContentMessage(tabId, { type: "scrollToRef", ref: args.ref });
        }
        if (coordinate) {
          await sendContentMessage(tabId, {
            type: "scrollToPosition",
            x: coordinate[0], y: coordinate[1],
          });
        }
        await sleep(300);
        return { content: [{ type: "text", text: `Scrolled to target` }] };
      }

      case "wait": {
        const duration = Math.min(args.duration || 1, 30);
        await sleep(duration * 1000);
        return { content: [{ type: "text", text: `Waited for ${duration} second${duration !== 1 ? "s" : ""}` }] };
      }

      case "left_click_drag": {
        if (!args.start_coordinate || !coordinate) {
          return {
            content: [{ type: "text", text: "start_coordinate and coordinate are required for left_click_drag" }],
          };
        }
        const [sx, sy] = args.start_coordinate;
        const [ex, ey] = coordinate;
        await sendContentMessage(tabId, {
          type: "dispatchDrag",
          startX: sx, startY: sy, endX: ex, endY: ey, modifiers,
        });
        return { content: [{ type: "text", text: `Dragged from (${sx}, ${sy}) to (${ex}, ${ey})` }] };
      }

      case "zoom": {
        if (!args.region || args.region.length !== 4) {
          return { content: [{ type: "text", text: "region [x0, y0, x1, y1] is required for zoom" }] };
        }
        const [x0, y0, x1, y1] = args.region.map(Number);
        if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) {
          return { content: [{ type: "text", text: "region must be numbers with x1 > x0 and y1 > y0" }] };
        }
        // captureVisibleTab's rect is in page coordinates, so add the scroll offset.
        const [{ result: view }] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => ({ scrollX: window.scrollX, scrollY: window.scrollY, innerWidth: window.innerWidth }),
        });
        // The rect must be whole pixels (scroll offsets can be fractional on
        // scaled displays); round outwards so the whole region is covered.
        const left = Math.floor(view.scrollX + x0);
        const top = Math.floor(view.scrollY + y0);
        const width = Math.ceil(view.scrollX + x1) - left;
        const height = Math.ceil(view.scrollY + y1) - top;
        // Render the region at up to 4x so it fills roughly a viewport's width.
        const scale = Math.min(4, Math.max(1, view.innerWidth / width));
        const { base64 } = await takeScreenshot(tabId, {
          rect: { x: left, y: top, width, height },
          scale,
        });
        return {
          content: [
            { type: "text", text: `Zoomed into region [${args.region.join(", ")}] at ${scale.toFixed(1)}x` },
            { type: "image", data: base64, mimeType: "image/jpeg" },
          ],
        };
      }

      default:
        return { content: [{ type: "text", text: `Unknown computer action: ${action}` }] };
    }
  },

  async read_page(args) {
    const { tabId } = args;
    if (!(await isInGroup(tabId)))
      return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP window.` }] };

    const resp = await sendContentMessage(tabId, {
      type: "generateAccessibilityTree",
      options: {
        filter: args.filter,
        depth: args.depth,
        max_chars: args.max_chars,
        ref_id: args.ref_id,
      },
    });

    let tree = resp?.result || "Error: Could not generate accessibility tree";
    try {
      const vpResult = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => window.innerWidth + "x" + window.innerHeight,
      });
      if (vpResult[0]?.result) tree += `\n\nViewport: ${vpResult[0].result}`;
    } catch {}
    return { content: [{ type: "text", text: tree }] };
  },

  async get_page_text(args) {
    const { tabId } = args;
    if (!(await isInGroup(tabId)))
      return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP window.` }] };

    const resp = await sendContentMessage(tabId, { type: "getPageText" });
    if (!resp?.result)
      return { content: [{ type: "text", text: "Error: Could not extract page text" }] };

    try {
      const data = JSON.parse(resp.result);
      return {
        content: [
          {
            type: "text",
            text: `Title: ${data.title}\nURL: ${data.url}\nSource: <${data.sourceTag}>\n\n${data.text}`,
          },
        ],
      };
    } catch {
      return { content: [{ type: "text", text: resp.result }] };
    }
  },

  async find(args) {
    const { query, tabId } = args;
    if (!(await isInGroup(tabId)))
      return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP window.` }] };

    const resp = await sendContentMessage(tabId, { type: "findElements", query });
    const results = resp?.result || [];

    if (results.length === 0) {
      return { content: [{ type: "text", text: `No elements found matching "${query}"` }] };
    }

    let text = `Found ${results.length} element(s) matching "${query}":\n\n`;
    for (const r of results) {
      text += `[${r.ref}] ${r.role} "${r.name}" at (${r.coordinates[0]}, ${r.coordinates[1]})\n`;
    }

    return { content: [{ type: "text", text }] };
  },

  async form_input(args) {
    const { ref, value, tabId } = args;
    if (!(await isInGroup(tabId)))
      return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP window.` }] };

    const resp = await sendContentMessage(tabId, { type: "setFormValue", ref, value });
    const result = resp?.result;

    if (result?.error) return { content: [{ type: "text", text: `Error: ${result.error}` }] };
    return { content: [{ type: "text", text: `Set ${ref} to "${value}". Result: ${JSON.stringify(result)}` }] };
  },

  async javascript_tool(args) {
    const { text, tabId } = args;
    if (!(await isInGroup(tabId)))
      return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP window.` }] };

    try {
      let result = await evalInPage(tabId, text);
      if (result?.error && isCspError(result.error)) {
        if (chrome.userScripts?.execute) {
          result = await runAsUserScript(tabId, text);
        } else {
          // The namespace only exists once the permission is granted;
          // userScripts.execute itself needs Firefox 153+.
          const fix = chrome.userScripts
            ? "Running scripts on sites like this needs Firefox 153 or later."
            : `To run scripts on sites like this, click the ${EXTENSION_NAME} toolbar button and allow "User scripts".`;
          result = { error: `${result.error}. This site's security policy blocks eval(). ${fix}` };
        }
      }

      if (!result) return { content: [{ type: "text", text: "undefined" }] };
      if (result.error)
        return { content: [{ type: "text", text: `Error: ${result.error}` }] };
      const val = result.value;
      if (val === "__undefined__") return { content: [{ type: "text", text: "undefined" }] };
      return {
        content: [
          {
            type: "text",
            text: typeof val === "object" && val !== null ? JSON.stringify(val) : String(val),
          },
        ],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${withPermissionHelp(e.message)}` }] };
    }
  },

  async read_console_messages(args) {
    const { tabId, pattern, limit = 100, onlyErrors, clear } = args;
    if (!(await isInGroup(tabId)))
      return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP window.` }] };

    await ensureConsoleInterceptor(tabId);

    let msgs = [];
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (shouldClear) => {
          const queue = window.__firefoxConsoleQueue || [];
          const copy = queue.slice();
          if (shouldClear) window.__firefoxConsoleQueue = [];
          return copy;
        },
        args: [!!clear],
      });
      msgs = results[0]?.result || [];
    } catch {}

    if (clear) consoleMessages.delete(tabId);

    if (onlyErrors) {
      msgs = msgs.filter((m) => ["error", "exception"].includes(m.level));
    }

    if (pattern) {
      try {
        const re = new RegExp(pattern, "i");
        msgs = msgs.filter((m) => re.test(m.text) || re.test(m.level));
      } catch {
        msgs = msgs.filter((m) => m.text.includes(pattern));
      }
    }

    msgs = msgs.slice(-limit);

    if (msgs.length === 0) {
      return { content: [{ type: "text", text: "No console messages matching the pattern." }] };
    }

    const text = msgs
      .map((m) => `[${m.level}] ${m.text}${m.url ? ` (${m.url})` : ""}`)
      .join("\n");

    return { content: [{ type: "text", text: `Console messages (${msgs.length}):\n${text}` }] };
  },

  async read_network_requests(args) {
    const { tabId, urlPattern, limit = 100, clear } = args;
    if (!(await isInGroup(tabId)))
      return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP window.` }] };

    let reqs = networkRequests.get(tabId) || [];

    if (urlPattern) {
      reqs = reqs.filter((r) => r.url.includes(urlPattern));
    }

    reqs = reqs.slice(-limit);

    if (clear) {
      networkRequests.set(tabId, []);
    }

    if (reqs.length === 0) {
      return { content: [{ type: "text", text: "No network requests matching the pattern." }] };
    }

    const text = reqs
      .map(
        (r) =>
          `${r.method} ${r.url} ${r.status ? `→ ${r.status}` : "(pending)"}${r.mimeType ? ` [${r.mimeType}]` : ""}`
      )
      .join("\n");

    return { content: [{ type: "text", text: `Network requests (${reqs.length}):\n${text}` }] };
  },

  async resize_window(args) {
    const { width, height, tabId } = args;
    if (!(await isInGroup(tabId)))
      return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP window.` }] };

    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { width, height });
    return { content: [{ type: "text", text: `Resized window to ${width}x${height}` }] };
  },

  async upload_image(args) {
    return {
      content: [
        {
          type: "text",
          text: "Image upload via file input is not supported in Firefox WebExtensions. Use drag & drop on the page instead.",
        },
      ],
    };
  },

  async gif_creator(args) {
    return { content: [{ type: "text", text: "GIF recording is not yet implemented in this extension." }] };
  },

  async shortcuts_list(args) {
    return { content: [{ type: "text", text: "No shortcuts available. Shortcuts are not supported in this extension." }] };
  },

  async shortcuts_execute(args) {
    return { content: [{ type: "text", text: "Shortcuts are not supported in this extension." }] };
  },

  async switch_browser(args) {
    return {
      content: [
        {
          type: "text",
          text: "Browser switching is not yet supported. The extension connects to whichever Firefox browser has it loaded.",
        },
      ],
    };
  },

  async update_plan(args) {
    const { domains, approach } = args;
    let text = `Plan:\n\nDomains: ${domains.join(", ")}\n\nApproach:\n`;
    for (const step of approach) {
      text += `- ${step}\n`;
    }
    text += "\nPlan auto-approved (no permission restrictions in this extension).";
    return { content: [{ type: "text", text }] };
  },
};

// --- Tool dispatch ---
async function handleToolRequest(id, tool, args) {
  const handler = toolHandlers[tool];
  if (!handler) {
    sendError(id, `Unknown tool: ${tool}`);
    return;
  }

  try {
    const result = await handler(args);
    sendResponse(id, result);
  } catch (err) {
    sendError(id, `${tool} failed: ${withPermissionHelp(err.message)}`);
  }
}

// --- javascript_tool helpers ---

// eval() in the page's own world, so page variables are visible. Pages whose
// CSP forbids eval (reddit, HN, ...) make this fail with a CSP error.
async function evalInPage(tabId, code) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (code) => {
      try {
        const val = eval(code); // eslint-disable-line no-eval
        if (val && typeof val.then === "function") {
          return val
            .then((v) => ({ value: v === undefined ? "__undefined__" : v }))
            .catch((e) => ({ error: e.message }));
        }
        return { value: val === undefined ? "__undefined__" : val };
      } catch (e) {
        return { error: e.message };
      }
    },
    args: [code],
  });
  return results[0]?.result;
}

function isCspError(error) {
  return /CSP|Content Security Policy/i.test(String(error));
}

function errorText(error) {
  return typeof error === "string" ? error : error?.message || String(error);
}

// Runs code as a user script: Firefox injects it itself instead of through
// eval(), so the page's CSP doesn't stop it. Needs the optional "userScripts"
// permission. Tries the page's world first (page variables visible), then the
// isolated user-script world. The block keeps top-level const/let from
// leaking into the page between calls, and keeps the completion value.
async function runAsUserScript(tabId, code) {
  let lastError;
  for (const world of ["MAIN", "USER_SCRIPT"]) {
    try {
      const [res] = await chrome.userScripts.execute({
        target: { tabId },
        js: [{ code: `{\n${code}\n}` }],
        world,
      });
      if (!res?.error) return { value: res?.result === undefined ? "__undefined__" : res.result };
      lastError = res.error;
    } catch (e) {
      lastError = e;
    }
    if (!isCspError(lastError)) break;
  }
  return { error: errorText(lastError) };
}

// --- Permissions and the setup page ---
// Website access is in the install prompt (Firefox 127+), but users can revoke
// it at any time. userScripts is optional-only in Firefox, so it can only be
// granted from a click: on the setup page, which opens on install and from
// the toolbar button.

const EXTENSION_NAME = "Claude MCP in Fayar kitsune";
const SITE_ACCESS = { origins: ["<all_urls>"] };

function withPermissionHelp(message) {
  return /Missing (host|activeTab) permission/i.test(message)
    ? `${message}. Firefox hasn't given ${EXTENSION_NAME} access to websites: click its toolbar button and allow "Access to all websites".`
    : message;
}

async function openSetupPage() {
  const url = chrome.runtime.getURL("setup.html");
  const [existing] = await chrome.tabs.query({ url });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

async function updateBadge() {
  const hasSiteAccess = await chrome.permissions.contains(SITE_ACCESS);
  await chrome.action.setBadgeBackgroundColor({ color: "#d70022" });
  await chrome.action.setBadgeText({ text: hasSiteAccess ? "" : "!" });
  await chrome.action.setTitle({
    title: hasSiteAccess ? EXTENSION_NAME : `${EXTENSION_NAME}: needs website access, click to set up`,
  });
}

chrome.action.onClicked.addListener(() => openSetupPage());
chrome.permissions.onAdded.addListener(updateBadge);
chrome.permissions.onRemoved.addListener(updateBadge);

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  // Always on first install, since userScripts can't be in the install
  // prompt; on updates only if website access is missing.
  if (reason === "install" || !(await chrome.permissions.contains(SITE_ACCESS))) {
    openSetupPage();
  }
});

// The setup page shows whether Claude's MCP server is connected.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "getConnectionStatus") {
    sendResponse({ connected: serverSocket?.readyState === WebSocket.OPEN });
  }
});

// --- Init ---

// Recover MCP window state after service worker restart
async function recoverMcpWindowState() {
  try {
    const stored = await chrome.storage.local.get(MCP_WINDOW_STORAGE_KEY);
    const savedId = stored[MCP_WINDOW_STORAGE_KEY];
    if (savedId) {
      try {
        await chrome.windows.get(savedId);
        mcpWindowId = savedId;
        const tabs = await chrome.tabs.query({ windowId: mcpWindowId });
        tabs.forEach((t) => mcpTabs.add(t.id));
      } catch {
        await chrome.storage.local.remove(MCP_WINDOW_STORAGE_KEY);
      }
    }
  } catch {}
}

recoverMcpWindowState();
connectToServer();
updateBadge();
