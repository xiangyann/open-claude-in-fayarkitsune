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
// Tells this browser (Firefox profile) apart from others connecting to the
// server; random, kept in storage.local.
let browserId = null;
const BROWSER_ID_STORAGE_KEY = "browserId";
const networkRequests = new Map(); // tabId -> [{url, method, status, type, timestamp, requestId}]
const screenshotStore = new Map(); // imageId -> base64
const keyFrames = new Map(); // tabId -> the frame Claude last clicked in, if not the page itself

// --- Keep-alive alarm ---
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    if (!serverSocket) connectToServer();
    // The request journal doesn't keep what a call did longer than needed.
    stateReady.then(() => {
      if (pruneJournal()) saveJournal();
    });
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
    // Says which browser (Firefox profile) this is: the server only resends
    // a request to the browser it first went to.
    stateReady.then(() => {
      if (serverSocket === ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "extension_hello", browserId, version: EXTENSION_VERSION }));
      }
    });
    // Servers from 2.0.0 on say their version right away; one that hasn't
    // within a moment is older. The retry delay starts over only then: a
    // server that refuses this browser (another one is connected) closes the
    // connection at once, and is retried less and less often.
    server.version = null;
    server.settled = false;
    clearTimeout(server.timer);
    server.timer = setTimeout(() => {
      server.settled = true;
      reconnectDelay = 1000;
      updateBadge();
    }, 2000);
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "tool_request" && msg.id) {
      handleToolRequest(msg.id, msg.tool, msg.args || {}, msg.serverVersion, msg.resent === true, msg.timeLeft);
    } else if (msg.type === "tool_cancel" && msg.id) {
      cancelRequest(msg.id);
    } else if (msg.type === "server_hello") {
      server.version = String(msg.version || "");
      server.settled = true;
      reconnectDelay = 1000;
      clearTimeout(server.timer);
      updateBadge();
    }
  };

  // onerror is always followed by onclose
  ws.onclose = () => {
    if (serverSocket === ws) serverSocket = null;
    // Calls still running have lost the server that waits for them. One that
    // comes back in time sends the actions among them again, and they go on
    // (see handleToolRequest). Those it doesn't are stopped like a cancel:
    // no one gets their answers (the session may have quit), and they
    // mustn't go on acting on a page Claude was told they failed on.
    const lostAt = Date.now();
    for (const request of runningRequests.values()) request.lostAt ||= lostAt;
    setTimeout(() => {
      for (const request of runningRequests.values()) {
        if (request.lostAt && Date.now() - request.lostAt >= ORPHANED_AFTER_MS) request.cancelled = true;
      }
    }, ORPHANED_AFTER_MS);
    clearTimeout(server.timer);
    server.settled = false;
    updateBadge();
    scheduleReconnect();
  };
}

// --- Matching versions ---
// Firefox updates the extension by itself (update_url), but a .mcpb
// installed in Claude Desktop isn't updated, so the two can drift apart.
// The server says its version when the extension connects; when they
// differ, the toolbar badge, the setup page and tabs_context_mcp say so.
// EXTENSION_VERSION (lib/version.js) is the full version, e.g. 2.0.0-dev.3;
// the manifest's version is the plain-number form Firefox needs (see
// scripts/set-version.mjs).
const RELEASES_URL = "https://github.com/xiangyann/open-claude-in-fayarkitsune/releases";
const server = { version: null, settled: false, timer: null };

// null when the versions match (or nothing is connected yet), otherwise a
// sentence for the user. Without a version, it's about the server the
// extension is connected to; a tool request says which server sent it,
// which may be another Claude session's, forwarded by that one ("" for one
// before 2.0.0).
function versionMismatch(version) {
  if (version === undefined) {
    if (!server.settled || serverSocket?.readyState !== WebSocket.OPEN) return null;
    version = server.version;
  }
  if (version === EXTENSION_VERSION) return null;
  const serverText = version ? `version ${version}` : "older than 2.0.0";
  return `Claude's MCP server is ${serverText}, and this extension is version ${EXTENSION_VERSION}. Install the matching .mcpb from ${RELEASES_URL} (or update the server you added to Claude Code).`;
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

// Whether it was sent (not whether it arrived).
function postToServer(msg) {
  if (!serverSocket || serverSocket.readyState !== WebSocket.OPEN) return false;
  try {
    serverSocket.send(JSON.stringify(msg));
    return true;
  } catch {
    return false; // Socket closed
  }
}

// Every answer goes through the checks for secrets in text (lib/redact.js):
// tokens in the URLs tabs_context_mcp, navigate, read_page or get_page_text
// show, a dialog's default text, … javascript_tool's results get more (see
// formatJavascriptOutcome).
function sendResponse(id, result) {
  return postToServer({ id, type: "tool_response", result: redactResult(result) });
}

// JSON in a result that was checked value by value already (the tab list:
// see formatTabContext), wherever it is in its text: tabs_create_mcp and
// tabs_close_mcp put a line before it. Checked as text, a quote in one tab's
// title and one in another's could be taken for a quoted value and hidden,
// with what's between them: one tab would get the other's URL and sharing.
// (Kept by text item: the journal keeps a copy of the result with the same
// items.)
const checkedJson = new WeakMap(); // text item -> its checked JSON

function redactResult(result) {
  if (!Array.isArray(result?.content)) return result;
  return {
    ...result,
    content: result.content.map((item) => {
      if (item?.type !== "text") return item;
      const json = checkedJson.get(item);
      const at = json ? item.text.indexOf(json) : -1;
      if (at !== -1) return { ...item, text: redactTokens(item.text.slice(0, at)) + json + redactTokens(item.text.slice(at + json.length)) };
      return { ...item, text: redactTokens(item.text) };
    }),
  };
}

function sendError(id, error) {
  postToServer({ id, type: "tool_error", error: redactTokens(String(error)) });
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

// A tool's answer that says it failed: marked so, for Claude (the server
// passes it on as it is).
function errorResult(text) {
  return { ...textResult(text), isError: true };
}

// Adds a note after a tool's result. Claude's apps show a result's text
// blocks run together, so it goes on its own lines of the last one.
function addNote(result, note) {
  const last = result.content[result.content.length - 1];
  if (last?.type === "text") last.text = `${last.text.replace(/\n+$/, "")}\n\n${note}`;
  else result.content.push({ type: "text", text: note });
}

// --- What the extension did (the debug tool) ---
// A list of what happened, with when: tool calls and how they ended, where
// input went, how screenshots were taken, pages that didn't answer. Only in
// memory, and only so long. What Claude typed, put in a form or gave a prompt
// isn't kept, and text goes through the same redaction as results.
const DEBUG_MAX_EVENTS = 2000;
const debugLog = [];
let debugDropped = 0;

function debugEvent(kind, tabId, text) {
  debugLog.push({ at: Date.now(), kind, tabId: tabId ?? null, text: redactTokens(String(text)).slice(0, 600) });
  if (debugLog.length > DEBUG_MAX_EVENTS) {
    debugLog.shift();
    debugDropped++;
  }
}

// A call's arguments, for the debug log, without what Claude typed or entered
// (a script can set a field's value too).
const PRIVATE_ARGUMENTS = { computer: ["text"], form_input: ["value"], handle_dialog: ["promptText"], upload_files: ["files"], javascript_tool: ["text"] };
function describeArguments(tool, args) {
  const shown = { ...args };
  for (const name of PRIVATE_ARGUMENTS[tool] || []) {
    if (name in shown) shown[name] = "(left out)";
  }
  if (typeof shown.text === "string" && shown.text.length > 300) shown.text = `${shown.text.slice(0, 300)}…`;
  return JSON.stringify(shown);
}

// --- Settings (get_config and set_config) ---
// For every tab (kept in storage.local), and for one tab (in storage.session,
// dropped when the tab closes).
const SETTINGS = {
  humanize: {
    type: "boolean",
    default: false,
    about: "Move the mouse to where it acts along a curved path, at a human pace (the user sees it as an orange cursor), and type and press keys with a human rhythm, instead of all at once. Slower; for when the user asks for human input or behaviour, and for sites that tell scripted input apart by its timing (it doesn't change that the events are synthetic).",
  },
  humanize_speed: {
    type: "string",
    values: ["fast", "natural", "relaxed"],
    default: "natural",
    about: "How fast humanized input is.",
  },
};
const CONFIG_STORAGE_KEY = "config";
const TAB_CONFIG_STORAGE_KEY = "tabConfig";
let configForAll = {};
const configForTabs = new Map(); // tabId -> its own settings

function settingsFor(tabId) {
  const defaults = Object.fromEntries(Object.entries(SETTINGS).map(([key, setting]) => [key, setting.default]));
  return { ...defaults, ...configForAll, ...(configForTabs.get(tabId) || {}) };
}

function saveTabConfig() {
  chrome.storage.session.set({ [TAB_CONFIG_STORAGE_KEY]: [...configForTabs] }).catch(() => {});
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
  pageOrigins.delete(tabId);
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
// The tab is read last, with nothing awaited between that and the decision:
// the tab may be on its way into or out of the group, and what's decided about
// it must fit where it is then.
async function tabControl(tabId) {
  const group = await findClaudeGroup();
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { tab: null, kind: null };
  }
  if (group && tab.groupId === group.id) {
    // Dragged into the group, unless it's on its way out (see moveTabsToUser).
    if (!movingOut.has(tabId) && sharedTabs.delete(tabId)) saveSharedTabs();
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
  // Checked here, one by one (see redactResult): the server reads this JSON.
  const entry = (t) => ({ tabId: t.id, title: redactTokens(t.title || "Untitled"), url: redactTokens(t.url || "") });
  const available = [
    ...own.map(entry),
    ...shared.map((t) => ({ ...entry(t), sharedByUser: true })),
  ];
  // The old ids of tabs another add-on reopened, for the server's own
  // lookups (see "Tabs another add-on reopens").
  const reopened = reopenedIds(available.map((t) => t.tabId));
  const json = JSON.stringify({ availableTabs: available, groupId: group?.id ?? null, windowId: group?.windowId ?? null, ...(reopened && { reopened }) });
  let text = "Tab Context:\n";
  text += `- Claude's tabs (tab group "${GROUP_TITLE}"):\n`;
  text += own.length ? own.map(tabLine).join("") : "  (none)\n";
  if (shared.length) {
    text += "- Tabs the user shared with you (their own tabs, in their windows):\n";
    text += shared.map(tabLine).join("");
  }
  const result = textResult(json + "\n\n" + text);
  checkedJson.set(result.content[0], json);
  return result;
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
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  await stateReady; // or the restore could bring its ids back afterwards
  noteClosed(tabId, removeInfo); // first: it may have been reopened (see below)
  networkRequests.delete(tabId);
  if (startedTabs.delete(tabId)) saveStartedTabs();
  pageOrigins.delete(tabId);
  lastWorkAt.delete(tabId);
  hookedTabs.delete(tabId);
  keyFrames.delete(tabId);
  knownViews.delete(tabId);
  lastScreenshots.delete(tabId);
  lastTrees.delete(tabId);
  if (configForTabs.delete(tabId)) saveTabConfig();
  ownTabs.delete(tabId);
  if (sharedTabs.delete(tabId)) saveSharedTabs();
  if (tabOrigins.delete(tabId)) saveTabOrigins();
});

// --- Tabs another add-on reopens ---
// A container add-on (Facebook Container, say) moves a site into or out of a
// container by stopping the tab's page from loading, opening it in a new tab
// in another container where the old one was, and closing the old one. To
// Claude it's still the same tab: the new one takes over the old one's place
// (Claude's group, or the user's sharing) and settings, and a call that names
// the old id runs in the new one, with a word about it. A new tab only counts
// as the old one reopened if it opens, in the same window, in another
// container and within seconds of the old one closing, the very address the
// old one had just started to load. (Not a tab the user opens there, or one
// they bring back with "Reopen Closed Tab": those stay in its container.)
const REOPEN_WINDOW_MS = 3000;
const REOPENED_KEPT_MS = 30 * 60 * 1000;
const CLOSED_KEPT_MS = 10 * 60 * 1000;
const pageLoads = new Map(); // tabId -> [{ url, store, at }]: pages Claude's tabs just started to load, and in which container
const justClosed = new Map(); // tabId -> { windowId, kind, loads (url -> container), at, settings, origin } of a tab Claude could use
const closedTabs = new Set(); // ids of tabs that closed lately, Claude's or not
const justOpened = new Map(); // tabId -> { windowId, store, at, urls }
const reopenedTabs = new Map(); // old tabId -> { tabId, at, ready }
const reopenWaiters = new Set(); // (oldId, newId or null) => void

function recentLoads(tabId) {
  return (pageLoads.get(tabId) || []).filter((load) => Date.now() - load.at < REOPEN_WINDOW_MS);
}

// From the webRequest listener: a tab started to load a page, in the
// container `store`. The old tab's load can be reported only after it closed:
// the add-on that stops the load can close the tab before listeners like this
// one hear of it.
function notePageLoad(tabId, url, store) {
  const opened = justOpened.get(tabId);
  if (opened && !opened.urls.has(url) && opened.urls.size < 5) {
    opened.urls.add(url);
    matchReopened();
  }
  const closed = justClosed.get(tabId);
  if (closed && !closed.loads.has(url) && closed.loads.size < 5) {
    closed.loads.set(url, store);
    matchReopened();
  }
  if (isControlledNow(tabId)) pageLoads.set(tabId, [...recentLoads(tabId), { url, store, at: Date.now() }].slice(-5));
}

chrome.tabs.onCreated.addListener((tab) => {
  const urls = new Set(/^https?:/i.test(tab.url || "") ? [tab.url] : []);
  justOpened.set(tab.id, { windowId: tab.windowId, store: tab.cookieStoreId, at: Date.now(), urls });
  setTimeout(() => justOpened.delete(tab.id), REOPEN_WINDOW_MS);
  if (urls.size) matchReopened();
});
// And the address it shows once it does, should its load have gone unseen.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  const opened = justOpened.get(tabId);
  if (opened && info.url && !opened.urls.has(info.url) && opened.urls.size < 5) {
    opened.urls.add(info.url);
    matchReopened();
  }
});

// From the onRemoved listener, before the tab's records go: a tab Claude
// could use closed. The page it was loading may be reported yet.
function noteClosed(tabId, { windowId, isWindowClosing }) {
  const kind = ownTabs.has(tabId) ? "own" : sharedTabs.has(tabId) ? "shared" : null;
  const loads = new Map(recentLoads(tabId).map((load) => [load.url, load.store]));
  pageLoads.delete(tabId);
  closedTabs.add(tabId);
  setTimeout(() => closedTabs.delete(tabId), CLOSED_KEPT_MS);
  if (!kind || isWindowClosing) return;
  justClosed.set(tabId, { windowId, kind, loads, at: Date.now(), settings: configForTabs.get(tabId), origin: tabOrigins.get(tabId) });
  setTimeout(() => {
    if (justClosed.delete(tabId)) settleReopen(tabId, null);
  }, REOPEN_WINDOW_MS);
  matchReopened();
}

