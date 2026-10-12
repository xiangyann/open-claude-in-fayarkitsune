// Background script for Claude MCP in Fayar kitsune extension.
// Handles: WebSocket link to the MCP server, Firefox WebExtension APIs, tool
// dispatch, Claude's tab group and the tabs the user shares with Claude.
// Also loaded (see manifest.json): lib/keys.js, lib/redact.js,
// lib/js-source.js and lib/page-hooks.js.

self.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
});

// Must match the MCP server's port (host/mcp-server.js, default 18765).
const SERVER_URL = "ws://127.0.0.1:18765";

// --- State ---
let serverSocket = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
const networkRequests = new Map(); // tabId -> [{url, method, status, type, timestamp, requestId}]
const screenshotStore = new Map(); // imageId -> base64

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

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

// --- Claude's tabs ---
// Claude works in tabs of its own, kept in a tab group named "Claude" (in a
// window of its own, unless the user moves the group), and in tabs the user
// shares with it. The group keeps Claude's tabs together and findable when
// Claude restarts or loses track of them. After a Firefox restart, session
// restore brings the group back with a new id, so it's found by name and
// color. A tab the user drags into the group becomes Claude's; a tab dragged
// out of it doesn't belong to Claude anymore.

const GROUP_TITLE = "Claude";
const GROUP_COLOR = "orange";
const GROUP_STORAGE_KEY = "claudeGroupId";
const SHARED_STORAGE_KEY = "sharedTabIds";

let claudeGroupId = null;
const sharedTabs = new Set(); // ids of the user's tabs shared with Claude
// Ids of the tabs in Claude's group, kept in step with it for code that
// can't wait for tabControl, like the webRequest listeners.
const ownTabs = new Set();
const lastWorkAt = new Map(); // tabId -> when a tool last worked in it

async function rememberGroup(id) {
  claudeGroupId = id;
  await syncOwnTabs();
  try {
    await chrome.storage.local.set({ [GROUP_STORAGE_KEY]: id });
  } catch {}
}

// A group is Claude's by its name and color: renamed or recolored, it's
// the user's, as it would be after a Firefox restart.
function isClaudeGroup(group) {
  return group.title === GROUP_TITLE && group.color === GROUP_COLOR;
}

// Whether Claude may use a tab right now, without waiting: in its group or
// shared. tabControl is the full check.
function isControlledNow(tabId) {
  return ownTabs.has(tabId) || sharedTabs.has(tabId);
}

// Claude can't use a tab anymore: forget what was recorded for it, and give
// its dialogs back to the user (see releasePage).
function forgetTab(tabId) {
  networkRequests.delete(tabId);
  releasePage(tabId);
}

async function syncOwnTabs() {
  let ids = [];
  if (claudeGroupId !== null) {
    try {
      ids = (await tabsInGroup(await chrome.tabGroups.get(claudeGroupId))).map((t) => t.id);
    } catch {}
  }
  for (const id of ownTabs) {
    if (!ids.includes(id)) {
      ownTabs.delete(id);
      if (!sharedTabs.has(id)) forgetTab(id);
    }
  }
  for (const id of ids) ownTabs.add(id);
}

async function saveSharedTabs() {
  try {
    await chrome.storage.session.set({ [SHARED_STORAGE_KEY]: [...sharedTabs] });
  } catch {}
}

async function findClaudeGroup() {
  if (claudeGroupId !== null) {
    try {
      const group = await chrome.tabGroups.get(claudeGroupId);
      if (isClaudeGroup(group)) return group;
    } catch {}
  }
  const [group] = await chrome.tabGroups.query({ title: GROUP_TITLE, color: GROUP_COLOR });
  if (group) {
    if (group.id !== claudeGroupId) await rememberGroup(group.id);
  } else if (claudeGroupId !== null) {
    claudeGroupId = null;
    await syncOwnTabs(); // the group is gone or renamed: its tabs are the user's
  }
  return group || null;
}

// Renaming or recoloring Claude's group gives its tabs back to the user
// right away, not only when Claude next looks for the group.
chrome.tabGroups.onUpdated.addListener(async (group) => {
  await stateReady;
  if (group.id === claudeGroupId && !isClaudeGroup(group)) await findClaudeGroup();
});

// Tool calls from several Claude sessions run at the same time. Anything
// that may create the group runs one at a time and looks for the group
// again first, so two calls can't each make a "Claude" group.
let groupLock = Promise.resolve();
function withGroupLock(task) {
  const run = groupLock.then(task);
  groupLock = run.catch(() => {});
  return run;
}

function ensureClaudeGroup() {
  return withGroupLock(async () => (await findClaudeGroup()) || createClaudeGroup());
}

async function createClaudeGroup() {
  const win = await chrome.windows.create({ focused: true, url: "about:blank" });
  const groupId = await chrome.tabs.group({
    tabIds: [win.tabs[0].id],
    createProperties: { windowId: win.id },
  });
  await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: GROUP_COLOR });
  await rememberGroup(groupId);
  return chrome.tabGroups.get(groupId);
}

async function tabsInGroup(group) {
  const tabs = await chrome.tabs.query({ windowId: group.windowId });
  return tabs.filter((t) => t.groupId === group.id);
}

async function sharedTabList() {
  const tabs = [];
  for (const id of sharedTabs) {
    try {
      tabs.push(await chrome.tabs.get(id));
    } catch {
      sharedTabs.delete(id);
    }
  }
  return tabs;
}

// Whether Claude may use a tab: { tab, kind } with kind "own" (in Claude's
// group), "shared" (shared by the user) or null. tab is null if it's gone.
async function tabControl(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { tab: null, kind: null };
  }
  const group = await findClaudeGroup();
  if (group && tab.groupId === group.id) {
    if (sharedTabs.delete(tabId)) saveSharedTabs(); // dragged into the group
    ownTabs.add(tabId);
    return { tab, kind: "own" };
  }
  ownTabs.delete(tabId);
  if (sharedTabs.has(tabId)) return { tab, kind: "shared" };
  return { tab, kind: null };
}

// Only web pages can be shared: Firefox doesn't let extensions script its
// own pages (about:, addons.mozilla.org, other extensions).
function isShareableUrl(url) {
  return /^(https?|file):/i.test(url || "") && !/^https:\/\/addons\.mozilla\.org\//i.test(url);
}

async function shareTabs(tabIds) {
  const added = [];
  for (const id of tabIds) {
    const { tab, kind } = await tabControl(id);
    if (!tab || kind || !isShareableUrl(tab.url)) continue;
    sharedTabs.add(id);
    added.push(tab);
  }
  if (added.length) await saveSharedTabs();
  return added;
}

async function unshareTab(tabId) {
  if (!sharedTabs.delete(tabId)) return false;
  await saveSharedTabs();
  forgetTab(tabId);
  return true;
}

function tabLine(t) {
  return `  • tabId ${t.id}: "${t.title || "Untitled"}" (${t.url || ""})\n`;
}

