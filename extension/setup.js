// Setup page: shows and requests the extension's permissions, and whether
// Claude's MCP server is connected.

const PERMISSIONS = [
  { id: "site-access", request: { origins: ["<all_urls>"] } },
  { id: "user-scripts", request: { permissions: ["userScripts"] } },
];

async function renderPermissions() {
  for (const { id, request } of PERMISSIONS) {
    const row = document.getElementById(id);
    const status = row.querySelector(".status");
    const button = row.querySelector("button");
    const granted = await chrome.permissions.contains(request);
    status.textContent = granted ? "Allowed" : "Not allowed";
    status.className = `status ${granted ? "ok" : "warn"}`;
    button.hidden = granted;
  }
}

for (const { id, request } of PERMISSIONS) {
  // permissions.request only works directly inside the click handler.
  document.getElementById(id).querySelector("button").addEventListener("click", () => {
    chrome.permissions.request(request).then(renderPermissions, renderPermissions);
  });
}

async function renderConnection() {
  let status = {};
  try {
    status = (await chrome.runtime.sendMessage({ type: "getConnectionStatus" })) || {};
  } catch {}
  const el = document.getElementById("connection");
  el.textContent = status.connected
    ? "Connected. Claude can use this browser."
    : "Not connected yet. Start Claude Desktop with the Claude MCP in Fayar kitsune extension installed, or a Claude Code session with the MCP server added. This page updates by itself.";

  const versions = document.getElementById("versions");
  const server = status.serverVersion === undefined ? "" : ` · server ${status.serverVersion || "older than 2.0.0"}`;
  versions.textContent = `Extension ${EXTENSION_VERSION}${status.connected ? server : ""}`;

  // Firefox updates the extension by itself, Claude Desktop's .mcpb doesn't.
  const warning = document.getElementById("version-warning");
  warning.hidden = !status.mismatch;
  // Rebuilt only when the message changes, so a refresh doesn't swallow a
  // click on the link.
  if (status.mismatch && warning.dataset.message !== status.mismatch) {
    warning.dataset.message = status.mismatch;
    // The message says where to get the .mcpb: make that a link.
    const at = status.releasesUrl ? status.mismatch.lastIndexOf(status.releasesUrl) : -1;
    if (at < 0) {
      warning.textContent = status.mismatch;
    } else {
      const link = document.createElement("a");
      link.href = status.releasesUrl;
      link.textContent = status.releasesUrl;
      warning.replaceChildren(
        status.mismatch.slice(0, at),
        link,
        status.mismatch.slice(at + status.releasesUrl.length)
      );
    }
  }
}

chrome.permissions.onAdded.addListener(renderPermissions);
chrome.permissions.onRemoved.addListener(renderPermissions);
renderPermissions();
renderConnection();
setInterval(renderConnection, 3000);