function matchReopened() {
  for (const [oldId, closed] of justClosed) {
    for (const [newId, opened] of justOpened) {
      if (newId === oldId || opened.windowId !== closed.windowId) continue;
      if (Math.abs(opened.at - closed.at) > REOPEN_WINDOW_MS) continue;
      if (![...closed.loads].some(([url, store]) => opened.urls.has(url) && store && opened.store && store !== opened.store)) continue;
      justClosed.delete(oldId);
      justOpened.delete(newId);
      for (const [id, entry] of reopenedTabs) {
        if (Date.now() - entry.at > REOPENED_KEPT_MS) reopenedTabs.delete(id);
      }
      reopenedTabs.set(oldId, { tabId: newId, at: Date.now(), ready: takeOver(oldId, newId, closed) });
      settleReopen(oldId, newId);
      break;
    }
  }
}

function settleReopen(oldId, newId) {
  for (const waiter of [...reopenWaiters]) waiter(oldId, newId);
}

// The new tab takes the old one's place. (Firefox may have put it in the old
// one's group already: it opens where the old one was.)
async function takeOver(oldId, newId, closed) {
  debugEvent("tab", newId, `tab ${oldId} was reopened as tab ${newId} by another add-on`);
  if (closed.settings) {
    configForTabs.set(newId, closed.settings);
    saveTabConfig();
  }
  if (closed.origin) {
    tabOrigins.set(newId, closed.origin);
    saveTabOrigins();
  }
  try {
    if (closed.kind === "shared") {
      if (!(await tabControl(newId)).kind) {
        sharedTabs.add(newId);
        await saveSharedTabs();
      }
      return;
    }
    await withGroupLock(async () => {
      const tab = await chrome.tabs.get(newId);
      const group = await findClaudeGroup();
      if (group && tab.groupId === group.id) return;
      if (group) {
        if (tab.windowId !== group.windowId) await chrome.tabs.move(newId, { windowId: group.windowId, index: -1 });
        await chrome.tabs.group({ groupId: group.id, tabIds: [newId] });
      } else {
        // The old tab was the group's last one: the new one starts it again.
        const groupId = await chrome.tabs.group({ tabIds: [newId], createProperties: { windowId: tab.windowId } });
        await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: GROUP_COLOR });
        await rememberGroup(groupId);
      }
    });
  } catch {
    // Closed already, or it can't join the group: it stays as it is.
  } finally {
    await tabControl(newId).catch(() => {}); // ownTabs, up to date
  }
}

// Old id -> the tab it stands for now, for those of `ids` (the tabs Claude
// can use) that were reopened; null if none were.
function reopenedIds(ids) {
  const found = {};
  for (const oldId of reopenedTabs.keys()) {
    let id = oldId;
    for (let hops = 0; hops < 10 && reopenedTabs.has(id); hops++) id = reopenedTabs.get(id).tabId;
    if (ids.includes(id)) found[oldId] = id;
  }
  return Object.keys(found).length ? found : null;
}

// What a tab id stands for now: the tab its page was reopened in, if it was.
async function currentTabId(tabId) {
  for (let hops = 0; hops < 10 && reopenedTabs.has(tabId); hops++) {
    const entry = reopenedTabs.get(tabId);
    await entry.ready;
    tabId = entry.tabId;
  }
  return tabId;
}

// Whether a tab that's gone may yet turn out reopened: it had started to
// load a page, or a tab opened in its window meanwhile. Its onRemoved may not
// have come yet; one that came and kept nothing was no tab of Claude's, or
// closed with its window.
function mayBeReopened(tabId) {
  const closed = justClosed.get(tabId);
  if (!closed) return !closedTabs.has(tabId) && (recentLoads(tabId).length > 0 || justOpened.size > 0);
  return closed.loads.size > 0 || [...justOpened.values()].some((opened) => opened.windowId === closed.windowId);
}

// The tab a closed tab was reopened as, or null, after waiting for it (until
// `deadline` at the latest) if it may yet be.
async function reopenedAs(tabId, deadline = Infinity) {
  if (!reopenedTabs.has(tabId) && !(await chrome.tabs.get(tabId).catch(() => null)) && mayBeReopened(tabId)) {
    await new Promise((resolve) => {
      const waiter = (oldId) => {
        if (oldId !== tabId) return;
        reopenWaiters.delete(waiter);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => waiter(tabId), Math.max(0, Math.min(REOPEN_WINDOW_MS, deadline - Date.now())));
      reopenWaiters.add(waiter);
      if (reopenedTabs.has(tabId)) waiter(tabId);
    });
  }
  const entry = reopenedTabs.get(tabId);
  if (!entry) return null;
  await entry.ready;
  return entry.tabId;
}

function reopenedNote(oldId, newId) {
  return `Tab ${oldId} is now tab ${newId}: another add-on reopened its page in a new tab, as container add-ons do to move a site into or out of a container. Use tabId ${newId} from now on.`;
}

// --- Network monitoring via webRequest ---
// Only tabs Claude can use are recorded, from the moment it can: a tab the
// user shares later starts with an empty history, not with what it loaded
// while it was private.
// A page loading from another site starts the list over (the tool's
// description promises that); within a site, earlier pages' requests stay.
// The redirects of one navigation share its request id: they don't start
// it over, they only change where it's going.
const pageOrigins = new Map(); // tabId -> { origin, requestId } of the last page loaded

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.type === "main_frame") notePageLoad(details.tabId, details.url, details.cookieStoreId);
    if (!isControlledNow(details.tabId)) return;
    let reqs = networkRequests.get(details.tabId) || [];
    if (details.type === "main_frame") {
      const origin = URL.canParse(details.url) ? new URL(details.url).origin : null;
      const last = pageOrigins.get(details.tabId);
      if (last && last.requestId !== details.requestId && last.origin !== origin) reqs = [];
      pageOrigins.set(details.tabId, { origin, requestId: details.requestId });
    }
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
    // Only requests already recorded: not for tabs Claude can't use.
    const reqs = networkRequests.get(details.tabId);
    if (!reqs) return;
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
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// A redirect ends this part of the request: the next part comes as a new
// request with the same id.
chrome.webRequest.onBeforeRedirect.addListener(
  (details) => {
    const reqs = networkRequests.get(details.tabId);
    if (!reqs) return;
    for (let i = reqs.length - 1; i >= 0; i--) {
      if (reqs[i].requestId === details.requestId && reqs[i].status === 0) {
        reqs[i].status = details.statusCode;
        break;
      }
    }
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    // Only requests already recorded: not for tabs Claude can't use.
    const reqs = networkRequests.get(details.tabId);
    if (!reqs) return;
    for (let i = reqs.length - 1; i >= 0; i--) {
      if (reqs[i].requestId === details.requestId) {
        reqs[i].status = -1;
        reqs[i].error = details.error;
        break;
      }
    }
  },
  { urls: ["<all_urls>"] }
);

// --- Content script communication ---
// A page busy with a script (one javascript_tool gave up on, say) can't
// answer. Each message carries a deadline: the tool reports the page as busy
// when it passes, and the content script drops a message it only gets after
// it, so a click or a key doesn't happen late, after Claude was told it
// failed.
const CONTENT_TIMEOUT_MS = 20000;

// One step of a tool (a key, say) gets no more time than its call has left,
// less a second to answer with how far it got.
function stepTimeout(request) {
  return Math.max(1500, Math.min(CONTENT_TIMEOUT_MS, request.deadline - Date.now() - 1000));
}

// frameId: the page itself, unless a frame is meant (see "Frames" in
// content.js). tabs.sendMessage goes to every frame with the script otherwise,
// and the first to answer would count.
async function sendContentMessage(tabId, message, timeoutMs = CONTENT_TIMEOUT_MS, frameId = 0) {
  const deadline = Date.now() + timeoutMs;
  const send = async () => {
    let timer;
    const late = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(
        `The page didn't respond within ${Math.round(timeoutMs / 1000)} s: it may be busy, e.g. with a script that's still running. It may or may not have done this already (check before repeating it), but it won't do it later.`
      )), Math.max(0, deadline - Date.now()));
    });
    let response;
    try {
      response = await Promise.race([chrome.tabs.sendMessage(tabId, { ...message, deadline }, { frameId }), late]);
    } finally {
      clearTimeout(timer);
    }
    // The page got it too late to act on it (see content.js): not done.
    if (response?.error === "expired") {
      const err = new Error("The page was too busy to take this in time; it wasn't done.");
      err.notDone = true;
      throw err;
    }
    // Humanized input stopped on its way there (see content.js).
    if (response?.error === "released") {
      const err = new Error("The user took this tab back, so it wasn't done.");
      err.notDone = true;
      throw err;
    }
    return response;
  };
  try {
    return await send();
  } catch (err) {
    // Only when there's no content script (a page loaded before the
    // extension was): inject it and send again. Any other failure, e.g. the
    // page navigating away mid-message, may come after the action happened.
    if (!/Receiving end does not exist|Could not establish connection/i.test(err?.message || "")) throw err;
    // No longer than the message may take: a frame that's stuck is left
    // out, like one that doesn't answer.
    let timer;
    try {
      await Promise.race([
        chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["content.js"], injectImmediately: true }),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error(
            `The page didn't respond within ${Math.round(timeoutMs / 1000)} s: it may be busy, e.g. with a script that's still running.`
          )), Math.max(0, deadline - Date.now()));
        }),
      ]);
    } catch (injectError) {
      injectError.unreachable = true; // nothing was sent to the page
      throw injectError;
    } finally {
      clearTimeout(timer);
    }
    return send();
  }
}

// Why a call shouldn't go on acting on the tab, if there's a reason.
function stopReason(tabId, request) {
  if (!isControlledNow(tabId)) return "the user took this tab back";
  if (request.cancelled) return "the call was cancelled";
  if (Date.now() >= request.deadline) return "the call ran out of time";
  return null;
}

// Frames a page is shown with, all levels of them, in the coordinates of the
// top page: [{ frameId, x, y }]. A frame that doesn't answer in time is left
// out. Few are looked at: a page can have hundreds of ad frames.
const MAX_FRAME_DEPTH = 4;
const MAX_FRAMES = 20;
const FRAME_TIMEOUT_MS = 2000;

async function shownFrames(tabId) {
  const frames = [];
  let level = [{ frameId: 0, x: 0, y: 0 }];
  for (let depth = 0; depth < MAX_FRAME_DEPTH && level.length; depth++) {
    const lists = await Promise.all(level.map(async (parent) => {
      const resp = await sendContentMessage(tabId, { type: "listFrames" }, FRAME_TIMEOUT_MS, parent.frameId).catch(() => null);
      return (resp?.result || []).map((f) => ({ frameId: f.frameId, x: parent.x + f.x, y: parent.y + f.y }));
    }));
    level = lists.flat().slice(0, MAX_FRAMES - frames.length);
    frames.push(...level);
  }
  return frames;
}

// The frame a ref is from (see getOrAssignRef in content.js).
function refFrame(ref) {
  return Number(/^ref_f(\d+)_/.exec(ref || "")?.[1] ?? 0);
}

// A message for the page about acting on it. It isn't sent once the call
// shouldn't act anymore (the tab can stop being Claude's, or the call stop
// being wanted, between one step and the next), and gets no longer than the
// call has left.
function pageMessage(tabId, request, message, frameId = 0) {
  const reason = stopReason(tabId, request);
  if (reason) {
    const err = new Error(`${reason}, so this wasn't done`);
    err.notDone = true;
    return Promise.reject(err);
  }
  return sendContentMessage(tabId, message, stepTimeout(request), frameId);
}

// A mouse message goes to the page. If its point is in a frame, the page says
// so, and it goes on to that frame. Answers with the frame it ended in.
async function pointMessage(tabId, request, message, frameId = 0) {
  let target = frameId;
  let sent = message;
  for (let hops = 0; hops < MAX_FRAME_DEPTH; hops++) {
    let resp;
    try {
      resp = await pageMessage(tabId, request, sent, target);
    } catch (err) {
      if (!err.unreachable) throw err;
      return { error: `That point is inside a frame Claude can't reach (${err.message}).` };
    }
    if (!resp?.intoFrame) {
      if (resp?.hit) debugEvent("input", tabId, `${message.type} in frame ${target}: ${resp.hit}`);
      return { ...resp, frameId: target };
    }
    const { frameId: inner, ...points } = resp.intoFrame;
    debugEvent("input", tabId, `${message.type}: into frame ${inner}`);
    target = inner;
    sent = { ...message, ...points };
  }
  return { error: "That point is inside frames nested too deep to reach." };
}

// Asks each frame of a page, in parallel. Those that fail or don't answer in
// time are left out.
function askFrames(tabId, frames, message) {
  return Promise.all(frames.map(async (frame) => {
    const resp = await sendContentMessage(tabId, message, FRAME_TIMEOUT_MS, frame.frameId).catch(() => null);
    return { frame, resp };
  }));
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
  chrome.tabs.sendMessage(tabId, { type: "glow", mode }, { frameId: 0 }).catch(() => {});
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
// scripted. With busy: true, the page didn't answer in time: a script stuck
// in a loop (one javascript_tool gave up on) blocks the page's world, and the
// tool result mustn't wait for it. What was asked still happens, once the
// page is free: the call stays queued there.
const PAGE_HOOKS_TIMEOUT_MS = 3000;
const FRAME_HOOKS_TIMEOUT_MS = 1000;

// The page's frames are hooked too: a frame's alert() would freeze the tab
// just the same. Their records are merged with the page's. The page and its
// frames are asked apart, so that what the page answers isn't lost to a frame
// stuck in a script, and each is only asked once: asking again would take
// what the first call took, and could undo a release that came after it.
// Every caller but releasePage acts on a tab Claude controls, so recording
// is on unless the settings say otherwise.
// The first call for a tab since Claude started using it also makes the page
// forget what it recorded before: while it wasn't shared, or before an
// extension update or reload ended the sharing without telling the page.
// Those tabs are kept in storage.session, which lasts as long as sharing does.
const STARTED_STORAGE_KEY = "startedTabIds";
const startedTabs = new Set();
const REFUSED = Symbol("the page can't be scripted");

function saveStartedTabs() {
  chrome.storage.session.set({ [STARTED_STORAGE_KEY]: [...startedTabs] }).catch(() => {});
}

async function callPageHooks(tabId, settings, frameId) {
  const releasing = settings?.recording === false;
  // Taken back meanwhile (a tool's last call can come after that): the page
  // must not start recording again.
  if (!releasing && !isControlledNow(tabId)) return null;
  // Marked before the call, and only unmarked if the page refused it: a call
  // that takes too long still lands, forgetting what it should, and a later
  // call that forgot too would take what a tool did in between with it.
  // (Refused, there's no page yet to have forgotten anything.)
  const starting = !releasing && !startedTabs.has(tabId);
  if (starting) startedTabs.add(tabId);
  if (starting || (releasing && startedTabs.delete(tabId))) saveStartedTabs();
  const sent = { recording: true, ...settings, ...(starting ? { forget: true } : {}) };
  const run = (target, args, timeoutMs) => {
    const call = chrome.scripting
      .executeScript({
        target,
        world: "MAIN",
        injectImmediately: true,
        func: installPageHooks,
        args: [args],
      })
      .catch(() => REFUSED);
    return Promise.race([call, sleep(timeoutMs).then(() => null)]);
  };
  const [page, frames] = await Promise.all([
    run({ tabId, frameIds: [frameId ?? 0] }, sent, PAGE_HOOKS_TIMEOUT_MS),
    frameId === undefined ? run({ tabId, allFrames: true }, { ...sent, subframes: true }, FRAME_HOOKS_TIMEOUT_MS) : null,
  ]);
  if (page === REFUSED) {
    if (starting && startedTabs.delete(tabId)) saveStartedTabs();
    return null;
  }
  const busy = page === null;
  if (busy) debugEvent("page", tabId, `the page didn't answer its hooks within ${PAGE_HOOKS_TIMEOUT_MS / 1000} s`);
  if (settings?.answerUntil > 0) hookedTabs.add(tabId);
  const records = [page, frames].flatMap((r) => (Array.isArray(r) ? r : [])).map((res) => res?.result).filter(Boolean);
  if (!records.length && !busy) return null;
  if (settings?.read === "logs") {
    return { busy, logs: records.flatMap((r) => r.logs || []).sort((a, b) => a.timestamp - b.timestamp) };
  }
  return {
    busy,
    dialogs: records.flatMap((r) => r.dialogs || []),
    dropped: records.reduce((sum, r) => sum + (Number(r.dropped) || 0), 0),
  };
}

// A tab Claude no longer controls (released, or dragged out of Claude's
// group) gets its dialogs back right away: the page stops answering them,
// and an answer chosen with handle_dialog is dropped. The glow goes too.
// Callers only release tabs Claude could use until now (hooked or
// controlled), so the user's other tabs aren't touched. Not just hookedTabs:
// that's in memory, and a page keeps its hooks across an extension reload.
// The page also stops recording, and forgets what it recorded: if the tab
// is shared again, Claude sees only what happens from then on.
function releasePage(tabId) {
  hookedTabs.delete(tabId);
  setGlow(tabId, "remove");
  // Frames too: humanized input in one stops before pressing (see content.js).
  chrome.tabs.sendMessage(tabId, { type: "released" }).catch(() => {});
  callPageHooks(tabId, { answerUntil: 0, nextAnswer: null, recording: false, forget: true });
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
  // (startedTabs too: it outlasts this background script, the others are
  // only in memory.)
  const couldUse = isControlledNow(tabId) || hookedTabs.has(tabId) || startedTabs.has(tabId);
  const { kind } = await tabControl(tabId);
  if (!kind) {
    if (couldUse) forgetTab(tabId);
  } else {
    callPageHooks(tabId, { answerUntil: dialogDeadline(tabId, kind), report: false });
  }
}
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if ("groupId" in info) reconsiderTab(tabId);
});
chrome.tabs.onAttached.addListener((tabId) => reconsiderTab(tabId));
chrome.tabs.onMoved.addListener((tabId) => reconsiderTab(tabId));