function formatTabContext(group, own, shared) {
  const available = [
    ...own.map((t) => ({ tabId: t.id, title: t.title || "Untitled", url: t.url || "" })),
    ...shared.map((t) => ({ tabId: t.id, title: t.title || "Untitled", url: t.url || "", sharedByUser: true })),
  ];
  let text = "Tab Context:\n";
  text += `- Claude's tabs (tab group "${GROUP_TITLE}"):\n`;
  text += own.length ? own.map(tabLine).join("") : "  (none)\n";
  if (shared.length) {
    text += "- Tabs the user shared with you (their own tabs, in their windows):\n";
    text += shared.map(tabLine).join("");
  }
  return textResult(
    JSON.stringify({ availableTabs: available, groupId: group?.id ?? null, windowId: group?.windowId ?? null }) +
      "\n\n" +
      text
  );
}

// Tabs opened from Claude's tabs (links with target=_blank, window.open)
// join Claude's group. A popup window's tab may not be movable into the
// group's window (Firefox only moves tabs between normal windows); it's
// still Claude's, so it's shared with Claude instead. (From a shared tab,
// only links Claude itself clicks open as shared tabs: see
// openLinkInNewTab. Tabs the user or the page opens there stay theirs.)
chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.openerTabId === undefined) return;
  await stateReady;
  const { kind } = await tabControl(tab.openerTabId);
  if (kind !== "own" || tab.groupId === claudeGroupId) return;
  try {
    const group = await findClaudeGroup();
    if (tab.windowId !== group.windowId) await chrome.tabs.move(tab.id, { windowId: group.windowId, index: -1 });
    await chrome.tabs.group({ groupId: group.id, tabIds: [tab.id] });
  } catch {
    sharedTabs.add(tab.id);
    saveSharedTabs();
  }
});

// Clean up when a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  networkRequests.delete(tabId);
  lastWorkAt.delete(tabId);
  hookedTabs.delete(tabId);
  ownTabs.delete(tabId);
  if (sharedTabs.delete(tabId)) saveSharedTabs();
  if (tabOrigins.delete(tabId)) saveTabOrigins();
});

// --- Network monitoring via webRequest ---
// Only tabs Claude can use are recorded, from the moment it can: a tab the
// user shares later starts with an empty history, not with what it loaded
// while it was private.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0 || !isControlledNow(details.tabId)) return;
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

// --- Working in a page: glow, page hooks, dialog reports ---

// Dialogs on a shared tab are only answered for Claude this long after its
// last action there; after that they're left for the user. In Claude's own
// tabs they're always answered.
const SHARED_DIALOG_WINDOW_MS = 15000;
const ALWAYS = Number.MAX_SAFE_INTEGER;
const capturing = new Map(); // tabId -> screenshots in progress (they can overlap)
const hookedTabs = new Set(); // tabs whose page may be answering dialogs for Claude

function setGlow(tabId, mode) {
  if (mode === "show" && capturing.has(tabId)) return;
  chrome.tabs.sendMessage(tabId, { type: "glow", mode }).catch(() => {});
}

// While a tool is working in a shared tab, its dialogs are answered for the
// longest a tool call can take; when it's done, for SHARED_DIALOG_WINDOW_MS
// more. (Not "always" during the call: if the extension stopped mid-call,
// the page would keep answering dialogs for good.)
const TOOL_CALL_MAX_MS = 70000;
const workingTabs = new Map(); // tabId -> tool calls working in it

function dialogDeadline(tabId, kind) {
  if (kind === "own") return ALWAYS;
  if (workingTabs.get(tabId)) return Date.now() + TOOL_CALL_MAX_MS;
  return (lastWorkAt.get(tabId) || 0) + SHARED_DIALOG_WINDOW_MS;
}

// Installs or updates the hooks in the tab's page and returns what they
// recorded ({ dialogs, dropped } or { logs }); null where pages can't be
// scripted, or when the page doesn't answer in time: a script stuck in a
// loop (one javascript_tool gave up on) blocks the page's world, and the
// tool result mustn't wait for it.
const PAGE_HOOKS_TIMEOUT_MS = 3000;

async function callPageHooks(tabId, settings, frameId = 0) {
  const call = (async () => {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: "MAIN",
      injectImmediately: true,
      func: installPageHooks,
      args: [settings],
    });
    if (settings?.answerUntil > 0) hookedTabs.add(tabId);
    return res?.result ?? null;
  })().catch(() => null);
  return Promise.race([call, sleep(PAGE_HOOKS_TIMEOUT_MS).then(() => null)]);
}

// A tab Claude no longer controls (released, or dragged out of Claude's
// group) gets its dialogs back right away: the page stops answering them,
// and an answer chosen with handle_dialog is dropped. The glow goes too.
// Callers only release tabs Claude could use until now (hooked or
// controlled), so the user's other tabs aren't touched. Not just hookedTabs:
// that's in memory, and a page keeps its hooks across an extension reload.
function releasePage(tabId) {
  hookedTabs.delete(tabId);
  setGlow(tabId, "remove");
  callPageHooks(tabId, { answerUntil: 0, nextAnswer: null });
}

// A tab joined or left a group (dragged by the user, or moved by the
// extension). tabControl brings ownTabs up to date; the page's hooks get
// the dialog handling of its new standing: always answered in Claude's own
// tabs, only while Claude works in a shared one, never in the user's.
// Firefox reports a group change within a window as a groupId update, but
// a tab dragged into a group in another window only as detached and
// attached (already in the group), so moves are checked too.
async function reconsiderTab(tabId) {
  await stateReady;
  const couldUse = isControlledNow(tabId) || hookedTabs.has(tabId);
  const { kind } = await tabControl(tabId);
  if (!kind) {
    if (couldUse) forgetTab(tabId);
  } else if (couldUse) {
    callPageHooks(tabId, { answerUntil: dialogDeadline(tabId, kind) });
  }
}
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if ("groupId" in info) reconsiderTab(tabId);
});
chrome.tabs.onAttached.addListener((tabId) => reconsiderTab(tabId));
chrome.tabs.onMoved.addListener((tabId) => reconsiderTab(tabId));

function describeDialogs(dialogs, dropped = 0) {
  if (!dialogs.length && !dropped) return null;
  const lines = dialogs.map((d) => {
    const msg = d.message ? ` "${d.message}"` : "";
    return d.answer === "left open for the user"
      ? `- ${d.type}${msg}: shown to the user (it opened while you weren't working in this tab); the page is paused until they answer it`
      : `- ${d.type}${msg}: answered ${d.answer} automatically`;
  });
  if (dropped) lines.push(`- … and ${dropped} more, not listed`);
  return `The page opened dialogs:\n${lines.join("\n")}\nUse handle_dialog to choose how the next confirm or prompt is answered.`;
}

// Tools that work inside a tab's page get the glow, page hooks, and a report
// of any dialogs the page opened.
async function startPageWork(tabId, kind) {
  lastWorkAt.set(tabId, Date.now());
  workingTabs.set(tabId, (workingTabs.get(tabId) || 0) + 1);
  const before = await callPageHooks(tabId, { answerUntil: dialogDeadline(tabId, kind) });
  setGlow(tabId, "show");
  const keepGlowing = setInterval(() => {
    if (isControlledNow(tabId)) setGlow(tabId, "show");
  }, 2000);
  return async function finish(result) {
    clearInterval(keepGlowing);
    const left = workingTabs.get(tabId) - 1;
    if (left > 0) workingTabs.set(tabId, left);
    else workingTabs.delete(tabId);
    lastWorkAt.set(tabId, Date.now());
    // The user may have taken the tab back while the tool ran: then it stays
    // released, and its dialogs aren't Claude's to report.
    const now = await tabControl(tabId);
    if (!now.kind) return result;
    setGlow(tabId, "show"); // it fades out a few seconds after the last refresh
    const after = await callPageHooks(tabId, { answerUntil: dialogDeadline(tabId, now.kind) });
    const note = describeDialogs(
      [...(before?.dialogs || []), ...(after?.dialogs || [])],
      (before?.dropped || 0) + (after?.dropped || 0)
    );
    if (note && result?.content) result.content.push({ type: "text", text: note });
    return result;
  };
}

// A new page started loading in a tab (content.js runs at document_start):
// hook it early if Claude controls the tab.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "pageStarted" || !sender.tab) return;
  (async () => {
    await stateReady;
    const { kind } = await tabControl(sender.tab.id);
    if (kind) await callPageHooks(sender.tab.id, { answerUntil: dialogDeadline(sender.tab.id, kind) }, sender.frameId);
  })();
});

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

  // Keep the glow out of the picture, until the last of any overlapping
  // screenshots of this tab is done.
  capturing.set(tabId, (capturing.get(tabId) || 0) + 1);
  let base64;
  try {
    await chrome.tabs.sendMessage(tabId, { type: "glow", mode: "hide" }).catch(() => {});
    base64 = await capture(55);
    if (base64.length > 500000) base64 = await capture(30);
  } finally {
    const left = capturing.get(tabId) - 1;
    if (left > 0) {
      capturing.set(tabId, left);
    } else {
      capturing.delete(tabId);
      setGlow(tabId, "show");
    }
  }

  const imageId = `screenshot_${Date.now()}`;
  screenshotStore.set(imageId, base64);
  const keys = Array.from(screenshotStore.keys());
  while (keys.length > 10) screenshotStore.delete(keys.shift());

  return { base64, imageId };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A link Claude clicked that opens a new tab (see content.js): it opens in
// the background next to the tab it came from, and belongs to Claude the
// same way that tab does: in Claude's group, or shared.
async function openLinkInNewTab(fromTabId, kind, url) {
  const from = await chrome.tabs.get(fromTabId);
  const tab = await chrome.tabs.create({
    url,
    windowId: from.windowId,
    index: from.index + 1,
    openerTabId: fromTabId,
    active: false,
  });
  if (kind === "own") {
    if (claudeGroupId !== null) await chrome.tabs.group({ groupId: claudeGroupId, tabIds: [tab.id] }).catch(() => {});
  } else {
    sharedTabs.add(tab.id);
    await saveSharedTabs();
  }
  return tab;
}

const CLICKS = {
  left_click: { button: "left", count: 1, verb: "Clicked" },
  right_click: { button: "right", count: 1, verb: "Right-clicked" },
  double_click: { button: "left", count: 2, verb: "Double-clicked" },
  triple_click: { button: "left", count: 3, verb: "Triple-clicked" },
};