// A page can reach what its hooks recorded and write anything there: these
// records are cut to size and to known words, so a page's text only ever
// appears quoted, and not in the size of text that keeps redaction busy.
const DIALOG_TYPES = new Set(["alert", "confirm", "prompt"]);
const DIALOG_ANSWERS = new Set(["OK", "Cancel", "OK with your text", "OK with its default text"]);
const MAX_DIALOG_MESSAGE = 500;
const MAX_DIALOGS_LISTED = 50;

function describeDialogs(dialogs, dropped = 0) {
  if (!dialogs.length && !dropped) return null;
  const lines = dialogs.slice(0, MAX_DIALOGS_LISTED).map((d) => {
    const type = DIALOG_TYPES.has(d.type) ? d.type : "dialog";
    const text = String(d.message ?? "").slice(0, MAX_DIALOG_MESSAGE);
    const msg = text ? ` "${redactString(text)}"` : "";
    if (d.answer === "left open for the user") {
      return `- ${type}${msg}: shown to the user (it opened while you weren't working in this tab); the page is paused until they answer it`;
    }
    return `- ${type}${msg}: answered ${DIALOG_ANSWERS.has(d.answer) ? d.answer : "by the page's hooks"} automatically`;
  });
  if (dropped) lines.push(`- … and ${dropped} more, not listed`);
  return `The page opened dialogs:\n${lines.join("\n")}\nUse handle_dialog to choose how the next confirm or prompt is answered.`;
}

// In Claude's own window, the tab Claude works in is the one shown: Firefox
// slows down the pages of tabs that aren't (timers, animations), which a
// screenshot taken in place (tabs.captureTab) would show as half done. Not
// in a window that holds the user's tabs too (they moved Claude's group
// there): that's theirs to switch.
async function showInClaudesWindow(tab) {
  const tabs = await chrome.tabs.query({ windowId: tab.windowId }).catch(() => []);
  if (tabs.length && tabs.every((t) => t.groupId === tab.groupId)) {
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  }
}

// Tools that work inside a tab's page get the glow, page hooks, and a report
// of any dialogs the page opened.
async function startPageWork(tabId, kind, request) {
  lastWorkAt.set(tabId, Date.now());
  workingTabs.set(tabId, (workingTabs.get(tabId) || 0) + 1);
  const before = await callPageHooks(tabId, { answerUntil: dialogDeadline(tabId, kind) });
  if (isControlledNow(tabId)) setGlow(tabId, "show");
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
    // released, and neither its dialogs nor what the tool found there are
    // Claude's to see anymore.
    const now = await tabControl(tabId);
    // Closed meanwhile, maybe by what the tool did (a click on a popup's
    // close button): the result stands, with a word about it.
    if (!now.tab) {
      const reopened = await reopenedAs(tabId, request.deadline);
      if (result?.content) addNote(result, reopened === null ? `Tab ${tabId} has closed.` : reopenedNote(tabId, reopened));
      return result;
    }
    if (!now.kind) {
      return result && errorResult(
        `The user took tab ${tabId} back while this was running. It may have been done, but what it found there isn't shown. Use tabs_context_mcp to see the tabs you can use.`
      );
    }
    setGlow(tabId, "show"); // it fades out a few seconds after the last refresh
    const after = await callPageHooks(tabId, { answerUntil: dialogDeadline(tabId, now.kind) });
    const note = describeDialogs(
      [...(before?.dialogs || []), ...(after?.dialogs || [])],
      (before?.dropped || 0) + (after?.dropped || 0)
    );
    if (note && result?.content) addNote(result, note);
    return result;
  };
}

// A new page started loading in a tab (content.js runs at document_start):
// hook it early if Claude controls the tab.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "pageStarted" || !sender.tab) return;
  (async () => {
    await stateReady;
    if (sender.frameId === 0) keyFrames.delete(sender.tab.id); // its frames are gone
    const { kind } = await tabControl(sender.tab.id);
    // (report: false: this can come during a tool, whose report they're for.)
    if (kind) await callPageHooks(sender.tab.id, { answerUntil: dialogDeadline(sender.tab.id, kind), report: false }, sender.frameId);
  })();
});

// --- Screenshot helper ---
// Firefox draws the tab with tabs.captureTab(), whether or not it's the one
// its window shows; failing that, it's made active for tabs.captureVisibleTab().
// It renders at scale × the page's zoom: a scale of 1/zoom keeps image pixels
// equal to CSS pixels, so coordinates read off a screenshot match the ones
// clicks use, on HiDPI screens and zoomed pages alike. An image larger than
// what Claude's API takes in is shrunk before Claude sees it, and the
// coordinates Claude reads off it would be wrong by as much: it's captured
// at that size (viewOf), and coordinates are taken back from it.
// rect (optional) is a region in page coordinates, i.e. including scroll offset.
// Screenshots of a window take turns: another session could otherwise make
// its own tab the active one between this one's activating and capturing.
// One that hangs (a page stuck in a script may not render) is given up on,
// so the next ones still get their turn.
const windowQueues = new Map(); // windowId -> the last screenshot queued there
const SCREENSHOT_TIMEOUT_MS = 10000;
const MAX_IMAGE_EDGE = 1568;
const MAX_IMAGE_PIXELS = 1150000;

// The tab's viewport in CSS pixels, its zoom, and fit: the image pixels of a
// screenshot per CSS pixel. The size is read in the extension's own world on
// the page: the page's script can't change what that sees. A page too busy to
// answer gets the size it last had. (tabs.get's width is often 0 in Firefox.)
const knownViews = new Map(); // tabId -> [width, height]

async function viewOf(tabId) {
  const zoom = await chrome.tabs.getZoom(tabId).catch(() => 1);
  const read = chrome.scripting
    .executeScript({ target: { tabId }, injectImmediately: true, func: () => [window.innerWidth, window.innerHeight] })
    .then((results) => results?.[0]?.result, () => null);
  const size = await Promise.race([read, sleep(1000).then(() => null)]);
  if (Array.isArray(size) && size[0] > 0 && size[1] > 0) knownViews.set(tabId, size);
  const [width, height] = knownViews.get(tabId) || [0, 0];
  const fit = width && height
    ? Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height), Math.sqrt(MAX_IMAGE_PIXELS / (width * height)))
    : 1;
  return { zoom, fit, width, height, imageWidth: Math.round(width * fit), imageHeight: Math.round(height * fit) };
}

// A task gets its turn ({ over }): once it's given up on, it must not
// activate a tab or capture anymore, since the next task has the window.
function inWindowQueue(windowId, task) {
  const timed = () => {
    const turn = { over: false };
    let timer;
    const late = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        turn.over = true;
        reject(new Error("the screenshot took too long: the page may be busy"));
      }, SCREENSHOT_TIMEOUT_MS);
    });
    return Promise.race([task(turn), late]).finally(() => clearTimeout(timer));
  };
  const run = (windowQueues.get(windowId) || Promise.resolve()).catch(() => {}).then(timed);
  windowQueues.set(windowId, run);
  run.finally(() => {
    if (windowQueues.get(windowId) === run) windowQueues.delete(windowId);
  }).catch(() => {});
  return run;
}

async function takeScreenshot(tabId, request, options = {}) {
  const { windowId } = await chrome.tabs.get(tabId);
  return inWindowQueue(windowId, (turn) => takeScreenshotNow(tabId, request, options, turn));
}

let lastScreenshotNumber = 0;

// `keep`: whether it gets an imageId (for upload_image and if_changed), and
// one of the 10 places; the images scroll and zoom show don't.
async function takeScreenshotNow(tabId, request, { rect, scale, keep = true } = {}, turn = { over: false }) {
  // It may have waited its turn: is the tab still Claude's to show, and does
  // the call still want it? And is it still this screenshot's turn?
  const stillClaudes = () => {
    if (turn.over) throw new Error("the screenshot took too long: the page may be busy");
    const reason = stopReason(tabId, request);
    if (reason) throw new Error(reason);
  };
  stillClaudes();

  let view;
  const optionsFor = (quality) => {
    const options = { format: "jpeg", quality, scale: (scale ?? view.fit) / view.zoom };
    if (rect) options.rect = rect;
    return options;
  };

  // Firefox can draw a tab its window isn't showing (tabs.captureTab), so the
  // window stays on whatever tab the user has there.
  const captureInPlace = async (quality) => {
    view = await viewOf(tabId);
    stillClaudes();
    const dataUrl = await chrome.tabs.captureTab(tabId, optionsFor(quality));
    if (!isControlledNow(tabId)) throw new Error("the user took this tab back");
    return dataUrl.replace(/^data:image\/jpeg;base64,/, "");
  };

  // Where it can't (a tab never shown since it loaded has no size to draw
  // at), the tab is made the active one and the window's visible tab is taken.
  const capture = async (quality) => {
    // Still this tab, and still in the window it's captured from? The user
    // can switch tabs, or move the tab to another window: then the window
    // shows a tab of theirs. Made active again once; checked again after
    // the capture, and the picture is dropped if anything changed.
    stillClaudes();
    let now = await chrome.tabs.get(tabId);
    if (!now.active) {
      stillClaudes();
      await chrome.tabs.update(tabId, { active: true });
      await sleep(100);
      now = await chrome.tabs.get(tabId);
      if (!now.active) {
        throw new Error("another tab kept becoming the active one in this window; try again");
      }
    }
    view = await viewOf(tabId);
    stillClaudes();
    const dataUrl = await chrome.tabs.captureVisibleTab(now.windowId, optionsFor(quality));
    const after = await chrome.tabs.get(tabId);
    if (!after.active || after.windowId !== now.windowId || !isControlledNow(tabId)) {
      throw new Error("the tab was switched away or moved during the screenshot; try again");
    }
    return dataUrl.replace(/^data:image\/jpeg;base64,/, "");
  };

  // Keep the glow out of the picture, until the last of any overlapping
  // screenshots of this tab is done. A busy page can't answer; it's not
  // waited for long.
  capturing.set(tabId, (capturing.get(tabId) || 0) + 1);
  let base64;
  try {
    await Promise.race([chrome.tabs.sendMessage(tabId, { type: "glow", mode: "hide" }, { frameId: 0 }).catch(() => {}), sleep(1000)]);
    let take = captureInPlace;
    try {
      base64 = await take(55);
    } catch (err) {
      if (turn.over || stopReason(tabId, request)) throw err;
      debugEvent("screenshot", tabId, `captureTab failed (${err.message}); made the tab active for captureVisibleTab`);
      take = capture;
      base64 = await take(55);
    }
    debugEvent("screenshot", tabId, `${take === capture ? "captureVisibleTab" : "captureTab"}: viewport ${view.width}x${view.height}, zoom ${view.zoom}, image scale ${view.fit.toFixed(3)}${rect ? `, region ${JSON.stringify(rect)}` : ""}`);
    if (base64.length > 500000) base64 = await take(30);
  } finally {
    const left = capturing.get(tabId) - 1;
    if (left > 0) {
      capturing.set(tabId, left);
    } else {
      capturing.delete(tabId);
      if (isControlledNow(tabId)) setGlow(tabId, "show");
    }
  }

  if (!keep) return { base64, imageId: null, view };
  // Unique, also for screenshots of two windows taken in the same millisecond.
  lastScreenshotNumber = Math.max(Date.now(), lastScreenshotNumber + 1);
  const imageId = `screenshot_${lastScreenshotNumber}`;
  screenshotStore.set(imageId, base64);
  const keys = Array.from(screenshotStore.keys());
  while (keys.length > 10) screenshotStore.delete(keys.shift());

  return { base64, imageId, view };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A link Claude clicked that opens a new tab (see content.js): it opens in
// the background next to the tab it came from, and belongs to Claude the
// same way that tab does: in Claude's group, or shared. Returns the tab and
// how it's Claude's. If the user takes the tab back meanwhile, the link's tab
// isn't shared either: it's only Claude's by way of that tab.
async function openLinkInNewTab(fromTabId, kind, url) {
  // Web pages only, as with navigate: not local files or other schemes.
  if (!/^https?:/i.test(url)) throw new Error(`the link goes to ${url.split(":")[0]}:, which Claude doesn't open`);
  if (!isControlledNow(fromTabId)) throw new Error("the user took this tab back, so the link wasn't opened");
  const from = await chrome.tabs.get(fromTabId);
  const tab = await chrome.tabs.create({
    url,
    windowId: from.windowId,
    index: from.index + 1,
    openerTabId: fromTabId,
    active: false,
  });
  let grouped = false;
  if (kind === "own" && claudeGroupId !== null) {
    grouped = await chrome.tabs.group({ groupId: claudeGroupId, tabIds: [tab.id] }).then(() => true, () => false);
  }
  if (!grouped && isControlledNow(fromTabId)) {
    sharedTabs.add(tab.id);
    await saveSharedTabs();
  }
  return { tab, where: grouped ? "in Claude's tab group" : "shared with you like the tab it came from" };
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
  async tabs_context_mcp(args, control, request) {
    let group = await findClaudeGroup();
    if (!group && args.createIfEmpty) group = await ensureClaudeGroup();
    const own = group ? await tabsInGroup(group) : [];
    const shared = await sharedTabList();
    const result = own.length || shared.length
      ? formatTabContext(group, own, shared)
      : textResult(`No "${GROUP_TITLE}" tab group exists. Use createIfEmpty: true to create one.`);
    // Tools may not match when the server and extension versions differ;
    // tell the user, who can fix it.
    const mismatch = versionMismatch(request.serverVersion);
    if (mismatch) addNote(result, `Note for the user: ${mismatch}`);
    return result;
  },

  async tabs_create_mcp() {
    const group = await ensureClaudeGroup();
    const tab = await chrome.tabs.create({ windowId: group.windowId, active: true });
    try {
      await chrome.tabs.group({ groupId: group.id, tabIds: [tab.id] });
    } catch (err) {
      // Not left behind as a tab Claude can't use. (Firefox refuses this
      // while a private window is the frontmost one, say.)
      await chrome.tabs.remove(tab.id).catch(() => {});
      throw err;
    }
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
      return errorResult(
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
      return errorResult(`Tab ${args.tabId} is one of Claude's own tabs. Use tabs_close_mcp to close it.`);
    }
    await unshareTab(args.tabId);
    return textResult(`Released tab ${args.tabId}: it's the user's again, and you can't use it anymore.`);
  },

  async set_tab_focus(args, { tab }) {
    await chrome.tabs.update(args.tabId, { active: true });
    if (args.focus_window) await chrome.windows.update(tab.windowId, { focused: true });
    return textResult(
      `Tab ${args.tabId} is now the selected tab in its window${args.focus_window ? ", which is in front of the user's other windows" : ""}.`
    );
  },

  async upload_image(args, control, request) {
    const data = screenshotStore.get(args.imageId);
    if (!data) {
      return errorResult(`Error: there's no screenshot ${args.imageId} (only the 10 most recent are kept). Take a new one.`);
    }
    return putFiles(args, [{ name: args.filename || "screenshot.jpg", type: "image/jpeg", data }], request);
  },

  // file_upload's files, read by the MCP server once the user agreed. With
  // check, whether the ref is a file input that takes `count` files, before
  // the user is asked.
  async upload_files(args, control, request) {
    if (args.check) {
      const resp = await pageMessage(args.tabId, request, { type: "setFiles", ref: args.ref, check: true, count: args.count }, refFrame(args.ref));
      if (resp?.error) return errorResult(`Error: ${resp.error}`);
      if (!resp?.result) return errorResult("Error: the page gave no answer.");
      // (Read by the server: which site, in which tab, gets the files.)
      return textResult(JSON.stringify({ ok: true, origin: resp.result.origin, tabId: args.tabId }));
    }
    return putFiles(args, Array.isArray(args.files) ? args.files : [], request);
  },

  async navigate(args, control, request) {
    const { url, tabId } = args;

    let targetUrl = null;
    if (url !== "back" && url !== "forward") {
      targetUrl = url;
      // Extension pages (this one's share and setup pages, or another
      // add-on's) are off limits: scripting one could act with the
      // extension's own powers, e.g. approve a share request.
      if (/^moz-extension:/i.test(targetUrl)) {
        return errorResult("Claude can't open extension pages (moz-extension: URLs).");
      }
      if (/^javascript:/i.test(targetUrl) && /^moz-extension:/i.test(control?.tab?.url || "")) {
        return errorResult("This tab shows an extension page; navigate it to a web page first.");
      }
      // Web pages only. (Not everything before a colon is a scheme: example.com:8080.)
      const otherScheme = /^(blob|chrome|data|file|ftp|jar|mailto|resource|view-source):/i.exec(targetUrl);
      if (otherScheme) {
        return errorResult(`Claude can't open ${otherScheme[1].toLowerCase()}: URLs, only web pages.`);
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
        return errorResult(`Invalid URL: "${url}". Could not parse as a valid URL.`);
      }
    }

    // Wait for this navigation's "complete", not one still on its way from
    // the page that was loading before: only count it once the tab has
    // started loading again. A jump within the same page (#anchor) doesn't
    // load anything; it's done when the tab shows the requested URL (for
    // back/forward, any new URL). Another add-on can reopen the page in a
    // new tab (see "Tabs another add-on reopens"): that's the one to wait for
    // then, past the blank page it starts with.
    const urlBefore = control?.tab?.url;
    let current = tabId;
    const loaded = new Promise((resolve) => {
      let started = false;
      const listener = (updatedTabId, info, tab) => {
        if (updatedTabId !== current) return;
        if (info.status === "loading") started = true;
        else if (started && info.status === "complete" && (current === tabId || tab.url !== "about:blank")) finish();
        else if (!started && info.url && tab.status === "complete" && (targetUrl === null || info.url === targetUrl)) finish();
      };
      const reopened = (oldId, newId) => {
        if (oldId !== current) return;
        if (newId === null) return finish();
        current = newId;
        started = true;
        chrome.tabs.get(newId).then((tab) => {
          if (tab.status === "complete" && tab.url !== "about:blank") finish();
        }, finish);
      };
      // Closed, and not reopened: nothing more will load.
      const removed = (removedTabId) => {
        if (removedTabId === current) setTimeout(() => removedTabId === current && finish(), REOPEN_WINDOW_MS + 500);
      };
      const finish = () => {
        chrome.tabs.onUpdated.removeListener(listener);
        chrome.tabs.onRemoved.removeListener(removed);
        reopenWaiters.delete(reopened);
        clearTimeout(timer);
        clearTimeout(nothingYet);
        resolve();
      };
      const timer = setTimeout(finish, 10000);
      // Back or forward with nowhere to go does nothing, and says nothing.
      const nothingYet = targetUrl === null && setTimeout(() => {
        if (!started) finish();
      }, 3000);
      chrome.tabs.onUpdated.addListener(listener);
      chrome.tabs.onRemoved.addListener(removed);
      reopenWaiters.add(reopened);
    });

    if (url === "back") {
      await chrome.tabs.goBack(tabId);
    } else if (url === "forward") {
      await chrome.tabs.goForward(tabId);
    } else {
      await chrome.tabs.update(tabId, { url: targetUrl });
    }

    await loaded;

    let tab = await chrome.tabs.get(current).catch(() => null);
    if (!tab) return errorResult("Error: the tab closed before the page finished loading.");
    if (current !== tabId) await currentTabId(tabId); // it has taken the old one's place
    if (targetUrl === null && tab.url === urlBefore && tab.status === "complete") {
      return errorResult(`Nothing happened: this tab has no page to go ${url} to, or that page didn't load. It still shows ${tab.url}.`);
    }
    let busyNote = "";
    if (args.wait === "networkidle") {
      const waited = await networkIdle(current, request);
      if (waited !== true) {
        busyNote = ` (it was still making requests after ${Math.round(waited / 1000)} s more; what it shows may not be complete)`;
      }
    }
    tab = await chrome.tabs.get(current);
    const group = await findClaudeGroup();
    const tabs = group && tab.groupId === group.id ? await tabsInGroup(group) : [tab];
    const loading = tab.status !== "complete" ? " (still loading)" : "";
    const text =
      `Navigated to ${tab.url}${loading}${busyNote}.\n## Pages\n` +
      tabs.map((t, i) => `${i + 1}: ${t.url}${t.id === current ? " [selected]" : ""}`).join("\n");

    return textResult(text);
  },

  async computer(args, { kind }, request) {
    const { action, tabId } = args;

    // Everything that acts on the page goes through here. The tab can stop
    // being Claude's, or the call stop being wanted, between one step and the
    // next; a message gets no longer than the call has left.
    const inPage = (message, frameId = 0) => pageMessage(tabId, request, message, frameId);
    // Mouse messages carry the humanize setting: the page moves the mouse
    // there itself, at a human pace.
    const settings = settingsFor(tabId);
    const humanize = settings.humanize ? settings.humanize_speed : null;
    const atPoint = (message, frameId = 0) => pointMessage(tabId, request, { ...message, humanize }, frameId);

    // Coordinates Claude gives are in screenshot pixels. (Usually CSS pixels:
    // see viewOf.)
    const view = await viewOf(tabId);
    const toPage = (point) => (view.fit === 1 ? point : point.map((v) => Math.round(v / view.fit)));
    const outside = (x, y) => errorResult(
      `Error: (${x}, ${y}) is outside the visible area of the page (${view.imageWidth}x${view.imageHeight}). Scroll first, or click by ref.`
    );

    // A ref is turned into a point on screen. The element is scrolled into
    // view first if needed: coordinates can only reach what's visible.
    let coordinate = args.coordinate; // as Claude knows it
    let point = coordinate ? toPage(coordinate) : null; // in the page
    let startFrame = 0;
    let refNote = "";
    if (args.ref && !coordinate && (action in CLICKS || action === "hover" || action === "scroll")) {
      startFrame = refFrame(args.ref);
      const resp = await inPage({ type: "locateRef", ref: args.ref }, startFrame);
      const loc = resp?.result;
      if (!loc) return errorResult(`Could not resolve ref "${args.ref}" to coordinates.`);
      if (loc.error) return errorResult(`Error: ${loc.error}`);
      point = [loc.x, loc.y];
      coordinate = point.map((v) => Math.round(v * view.fit));
      if (loc.scrolled) refNote += ` (scrolled ${args.ref} into view first)`;
      if (loc.coveredBy) {
        refNote += `. Note: ${loc.coveredBy} is on top of ${args.ref} at that point, so it received the input instead`;
      }
    }
    // Where the result says it acted: a frame's coordinates aren't the page's.
    const at = startFrame ? `on ${args.ref}` : coordinate ? `at (${coordinate[0]}, ${coordinate[1]})` : "";

    const modifiers = modifierBits(args.modifiers);

    switch (action) {
      case "screenshot": {
        const previous = lastScreenshots.get(tabId);
        const { base64, imageId, view: shot } = await takeScreenshot(tabId, request);
        // (Not after a resend: Claude may never have got the one before.)
        if (args.if_changed && previous?.session === request.session && !request.resent && screenshotStore.get(previous.imageId) === base64) {
          screenshotStore.delete(imageId);
          return textResult(`Unchanged: the tab looks exactly as in ${previous.imageId}, so the image was left out.`);
        }
        // Only one Claude got (see handleToolRequest).
        // (Not if the tab closed or went back to the user meanwhile.)
        request.answered = () => {
          if (isControlledNow(tabId)) lastScreenshots.set(tabId, { session: request.session, imageId });
        };
        const size = shot.fit < 1
          ? `${shot.imageWidth}x${shot.imageHeight}, jpeg, of a ${shot.width}x${shot.height} viewport; use this image's pixels as coordinates`
          : `${shot.width}x${shot.height}, jpeg`;
        return {
          content: [
            { type: "text", text: `Successfully captured screenshot (${size}) - ID: ${imageId}` },
            { type: "image", data: base64, mimeType: "image/jpeg" },
          ],
        };
      }

      case "left_click":
      case "right_click":
      case "double_click":
      case "triple_click": {
        if (!coordinate) return errorResult(`Error: coordinate or ref is required for ${action}`);
        const { button, count, verb } = CLICKS[action];
        const resp = await atPoint({
          type: "dispatchMouseClick",
          x: point[0], y: point[1],
          button, clickCount: count, modifiers,
        }, startFrame);
        if (resp.outside) return outside(...coordinate);
        if (resp.error) return errorResult(`Error: ${resp.error}`);
        // Keys go where the click put the focus.
        if (resp.frameId) keyFrames.set(tabId, resp.frameId);
        else keyFrames.delete(tabId);
        let opened = "";
        if (resp.openInNewTab) {
          const { tab, where } = await openLinkInNewTab(tabId, kind, resp.openInNewTab);
          opened = `. The link opens in a new tab: tab ${tab.id} (${resp.openInNewTab}), ${where}`;
        }
        const missed = resp.missed
          ? `. Nothing was there but the page itself (<${resp.missed}>): if you meant an element, check its position in a new screenshot`
          : "";
        return textResult(`${verb} ${at}${refNote}${opened}${missed}`);
      }

      case "hover": {
        if (!coordinate)
          return errorResult("Error: coordinate or ref is required for hover");
        const resp = await atPoint({
          type: "dispatchMouseMove",
          x: point[0], y: point[1], modifiers,
        }, startFrame);
        if (resp.outside) return outside(...coordinate);
        if (resp.error) return errorResult(`Error: ${resp.error}`);
        await sleep(200);
        return textResult(`Hovered ${at}${refNote}`);
      }

      case "type": {
        if (!args.text)
          return errorResult("Error: text is required for type action");
        const frameId = await keyFrame(tabId);
        let inserted = 0;
        let handled = 0; // taken by the page's own key handlers, with no text field focused
        let typed = 0;
        let submitted = false;
        const chars = [...args.text.replace(/\r\n?/g, "\n")];
        // Stops early, saying how far it got: the user took the tab back or
        // cancelled the call, typing all of it would outlast the tool call,
        // or the page stopped answering. The field gets its change event
        // only while the tab is still Claude's and the page answers. When
        // the page didn't confirm a character, it may still have been typed.
        const stopped = async (why, { finishEdit = true, unsure = false } = {}) => {
          if (finishEdit && typed && isControlledNow(tabId)) {
            await sendContentMessage(tabId, { type: "endTyping" }, 2000, frameId).catch(() => {});
          }
          const rest = chars.slice(typed).join("");
          const unsureNote = unsure
            ? ` The next character ("${chars[typed]}") may or may not have been typed: check the field before typing the rest.`
            : "";
          return textResult(
            `Typed the first ${typed} of ${chars.length} characters, then stopped: ${why}.${unsureNote} Still to type: "${rest.substring(0, 50)}${rest.length > 50 ? "..." : ""}" (${rest.length} characters).`
          );
        };
        for (const char of chars) {
          if (!isControlledNow(tabId)) return stopped("the user took this tab back", { finishEdit: false });
          if (request.cancelled) return stopped("the call was cancelled");
          // Typing goes key by key; a long text would outlast the tool call.
          if (Date.now() > request.deadline - TYPING_MARGIN_MS) {
            return stopped("typing all of it would take longer than a tool call may; type the rest with another call");
          }
          let resp;
          try {
            resp = await sendContentMessage(tabId, { type: "typeChar", text: char, key: keyForChar(char) }, stepTimeout(request), frameId);
          } catch (err) {
            return stopped(`the page stopped responding (${err.message})`, { finishEdit: false, unsure: !err.notDone });
          }
          typed++;
          if (resp?.inserted) inserted++;
          if (resp?.handled) handled++;
          submitted ||= !!resp?.submitted;
          // The first key went into no text field, and none has the focus:
          // the rest would only set off the page's shortcuts (one-key ones,
          // on some sites; a handler that took the key may be one).
          if (typed === 1 && chars.length > 1 && !resp?.inserted && resp?.editable === false) {
            const went = resp?.handled ? "the page's own key handlers took it (a shortcut, maybe)" : "it went to the page";
            return errorResult(
              `Sent the first key of "${args.text.substring(0, 50)}${args.text.length > 50 ? "..." : ""}", but no text field had focus, so ${went}, and typing stopped. Click the field first (or use the key action to send keys to the page itself).`
            );
          }
          if (typed < chars.length && (resp?.submitted || resp?.left)) {
            return stopped(resp.submitted ? "Enter submitted the form" : "the focus left the field");
          }
          await sleep(humanize ? typingPause(char, humanize) : 10);
        }
        // Fields announce a finished edit with one change event, as when the
        // user moves on.
        // All of it is typed by now: a page too slow for this last step
        // mustn't turn that into a failure (typing it again would double it).
        let changeNote = "";
        try {
          await sendContentMessage(tabId, { type: "endTyping" }, stepTimeout(request), frameId);
        } catch {
          if (!submitted) changeNote = " (the page didn't answer afterwards, so the field may not have had its change event)";
        }
        const shown = `"${args.text.substring(0, 50)}${args.text.length > 50 ? "..." : ""}"`;
        if (inserted === 0 && handled === 0) {
          return errorResult(
            `Sent the keys for ${shown}, but no text field had focus, so no text was inserted. Click the field first.`
          );
        }
        if (handled) {
          return textResult(
            `Sent the keys for ${shown}; ${handled} of the ${chars.length} went to the page's own key handlers, with no text field focused (an app that takes keys itself, or its shortcuts). Check the page.`
          );
        }
        if (inserted < chars.length) {
          return textResult(
            `Only ${inserted} of the ${chars.length} characters of ${shown} went into a text field: there was none with the focus for the others. Check the field.`
          );
        }
        return textResult(`Typed ${shown}${submitted ? " (Enter submitted the form)" : ""}${changeNote}`);
      }

      case "key": {
        if (!args.text)
          return errorResult("Error: text is required for key action");
        const frameId = await keyFrame(tabId);
        const repeat = Math.min(args.repeat || 1, 100);
        const keys = args.text.split(" ").filter(Boolean);
        const total = repeat * keys.length;
        let pressed = 0;
        let submitted = false;
        const noDefault = new Set(); // keys that only reached the page's handlers
        const stopped = (why, unsure = false) => textResult(
          `Pressed ${pressed} of ${total} keys, then stopped: ${why}.${unsure ? " The next key may or may not have been pressed: check the page before pressing the rest." : ""}`
        );
        for (let r = 0; r < repeat; r++) {
          for (const keyStr of keys) {
            if (!isControlledNow(tabId)) return stopped("the user took this tab back");
            if (request.cancelled) return stopped("the call was cancelled");
            if (Date.now() > request.deadline - TYPING_MARGIN_MS) {
              return stopped("all of them would take longer than a tool call may");
            }
            const { key, code, keyCode, modifiers: keyMod } = parseKeyCombo(keyStr);
            let resp;
            try {
              resp = await sendContentMessage(tabId, {
                type: "dispatchKeyEvent", eventType: "keyDown",
                key, code, keyCode, modifiers: keyMod,
              }, stepTimeout(request), frameId);
            } catch (err) {
              return stopped(`the page stopped responding (${err.message})`, !err.notDone);
            }
            pressed++;
            if (resp?.noDefault) noDefault.add(keyStr);
            submitted ||= !!resp?.submitted;
            try {
              await sendContentMessage(tabId, {
                type: "dispatchKeyEvent", eventType: "keyUp",
                key, code, keyCode, modifiers: keyMod,
              }, stepTimeout(request), frameId);
            } catch (err) {
              // Enter can take the page away: nothing's left to release it
              // in, or to press the rest in.
              if (submitted && pressed === total) break;
              if (submitted) return stopped("Enter submitted the form, and the page went away");
              return stopped(`the page stopped responding while that key was being released (${err.message})`);
            }
            // The page is going: the rest would land on it or the next one.
            if (submitted && pressed < total) return stopped("Enter submitted the form");
            await sleep(humanize ? typingPause(keyStr, humanize) : 30);
          }
        }
        // A field changed by keys gets its change event, as after typing.
        await sendContentMessage(tabId, { type: "endTyping" }, 2000, frameId).catch(() => {});
        const notes = [
          ...(submitted ? [" (Enter submitted the form)"] : []),
          ...(noDefault.size ? [` (${[...noDefault].join(", ")} only reached the page's own key handlers: synthetic keys don't do what they do in Firefox itself, like copying or browser shortcuts)`] : []),
        ];
        return textResult(`Pressed ${total} key${total > 1 ? "s" : ""}: ${args.text}${notes.join("")}`);
      }

      case "scroll": {
        if (!coordinate)
          return errorResult("Error: coordinate is required for scroll");
        const dir = args.scroll_direction || "down";
        const amount = Math.min(args.scroll_amount || 3, 10);
        const deltaX = dir === "left" ? -amount * 100 : dir === "right" ? amount * 100 : 0;
        const deltaY = dir === "up" ? -amount * 100 : dir === "down" ? amount * 100 : 0;
        const outcome = await atPoint({
          type: "dispatchScroll",
          x: point[0], y: point[1],
          deltaX, deltaY, modifiers,
        }, startFrame);
        if (outcome.error) return errorResult(`Error: ${outcome.error}`);
        let note = "";
        if (outcome.unlocked) note = " (the page had scrolling locked; forced overflow:auto on html/body)";
        if (outcome.handledByPage) note = " (the page handled the wheel event itself, e.g. a map or carousel)";
        else if (outcome.moved === false) note += " (nothing scrolled: already at the edge, or nothing scrollable here)";
        await sleep(300);
        const scrolled = `Scrolled ${dir} by ${amount} ticks at (${coordinate[0]}, ${coordinate[1]})${note}`;
        // The scroll happened; a screenshot that fails afterwards doesn't undo it.
        let base64;
        try {
          ({ base64 } = await takeScreenshot(tabId, request, { keep: false }));
        } catch (err) {
          return textResult(`${scrolled}. No screenshot afterwards: ${err.message}.`);
        }
        return {
          content: [
            { type: "text", text: scrolled },
            { type: "image", data: base64, mimeType: "image/jpeg" },
          ],
        };
      }

      case "scroll_to": {
        if (!coordinate && !args.ref)
          return errorResult("Error: coordinate or ref is required for scroll_to");
        if (args.ref) {
          const resp = await inPage({ type: "scrollToRef", ref: args.ref }, refFrame(args.ref));
          if (resp?.error) return errorResult(`Error: ${resp.error}`);
        }
        if (coordinate) {
          await inPage({
            type: "scrollToPosition",
            x: coordinate[0], y: coordinate[1],
          });
        }
        await sleep(300);
        return textResult("Scrolled to target");
      }

      case "wait": {
        const duration = Math.min(args.duration ?? 1, 30);
        await sleep(duration * 1000);
        return textResult(`Waited for ${duration} second${duration !== 1 ? "s" : ""}`);
      }

      case "left_click_drag": {
        if (!args.start_coordinate || !coordinate) {
          return errorResult("Error: start_coordinate and coordinate are required for left_click_drag");
        }
        const [sx, sy] = args.start_coordinate;
        const [ex, ey] = coordinate;
        const [startX, startY] = toPage(args.start_coordinate);
        const resp = await atPoint({
          type: "dispatchDrag",
          startX, startY, endX: point[0], endY: point[1], modifiers,
        });
        if (resp.outside) return outside(sx, sy);
        if (resp.error) return errorResult(`Error: ${resp.error}`);
        const dropNote = resp.dropped === false ? " (a browser drag: the page didn't accept the drop there)" : "";
        return textResult(`Dragged from (${sx}, ${sy}) to (${ex}, ${ey})${dropNote}`);
      }

      case "zoom": {
        if (!args.region || args.region.length !== 4) {
          return errorResult("Error: region [x0, y0, x1, y1] is required for zoom");
        }
        const region = args.region.map(Number);
        if (!region.every(Number.isFinite) || region[2] <= region[0] || region[3] <= region[1]) {
          return errorResult("Error: region must be numbers with x1 > x0 and y1 > y0");
        }
        const [x0, y0, x1, y1] = toPage(region);
        // captureVisibleTab's rect is in page coordinates, so add the scroll
        // offset. A page busy with a script can't answer: not waited for long.
        const offsets = await Promise.race([
          chrome.scripting.executeScript({
            target: { tabId },
            func: () => ({ scrollX: window.scrollX, scrollY: window.scrollY }),
          }),
          sleep(3000).then(() => null),
        ]);
        const scrolled = offsets?.[0]?.result;
        if (!scrolled) return errorResult("Error: the page didn't respond (it may be busy, e.g. with a script that's still running), so the region can't be located.");
        // The rect must be whole pixels (scroll offsets can be fractional on
        // scaled displays); round outwards so the whole region is covered.
        const left = Math.floor(scrolled.scrollX + x0);
        const top = Math.floor(scrolled.scrollY + y0);
        const width = Math.ceil(scrolled.scrollX + x1) - left;
        const height = Math.ceil(scrolled.scrollY + y1) - top;
        // Render the region at up to 4x so it fills roughly a viewport's width.
        const scale = Math.min(4, Math.max(1, view.imageWidth / width));
        const { base64 } = await takeScreenshot(tabId, request, {
          rect: { x: left, y: top, width, height },
          scale,
          keep: false,
        });
        return {
          content: [
            { type: "text", text: `Zoomed into region [${args.region.join(", ")}] at ${scale.toFixed(1)}x` },
            { type: "image", data: base64, mimeType: "image/jpeg" },
          ],
        };
      }

      default:
        return errorResult(`Error: unknown computer action: ${action}`);
    }
  },

  async read_page(args, control, request) {
    const { tabId } = args;
    const message = {
      type: "generateAccessibilityTree",
      options: {
        filter: args.filter,
        depth: args.depth,
        max_chars: args.max_chars,
        ref_id: args.ref_id,
      },
    };

    const resp = await sendContentMessage(tabId, message, stepTimeout(request), refFrame(args.ref_id));
    if (resp?.error) return errorResult(`Error: ${resp.error}`);
    if (typeof resp?.result !== "string") return errorResult("Error: Could not generate accessibility tree");
    let tree = resp.result;

    // The frames on the page, unless a part of the page was asked for.
    if (!args.ref_id) {
      for (const { frame, resp: inner } of await askFrames(tabId, await shownFrames(tabId), message)) {
        if (inner?.result?.trim()) tree += `\n--- frame ${frame.frameId} ---\n${inner.result}`;
      }
    }
    const maxChars = args.max_chars || 50000;
    if (tree.length > maxChars) {
      tree = `${tree.slice(0, maxChars)}\n... (truncated: use a smaller depth, or ref_id to read one part of the page)`;
    }
    if (!tree.trim()) {
      tree = args.filter === "interactive" ? "This page has no interactive elements to show." : "This page has nothing to show.";
    }
    const { imageWidth, imageHeight } = await viewOf(tabId);
    const viewport = `\n\nViewport: ${imageWidth}x${imageHeight}`;
    // Only what changed, if that was asked for and makes sense: the same page
    // and options as last time, neither of them cut short.
    const sameRead = JSON.stringify([control.tab.url, args.filter, args.depth, args.max_chars, args.ref_id]);
    const previous = lastTrees.get(tabId);
    const whole = !/\n\.\.\. \(truncated/.test(tree);
    // Compared only with a read Claude got (see screenshot's if_changed).
    request.answered = () => {
      if (isControlledNow(tabId)) lastTrees.set(tabId, whole ? { session: request.session, sameRead, tree } : null);
    };
    if (args.delta && whole && !request.resent && previous?.session === request.session && previous.sameRead === sameRead) {
      const changes = treeChanges(previous.tree, tree);
      if (changes !== null) return textResult(`${changes}${viewport}`);
    }
    return textResult(`${tree}${viewport}`);
  },

  async get_page_text(args, control, request) {
    const { tabId } = args;

    const resp = await sendContentMessage(tabId, { type: "getPageText" }, stepTimeout(request));
    if (!resp?.result) return errorResult("Error: Could not extract page text");

    let data;
    try {
      data = JSON.parse(resp.result);
    } catch {
      return textResult(resp.result);
    }
    let text = data.text;
    if (data.fullLength > text.length) {
      text += `\n… (cut at ${text.length} of ${data.fullLength} characters)`;
    }
    for (const { frame, resp: inner } of await askFrames(tabId, await shownFrames(tabId), { type: "getPageText" })) {
      try {
        const framed = JSON.parse(inner?.result);
        if (framed.text) text += `\n\n--- frame ${frame.frameId} (${framed.url}) ---\n${framed.text}`;
      } catch {}
    }
    return textResult(`Title: ${data.title}\nURL: ${data.url}\nSource: <${data.sourceTag}>\n\n${text}`);
  },

  async find(args, control, request) {
    const { query, tabId } = args;

    const message = { type: "findElements", query };
    const resp = await sendContentMessage(tabId, message, stepTimeout(request));
    const inFrames = await askFrames(tabId, await shownFrames(tabId), message);
    const { fit } = await viewOf(tabId);

    // In the coordinates of the screenshot, wherever they were found. Each
    // document ranks its own; across them, those with the most of the query's
    // words that say which element it is come first (see findElements).
    const answers = [{ frame: { x: 0, y: 0 }, resp }, ...inFrames].filter((a) => a.resp?.result?.found);
    const tier = Math.max(0, ...answers.map((a) => a.resp.result.tier || 0));
    const all = answers
      .filter((a) => (a.resp.result.tier || 0) === tier)
      .flatMap(({ frame, resp: answer }) => answer.result.found.map((r) => ({
        ...r, coordinates: [Math.round((r.coordinates[0] + frame.x) * fit), Math.round((r.coordinates[1] + frame.y) * fit)],
      })))
      .sort((a, b) => (b.score || 0) - (a.score || 0) || (b.interactive ? 1 : 0) - (a.interactive ? 1 : 0));
    const results = all.slice(0, 20);

    if (results.length === 0) {
      return textResult(`No elements found matching "${query}"`);
    }

    let text = `Found ${results.length} element(s) matching "${query}":\n\n`;
    for (const r of results) {
      const at = r.hidden ? "(hidden: give its ref to upload_image or file_upload)" : `at (${r.coordinates[0]}, ${r.coordinates[1]})`;
      text += `[${r.ref}] ${r.role} "${r.name}" ${at}${r.offscreen ? " (off-screen: click it by ref, or scroll first)" : ""}\n`;
    }
    const more = all.length > results.length || resp?.result?.more || inFrames.some(({ resp: inner }) => inner?.result?.more);
    if (more) text += "\nMore elements match; these are the best 20. Use a more specific query.\n";

    return textResult(text);
  },

  async form_input(args, control, request) {
    const { ref, value, tabId } = args;

    const resp = await sendContentMessage(tabId, { type: "setFormValue", ref, value }, stepTimeout(request), refFrame(ref));
    const result = resp?.result;

    if (result?.error) return errorResult(`Error: ${result.error}`);
    if (!result) return errorResult("Error: the page gave no answer, so it's not known whether the value was set.");
    return textResult(`Set ${ref} to "${value}". Result: ${JSON.stringify(result)}`);
  },

  async javascript_tool(args, control, request) {
    const { text, tabId } = args;
    const seconds = jsTimeoutSeconds(args.timeout);
    const deadline = Math.min(Date.now() + seconds * 1000, request.deadline);

    let outcome;
    try {
      outcome = await Promise.race([runJavascript(tabId, text, deadline), sleep(deadline - Date.now()).then(() => null)]);
    } catch (e) {
      return errorResult(`Error: ${await withPermissionHelp(errorText(e))}`);
    }
    if (!outcome || outcome.timedOut) {
      return errorResult(
        `Error: the script didn't finish within ${seconds}s. It may still be running in the page: Firefox can't stop it from here, so navigate or reload the tab if the page is stuck.`
      );
    }
    return formatJavascriptOutcome(outcome);
  },

  async read_console_messages(args) {
    const { tabId, pattern, onlyErrors, clear } = args;
    const limit = args.limit >= 1 ? args.limit : 100;

    const res = await callPageHooks(tabId, { read: "logs", report: false });
    if (!res) return textResult("No console messages: Firefox doesn't let extensions script this page.");
    if (res.busy) return errorResult("Error: the page didn't answer in time; it may be busy, e.g. with a script that's still running.");

    // A page can write what its hooks recorded (see describeDialogs).
    let logs = res.logs.slice(-MAX_LOGS_READ).map((m) => ({
      id: m.id,
      level: LOG_LEVELS.has(m.level) ? m.level : "log",
      text: String(m.text ?? "").slice(0, MAX_LOG_TEXT),
      url: String(m.url ?? "").slice(0, MAX_LOG_URL),
    }));
    if (onlyErrors) logs = logs.filter((m) => m.level === "error" || m.level === "exception");
    if (typeof pattern === "string" && pattern) {
      logs = await filterByPattern(logs, pattern);
      if (!logs) return errorResult(`Error: the pattern took too long to match (it was stopped after ${PATTERN_TIMEOUT_MS / 1000} s). Use a simpler one.`);
    }
    const msgs = logs.slice(-limit);
    if (clear && msgs.length) await callPageHooks(tabId, { clearLogs: msgs.map((m) => m.id), report: false });

    if (msgs.length === 0) {
      return textResult("No console messages matching the pattern.");
    }

    const text = msgs
      // Credentials are hidden as in javascript_tool's results.
      .map((m) => `[${m.level}] ${redactString(m.text)}${m.url ? ` (${redactTokens(m.url)})` : ""}`)
      .join("\n");

    return textResult(`Console messages (${msgs.length}):\n${text}`);
  },

  async read_network_requests(args) {
    const { tabId, urlPattern, clear } = args;
    const limit = args.limit >= 1 ? args.limit : 100;

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

    const status = (r) => {
      if (r.status === -1) return `→ failed${r.error ? `: ${r.error}` : ""}`;
      return r.status ? `→ ${r.status}` : "(pending)";
    };
    const text = reqs
      .map((r) => `${r.method} ${redactTokens(r.url)} ${status(r)}${r.mimeType ? ` [${r.mimeType}]` : ""}`)
      .join("\n");

    return textResult(`Network requests (${reqs.length}):\n${text}`);
  },

  async resize_window(args, { tab, kind }) {
    const { width, height } = args;
    if (kind === "shared") {
      // The window holds the user's other tabs too, which they didn't share.
      return errorResult(
        "This tab is in one of the user's windows, which holds their other tabs too, so it keeps its size. To resize, ask the user to hand the tab over with tabs_request_handover: it moves into Claude's own window."
      );
    }
    // The user can move Claude's group into one of their windows: then the
    // window holds their tabs too.
    const others = (await chrome.tabs.query({ windowId: tab.windowId })).filter((t) => t.groupId !== tab.groupId);
    if (others.length) {
      return errorResult(
        "Error: Claude's tab group is in a window that holds the user's own tabs too, so the window keeps its size. Ask the user to move Claude's group to a window of its own (or resize it themselves)."
      );
    }
    // (Out of "maximized", or the size wouldn't change. The size it ends up
    // with can differ: a window has a minimum, and only so much screen.)
    await chrome.windows.update(tab.windowId, { state: "normal", width, height });
    await sleep(100);
    const now = await chrome.windows.get(tab.windowId);
    const differs = now.width !== width || now.height !== height;
    return textResult(`Resized window to ${now.width}x${now.height}${differs ? ` (${width}x${height} was asked for)` : ""}`);
  },

  async handle_dialog(args) {
    const { tabId, accept, promptText } = args;
    const nextAnswer = { accept: !!accept, promptText: promptText ?? null };
    // The page itself, not its frames: an answer armed in every frame would
    // answer a confirm in each of them.
    const res = await callPageHooks(tabId, { nextAnswer, report: false }, 0);
    if (!res) return errorResult("Error: this page can't be scripted, so its dialogs can't be handled.");
    const what = accept ? `accepted${promptText !== undefined ? ` with "${promptText}"` : ""}` : "cancelled";
    if (res.busy) {
      return errorResult(
        `The page is busy and didn't answer. This takes effect once it's free: its next confirm or prompt will then be ${what}. Call handle_dialog again to change that.`
      );
    }
    return textResult(`The next confirm or prompt on this page itself (not in a frame) will be ${what}. Alerts are always acknowledged.`);
  },

  async gif_creator(args) {
    return errorResult("GIF recording isn't implemented in this extension.");
  },

  async shortcuts_list(args) {
    return errorResult("Shortcuts aren't supported in this extension.");
  },

  async shortcuts_execute(args) {
    return errorResult("Shortcuts aren't supported in this extension.");
  },

  async switch_browser(args) {
    return errorResult("Switching browsers isn't supported. The extension connects to whichever Firefox has it loaded.");
  },

  async update_plan(args) {
    const { domains, approach } = args;
    let text = `Plan:\n\nDomains: ${domains.join(", ")}\n\nApproach:\n`;
    for (const step of approach) {
      text += `- ${step}\n`;
    }
    text += "\nNoted. The user wasn't shown this: this extension has no approval step and no domain restrictions, so tell them in the conversation if they should see it.";
    return textResult(text);
  },

  async debug(args) {
    const limit = Math.min(Math.max(1, args.limit || 100), 1000);
    const since = typeof args.since_ms === "number" ? Date.now() - args.since_ms : -Infinity;
    const filter = typeof args.filter === "string" ? args.filter.toLowerCase() : "";
    const matching = debugLog.filter((e) =>
      e.at >= since &&
      (!args.kind || e.kind === args.kind) &&
      (args.tabId === undefined || e.tabId === args.tabId) &&
      (!filter || e.text.toLowerCase().includes(filter))
    );
    const shown = matching.slice(-limit);
    const reach = debugLog.length ? `${Math.round((Date.now() - debugLog[0].at) / 1000)} s` : "nothing yet";
    const head = `${shown.length} of ${matching.length} matching events. The list goes back ${reach}` +
      `${debugDropped ? `; ${debugDropped} older events were dropped` : ""}, and starts over when the extension restarts.`;
    const lines = shown.map((e) => {
      const ago = ((Date.now() - e.at) / 1000).toFixed(1);
      return `-${ago}s [${e.kind}]${e.tabId !== null ? ` tab ${e.tabId}` : ""}: ${e.text}`;
    });
    if (args.clear) {
      debugLog.length = 0;
      debugDropped = 0;
    }
    return textResult([head, ...lines].join("\n"));
  },

  async get_config(args) {
    const lines = ["Settings for every tab:", JSON.stringify(configForAll)];
    if (configForTabs.size) {
      lines.push("Set for single tabs:", JSON.stringify(Object.fromEntries(configForTabs)));
    }
    if (args.tabId !== undefined) lines.push(`What applies to tab ${args.tabId}:`, JSON.stringify(settingsFor(args.tabId)));
    lines.push("The settings:");
    for (const [key, setting] of Object.entries(SETTINGS)) {
      const values = setting.values ? `one of ${setting.values.map((v) => `"${v}"`).join(", ")}` : setting.type;
      lines.push(`- ${key} (${values}, default ${JSON.stringify(setting.default)}): ${setting.about}`);
    }
    return textResult(lines.join("\n"));
  },

  async set_config(args) {
    if (args.tabId !== undefined && !(await chrome.tabs.get(args.tabId).catch(() => null))) {
      return errorResult(`Error: there's no tab ${args.tabId}. Use tabs_context_mcp to see the tabs.`);
    }
    const setting = SETTINGS[args.key];
    if (!setting) return errorResult(`Error: there's no setting "${args.key}". The settings: ${Object.keys(SETTINGS).join(", ")}.`);
    const { value } = args;
    if (value !== null && (typeof value !== setting.type || (setting.values && !setting.values.includes(value)))) {
      return errorResult(`Error: ${args.key} takes ${setting.values ? setting.values.map((v) => `"${v}"`).join(", ") : `a ${setting.type}`}, or null.`);
    }
    if (args.tabId !== undefined) {
      const own = { ...(configForTabs.get(args.tabId) || {}) };
      if (value === null) delete own[args.key];
      else own[args.key] = value;
      if (Object.keys(own).length) configForTabs.set(args.tabId, own);
      else configForTabs.delete(args.tabId);
      saveTabConfig();
    } else {
      configForAll = { ...configForAll };
      if (value === null) delete configForAll[args.key];
      else configForAll[args.key] = value;
      await chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: configForAll }).catch(() => {});
    }
    const where = args.tabId !== undefined ? `tab ${args.tabId}` : "every tab";
    return textResult(`${args.key} is ${value === null ? `back to its default for ${where}` : `${JSON.stringify(value)} for ${where}`}. Now applying${args.tabId !== undefined ? ` to tab ${args.tabId}` : " by default"}: ${JSON.stringify(settingsFor(args.tabId))}`);
  },
};