// --- Tool handlers ---
// Handlers that take a tabId run only after handleToolRequest has checked
// that Claude may use the tab; they get { tab, kind } from tabControl.
const toolHandlers = {
  async tabs_context_mcp(args) {
    let group = await findClaudeGroup();
    if (!group && args.createIfEmpty) group = await ensureClaudeGroup();
    const own = group ? await tabsInGroup(group) : [];
    const shared = await sharedTabList();
    if (!own.length && !shared.length) {
      return textResult(`No "${GROUP_TITLE}" tab group exists. Use createIfEmpty: true to create one.`);
    }
    return formatTabContext(group, own, shared);
  },

  async tabs_create_mcp() {
    const group = await ensureClaudeGroup();
    const tab = await chrome.tabs.create({ windowId: group.windowId, active: true });
    await chrome.tabs.group({ groupId: group.id, tabIds: [tab.id] });
    const result = formatTabContext(group, await tabsInGroup(group), await sharedTabList());
    result.content[0].text = `Created new tab. Tab ID: ${tab.id}\n\n` + result.content[0].text;
    return result;
  },

  // Shared tabs too: sharing a tab hands it to Claude completely.
  async tabs_close_mcp(args) {
    await chrome.tabs.remove(args.tabId);
    const group = await findClaudeGroup();
    const own = group ? await tabsInGroup(group) : [];
    const result = formatTabContext(group, own, await sharedTabList());
    result.content[0].text = `Closed tab ${args.tabId}.\n\n` + result.content[0].text;
    return result;
  },

  async tabs_request_access(args) {
    const outcome = await requestTabAccess(args);
    if (outcome.declined) return textResult("The user chose not to share any tabs.");
    if (outcome.pending) {
      return textResult(
        "No answer yet. The request stays open in a Firefox window; call tabs_context_mcp later to see whether the user shared any tabs."
      );
    }
    return textResult(
      `The user shared ${outcome.tabs.length} tab${outcome.tabs.length === 1 ? "" : "s"} with you:\n` +
        outcome.tabs.map(tabLine).join("") +
        "These are the user's own tabs: use them for the task, and call tabs_release when you're done (or tabs_close_mcp to close one)."
    );
  },

  // Moves shared tabs into Claude's group. The MCP server only sends this
  // once the user agreed (tabs_request_handover asks them in Claude's own
  // prompt); a shared tab is fully Claude's to use anyway.
  async tabs_handover(args) {
    const ids = [...new Set((args.tabIds || []).map(Number))];
    const notShared = ids.filter((id) => !sharedTabs.has(id));
    if (!ids.length || notShared.length) {
      return textResult(
        `Only tabs the user shared with you can be handed over${notShared.length ? `; not shared: ${notShared.join(", ")}` : ""}. Use tabs_context_mcp to see them.`
      );
    }
    const tabs = await moveTabsToClaude(ids);
    return textResult(
      `Handed over ${tabs.length} tab${tabs.length === 1 ? "" : "s"}: now in Claude's tab group, in its window:\n` + tabs.map(tabLine).join("")
    );
  },

  async tabs_release(args, { kind }) {
    if (kind === "own") {
      return textResult(`Tab ${args.tabId} is one of Claude's own tabs. Use tabs_close_mcp to close it.`);
    }
    await unshareTab(args.tabId);
    return textResult(`Released tab ${args.tabId}: it's the user's again, and you can't use it anymore.`);
  },

  async navigate(args, control) {
    const { url, tabId } = args;

    let targetUrl = null;
    if (url !== "back" && url !== "forward") {
      targetUrl = url;
      // Extension pages (this one's share and setup pages, or another
      // add-on's) are off limits: scripting one could act with the
      // extension's own powers, e.g. approve a share request.
      if (/^moz-extension:/i.test(targetUrl)) {
        return textResult("Claude can't open extension pages (moz-extension: URLs).");
      }
      if (/^javascript:/i.test(targetUrl) && /^moz-extension:/i.test(control?.tab?.url || "")) {
        return textResult("This tab shows an extension page; navigate it to a web page first.");
      }
      if (
        !targetUrl.match(/^https?:\/\//i) &&
        !targetUrl.startsWith("about:") &&
        !targetUrl.startsWith("javascript:")
      ) {
        targetUrl = targetUrl.replace(/^[a-z]{1,5}:\/+/i, "");
        targetUrl = "https://" + targetUrl;
      }
      try {
        targetUrl = new URL(targetUrl).href;
      } catch {
        return textResult(`Invalid URL: "${url}". Could not parse as a valid URL.`);
      }
    }

    // Wait for this navigation's "complete", not one still on its way from
    // the page that was loading before: only count it once the tab has
    // started loading again. A jump within the same page (#anchor) doesn't
    // load anything; it's done when the tab shows the requested URL (for
    // back/forward, any new URL).
    const loaded = new Promise((resolve) => {
      let started = false;
      const listener = (updatedTabId, info, tab) => {
        if (updatedTabId !== tabId) return;
        if (info.status === "loading") started = true;
        else if (started && info.status === "complete") finish();
        else if (!started && info.url && tab.status === "complete" && (targetUrl === null || info.url === targetUrl)) finish();
      };
      const finish = () => {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 10000);
      chrome.tabs.onUpdated.addListener(listener);
    });

    if (url === "back") {
      await chrome.tabs.goBack(tabId);
    } else if (url === "forward") {
      await chrome.tabs.goForward(tabId);
    } else {
      await chrome.tabs.update(tabId, { url: targetUrl });
    }

    await loaded;

    const tab = await chrome.tabs.get(tabId);
    const group = await findClaudeGroup();
    const tabs = group && tab.groupId === group.id ? await tabsInGroup(group) : [tab];
    const loading = tab.status !== "complete" ? " (still loading)" : "";
    const text =
      `Navigated to ${tab.url}${loading}.\n## Pages\n` +
      tabs.map((t, i) => `${i + 1}: ${t.url}${t.id === tabId ? " [selected]" : ""}`).join("\n");

    return textResult(text);
  },

  async computer(args, { kind }) {
    const { action, tabId } = args;

    // A ref is turned into a point on screen. The element is scrolled into
    // view first if needed: coordinates can only reach what's visible.
    let coordinate = args.coordinate;
    let refNote = "";
    if (args.ref && !coordinate && (action in CLICKS || action === "hover" || action === "scroll")) {
      const resp = await sendContentMessage(tabId, { type: "locateRef", ref: args.ref });
      const loc = resp?.result;
      if (!loc) return textResult(`Could not resolve ref "${args.ref}" to coordinates.`);
      if (loc.error) return textResult(`Error: ${loc.error}`);
      coordinate = [loc.x, loc.y];
      if (loc.scrolled) refNote += ` (scrolled ${args.ref} into view first)`;
      if (loc.coveredBy) {
        refNote += `. Note: ${loc.coveredBy} is on top of ${args.ref} at that point, so it received the input instead`;
      }
    }

    const modifiers = modifierBits(args.modifiers);

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

      case "left_click":
      case "right_click":
      case "double_click":
      case "triple_click": {
        if (!coordinate) return textResult(`coordinate or ref is required for ${action}`);
        const { button, count, verb } = CLICKS[action];
        const resp = await sendContentMessage(tabId, {
          type: "dispatchMouseClick",
          x: coordinate[0], y: coordinate[1],
          button, clickCount: count, modifiers,
        });
        if (resp?.error) return textResult(`Error: ${resp.error}`);
        let opened = "";
        if (resp?.openInNewTab) {
          const tab = await openLinkInNewTab(tabId, kind, resp.openInNewTab);
          opened = `. The link opens in a new tab: tab ${tab.id} (${resp.openInNewTab}), ${kind === "own" ? "in Claude's tab group" : "shared with you like the tab it came from"}`;
        }
        return textResult(`${verb} at (${coordinate[0]}, ${coordinate[1]})${refNote}${opened}`);
      }

      case "hover": {
        if (!coordinate)
          return textResult("coordinate or ref is required for hover");
        await sendContentMessage(tabId, {
          type: "dispatchMouseMove",
          x: coordinate[0], y: coordinate[1], modifiers,
        });
        await sleep(200);
        return textResult(`Hovered at (${coordinate[0]}, ${coordinate[1]})${refNote}`);
      }

      case "type": {
        if (!args.text)
          return textResult("text is required for type action");
        let inserted = 0;
        let typed = 0;
        for (const char of args.text) {
          // The user can take the tab back mid-way; stop typing into it then.
          if (!isControlledNow(tabId)) {
            return textResult(`Stopped after ${typed} characters: the user took this tab back.`);
          }
          const resp = await sendContentMessage(tabId, { type: "typeChar", text: char, key: keyForChar(char) });
          typed++;
          if (resp?.inserted) inserted++;
          await sleep(10);
        }
        // Fields announce a finished edit with one change event, as when the
        // user moves on.
        await sendContentMessage(tabId, { type: "endTyping" });
        const shown = `"${args.text.substring(0, 50)}${args.text.length > 50 ? "..." : ""}"`;
        if (inserted === 0) {
          return textResult(
            `Sent the keys for ${shown}, but no text field had focus, so no text was inserted. Click the field first.`
          );
        }
        return textResult(`Typed ${shown}`);
      }

      case "key": {
        if (!args.text)
          return textResult("text is required for key action");
        const repeat = Math.min(args.repeat || 1, 100);
        const keys = args.text.split(" ").filter(Boolean);
        for (let r = 0; r < repeat; r++) {
          for (const keyStr of keys) {
            if (!isControlledNow(tabId)) return textResult("Stopped: the user took this tab back.");
            const { key, code, keyCode, modifiers: keyMod } = parseKeyCombo(keyStr);
            await sendContentMessage(tabId, {
              type: "dispatchKeyEvent", eventType: "keyDown",
              key, code, keyCode, modifiers: keyMod,
            });
            await sendContentMessage(tabId, {
              type: "dispatchKeyEvent", eventType: "keyUp",
              key, code, keyCode, modifiers: keyMod,
            });
            await sleep(30);
          }
        }
        return textResult(`Pressed ${repeat} key${repeat > 1 ? "s" : ""}: ${args.text}`);
      }

      case "scroll": {
        if (!coordinate)
          return textResult("coordinate is required for scroll");
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
          return textResult("coordinate or ref is required for scroll_to");
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
        return textResult("Scrolled to target");
      }

      case "wait": {
        const duration = Math.min(args.duration || 1, 30);
        await sleep(duration * 1000);
        return textResult(`Waited for ${duration} second${duration !== 1 ? "s" : ""}`);
      }

      case "left_click_drag": {
        if (!args.start_coordinate || !coordinate) {
          return textResult("start_coordinate and coordinate are required for left_click_drag");
        }
        const [sx, sy] = args.start_coordinate;
        const [ex, ey] = coordinate;
        await sendContentMessage(tabId, {
          type: "dispatchDrag",
          startX: sx, startY: sy, endX: ex, endY: ey, modifiers,
        });
        return textResult(`Dragged from (${sx}, ${sy}) to (${ex}, ${ey})`);
      }

      case "zoom": {
        if (!args.region || args.region.length !== 4) {
          return textResult("region [x0, y0, x1, y1] is required for zoom");
        }
        const [x0, y0, x1, y1] = args.region.map(Number);
        if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) {
          return textResult("region must be numbers with x1 > x0 and y1 > y0");
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
        return textResult(`Unknown computer action: ${action}`);
    }
  },

  async read_page(args) {
    const { tabId } = args;

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
    return textResult(tree);
  },

  async get_page_text(args) {
    const { tabId } = args;

    const resp = await sendContentMessage(tabId, { type: "getPageText" });
    if (!resp?.result) return textResult("Error: Could not extract page text");

    try {
      const data = JSON.parse(resp.result);
      return textResult(`Title: ${data.title}\nURL: ${data.url}\nSource: <${data.sourceTag}>\n\n${data.text}`);
    } catch {
      return textResult(resp.result);
    }
  },

  async find(args) {
    const { query, tabId } = args;

    const resp = await sendContentMessage(tabId, { type: "findElements", query });
    const results = resp?.result || [];

    if (results.length === 0) {
      return textResult(`No elements found matching "${query}"`);
    }

    let text = `Found ${results.length} element(s) matching "${query}":\n\n`;
    for (const r of results) {
      const where = `at (${r.coordinates[0]}, ${r.coordinates[1]})`;
      text += `[${r.ref}] ${r.role} "${r.name}" ${where}${r.offscreen ? " (off-screen: click it by ref, or scroll first)" : ""}\n`;
    }

    return textResult(text);
  },

  async form_input(args) {
    const { ref, value, tabId } = args;

    const resp = await sendContentMessage(tabId, { type: "setFormValue", ref, value });
    const result = resp?.result;

    if (result?.error) return textResult(`Error: ${result.error}`);
    return textResult(`Set ${ref} to "${value}". Result: ${JSON.stringify(result)}`);
  },

  async javascript_tool(args) {
    const { text, tabId } = args;
    const seconds = jsTimeoutSeconds(args.timeout);
    const deadline = Date.now() + seconds * 1000;

    let outcome;
    try {
      outcome = await Promise.race([runJavascript(tabId, text, deadline), sleep(seconds * 1000).then(() => null)]);
    } catch (e) {
      return textResult(`Error: ${withPermissionHelp(errorText(e))}`);
    }
    if (!outcome || outcome.timedOut) {
      return textResult(
        `Error: the script didn't finish within ${seconds}s. It may still be running in the page: Firefox can't stop it from here, so navigate or reload the tab if the page is stuck.`
      );
    }
    return formatJavascriptOutcome(outcome);
  },

  async read_console_messages(args) {
    const { tabId, pattern, limit = 100, onlyErrors, clear } = args;

    const res = await callPageHooks(tabId, { read: "logs", clear: !!clear });
    let msgs = res?.logs || [];

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
      return textResult("No console messages matching the pattern.");
    }

    const text = msgs
      .map((m) => `[${m.level}] ${m.text}${m.url ? ` (${m.url})` : ""}`)
      .join("\n");

    return textResult(`Console messages (${msgs.length}):\n${text}`);
  },

  async read_network_requests(args) {
    const { tabId, urlPattern, limit = 100, clear } = args;

    let reqs = networkRequests.get(tabId) || [];

    if (urlPattern) {
      reqs = reqs.filter((r) => r.url.includes(urlPattern));
    }

    reqs = reqs.slice(-limit);

    if (clear) {
      networkRequests.set(tabId, []);
    }

    if (reqs.length === 0) {
      return textResult("No network requests matching the pattern.");
    }

    const text = reqs
      .map(
        (r) =>
          `${r.method} ${r.url} ${r.status ? `→ ${r.status}` : "(pending)"}${r.mimeType ? ` [${r.mimeType}]` : ""}`
      )
      .join("\n");

    return textResult(`Network requests (${reqs.length}):\n${text}`);
  },

  async resize_window(args, { tab, kind }) {
    const { width, height } = args;
    if (kind === "shared") {
      // The window holds the user's other tabs too, which they didn't share.
      return textResult(
        "This tab is in one of the user's windows, which holds their other tabs too, so it keeps its size. To resize, ask the user to hand the tab over with tabs_request_handover: it moves into Claude's own window."
      );
    }
    await chrome.windows.update(tab.windowId, { width, height });
    return textResult(`Resized window to ${width}x${height}`);
  },

  async handle_dialog(args) {
    const { tabId, accept, promptText } = args;
    const nextAnswer = { accept: !!accept, promptText: promptText ?? null };
    const res = await callPageHooks(tabId, { nextAnswer });
    if (!res) return textResult("Error: this page can't be scripted, so its dialogs can't be handled.");
    const what = accept ? `accepted${promptText !== undefined ? ` with "${promptText}"` : ""}` : "cancelled";
    return textResult(`The next confirm or prompt on this page will be ${what}. Alerts are always acknowledged.`);
  },

  async upload_image(args) {
    return textResult("Image upload via file input is not supported in Firefox WebExtensions. Use drag & drop on the page instead.");
  },

  async gif_creator(args) {
    return textResult("GIF recording is not yet implemented in this extension.");
  },

  async shortcuts_list(args) {
    return textResult("No shortcuts available. Shortcuts are not supported in this extension.");
  },

  async shortcuts_execute(args) {
    return textResult("Shortcuts are not supported in this extension.");
  },

  async switch_browser(args) {
    return textResult("Browser switching is not yet supported. The extension connects to whichever Firefox browser has it loaded.");
  },

  async update_plan(args) {
    const { domains, approach } = args;
    let text = `Plan:\n\nDomains: ${domains.join(", ")}\n\nApproach:\n`;
    for (const step of approach) {
      text += `- ${step}\n`;
    }
    text += "\nPlan auto-approved (no permission restrictions in this extension).";
    return textResult(text);
  },
};

// Tools that act on one tab, which must be Claude's or shared with Claude.
const TAB_TOOLS = new Set([
  "navigate", "computer", "read_page", "get_page_text", "find", "form_input",
  "javascript_tool", "read_console_messages", "read_network_requests",
  "resize_window", "handle_dialog", "tabs_close_mcp", "tabs_release",
]);
// Of those, the ones that work inside the page.
const PAGE_TOOLS = new Set([
  "navigate", "computer", "read_page", "get_page_text", "find", "form_input",
  "javascript_tool", "read_console_messages", "handle_dialog",
]);

// --- Tool dispatch ---
async function handleToolRequest(id, tool, args) {
  const handler = toolHandlers[tool];
  if (!handler) {
    sendError(id, `Unknown tool: ${tool}`);
    return;
  }

  let finish = null;
  try {
    await stateReady;
    let control = null;
    if (TAB_TOOLS.has(tool)) {
      control = await tabControl(args.tabId);
      if (!control.tab) {
        sendResponse(id, textResult(`Tab ${args.tabId} doesn't exist anymore. Use tabs_context_mcp to see the tabs you can use.`));
        return;
      }
      if (!control.kind) {
        sendResponse(id, textResult(
          `Tab ${args.tabId} isn't in Claude's tab group and the user hasn't shared it. Use tabs_context_mcp to see the tabs you can use, or tabs_request_access to ask the user to share one of theirs.`
        ));
        return;
      }
      // A tab can still show an extension page (dragged into the group, or
      // opened by the user): only navigating away is allowed there.
      if (PAGE_TOOLS.has(tool) && tool !== "navigate" && /^moz-extension:/i.test(control.tab.url || "")) {
        sendResponse(id, textResult(`Tab ${args.tabId} shows an extension page, which Claude can't use. Navigate it to a web page first.`));
        return;
      }
      if (PAGE_TOOLS.has(tool)) finish = await startPageWork(args.tabId, control.kind);
    }
    let result = await handler(args, control);
    if (finish) result = await finish(result);
    sendResponse(id, result);
  } catch (err) {
    if (finish) await finish(null).catch(() => {});
    sendError(id, `${tool} failed: ${withPermissionHelp(err.message)}`);
  }
}