// The last screenshot of each tab, for screenshot's if_changed, and the last
// read_page of each, for its delta. Several Claude sessions can use a tab:
// each compares only with what it got itself (see sessionOf).
const lastScreenshots = new Map(); // tabId -> { session, imageId }
const lastTrees = new Map(); // tabId -> { session, sameRead, tree }

// What changed from one read_page to the next, line by line: "- " lines are
// gone, "+ " lines are new, "@@ line N @@" says where in the new tree. null
// when most of it changed, or it's too large to compare: then the whole tree
// says more.
const MAX_TREE_COMPARE = 4000000; // lines × lines compared at most

function treeChanges(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) return "Unchanged since your last read_page of this tab.";
  const n = endA - start;
  const m = endB - start;
  if (n * m > MAX_TREE_COMPARE) return null;
  // The longest common subsequence of the lines that differ, table filled
  // from the end.
  const width = m + 1;
  const common = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      common[i * width + j] = a[start + i] === b[start + j]
        ? common[(i + 1) * width + j + 1] + 1
        : Math.max(common[(i + 1) * width + j], common[i * width + j + 1]);
    }
  }
  const out = [];
  let changed = 0;
  let hunkOpen = false;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) {
      hunkOpen = false;
      i++;
      j++;
      continue;
    }
    if (!hunkOpen) {
      out.push(`@@ line ${start + j + 1} @@`);
      hunkOpen = true;
    }
    if (j < m && (i === n || common[i * width + j + 1] >= common[(i + 1) * width + j])) {
      out.push(`+ ${b[start + j]}`);
      j++;
    } else {
      out.push(`- ${a[start + i]}`);
      i++;
    }
    changed++;
  }
  if (changed > b.length / 2) return null;
  return `Changes since your last read_page of this tab:\n${out.join("\n")}`;
}