// --- javascript_tool ---

const JS_TIMEOUT_DEFAULT = 30;
const JS_TIMEOUT_MAX = 50; // the MCP server gives up on a tool call at 60s
const JS_RESULT_LIMIT = 50000;

function jsTimeoutSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return JS_TIMEOUT_DEFAULT;
  return Math.min(Math.max(n, 1), JS_TIMEOUT_MAX);
}

// Resolves to { ok: packed result }, { thrown: error text } or { timedOut }.
async function runJavascript(tabId, code, deadline) {
  let outcome = await evalInPage(tabId, code);
  if (outcome.needsFunctionBody) outcome = await evalBodiesInPage(tabId, code);
  if (!outcome.csp) return outcome;

  // The page's Content Security Policy blocks eval().
  if (chrome.userScripts?.execute) return runAsUserScript(tabId, code, deadline);
  // The namespace only exists once the permission is granted;
  // userScripts.execute itself needs Firefox 153+.
  const fix = chrome.userScripts
    ? "Running scripts on sites like this needs Firefox 153 or later."
    : `To run scripts on sites like this, click the ${EXTENSION_NAME} toolbar button and allow "User scripts".`;
  return { thrown: `${outcome.csp}. This site's security policy blocks eval(). ${fix}` };
}

// eval() in the page's own world (indirect, so it runs at global scope like a
// console), so page variables are visible. Pages whose CSP forbids eval
// (reddit, HN, ...) make it fail with { csp }. Code that uses top-level
// await or return comes back as { needsFunctionBody }, without having run.
async function evalInPage(tabId, code) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (code, packSource) => {
      const describe = (e) => (e && e.name ? `${e.name}: ${e.message}` : String(e));
      let pack;
      try {
        pack = (0, eval)(`(${packSource})`); // eslint-disable-line no-eval
      } catch (e) {
        return { csp: describe(e) };
      }
      let value;
      try {
        value = (0, eval)(code); // eslint-disable-line no-eval
      } catch (e) {
        if (e instanceof SyntaxError && /await is only valid in async functions|return not in function/.test(e.message)) {
          return { needsFunctionBody: true };
        }
        return { thrown: describe(e) };
      }
      try {
        return { ok: pack(await value) };
      } catch (e) {
        return { thrown: describe(e) };
      }
    },
    args: [code, packValue.toString()],
  });
  if (res?.error) return { thrown: errorText(res.error) };
  return res?.result ?? { thrown: "The script produced no result." };
}

// Runs the first candidate body for `code` (see lib/js-source.js) that
// parses as an async function body. The page builds them one at a time from
// the offsets, rather than receiving them all.
async function evalBodiesInPage(tabId, code) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (code, starts, bodyAtSource, packSource) => {
      const describe = (e) => (e && e.name ? `${e.name}: ${e.message}` : String(e));
      const pack = (0, eval)(`(${packSource})`); // eslint-disable-line no-eval
      const bodyAt = (0, eval)(`(${bodyAtSource})`); // eslint-disable-line no-eval
      const bodies = function* () {
        for (const at of starts) {
          const body = bodyAt(code, at);
          if (body !== null) yield body;
        }
        yield code;
      };
      let parseError = null;
      for (const body of bodies()) {
        let pending;
        try {
          // Parsing happens before anything runs: a body that doesn't parse
          // has no effects.
          pending = (0, eval)(`(async () => {\n${body}\n})()`); // eslint-disable-line no-eval
        } catch (e) {
          if (e instanceof SyntaxError) {
            parseError = e;
            continue;
          }
          return { thrown: describe(e) };
        }
        try {
          return { ok: pack(await pending) };
        } catch (e) {
          return { thrown: describe(e) };
        }
      }
      return { thrown: describe(parseError) };
    },
    args: [code, statementStarts(code), returnBodyAt.toString(), packValue.toString()],
  });
  if (res?.error) return { thrown: errorText(res.error) };
  return res?.result ?? { thrown: "The script produced no result." };
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
// isolated user-script world. Each candidate body (built one at a time, at
// most MAX_CANDIDATES + 1 of them) is a separate script; one that doesn't
// parse is reported as an error without running, and the next is tried.
async function runAsUserScript(tabId, code, deadline) {
  let world = "MAIN";
  let lastError = "The script produced no result.";
  for (const body of functionBodies(code)) {
    if (Date.now() > deadline) return { timedOut: true };
    let res;
    try {
      [res] = await chrome.userScripts.execute({
        target: { tabId },
        js: [{ code: userScriptSource(body) }],
        world,
      });
    } catch (e) {
      return { thrown: errorText(e) };
    }
    if (res && !res.error) return res.result ?? { thrown: lastError };
    lastError = errorText(res?.error);
    if (isCspError(lastError) && world === "MAIN") {
      // Retry the same body in the isolated world.
      world = "USER_SCRIPT";
      const [again] = await chrome.userScripts.execute({
        target: { tabId },
        js: [{ code: userScriptSource(body) }],
        world,
      });
      if (again && !again.error) return again.result ?? { thrown: lastError };
      lastError = errorText(again?.error);
    }
  }
  return { thrown: lastError };
}

// Credentials are hidden (lib/redact.js) and long output is cut.
function formatJavascriptOutcome(outcome) {
  if (outcome.thrown !== undefined) return textResult(`Error: ${redactErrorText(outcome.thrown)}`);
  const packed = outcome.ok;
  if (!packed || packed.undefined) return textResult("undefined");
  const value = redactValue(packed.value);
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) text = "undefined";
  if (text.length > JS_RESULT_LIMIT) {
    text = `${text.slice(0, JS_RESULT_LIMIT)}\n… (cut at ${JS_RESULT_LIMIT} of ${text.length} characters)`;
  } else if (packed.cut) {
    text += "\n… (the result was too large to return whole; parts marked … were left out)";
  }
  return textResult(text);
}

// --- Sharing the user's tabs ---
// Claude asks with tabs_request_access: a small Firefox window lists the
// user's tabs and they pick which to share (Claude never sees the others).
// Or the user right-clicks a tab and shares it.
//
// A shared tab stays in the user's window. When Claude needs it to itself
// (to resize its window, or to work without switching the tab the user is
// looking at), it can be moved into Claude's group: Claude asks with
// tabs_request_handover (the MCP server asks the user in Claude's own
// prompt), or the user does it from the tab menu.

const SHARE_PAGE = "share.html";
const SHARE_WAIT_MS = 50000; // the tool call itself times out at 60s
const shareRequests = new Map(); // requestId -> { reason, query, windowId, settle }

// Moves tabs into Claude's group, in its window; with no group yet, the
// first tab starts a new Claude window. They're Claude's own tabs afterwards.
// It may create the group, so it holds the group lock (see withGroupLock).
function moveTabsToClaude(tabIds) {
  return withGroupLock(() => moveTabsToClaudeNow(tabIds));
}

async function moveTabsToClaudeNow(tabIds) {
  for (const id of tabIds) {
    const tab = await chrome.tabs.get(id);
    if (tab.pinned) await chrome.tabs.update(id, { pinned: false }); // pinned tabs can't be grouped
  }
  let group = await findClaudeGroup();
  // Remember where each tab was, for "Move Tab Out of Claude's Group"; that
  // can be Claude's own window, outside the group.
  for (const id of tabIds) {
    const tab = await chrome.tabs.get(id);
    tabOrigins.set(id, { windowId: tab.windowId, index: tab.index });
  }
  await saveTabOrigins();
  if (group) {
    await chrome.tabs.move(tabIds, { windowId: group.windowId, index: -1 });
    await chrome.tabs.group({ groupId: group.id, tabIds });
  } else {
    const win = await chrome.windows.create({ tabId: tabIds[0] });
    if (tabIds.length > 1) await chrome.tabs.move(tabIds.slice(1), { windowId: win.id, index: -1 });
    const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId: win.id } });
    await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: GROUP_COLOR });
    await rememberGroup(groupId);
  }
  for (const id of tabIds) sharedTabs.delete(id);
  await saveSharedTabs();
  return Promise.all(tabIds.map((id) => chrome.tabs.get(id)));
}

// The other way: tabs of Claude's leave the group and stay shared with
// Claude ("Move Tab Out of Claude's Group"). A tab that was moved into the
// group goes back where it was, in whichever window that was; one Claude
// opened itself goes to the window the user last used that isn't Claude's,
// or a new one.
// Kept in storage.local, so they survive the extension being reloaded or
// updated (which clears storage.session), and cleared when Firefox starts,
// since tab and window ids start over then. They only decide where a tab
// goes back to, so a stale entry can't give Claude anything.
const ORIGINS_STORAGE_KEY = "tabOrigins";
const LAST_WINDOW_STORAGE_KEY = "lastUserWindowId";
const tabOrigins = new Map(); // tabId -> { windowId, index } before it joined Claude's group
let lastUserWindowId = null;

async function saveTabOrigins() {
  try {
    await chrome.storage.local.set({ [ORIGINS_STORAGE_KEY]: [...tabOrigins] });
  } catch {}
}

chrome.runtime.onStartup.addListener(async () => {
  await stateReady; // or the restore could bring the old entries back afterwards
  tabOrigins.clear();
  lastUserWindowId = null;
  chrome.storage.local.remove([ORIGINS_STORAGE_KEY, LAST_WINDOW_STORAGE_KEY]).catch(() => {});
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const win = await chrome.windows.get(windowId);
    const group = await findClaudeGroup();
    if (win.type !== "normal" || windowId === group?.windowId) return;
    lastUserWindowId = windowId;
    await chrome.storage.local.set({ [LAST_WINDOW_STORAGE_KEY]: windowId });
  } catch {}
});

// A window `tab` can move to: a normal window other than its own, of the
// same kind (private or not). Resolves the window id, or null.
async function usableWindow(windowId, tab) {
  if (windowId === null || windowId === undefined) return null;
  try {
    const win = await chrome.windows.get(windowId);
    return win.type === "normal" && win.id !== tab.windowId && win.incognito === tab.incognito ? win.id : null;
  } catch {
    return null;
  }
}

async function userWindowFor(tab) {
  const origin = tabOrigins.get(tab.id);
  const home = (await usableWindow(origin?.windowId, tab)) ?? (await usableWindow(lastUserWindowId, tab));
  if (home !== null) return home;
  for (const win of await chrome.windows.getAll({ windowTypes: ["normal"] })) {
    if ((await usableWindow(win.id, tab)) !== null) return win.id;
  }
  return null;
}

async function moveTabsToUser(tabIds) {
  // Shared first, so the tab never looks uncontrolled while it leaves the group.
  for (const id of tabIds) sharedTabs.add(id);
  await saveSharedTabs();
  await chrome.tabs.ungroup(tabIds);
  let focusWindowId = null;
  for (const id of tabIds) {
    const tab = await chrome.tabs.get(id);
    const origin = tabOrigins.get(id);
    // It was in this same window (Claude's), just outside the group.
    const stayHere = origin?.windowId === tab.windowId;
    let windowId = stayHere ? tab.windowId : await userWindowFor(tab);
    if (stayHere) {
      await chrome.tabs.move(id, { index: origin.index });
    } else if (windowId === null) {
      windowId = (await chrome.windows.create({ tabId: id })).id;
    } else {
      // Back at its old position when it returns home.
      const count = (await chrome.tabs.query({ windowId })).length;
      const index = origin?.windowId === windowId ? Math.min(origin.index, count) : -1;
      await chrome.tabs.move(id, { windowId, index });
    }
    // Dropped between two tabs of a group, a tab joins that group; it's
    // meant to be on its own.
    if ((await chrome.tabs.get(id)).groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) await chrome.tabs.ungroup([id]);
    tabOrigins.delete(id);
    focusWindowId ??= windowId;
  }
  await saveTabOrigins();
  await chrome.tabs.update(tabIds[0], { active: true });
  await chrome.windows.update(focusWindowId, { focused: true });
  // Dialogs there are answered for Claude only while it's working, as in
  // any shared tab.
  for (const id of tabIds) callPageHooks(id, { answerUntil: dialogDeadline(id, "shared") });
}

// "Stop Sharing" on one of Claude's own tabs: it leaves the group and stays
// where it is, no longer Claude's.
async function takeTabsFromClaude(tabIds) {
  await chrome.tabs.ungroup(tabIds);
  for (const id of tabIds) releasePage(id);
}

async function requestTabAccess({ reason, query }) {
  const requestId = crypto.randomUUID();
  let settle;
  const decided = new Promise((resolve) => (settle = resolve));
  shareRequests.set(requestId, { reason: reason || "", query: query || "", windowId: null, settle });
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(`${SHARE_PAGE}#${requestId}`),
    type: "popup",
    width: 560,
    height: 640,
    focused: true,
  });
  const open = shareRequests.get(requestId);
  if (open) open.windowId = win.id;
  // The window stays open after this times out, and an answer given later
  // still shares the tabs.
  return Promise.race([decided, sleep(SHARE_WAIT_MS).then(() => ({ pending: true }))]);
}