// navigate's wait: "networkidle": no request still going for half a second.
// Requests running longer than LONG_REQUEST_MS (long polling, streams) don't
// count, and neither do WebSockets.
const NETWORK_QUIET_MS = 500;
const NETWORK_IDLE_MAX_MS = 15000;
const LONG_REQUEST_MS = 10000;

// True once it's quiet, or how long it waited (ms) when it stopped waiting:
// at the limit, or when the call ends (cancelled, out of time, tab lost).
async function networkIdle(tabId, request) {
  const began = Date.now();
  const until = Math.min(began + NETWORK_IDLE_MAX_MS, request.deadline - 2000);
  let quietSince = began;
  while (Date.now() < until && !stopReason(tabId, request)) {
    const now = Date.now();
    const busy = (networkRequests.get(tabId) || []).some(
      (r) => r.status === 0 && r.type !== "websocket" && now - r.timestamp < LONG_REQUEST_MS
    );
    if (busy) quietSince = now;
    else if (now - quietSince >= NETWORK_QUIET_MS) return true;
    await sleep(100);
  }
  return Date.now() - began;
}

const DROP_MARGIN_MS = 1000;

// A drop of files at a point in a frame (in its CSS pixels), made in the
// page's own world: a page only sees the files of a DataTransfer it made
// itself (Firefox leaves out those a content script put in one). Too late
// once the call has given up on it.
async function dropInPage(tabId, frameId, x, y, files, request) {
  const reason = stopReason(tabId, request);
  if (reason) return { error: `${reason}, so nothing was dropped` };
  const timeout = stepTimeout(request);
  const run = chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: "MAIN",
    func: (x, y, files, deadline) => {
      if (Date.now() > deadline) return { error: "the page was too busy to take the drop in time" };
      let el = document.elementFromPoint(x, y);
      while (el?.shadowRoot) {
        const inner = el.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === el) break;
        el = inner;
      }
      if (!el) return { error: "there's nothing at that point to drop on" };
      const dataTransfer = new DataTransfer();
      for (const { name, type, data } of files) {
        const binary = atob(data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        dataTransfer.items.add(new File([bytes], name, { type }));
      }
      const init = {
        bubbles: true, cancelable: true, composed: true, view: window,
        clientX: x, clientY: y, screenX: (window.mozInnerScreenX ?? window.screenX) + x, screenY: (window.mozInnerScreenY ?? window.screenY) + y,
        dataTransfer,
      };
      const fire = (type) => el.dispatchEvent(new DragEvent(type, init));
      fire("dragenter");
      const dropped = !fire("dragover");
      fire(dropped ? "drop" : "dragleave");
      return { dropped };
    },
    args: [x, y, files, Date.now() + timeout - DROP_MARGIN_MS],
  }).then(([res]) => res?.result ?? { error: res?.error ? errorText(res.error) : "the page gave no answer" }, (err) => ({ error: err.message }));
  return Promise.race([run, sleep(timeout).then(() => ({ error: "the page didn't take the drop in time" }))]);
}

// upload_image and file_upload: files given to a file input (by ref) or
// dropped on a page element (at a point, in screenshot pixels).
async function putFiles(args, files, request) {
  const { tabId } = args;
  if (!files.length) return errorResult("Error: there are no files to upload.");
  if (args.ref && !args.coordinate) {
    const resp = await pageMessage(tabId, request, { type: "setFiles", ref: args.ref, files }, refFrame(args.ref));
    if (resp?.error) return errorResult(`Error: ${resp.error}`);
    if (!resp?.result) return errorResult("Error: the page gave no answer, so it's not known whether the files were set.");
    return textResult(`Put ${resp.result.names.join(", ")} in the file input ${args.ref}.`);
  }
  if (Array.isArray(args.coordinate) && args.coordinate.length === 2) {
    const { fit } = await viewOf(tabId);
    const [x, y] = args.coordinate.map((v) => (fit === 1 ? v : Math.round(v / fit)));
    const at = await pointMessage(tabId, request, { type: "dropFiles", x, y });
    if (at.outside) return errorResult(`Error: (${args.coordinate.join(", ")}) is outside the visible area of the page.`);
    if (at.error) return errorResult(`Error: ${at.error}`);
    const resp = await dropInPage(tabId, at.frameId, at.x, at.y, files, request);
    if (resp.error) return errorResult(`Error: ${resp.error}`);
    if (!resp.dropped) return errorResult(`Error: nothing at (${args.coordinate.join(", ")}) takes files dropped on it (the page didn't accept the drop).`);
    return textResult(`Dropped ${files.map((f) => f.name).join(", ")} at (${args.coordinate.join(", ")}).`);
  }
  return errorResult("Error: give ref (a file input) or coordinate (where to drop it).");
}

// The pause after a typed character or a pressed key, with humanize on: a
// human rhythm, slower after a space or punctuation, now and then a pause.
const TYPING_PACE = { fast: 45, natural: 95, relaxed: 165 };

function typingPause(typed, speed) {
  const base = TYPING_PACE[speed] || TYPING_PACE.natural;
  let pause = base * (0.55 + Math.random() * 0.9);
  if (/^[\s.,;:!?]$/.test(typed)) pause += base * Math.random() * 1.5;
  if (Math.random() < 0.04) pause += base * (2 + Math.random() * 4);
  return Math.round(pause);
}

// The frame keys go to: the one last clicked in, while it's still there.
async function keyFrame(tabId) {
  const frameId = keyFrames.get(tabId) ?? 0;
  if (!frameId) return 0;
  const there = await sendContentMessage(tabId, { type: "listFrames" }, FRAME_TIMEOUT_MS, frameId).catch(() => null);
  if (there) return frameId;
  keyFrames.delete(tabId);
  return 0;
}

// read_console_messages's pattern is matched in a worker (lib/pattern-worker.js),
// which is stopped if it takes too long: nothing else can stop a regular
// expression, and one can take forever, in the page or here alike. Resolves
// the messages that match, or null if it took too long.
const PATTERN_TIMEOUT_MS = 2000;
const LOG_LEVELS = new Set(["log", "info", "warn", "error", "debug", "exception"]);
const MAX_LOGS_READ = 5000;
const MAX_LOG_TEXT = 4100;
const MAX_LOG_URL = 2000;

function filterByPattern(logs, pattern) {
  return new Promise((resolve) => {
    let worker;
    const done = (matching) => {
      clearTimeout(timer);
      worker?.terminate();
      resolve(matching);
    };
    const timer = setTimeout(() => done(null), PATTERN_TIMEOUT_MS);
    const asText = () => done(logs.filter((m) => m.text.includes(pattern)));
    try {
      worker = new Worker(chrome.runtime.getURL("lib/pattern-worker.js"));
    } catch {
      asText();
      return;
    }
    worker.onmessage = ({ data }) => done(logs.filter((m, i) => data[i]));
    worker.onerror = asText;
    worker.postMessage({ pattern, messages: logs.map(({ text, level }) => ({ text, level })) });
  });
}

// Tools that act on one tab, which must be Claude's or shared with Claude.
const TAB_TOOLS = new Set([
  "navigate", "computer", "read_page", "get_page_text", "find", "form_input",
  "javascript_tool", "read_console_messages", "read_network_requests",
  "resize_window", "handle_dialog", "tabs_close_mcp", "tabs_release",
  "set_tab_focus", "upload_image", "upload_files",
]);
// Of those, the ones that work inside the page.
const PAGE_TOOLS = new Set([
  "navigate", "computer", "read_page", "get_page_text", "find", "form_input",
  "javascript_tool", "read_console_messages", "handle_dialog", "upload_image", "upload_files",
]);

// --- Tool dispatch ---
// The MCP server gives up on a call after 60 s. A tool here stops a little
// before, so that its answer, and the cleanup after it, still arrive. The
// time counts from when the request arrived.
const TOOL_DEADLINE_MS = 55000;
const TYPING_MARGIN_MS = 3000; // type and key stop this long before the deadline
const MIN_BUDGET_MS = 1000; // a call resent with less than this isn't started
// A server resends a call 5 s after the connection dropped; one not resent
// by this long after is stopped (see connectToServer).
const ORPHANED_AFTER_MS = 10000;

// Which Claude session a request comes from: its id is the session's
// server's prefix and a number, and for a session another one forwards,
// that one's prefix and the session's own in front ("c<prefix>-<n>_").
function sessionOf(id) {
  return String(id).replace(/-\d+$/, "");
}

// timeLeft: how long the server still waits for this call (from 2.1.0 on);
// a resent call has less than a new one.
async function handleToolRequest(id, tool, args, serverVersion, resent, timeLeft) {
  const handler = toolHandlers[tool];
  if (!handler) {
    sendError(id, `Unknown tool: ${tool}`);
    return;
  }
  // What a tool knows about its call: the server that sent it, when it must
  // be done by, and whether the user cancelled it (see cancelRequest).
  const budget = typeof timeLeft === "number"
    ? Math.max(0, Math.min(TOOL_DEADLINE_MS, timeLeft - (60000 - TOOL_DEADLINE_MS)))
    : TOOL_DEADLINE_MS;
  const request = { serverVersion, session: sessionOf(id), deadline: Date.now() + budget, budget, cancelled: false, resent };
  await stateReady;

  // A request the server sent again after the connection dropped (see
  // "Not running a request twice"). Only those are looked up: servers
  // before 2.1.0 start their ids over when they restart.
  if (resent && runningRequests.has(id)) {
    runningRequests.get(id).lostAt = 0; // its server is back (see connectToServer)
    return; // still running here: that run answers
  }
  const journaled = !isRepeatable(tool, args);
  if (journaled && resent) {
    const seen = journal.get(id);
    if (seen) {
      answerFromJournal(id, tool, args, seen);
      return;
    }
  }

  // Resent with no time left to speak of: started now, it would still be
  // acting on the page after Claude was told the call failed.
  if (budget < MIN_BUDGET_MS) {
    sendError(id, `${tool} wasn't run: the connection dropped, and it came back with no time left for this call. If an earlier attempt may have reached the page, check whether it took effect before repeating it.`);
    return;
  }

  // Running from here on, before anything else is awaited: an update waits
  // for it, and a resend arriving meanwhile doesn't start it a second time.
  // (It still counts as running until its answer is sent: an update that
  // waits for it mustn't reload in between.)
  runningRequests.set(id, request);
  toolCallsRunning++;
  const started = Date.now();
  if (tool !== "debug") debugEvent("tool", args.tabId, `${tool} ${describeArguments(tool, args)}${resent ? " (sent again)" : ""}`);
  try {
    let outcome;
    try {
      if (journaled) {
        journal.set(id, { tool, state: "started", at: Date.now() });
        await saveJournal();
      }
      outcome = { result: await runTool(tool, handler, args, request) };
    } catch (err) {
      outcome = { error: `${tool} failed: ${await withPermissionHelp(err.message)}` };
    } finally {
      runningRequests.delete(id);
    }
    if (journaled) {
      journal.set(id, { tool, state: "done", at: Date.now(), ...keptOutcome(tool, args, outcome) });
      await saveJournal();
    }
    if (tool !== "debug") {
      const summary = outcome.error ?? outcome.result?.content?.find((item) => item?.type === "text")?.text ?? "";
      const verdict = outcome.error || outcome.result?.isError ? "failed" : "done";
      // Not the result where it repeats what was typed, pressed, entered in
      // a form or given a prompt (see PRIVATE_ARGUMENTS).
      const shown = hidesInput(tool, args) ? "" : `: ${summary.split("\n")[0].slice(0, 200)}`;
      debugEvent("tool", args.tabId, `${tool} ${verdict} in ${Date.now() - started} ms${shown}`);
    }
    if (outcome.error) sendError(id, outcome.error);
    // What a tool keeps of what Claude got (request.answered), only if
    // Claude got it: not cancelled, in time, and sent.
    else if (sendResponse(id, outcome.result) && !request.cancelled && Date.now() < request.deadline) request.answered?.();
  } finally {
    toolCallsRunning--;
    reloadIfIdle();
  }
}

// The user cancelled the call in Claude. Tools that go step by step (typing,
// keys) stop before the next step; what already happened stays done.
// A cancel can come while the call still waits for the stored state; it
// waits for it too, and so finds the call running.
function cancelRequest(id) {
  stateReady.then(() => {
    const request = runningRequests.get(id);
    if (request) request.cancelled = true;
  });
}

async function runTool(tool, handler, args, request) {
  if (!TAB_TOOLS.has(tool) || typeof args.tabId !== "number") return runInTab(tool, handler, args, request);
  // A tab another add-on reopened goes by its new id, also one that's being
  // reopened just now (closed, and the new one not matched with it yet).
  let tabId = await currentTabId(args.tabId);
  const reopening = await reopenedAs(tabId, request.deadline);
  if (reopening !== null) tabId = await currentTabId(reopening);
  let result;
  try {
    result = await runInTab(tool, handler, { ...args, tabId }, request);
  } catch (err) {
    // The tab went from under the tool: it may have been reopened.
    const reopened = await reopenedAs(tabId, request.deadline);
    if (reopened === null) throw err;
    result = errorResult(`Error: ${err.message}. ${reopenedNote(tabId, reopened)} Check there whether this was done before repeating it.`);
  }
  // (Not in the upload check's answer: the server reads the tab from it, and
  // the upload after it gets the note.)
  if (tabId !== args.tabId && result?.content && !(tool === "upload_files" && args.check)) {
    // Reopened again during the call, the note about that has the id to use;
    // a tab that's gone, or isn't Claude's, isn't one to use.
    const now = await currentTabId(tabId);
    addNote(result, now === tabId && isControlledNow(tabId)
      ? `This ran in tab ${tabId}. ${reopenedNote(args.tabId, tabId)}`
      : `This was for tab ${tabId}: tab ${args.tabId} had been reopened as tab ${tabId} before.`);
  }
  return result;
}

async function runInTab(tool, handler, args, request) {
  let finish = null;
  // Why a tool can't work in the tab as it is now, if there's a reason.
  const refused = (control) => {
    if (!control.tab) {
      return errorResult(`Tab ${args.tabId} doesn't exist anymore. Use tabs_context_mcp to see the tabs you can use.`);
    }
    if (!control.kind) {
      return errorResult(
        `Tab ${args.tabId} isn't in Claude's tab group and the user hasn't shared it. Use tabs_context_mcp to see the tabs you can use, or tabs_request_access to ask the user to share one of theirs.`
      );
    }
    // A tab can still show an extension page (dragged into the group, or
    // opened by the user): only navigating away is allowed there.
    if (PAGE_TOOLS.has(tool) && tool !== "navigate" && /^moz-extension:/i.test(control.tab.url || "")) {
      return errorResult(`Tab ${args.tabId} shows an extension page, which Claude can't use. Navigate it to a web page first.`);
    }
    return null;
  };
  try {
    let control = null;
    if (TAB_TOOLS.has(tool)) {
      control = await tabControl(args.tabId);
      const no = refused(control);
      if (no) return no;
      if (PAGE_TOOLS.has(tool)) {
        finish = await startPageWork(args.tabId, control.kind, request);
        // That waits seconds for a busy page. A lot can change meanwhile, and
        // nothing has happened yet: this is the moment to stop.
        control = await tabControl(args.tabId);
        const noLonger = refused(control);
        if (noLonger) return noLonger;
        const reason = stopReason(args.tabId, request);
        if (reason) return errorResult(`Error: ${reason}, so this wasn't done.`);
        if (control.kind === "own" && !control.tab.active) await showInClaudesWindow(control.tab);
      }
    }
    // A tool that's still going at the deadline is answered for anyway; its
    // messages to the page expire with it (see sendContentMessage).
    let timer;
    const overtime = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(
        `it was still running after ${Math.round(request.budget / 1000)} s. It may have been done partly or fully: check whether it took effect before repeating it, and ask the user if you can't tell.`
      )), Math.max(0, request.deadline - Date.now()));
    });
    let result;
    try {
      result = await Promise.race([handler(args, control, request), overtime]);
    } finally {
      clearTimeout(timer);
    }
    if (finish) {
      const done = finish;
      finish = null;
      result = await done(result);
    }
    return result;
  } finally {
    // Cut short (an error, or the deadline): clean up without waiting on a
    // page that may be what held it up.
    if (finish) finish(null).catch(() => {});
  }
}

// --- Not running a request twice ---
// When the connection to the MCP server drops mid-call (Firefox restarting
// the extension, say), the server sends the call again once the extension is
// back. Tools that only read, or that end in the same state however often
// they run, simply run again. Any other is recorded in storage.local when it
// starts and when it's done, so a resent one isn't repeated: one that
// finished gets its result again, one still running here answers once, and
// one an extension restart cut short is reported as unknown, for Claude to
// check whether it happened, and to ask the user if it can't tell.
// (handle_dialog isn't one: a dialog can have used its answer already, and
// running it again would answer the next one too.)
const REPEATABLE_TOOLS = new Set([
  "tabs_context_mcp", "read_page", "get_page_text", "find", "resize_window", "update_plan",
  "gif_creator", "shortcuts_list", "shortcuts_execute", "switch_browser", "set_tab_focus",
  "get_config", "set_config",
  // (Even when it empties the log: run again, it shows what came since. Not
  // journaled, the log it returns isn't kept on disk.)
  "debug",
]);
const REPEATABLE_ACTIONS = new Set(["screenshot", "zoom", "wait", "hover", "scroll_to"]);
// Reading what was recorded repeats fine, unless the first read cleared it.
const REPEATABLE_UNLESS_CLEARING = new Set(["read_console_messages", "read_network_requests"]);
const JOURNAL_STORAGE_KEY = "requestJournal";
// The server resends within a few seconds, and gives up on a call after 60 s.
const JOURNAL_KEEP_MS = 2 * 60 * 1000;
const JOURNAL_RESULT_MAX = 50000; // characters; a larger result isn't kept
const journal = new Map(); // request id -> { tool, state: "started" | "done", at, result?, error? }
const runningRequests = new Map(); // request id -> its request (see handleToolRequest)

function isRepeatable(tool, args) {
  if (REPEATABLE_UNLESS_CLEARING.has(tool)) return !args.clear;
  // (Its answer names the site the user is asked about: it must be there.)
  if (tool === "upload_files") return args.check === true;
  return REPEATABLE_TOOLS.has(tool) || (tool === "computer" && REPEATABLE_ACTIONS.has(args.action));
}

// Calls whose results repeat what Claude typed, pressed, put in a form or
// gave a prompt (a password, say). (handle_dialog's answer can carry the
// text given to a prompt; a script's result, a field's value.)
function hidesInput(tool, args) {
  if (tool === "form_input" || tool === "handle_dialog" || tool === "upload_files" || tool === "javascript_tool") return true;
  return tool === "computer" && (args.action === "type" || args.action === "key");
}

// What's kept of a finished call, to answer a resend with: not what Claude
// typed, pressed, put in a form or gave a prompt, nor a picture of the page,
// nor a result too large to keep.
function keptOutcome(tool, args, outcome) {
  if (hidesInput(tool, args)) return {};
  // Kept as it would be sent: redacted (it's on disk, if only briefly).
  const textOnly = (result) => (Array.isArray(result?.content)
    ? { ...result, content: result.content.filter((item) => item?.type !== "image") }
    : result);
  const kept = outcome.error ? { error: redactTokens(outcome.error) } : { result: redactResult(textOnly(outcome.result)) };
  return JSON.stringify(kept).length <= JOURNAL_RESULT_MAX ? kept : {};
}

function pruneJournal() {
  const now = Date.now();
  let pruned = false;
  for (const [id, entry] of journal) {
    if (now - entry.at > JOURNAL_KEEP_MS) pruned = journal.delete(id);
  }
  return pruned;
}

async function saveJournal() {
  pruneJournal();
  try {
    await chrome.storage.local.set({ [JOURNAL_STORAGE_KEY]: [...journal] });
  } catch {}
}