function finishShareRequest(requestId, outcome) {
  const request = shareRequests.get(requestId);
  if (!request) return;
  shareRequests.delete(requestId);
  request.settle(outcome);
  if (request.windowId !== null) chrome.windows.remove(request.windowId).catch(() => {});
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [requestId, request] of shareRequests) {
    if (request.windowId === windowId) finishShareRequest(requestId, { declined: true });
  }
});

// Only the extension's own share page may answer a request: web pages and
// scripts Claude runs can't send these messages.
function fromSharePage(sender) {
  return typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(SHARE_PAGE));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "getShareRequest" && fromSharePage(sender)) {
    (async () => {
      await stateReady;
      const request = shareRequests.get(msg.requestId);
      if (!request) return sendResponse({ missing: true });
      const group = await findClaudeGroup();
      const tabs = (await chrome.tabs.query({}))
        .filter((t) => t.groupId !== group?.id && !sharedTabs.has(t.id) && isShareableUrl(t.url))
        .map((t) => ({ id: t.id, title: t.title || "", url: t.url, favIconUrl: t.favIconUrl || "" }));
      sendResponse({ reason: request.reason, query: request.query, tabs });
    })();
    return true;
  }
  if (msg?.type === "shareDecision" && fromSharePage(sender)) {
    (async () => {
      await stateReady;
      if (!shareRequests.has(msg.requestId)) return sendResponse({ ok: false });
      const tabs = Array.isArray(msg.tabIds) && msg.tabIds.length ? await shareTabs(msg.tabIds.map(Number)) : [];
      finishShareRequest(msg.requestId, tabs.length ? { tabs } : { declined: true });
      sendResponse({ ok: true });
    })();
    return true;
  }
});

// Tab context menu. Each item does one thing; together they move a tab
// either way between the user and Claude:
//   your tab --Share--> shared --Move to Claude's Window--> Claude's own
//   Claude's own --Move Out of Claude's Group--> shared --Stop Sharing--> your tab
// "Stop Sharing" on one of Claude's own tabs takes it straight back.
// Items apply to all selected tabs when the clicked one is part of a
// selection, to those tabs the item fits.
function createMenus() {
  chrome.menus.removeAll().then(() => {
    chrome.menus.create({ id: "share-tab", title: "Share Tab with Claude", contexts: ["tab"] });
    chrome.menus.create({ id: "unshare-tab", title: "Stop Sharing Tab with Claude", contexts: ["tab"], visible: false });
    chrome.menus.create({ id: "handover-tab", title: "Move Tab to Claude's Window", contexts: ["tab"] });
    chrome.menus.create({ id: "return-tab", title: "Move Tab Out of Claude's Group", contexts: ["tab"], visible: false });
  });
}
createMenus();

chrome.menus.onShown.addListener(async (info, tab) => {
  if (!info.contexts.includes("tab") || !tab) return;
  await stateReady;
  const { kind } = await tabControl(tab.id);
  const shareable = isShareableUrl(tab.url);
  await chrome.menus.update("share-tab", { visible: !kind && shareable });
  await chrome.menus.update("unshare-tab", { visible: !!kind });
  await chrome.menus.update("handover-tab", { visible: kind !== "own" && shareable });
  await chrome.menus.update("return-tab", { visible: kind === "own" });
  chrome.menus.refresh();
});

chrome.menus.onClicked.addListener(async (info, tab) => {
  if (!tab) return;
  await stateReady;
  let tabs = [tab];
  if (tab.highlighted) tabs = await chrome.tabs.query({ windowId: tab.windowId, highlighted: true });
  const byKind = { own: [], shared: [], none: [] };
  for (const t of tabs) byKind[(await tabControl(t.id)).kind || "none"].push(t);
  const ids = (list) => list.map((t) => t.id);

  if (info.menuItemId === "share-tab") await shareTabs(ids(byKind.none));
  if (info.menuItemId === "unshare-tab") {
    for (const t of byKind.shared) await unshareTab(t.id);
    if (byKind.own.length) await takeTabsFromClaude(ids(byKind.own));
  }
  if (info.menuItemId === "handover-tab") {
    const movable = [...byKind.shared, ...byKind.none].filter((t) => isShareableUrl(t.url));
    if (movable.length) await moveTabsToClaude(ids(movable));
  }
  if (info.menuItemId === "return-tab" && byKind.own.length) await moveTabsToUser(ids(byKind.own));
});

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

// The format of what's kept in storage.local: claudeGroupId (number),
// tabOrigins ([tabId, { windowId, index }] pairs) and lastUserWindowId
// (number). Bump it when that changes. Data in any other format is
// discarded rather than migrated: all of it rebuilds itself (the group is
// found by name, a tab without a home goes to the last-used window). That
// includes 1.1.x's mcpWindowId: its window isn't adopted, because after a
// Firefox restart the id can belong to one of the user's windows.
// storage.session needs no version: Firefox clears it whenever the
// extension is updated.
const STORAGE_VERSION = 1;
const STORAGE_VERSION_KEY = "storageVersion";

async function checkStorageVersion() {
  const stored = await chrome.storage.local.get(null);
  if (stored[STORAGE_VERSION_KEY] === STORAGE_VERSION) return;
  const discard = Object.keys(stored);
  if (discard.length) await chrome.storage.local.remove(discard);
  await chrome.storage.local.set({ [STORAGE_VERSION_KEY]: STORAGE_VERSION });
}

// Restores what this background script knew before it was suspended or
// restarted. Every listener that reads the state waits for this first.
async function restoreState() {
  try {
    await checkStorageVersion();
  } catch {}
  try {
    // Shared tabs only last for the extension's session: an id kept longer
    // could point at a different tab after Firefox restarts.
    const { [SHARED_STORAGE_KEY]: shared = [] } = await chrome.storage.session.get(SHARED_STORAGE_KEY);
    for (const id of shared) sharedTabs.add(id);
  } catch {}
  try {
    const stored = await chrome.storage.local.get([ORIGINS_STORAGE_KEY, LAST_WINDOW_STORAGE_KEY]);
    for (const [id, origin] of stored[ORIGINS_STORAGE_KEY] || []) tabOrigins.set(id, origin);
    if (typeof stored[LAST_WINDOW_STORAGE_KEY] === "number") lastUserWindowId ??= stored[LAST_WINDOW_STORAGE_KEY];
  } catch {}
  try {
    const stored = await chrome.storage.local.get(GROUP_STORAGE_KEY);
    if (typeof stored[GROUP_STORAGE_KEY] === "number") claudeGroupId = stored[GROUP_STORAGE_KEY];
  } catch {}
  try {
    // Check the remembered group is still Claude's, and learn its tabs.
    await findClaudeGroup();
    await syncOwnTabs();
  } catch {}
}

const stateReady = restoreState();
connectToServer();
updateBadge();