function answerFromJournal(id, tool, args, seen) {
  const what = tool === "computer" && args.action ? `${tool} ${args.action}` : tool;
  if (seen.state === "started") {
    // A script goes on running in the page without the extension: checking
    // too early would show it as not done, and it would then run twice.
    const script = tool === "javascript_tool"
      ? " The script keeps running in the page after the extension restarts, so allow the time it needs (and anything it waits for) before checking."
      : "";
    sendError(
      id,
      `The browser extension restarted while this ${what} was running, so it may have been done fully, partly or not at all.${script} Before repeating it, check whether it took effect (a screenshot, read_page or get_page_text): if it did, don't repeat it; if it didn't, run it again. If you still can't tell, ask the user.`
    );
  } else if (seen.error) {
    sendError(id, seen.error);
  } else if (seen.result) {
    sendResponse(id, seen.result);
  } else {
    sendResponse(id, textResult(`This ${what} already ran before the connection to Claude dropped, so it wasn't run again. Its result wasn't kept; check the page for it.`));
  }
}

// --- Updates ---
// Firefox would reload the extension as soon as an update is downloaded,
// even in the middle of a tool call. With this listener it waits, and the
// update is applied when no tool call is running.
let updateWaiting = false;
let toolCallsRunning = 0;

chrome.runtime.onUpdateAvailable.addListener(() => {
  updateWaiting = true;
  reloadIfIdle();
});

function reloadIfIdle() {
  if (!updateWaiting || toolCallsRunning > 0) return;
  // A moment later, in case Claude goes on with its next call right away.
  setTimeout(() => {
    if (toolCallsRunning === 0) chrome.runtime.reload();
  }, 3000);
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
async function runJavascript(tabId, text, deadline) {
  // (A hashbang only parses at the very start of a script: none of what's run
  // below starts with the code.)
  const code = text.replace(/^#!.*/, "");
  let outcome = await evalInPage(tabId, code, deadline);
  if (outcome.needsFunctionBody) outcome = await evalBodiesInPage(tabId, code, outcome.syntaxError, deadline);
  if (!outcome.csp) return outcome;

  // The page's Content Security Policy blocks eval(). The userScripts
  // namespace only exists once its optional permission is granted.
  if (chrome.userScripts?.execute) return runAsUserScript(tabId, code, deadline);
  return {
    thrown: `${outcome.csp}. This site's security policy blocks eval(). To run scripts on sites like this, click the ${EXTENSION_NAME} toolbar button and allow "User scripts".`,
  };
}

// eval() in the page's own world (indirect, so it runs at global scope like a
// console), so page variables are visible. Pages whose CSP forbids eval
// (reddit, HN, ...) make it fail with { csp }. Code that doesn't parse as a
// script (top-level await or return, say) comes back as { needsFunctionBody,
// syntaxError }, without having run. A page that takes longer than the deadline
// to get to this (it may be loading) is too late for it: Claude was told by
// then that the script didn't run in time.
async function evalInPage(tabId, code, deadline) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (code, bareAwait, deadline, packSource) => {
      if (Date.now() > deadline) return { timedOut: true };
      const describe = (e) => (e && e.name ? `${e.name}: ${e.message}` : String(e));
      let pack;
      try {
        pack = (0, eval)(`(${packSource})`); // eslint-disable-line no-eval
      } catch (e) {
        return { csp: describe(e) };
      }
      if (bareAwait) return { needsFunctionBody: true };
      // Whether it parses is found out by parsing it behind a `throw`: the
      // code can't run from there, whatever it is. An error thrown while it
      // runs can't be told from that afterwards (an eval() inside it can
      // throw a SyntaxError), and running it again as a function body would
      // do everything twice.
      try {
        (0, eval)(`throw 0;\n${code}`); // eslint-disable-line no-eval
      } catch (e) {
        if (e !== 0) return { needsFunctionBody: true, syntaxError: describe(e) };
      }
      let value;
      try {
        value = (0, eval)(code); // eslint-disable-line no-eval
      } catch (e) {
        return { thrown: describe(e) };
      }
      try {
        return { ok: pack(await value) };
      } catch (e) {
        return { thrown: describe(e) };
      }
    },
    args: [code, awaitsAtTopLevel(code), deadline, packValue.toString()],
  });
  if (res?.error) return { thrown: errorText(res.error) };
  return res?.result ?? { thrown: "The script produced no result." };
}

// Runs the first candidate body for `code` (see lib/js-source.js) that
// parses as an async function body. The page builds them one at a time from
// the offsets, rather than receiving them all. If none does, syntaxError
// says why the code didn't parse as a script.
async function evalBodiesInPage(tabId, code, syntaxError, deadline) {
  const { starts, end } = statementStarts(code);
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (code, starts, end, syntaxError, deadline, bodyAtSource, packSource) => {
      if (Date.now() > deadline) return { timedOut: true };
      const describe = (e) => (e && e.name ? `${e.name}: ${e.message}` : String(e));
      const pack = (0, eval)(`(${packSource})`); // eslint-disable-line no-eval
      const bodyAt = (0, eval)(`(${bodyAtSource})`); // eslint-disable-line no-eval
      const AsyncFunction = (async () => {}).constructor;
      const bodies = function* () {
        for (const at of starts) {
          const body = bodyAt(code, at, end);
          if (body !== null) yield body;
        }
        yield code;
      };
      let parseError = null;
      for (const body of bodies()) {
        let run;
        try {
          // Parsing happens before anything runs: a body that doesn't parse
          // has no effects. It's parsed as a body, on its own: in a wrapper
          // written around it as text, a stray "})" could close the wrapper.
          run = new AsyncFunction(body);
        } catch (e) {
          parseError = e;
          continue;
        }
        try {
          return { ok: pack(await run()) };
        } catch (e) {
          return { thrown: describe(e) };
        }
      }
      return { thrown: syntaxError ?? describe(parseError) };
    },
    args: [code, starts, end, syntaxError ?? null, deadline, returnBodyAt.toString(), packValue.toString()],
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
  if (outcome.thrown !== undefined) return errorResult(`Error: ${redactErrorText(outcome.thrown)}`);
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
// Open requests are also kept in storage.session, so the user's answer still
// counts if Firefox suspends this background script while they decide (the
// tool call has been answered with "pending" by then).
const SHARE_REQUESTS_STORAGE_KEY = "shareRequests";

function saveShareRequests() {
  const open = [...shareRequests].map(([id, { reason, query, windowId }]) => [id, { reason, query, windowId }]);
  return chrome.storage.session.set({ [SHARE_REQUESTS_STORAGE_KEY]: open }).catch(() => {});
}

// Moves tabs into Claude's group, in its window; with no group yet, the
// first tab starts a new Claude window. They're Claude's own tabs afterwards.
// It may create the group, so it holds the group lock (see withGroupLock).
function moveTabsToClaude(tabIds) {
  return withGroupLock(() => moveTabsToClaudeNow(tabIds));
}

async function moveTabsToClaudeNow(tabIds) {
  let group = await findClaudeGroup();
  // Remember where each tab was, for "Move Tab Out of Claude's Group"; that
  // can be Claude's own window, outside the group. A pinned tab is pinned
  // again when it goes back.
  const pinned = [];
  for (const id of tabIds) {
    const tab = await chrome.tabs.get(id);
    tabOrigins.set(id, { windowId: tab.windowId, index: tab.index, pinned: tab.pinned });
    if (tab.pinned) pinned.push(id);
  }
  await saveTabOrigins();
  try {
    for (const id of pinned) await chrome.tabs.update(id, { pinned: false }); // pinned tabs can't be grouped
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
  } catch (err) {
    // E.g. a private window's tab and Claude's group in a normal window:
    // leave the tabs as they were, also if they had moved already.
    for (const id of tabIds) {
      const origin = tabOrigins.get(id);
      await chrome.tabs.move(id, { windowId: origin.windowId, index: origin.index }).catch(() => {});
      tabOrigins.delete(id);
      if (pinned.includes(id)) await chrome.tabs.update(id, { pinned: true }).catch(() => {});
    }
    await saveTabOrigins();
    throw err;
  }
  // Claude's own before no longer shared, so they're never neither (a tool
  // working in one would take that for the user taking it back).
  for (const id of tabIds) {
    ownTabs.add(id);
    sharedTabs.delete(id);
  }
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

// Tabs on their way out of Claude's group, shared already: in the group, a
// shared tab otherwise counts as one the user dragged in.
const movingOut = new Set();

async function moveTabsToUser(tabIds) {
  // Shared first, so the tab never looks uncontrolled while it leaves the group.
  for (const id of tabIds) {
    movingOut.add(id);
    sharedTabs.add(id);
  }
  await saveSharedTabs();
  try {
    await chrome.tabs.ungroup(tabIds);
  } finally {
    for (const id of tabIds) movingOut.delete(id);
  }
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
    // Pinned again if it was, back at its place among the pinned tabs when
    // it's home (pinning puts it after them).
    if (origin?.pinned) {
      await chrome.tabs.update(id, { pinned: true });
      if (origin.windowId === windowId) await chrome.tabs.move(id, { index: origin.index }).catch(() => {});
    }
    tabOrigins.delete(id);
    focusWindowId ??= windowId;
  }
  await saveTabOrigins();
  await chrome.tabs.update(tabIds[0], { active: true });
  await chrome.windows.update(focusWindowId, { focused: true });
  // Dialogs there are answered for Claude only while it's working, as in
  // any shared tab.
  for (const id of tabIds) callPageHooks(id, { answerUntil: dialogDeadline(id, "shared"), report: false });
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
  let win;
  try {
    win = await chrome.windows.create({
      url: chrome.runtime.getURL(`${SHARE_PAGE}#${requestId}`),
      type: "popup",
      width: 560,
      height: 640,
      focused: true,
    });
  } catch (err) {
    shareRequests.delete(requestId);
    throw err;
  }
  const open = shareRequests.get(requestId);
  if (open) open.windowId = win.id;
  await saveShareRequests();
  // The window stays open after this times out, and an answer given later
  // still shares the tabs.
  return Promise.race([decided, sleep(SHARE_WAIT_MS).then(() => ({ pending: true }))]);
}

function finishShareRequest(requestId, outcome) {
  const request = shareRequests.get(requestId);
  if (!request) return;
  shareRequests.delete(requestId);
  saveShareRequests();
  request.settle(outcome);
  if (request.windowId !== null) chrome.windows.remove(request.windowId).catch(() => {});
}

chrome.windows.onRemoved.addListener(async (windowId) => {
  await stateReady;
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
// The items are made again each time this background script starts, which
// can be the right-click that onShown answers: it waits for them.
async function createMenus() {
  await chrome.menus.removeAll();
  chrome.menus.create({ id: "share-tab", title: "Share Tab with Claude", contexts: ["tab"] });
  chrome.menus.create({ id: "unshare-tab", title: "Stop Sharing Tab with Claude", contexts: ["tab"], visible: false });
  chrome.menus.create({ id: "handover-tab", title: "Move Tab to Claude's Window", contexts: ["tab"] });
  chrome.menus.create({ id: "return-tab", title: "Move Tab Out of Claude's Group", contexts: ["tab"], visible: false });
}
const menusReady = createMenus().catch(() => {});

chrome.menus.onShown.addListener(async (info, tab) => {
  if (!info.contexts.includes("tab") || !tab) return;
  await menusReady;
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

// Firefox says "Missing host permission" for any page it won't let extensions
// script, whatever access they have: its own pages, error pages, a page that's
// still on its way. Only without website access is that the thing to fix.
async function withPermissionHelp(message) {
  if (!/Missing (host|activeTab) permission/i.test(message)) return message;
  if (await chrome.permissions.contains(SITE_ACCESS)) {
    return `${message}. This page can't be scripted: it's a Firefox page, addons.mozilla.org or an error page, or it was still loading. Navigate to a web page, or try again.`;
  }
  return `${message}. Firefox hasn't given ${EXTENSION_NAME} access to websites: click its toolbar button and allow "Access to all websites".`;
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

// Red "!" while website access is missing; amber "!" while the server's
// version differs from the extension's.
async function updateBadge() {
  const hasSiteAccess = await chrome.permissions.contains(SITE_ACCESS);
  const mismatch = versionMismatch();
  let title = EXTENSION_NAME;
  if (!hasSiteAccess) title = `${EXTENSION_NAME}: needs website access, click to set up`;
  else if (mismatch) title = `${EXTENSION_NAME}: Claude's MCP server is a different version, click for details`;
  await chrome.action.setBadgeBackgroundColor({ color: hasSiteAccess ? "#b25d00" : "#d70022" });
  await chrome.action.setBadgeText({ text: !hasSiteAccess || mismatch ? "!" : "" });
  await chrome.action.setTitle({ title });
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
    sendResponse({
      connected: serverSocket?.readyState === WebSocket.OPEN,
      extensionVersion: EXTENSION_VERSION,
      serverVersion: server.settled ? server.version : undefined,
      mismatch: versionMismatch(),
      releasesUrl: RELEASES_URL,
    });
  }
});

// --- Init ---

// The format of what's kept in storage.local: claudeGroupId (number),
// tabOrigins ([tabId, { windowId, index, pinned? }] pairs), lastUserWindowId
// (number), requestJournal ([requestId, { tool, state, at, result?,
// error? }] pairs), browserId (string) and config ({ setting: value }, see
// SETTINGS; a setting it doesn't know is ignored). Bump it when that changes.
// Data in any other format is discarded rather than migrated: all of it
// rebuilds itself (the group is found by name, a tab without a home goes to
// the last-used window; settings go back to their defaults). That includes 1.1.x's mcpWindowId: its window isn't
// adopted, because after a Firefox restart the id can belong to one of the
// user's windows.
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
    const { [STARTED_STORAGE_KEY]: started = [] } = await chrome.storage.session.get(STARTED_STORAGE_KEY);
    for (const id of started) startedTabs.add(id);
  } catch {}
  try {
    // Share requests still open: the tool call that asked was answered
    // before this background script was suspended.
    const { [SHARE_REQUESTS_STORAGE_KEY]: open = [] } = await chrome.storage.session.get(SHARE_REQUESTS_STORAGE_KEY);
    for (const [id, request] of open) shareRequests.set(id, { ...request, settle: () => {} });
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
    const { [BROWSER_ID_STORAGE_KEY]: stored } = await chrome.storage.local.get(BROWSER_ID_STORAGE_KEY);
    browserId = typeof stored === "string" ? stored : crypto.randomUUID();
    if (browserId !== stored) await chrome.storage.local.set({ [BROWSER_ID_STORAGE_KEY]: browserId });
  } catch {}
  try {
    const { [CONFIG_STORAGE_KEY]: stored } = await chrome.storage.local.get(CONFIG_STORAGE_KEY);
    if (stored && typeof stored === "object") configForAll = stored;
    const { [TAB_CONFIG_STORAGE_KEY]: tabs = [] } = await chrome.storage.session.get(TAB_CONFIG_STORAGE_KEY);
    for (const [id, own] of tabs) configForTabs.set(id, own);
  } catch {}
  try {
    const { [JOURNAL_STORAGE_KEY]: entries = [] } = await chrome.storage.local.get(JOURNAL_STORAGE_KEY);
    for (const [id, entry] of entries) journal.set(id, entry);
    if (pruneJournal()) await saveJournal(); // old entries go as soon as they can
  } catch {}
  try {
    // Check the remembered group is still Claude's, and learn its tabs.
    await findClaudeGroup();
    await syncOwnTabs();
  } catch {}
  // A tab Claude lost while this background script wasn't running (dragged
  // out of the group, say) still has its page answering for Claude: release
  // it now.
  for (const id of [...startedTabs]) {
    if (!isControlledNow(id)) releasePage(id);
  }
}

const stateReady = restoreState();
connectToServer();
updateBadge();
