#!/usr/bin/env node

// MCP Server for Claude MCP in Fayar kitsune extension.
// Started by Claude Code via stdio MCP transport.
//
// Operates in one of two modes:
// - PRIMARY: Owns the TCP port, accepts native host + client connections
// - CLIENT: Port already taken by another session, connects as a client
//
// This allows multiple Claude Code sessions to share one browser extension.
//
// The primary's port accepts three kinds of connection:
// - the browser extension over WebSocket (extension >= 1.1.0)
// - client MCP servers (newline-delimited JSON, start with client_hello)
// - the legacy native messaging host (extension 1.0.0)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { WebSocketServer } from "ws";
import { z } from "zod";


const DEFAULT_PORT = 18765;

function getPort() {
  const configPath = path.join(os.homedir(), ".config", "open-claude-in-firefox", "config.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return config.port || DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

const TCP_PORT = getPort();

// --- Mode detection ---
// Try to bind the port. If it's taken, switch to client mode.
let mode = "primary"; // or "client"

// --- Shared state ---
// The browser extension's connection, whichever transport it came in on:
// { send(msg), close(), isOpen() }
let extensionConn = null;
const pendingRequests = new Map(); // id -> { resolve, reject, timer, tool, args, resent }
let requestIdCounter = 0;

// Primary mode: track client MCP server connections
const clientSockets = new Map(); // clientId -> socket
let clientIdCounter = 0;
// Map from prefixed request ID -> { clientId, originalId, tool, args, resent }
const clientRequestMap = new Map();

// Client mode: TCP connection to the primary
let primarySocket = null;
let clientBuffer = Buffer.alloc(0);

// --- sendToExtension: works in both modes ---

function sendToExtension(tool, args) {
  return new Promise((resolve, reject) => {
    const id = String(++requestIdCounter);
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error("Tool request timed out after 60s"));
    }, 60000);
    pendingRequests.set(id, { resolve, reject, timer, tool, args, resent: false });

    if (mode === "primary") {
      if (!extensionConnected()) {
        clearTimeout(timer);
        pendingRequests.delete(id);
        reject(new Error("Browser extension is not connected. Make sure Firefox is running with the Claude MCP in Fayar kitsune extension installed and enabled."));
        return;
      }
      extensionConn.send({ id, type: "tool_request", tool, args });
    } else {
      // Client mode: send to primary server
      if (!primarySocket || primarySocket.destroyed) {
        clearTimeout(timer);
        pendingRequests.delete(id);
        reject(new Error("Lost connection to primary MCP server."));
        return;
      }
      const msg = JSON.stringify({ id, type: "tool_request", tool, args }) + "\n";
      primarySocket.write(msg);
    }
  });
}

// --- Pidfile management ---

const pidfilePath = path.join(os.tmpdir(), `open-claude-in-firefox-mcp-${TCP_PORT}.pid`);

function writePidfile() {
  try { fs.writeFileSync(pidfilePath, String(process.pid)); } catch {}
}

function cleanupPidfile() {
  try {
    const content = fs.readFileSync(pidfilePath, "utf-8").trim();
    if (content === String(process.pid)) fs.unlinkSync(pidfilePath);
  } catch {}
}

function shutdown() {
  if (mode === "primary") cleanupPidfile();
  if (extensionConn) extensionConn.close();
  if (primarySocket && !primarySocket.destroyed) primarySocket.destroy();
  for (const [, sock] of clientSockets) {
    if (!sock.destroyed) sock.destroy();
  }
  for (const [, { reject, timer }] of pendingRequests) {
    clearTimeout(timer);
    reject(new Error("Server shutting down"));
  }
  pendingRequests.clear();
  if (mode === "primary") tcpServer.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGHUP", shutdown);
process.stdin.on("end", shutdown);
process.stdin.resume();

// --- Primary mode: handle incoming TCP connections ---

function handleResponse(msg) {
  // Check if this response is for a client request (prefixed ID)
  if (msg.id && clientRequestMap.has(msg.id)) {
    const { clientId, originalId } = clientRequestMap.get(msg.id);
    clientRequestMap.delete(msg.id);
    const clientSocket = clientSockets.get(clientId);
    if (clientSocket && !clientSocket.destroyed) {
      const fwd = JSON.stringify({ ...msg, id: originalId }) + "\n";
      clientSocket.write(fwd);
    }
    return;
  }

  // Otherwise it's for a local request
  if (msg.id && pendingRequests.has(msg.id)) {
    const { resolve, reject, timer } = pendingRequests.get(msg.id);
    clearTimeout(timer);
    pendingRequests.delete(msg.id);
    if (msg.type === "tool_error") {
      reject(new Error(msg.error || "Tool execution failed"));
    } else {
      resolve(msg.result);
    }
  }
}

function processLine(line) {
  if (!line) return;
  try {
    const msg = JSON.parse(line);
    if (msg.type === "heartbeat") return;
    handleResponse(msg);
  } catch {}
}

// --- Browser extension connection (WebSocket, or legacy native host socket) ---

function extensionConnected() {
  return extensionConn !== null && extensionConn.isOpen();
}

// Returns false if another browser is already connected.
function attachExtension(conn) {
  if (extensionConnected()) return false;
  extensionConn = conn;
  return true;
}

function detachExtension(conn) {
  if (extensionConn !== conn) return;
  extensionConn = null;
  // Only the requests that were in flight on this connection, this session's
  // and those forwarded from client sessions: anything sent after a
  // reconnect already reached the new connection and mustn't repeat.
  const inFlight = [...pendingRequests.keys()];
  const forwarded = [...clientRequestMap.keys()];
  if (inFlight.length === 0 && forwarded.length === 0) return;
  // Give the extension a few seconds to reconnect, then resend each once.
  setTimeout(() => {
    for (const id of inFlight) {
      const entry = pendingRequests.get(id);
      if (!entry) continue; // answered or timed out meanwhile
      if (extensionConnected() && !entry.resent) {
        entry.resent = true;
        extensionConn.send({ id, type: "tool_request", tool: entry.tool, args: entry.args });
      } else {
        clearTimeout(entry.timer);
        pendingRequests.delete(id);
        entry.reject(new Error("Browser extension disconnected"));
      }
    }
    for (const id of forwarded) {
      const entry = clientRequestMap.get(id);
      if (!entry) continue; // answered, or the client left
      if (extensionConnected() && !entry.resent) {
        entry.resent = true;
        extensionConn.send({ id, type: "tool_request", tool: entry.tool, args: entry.args });
      } else {
        clientRequestMap.delete(id);
        const clientSocket = clientSockets.get(entry.clientId);
        if (clientSocket && !clientSocket.destroyed) {
          clientSocket.write(JSON.stringify({ id: entry.originalId, type: "tool_error", error: "Browser extension disconnected" }) + "\n");
        }
      }
    }
  }, 5000);
}

// WebSocket upgrades are handed to this (non-listening) HTTP server. Only
// moz-extension:// origins are accepted, so web pages can't connect.
const httpServer = http.createServer((req, res) => {
  res.writeHead(426, { "Content-Type": "text/plain" });
  res.end("WebSocket upgrade required\n");
});
const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  const origin = req.headers.origin || "";
  if (!origin.startsWith("moz-extension://")) {
    process.stderr.write(`Rejected WebSocket connection from origin "${origin}"\n`);
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  wss.handleUpgrade(req, socket, head, setupExtensionWebSocket);
});

function setupExtensionWebSocket(ws) {
  const conn = {
    send: (msg) => ws.send(JSON.stringify(msg)),
    close: () => ws.terminate(),
    isOpen: () => ws.readyState === ws.OPEN,
  };
  if (!attachExtension(conn)) {
    ws.close(1008, "Another browser profile is already connected.");
    return;
  }
  process.stderr.write("Browser extension connected\n");
  ws.on("message", (data) => processLine(data.toString("utf-8")));
  ws.on("error", () => {});
  ws.on("close", () => {
    if (extensionConn === conn) process.stderr.write("Browser extension disconnected\n");
    detachExtension(conn);
  });
}

const tcpServer = net.createServer((socket) => {
  // Without an error listener, a peer that resets the connection (any local
  // program that connects and quits) is an uncaught exception that takes this
  // server down, and every Claude session using it loses the browser. This
  // one covers the socket for its whole life, whatever it turns out to be.
  socket.on("error", () => {});

  // Classification:
  // - "GET " means an HTTP request: the extension's WebSocket handshake.
  // - Client MCP servers send client_hello immediately.
  // - Anything else, or silence for 500ms, is a legacy native host.
  let classified = false;
  let earlyBuffer = Buffer.alloc(0);

  const classifyTimeout = setTimeout(() => {
    if (!classified) {
      classified = true;
      setupNativeHostConnection(socket, earlyBuffer);
    }
  }, 500); // 500ms is plenty for a local client_hello

  // Gone before it said anything: there's nothing to set up.
  socket.on("close", () => {
    classified = true;
    clearTimeout(classifyTimeout);
  });

  socket.on("data", function onEarlyData(chunk) {
    if (classified) return; // Already classified, data handler was replaced
    earlyBuffer = Buffer.concat([earlyBuffer, chunk]);

    if (earlyBuffer.length >= 4 && earlyBuffer.toString("latin1", 0, 4) === "GET ") {
      classified = true;
      clearTimeout(classifyTimeout);
      socket.removeListener("data", onEarlyData);
      socket.pause();
      socket.unshift(earlyBuffer);
      httpServer.emit("connection", socket);
      socket.resume();
      return;
    }

    const newlineIdx = earlyBuffer.indexOf(10);
    if (newlineIdx === -1) return; // No full line yet, keep buffering

    const firstLine = earlyBuffer.subarray(0, newlineIdx).toString("utf-8").trim();
    try {
      const firstMsg = JSON.parse(firstLine);
      if (firstMsg.type === "client_hello") {
        classified = true;
        clearTimeout(classifyTimeout);
        socket.removeListener("data", onEarlyData);
        setupClientConnection(socket, earlyBuffer.subarray(newlineIdx + 1));
        return;
      }
    } catch {}

    // Got data but it's not a client_hello, this is a native host
    classified = true;
    clearTimeout(classifyTimeout);
    socket.removeListener("data", onEarlyData);
    setupNativeHostConnection(socket, earlyBuffer);
  });
});

// Legacy: extension 1.0.0 talks to us through native-host.js over raw TCP.
function setupNativeHostConnection(socket, initialBuffer) {
  const conn = {
    send: (msg) => socket.write(JSON.stringify(msg) + "\n"),
    close: () => socket.destroy(),
    isOpen: () => !socket.destroyed,
  };
  if (!attachExtension(conn)) {
    socket.end(JSON.stringify({ type: "error", error: "Another browser profile is already connected." }) + "\n");
    socket.destroy();
    return;
  }

  let buffer = initialBuffer;

  // Process any data already in the buffer
  let idx;
  while ((idx = buffer.indexOf(10)) !== -1) {
    processLine(buffer.subarray(0, idx).toString("utf-8").trim());
    buffer = buffer.subarray(idx + 1);
  }

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf(10)) !== -1) {
      processLine(buffer.subarray(0, newlineIdx).toString("utf-8").trim());
      buffer = buffer.subarray(newlineIdx + 1);
    }
  });

  socket.on("close", () => detachExtension(conn));
}

function setupClientConnection(socket, initialBuffer) {
  const clientId = String(++clientIdCounter);
  clientSockets.set(clientId, socket);
  process.stderr.write(`Client MCP server connected (client ${clientId})\n`);

  // Send ack
  socket.write(JSON.stringify({ type: "client_ack", clientId }) + "\n");

  let buffer = initialBuffer;

  function processClientData() {
    let idx;
    while ((idx = buffer.indexOf(10)) !== -1) {
      const line = buffer.subarray(0, idx).toString("utf-8").trim();
      buffer = buffer.subarray(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === "tool_request" && msg.id) {
          // Forward to the extension with a prefixed ID
          const prefixedId = `c${clientId}_${msg.id}`;
          // tool/args are kept so the request can be resent after a reconnect
          clientRequestMap.set(prefixedId, { clientId, originalId: msg.id, tool: msg.tool, args: msg.args, resent: false });

          if (!extensionConnected()) {
            // Send error back to client
            socket.write(JSON.stringify({ id: msg.id, type: "tool_error", error: "Browser extension is not connected." }) + "\n");
            clientRequestMap.delete(prefixedId);
          } else {
            extensionConn.send({ ...msg, id: prefixedId });
          }
        }
      } catch {}
    }
  }

  // Process initial buffer
  processClientData();

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    processClientData();
  });

  socket.on("close", () => {
    clientSockets.delete(clientId);
    // Clean up any pending client requests
    for (const [prefixedId, info] of clientRequestMap) {
      if (info.clientId === clientId) clientRequestMap.delete(prefixedId);
    }
    process.stderr.write(`Client MCP server disconnected (client ${clientId})\n`);
  });
}

// --- Client mode: connect to primary ---

function startClientMode() {
  mode = "client";
  process.stderr.write(`Port ${TCP_PORT} in use. Connecting as client to primary MCP server...\n`);

  function connect() {
    primarySocket = net.createConnection(TCP_PORT, "127.0.0.1", () => {
      process.stderr.write(`Connected to primary MCP server on :${TCP_PORT}\n`);
      // Send handshake
      primarySocket.write(JSON.stringify({ type: "client_hello" }) + "\n");
    });

    primarySocket.on("data", (chunk) => {
      clientBuffer = Buffer.concat([clientBuffer, chunk]);
      let idx;
      while ((idx = clientBuffer.indexOf(10)) !== -1) {
        const line = clientBuffer.subarray(0, idx).toString("utf-8").trim();
        clientBuffer = clientBuffer.subarray(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "client_ack") continue;
          if (msg.type === "error") {
            process.stderr.write(`Primary server error: ${msg.error}\n`);
            continue;
          }
          // Tool response routed back from primary
          if (msg.id && pendingRequests.has(msg.id)) {
            const { resolve, reject, timer } = pendingRequests.get(msg.id);
            clearTimeout(timer);
            pendingRequests.delete(msg.id);
            if (msg.type === "tool_error") {
              reject(new Error(msg.error || "Tool execution failed"));
            } else {
              resolve(msg.result);
            }
          }
        } catch {}
      }
    });

    primarySocket.on("error", (err) => {
      process.stderr.write(`Client connection error: ${err.message}\n`);
    });

    primarySocket.on("close", () => {
      primarySocket = null;
      // Primary died, reject pending requests
      for (const [, { reject, timer }] of pendingRequests) {
        clearTimeout(timer);
        reject(new Error("Primary MCP server disconnected"));
      }
      pendingRequests.clear();
      // Nobody else will open the port if the primary is gone for good, so
      // try to take it over; if another session got there first (or the
      // primary is back), connect to that one. The random delay keeps
      // several waiting sessions from all trying at the same moment.
      setTimeout(async () => {
        if ((await listenAsPrimary()) === "listening") {
          process.stderr.write("The primary MCP server went away; this session took over.\n");
        } else {
          connect();
        }
      }, 1000 + Math.random() * 1000);
    });
  }

  connect();
}

// --- Startup: try primary, fall back to client ---

// Tries to own the port. Resolves "listening", "in-use", or the error.
function listenAsPrimary() {
  return new Promise((resolve) => {
    const onError = (err) => {
      tcpServer.removeListener("listening", onListening);
      resolve(err.code === "EADDRINUSE" ? "in-use" : err);
    };
    const onListening = () => {
      tcpServer.removeListener("error", onError);
      mode = "primary";
      writePidfile();
      process.stderr.write(`Primary MCP server listening on :${TCP_PORT}\n`);
      resolve("listening");
    };
    tcpServer.once("error", onError);
    tcpServer.once("listening", onListening);
    tcpServer.listen(TCP_PORT, "127.0.0.1");
  });
}

async function start() {
  // Clean up stale pidfiles (but don't kill live servers)
  const pidfiles = [
    pidfilePath,
    path.join(os.tmpdir(), `open-claude-in-firefox-mcp-${TCP_PORT}.pid`),
  ];
  for (const pf of pidfiles) {
    try {
      const oldPid = parseInt(fs.readFileSync(pf, "utf-8").trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        try {
          process.kill(oldPid, 0); // Check if alive
          // It's alive. DON'T kill it. We'll run as client instead.
        } catch {
          // Dead process, clean up pidfile
          try { fs.unlinkSync(pf); } catch {}
        }
      }
    } catch {}
  }

  const outcome = await listenAsPrimary();
  if (outcome === "in-use") {
    // Port taken by another live session. Run as client.
    startClientMode();
  } else if (outcome !== "listening") {
    process.stderr.write(`TCP server error: ${outcome.message}\n`);
    process.exit(1);
  }
}

await start();

// --- Helper to wrap tool results for MCP ---

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function imageResult(base64, mimeType = "image/png") {
  return { content: [{ type: "image", data: base64, mimeType }] };
}

function mixedResult(parts) {
  return { content: parts };
}

async function callTool(toolName, args) {
  try {
    const result = await sendToExtension(toolName, args);
    if (typeof result === "string") return textResult(result);
    if (result && result.content) return result;
    return textResult(JSON.stringify(result, null, 2));
  } catch (err) {
    return textResult(`Error: ${err.message}`);
  }
}

// Moving shared tabs into Claude's window takes the user's yes. Claude Code
// and Claude Desktop can ask it themselves (MCP elicitation): the question
// comes from this server and the answer from the user, not from the model.
// Apps without that ask Claude to get the answer in the conversation.
const HANDOVER_ANSWER_TIMEOUT_MS = 5 * 60 * 1000;

async function requestHandover({ tabIds, reason, confirmed }) {
  const ids = [...new Set(tabIds)];

  // Check the tabs are shared before asking anything, and name them in the
  // question. (If the extension can't answer, tabs_handover reports it.)
  let described = ids.map((id) => `tab ${id}`);
  try {
    const context = await sendToExtension("tabs_context_mcp", {});
    const { availableTabs = [] } = JSON.parse(context.content[0].text.split("\n")[0]);
    const shared = availableTabs.filter((t) => t.sharedByUser);
    const notShared = ids.filter((id) => !shared.some((t) => t.tabId === id));
    if (notShared.length) {
      return textResult(
        `Only tabs the user shared with you can be handed over; not shared: ${notShared.join(", ")}. Use tabs_context_mcp to see them.`
      );
    }
    described = ids.map((id) => {
      const tab = shared.find((t) => t.tabId === id);
      return `"${tab.title}" (${tab.url})`;
    });
  } catch {}

  if (!server.server.getClientCapabilities()?.elicitation) {
    if (confirmed) return callTool("tabs_handover", { tabIds: ids });
    return textResult(
      "This app can't show a confirmation prompt. Ask the user in the conversation whether to move these tabs out of their window into Claude's own window. If they agree, call tabs_request_handover again with confirmed: true."
    );
  }

  let answer;
  try {
    answer = await server.server.elicitInput(
      {
        message:
          `Claude wants to move ${ids.length === 1 ? "a tab" : `${ids.length} tabs`} you shared out of your window, into Claude's own window and its "Claude" tab group:\n` +
          described.map((d) => `• ${d}`).join("\n") +
          (reason ? `\n\nClaude says: ${reason}` : "") +
          "\n\nYou can take a tab back by dragging it out of the group.",
        requestedSchema: {
          type: "object",
          properties: {
            move: { type: "boolean", title: "Move them to Claude's window", default: true },
          },
          required: ["move"],
        },
      },
      { timeout: HANDOVER_ANSWER_TIMEOUT_MS }
    );
  } catch (err) {
    return textResult(`Error: couldn't ask the user (${err.message}). Ask them in the conversation instead.`);
  }
  if (answer.action !== "accept" || !answer.content?.move) {
    return textResult("The user chose to keep the tabs where they are. They're still shared with you.");
  }
  return callTool("tabs_handover", { tabIds: ids });
}

// --- MCP Server and its tools ---

const server = new McpServer({
  name: "open-claude-in-fayarkitsune",
  version: "1.2.0",
});

// Pre-validation arg coercion
{
  const origSetRequestHandler = server.server.setRequestHandler.bind(server.server);
  server.server.setRequestHandler = function(schema, handler) {
    return origSetRequestHandler(schema, async (request, extra) => {
      const args = request?.params?.arguments;
      if (args) {
        if (typeof args.tabId === "string") args.tabId = Number(args.tabId);
        if (typeof args.coordinate === "string") {
          try { args.coordinate = JSON.parse(args.coordinate); } catch {}
        }
        if (typeof args.start_coordinate === "string") {
          try { args.start_coordinate = JSON.parse(args.start_coordinate); } catch {}
        }
        if (typeof args.region === "string") {
          try { args.region = JSON.parse(args.region); } catch {}
        }
      }
      return handler(request, extra);
    });
  };
}
// 1. tabs_context_mcp
server.tool(
  "tabs_context_mcp",
  "Get context information about the current MCP tab group (the Firefox tab group named \"Claude\"). Returns all tab IDs inside the group if it exists, plus any of the user's own tabs they shared with you. The group survives Claude restarts, so tabs from an earlier conversation may still be there. CRITICAL: You must get the context at least once before using other browser automation tools so you know what tabs exist. Each new conversation should create its own new tab (using tabs_create_mcp) rather than reusing existing tabs, unless the user explicitly asks to use an existing tab.",
  { createIfEmpty: z.boolean().optional().describe("Creates a new MCP tab group if none exists, creates a new Window with a new tab group containing an empty tab (which can be used for this conversation). If a MCP tab group already exists, this parameter has no effect.") },
  async (args) => callTool("tabs_context_mcp", args)
);

// 2. tabs_create_mcp
server.tool(
  "tabs_create_mcp",
  "Creates a new empty tab in the MCP tab group. CRITICAL: You must get the context using tabs_context_mcp at least once before using other browser automation tools so you know what tabs exist.",
  {},
  async (args) => callTool("tabs_create_mcp", args)
);

server.tool(
  "tabs_close_mcp",
  "Close a tab in the MCP tab group, or a tab the user shared with you. To stop using a shared tab but leave it open, use tabs_release instead.",
  {
    tabId: z.number().describe("ID of the tab to close. Must be a tab in the MCP tab group, or one the user shared."),
  },
  async (args) => callTool("tabs_close_mcp", args)
);

server.tool(
  "tabs_request_access",
  "Ask the user to share some of their own open tabs with you, e.g. a page they're logged in to. Firefox shows them a list of their tabs and they choose which to share; you only learn about the tabs they share. Waits up to 50 seconds for an answer. Shared tabs then work with every tool like tabs in the MCP tab group, and appear in tabs_context_mcp. The user can also share a tab themselves (right-click it → Share Tab with Claude).",
  {
    reason: z.string().optional().describe("One short sentence, shown to the user, on what you need the tab for."),
    query: z.string().optional().describe("Text that the wanted tab's title or URL contains (e.g. 'mail.google.com'). Matching tabs are listed first; the user still chooses."),
  },
  async (args) => callTool("tabs_request_access", args)
);

server.tool(
  "tabs_request_handover",
  "Ask the user to hand tabs they shared with you over to Claude: they move out of the user's window into the MCP tab group, in Claude's own window. Use it when you need a shared tab to yourself, e.g. to resize its window, or to work in it for a while without switching the tab the user is looking at (screenshots have to show the tab). The user is asked to confirm in this app's own prompt; if the app can't show one, the result tells you to ask them in the conversation and call again with confirmed: true.",
  {
    tabIds: z.array(z.number()).min(1).describe("IDs of tabs the user shared with you."),
    reason: z.string().optional().describe("One short sentence, shown to the user, on why you need them in Claude's window."),
    confirmed: z.boolean().optional().describe("Only when this tool told you to ask in the conversation: true once the user agreed there."),
  },
  async (args) => requestHandover(args)
);

server.tool(
  "tabs_release",
  "Stop using a tab the user shared with you. It stays open; it's theirs again.",
  {
    tabId: z.number().describe("ID of a tab the user shared with you."),
  },
  async (args) => callTool("tabs_release", args)
);

server.tool(
  "handle_dialog",
  "Choose how the next JavaScript confirm() or prompt() on a page is answered. Dialogs never block your tools: alerts are acknowledged, and confirm/prompt are cancelled unless you choose otherwise here. Each one is reported in the result of the tool call during which it opened. Applies to the page currently loaded in the tab.",
  {
    tabId: z.number().describe("Tab ID of the page. Must be a tab in the current group, or one the user shared."),
    accept: z.boolean().describe("true to answer OK, false to answer Cancel."),
    promptText: z.string().optional().describe("For prompt(): the text to answer with when accept is true. Defaults to the prompt's default value."),
  },
  async (args) => callTool("handle_dialog", args)
);

// 3. navigate
server.tool(
  "navigate",
  'Navigate to a URL, or go forward/back in browser history. If you don\'t have a valid tab ID, use tabs_context_mcp first to get available tabs.',
  {
    url: z.string().describe('The URL to navigate to. Can be provided with or without protocol (defaults to https://). Use "forward" to go forward in history or "back" to go back in history.'),
    tabId: z.number().describe("Tab ID to navigate. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
  },
  async (args) => callTool("navigate", args)
);

// 4. computer
server.tool(
  "computer",
  "Use a mouse and keyboard to interact with a web browser, and take screenshots. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.\n* Whenever you intend to click on an element like an icon, you should consult a screenshot to determine the coordinates of the element before moving the cursor.\n* If you tried clicking on a program or link but it failed to load, even after waiting, try adjusting your click location so that the tip of the cursor visually falls on the element that you want to click.\n* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click boxes on their edges unless asked.",
  {
    action: z.enum([
      "left_click", "right_click", "double_click", "triple_click",
      "type", "screenshot", "wait", "scroll", "key",
      "left_click_drag", "zoom", "scroll_to", "hover"
    ]).describe('The action to perform:\n* `left_click`: Click the left mouse button at the specified coordinates.\n* `right_click`: Click the right mouse button at the specified coordinates to open context menus.\n* `double_click`: Double-click the left mouse button at the specified coordinates.\n* `triple_click`: Triple-click the left mouse button at the specified coordinates.\n* `type`: Type a string of text.\n* `screenshot`: Take a screenshot of the screen.\n* `wait`: Wait for a specified number of seconds.\n* `scroll`: Scroll up, down, left, or right at the specified coordinates.\n* `key`: Press a specific keyboard key.\n* `left_click_drag`: Drag from start_coordinate to coordinate.\n* `zoom`: Take a screenshot of a specific region for closer inspection.\n* `scroll_to`: Scroll an element into view using its element reference ID from read_page or find tools.\n* `hover`: Move the mouse cursor to the specified coordinates or element without clicking. Useful for revealing tooltips, dropdown menus, or triggering hover states.'),
    tabId: z.number().describe("Tab ID to execute the action on. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
    coordinate: z.array(z.number()).min(2).max(2).optional().describe("(x, y): The x (pixels from the left edge) and y (pixels from the top edge) coordinates. Required for `left_click`, `right_click`, `double_click`, `triple_click`, and `scroll`. For `left_click_drag`, this is the end position."),
    duration: z.number().min(0).max(30).optional().describe("The number of seconds to wait. Required for `wait`. Maximum 30 seconds."),
    modifiers: z.string().optional().describe('Modifier keys for click actions. Supports: "ctrl", "shift", "alt", "cmd" (or "meta"), "win" (or "windows"). Can be combined with "+" (e.g., "ctrl+shift", "cmd+alt"). Optional.'),
    ref: z.string().optional().describe('Element reference ID from read_page or find tools (e.g., "ref_1", "ref_2"). Required for `scroll_to` action. Can be used as alternative to `coordinate` for click actions.'),
    region: z.array(z.number()).min(4).max(4).optional().describe("(x0, y0, x1, y1): The rectangular region to capture for `zoom`. Coordinates define a rectangle from top-left (x0, y0) to bottom-right (x1, y1) in pixels from the viewport origin. Required for `zoom` action. Useful for inspecting small UI elements like icons, buttons, or text."),
    repeat: z.number().min(1).max(100).optional().describe("Number of times to repeat the key sequence. Only applicable for `key` action. Must be a positive integer between 1 and 100. Default is 1. Useful for navigation tasks like pressing arrow keys multiple times."),
    scroll_direction: z.enum(["up", "down", "left", "right"]).optional().describe("The direction to scroll. Required for `scroll`."),
    scroll_amount: z.number().min(1).max(10).optional().describe("The number of scroll wheel ticks. Optional for `scroll`, defaults to 3."),
    start_coordinate: z.array(z.number()).min(2).max(2).optional().describe("(x, y): The starting coordinates for `left_click_drag`."),
    text: z.string().optional().describe('The text to type (for `type` action) or the key(s) to press (for `key` action). For `key` action: Provide space-separated keys (e.g., "Backspace Backspace Delete"). Supports keyboard shortcuts using the platform\'s modifier key (use "cmd" on Mac, "ctrl" on Windows/Linux, e.g., "cmd+a" or "ctrl+a" for select all).'),
  },
  async (args) => callTool("computer", args)
);

// 5. find
server.tool(
  "find",
  'Find elements on the page using natural language. Can search for elements by their purpose (e.g., "search bar", "login button") or by text content (e.g., "organic mango product"). Returns up to 20 matching elements with references that can be used with other tools. If more than 20 matches exist, you\'ll be notified to use a more specific query. If you don\'t have a valid tab ID, use tabs_context_mcp first to get available tabs.',
  {
    query: z.string().describe('Natural language description of what to find (e.g., "search bar", "add to cart button", "product title containing organic")'),
    tabId: z.number().describe("Tab ID to search in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
  },
  async (args) => callTool("find", args)
);

// 6. form_input
server.tool(
  "form_input",
  "Set values in form elements using element reference ID from the read_page tool. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
  {
    ref: z.string().describe('Element reference ID from the read_page tool (e.g., "ref_1", "ref_2")'),
    value: z.union([z.string(), z.boolean(), z.number()]).describe("The value to set. For checkboxes use boolean, for selects use option value or text, for other inputs use appropriate string/number"),
    tabId: z.number().describe("Tab ID to set form value in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
  },
  async (args) => callTool("form_input", args)
);

// 7. get_page_text
server.tool(
  "get_page_text",
  "Extract raw text content from the page, prioritizing article content. Ideal for reading articles, blog posts, or other text-heavy pages. Returns plain text without HTML formatting. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
  {
    tabId: z.number().describe("Tab ID to extract text from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
  },
  async (args) => callTool("get_page_text", args)
);

// 8. gif_creator
server.tool(
  "gif_creator",
  "Manage GIF recording and export for browser automation sessions. Control when to start/stop recording browser actions (clicks, scrolls, navigation), then export as an animated GIF with visual overlays (click indicators, action labels, progress bar, watermark). All operations are scoped to the tab's group. When starting recording, take a screenshot immediately after to capture the initial state as the first frame. When stopping recording, take a screenshot immediately before to capture the final state as the last frame. For export, either provide 'coordinate' to drag/drop upload to a page element, or set 'download: true' to download the GIF.",
  {
    action: z.enum(["start_recording", "stop_recording", "export", "clear"]).describe("Action to perform: 'start_recording' (begin capturing), 'stop_recording' (stop capturing but keep frames), 'export' (generate and export GIF), 'clear' (discard frames)"),
    tabId: z.number().describe("Tab ID to identify which tab group this operation applies to"),
    download: z.boolean().optional().describe("Always set this to true for the 'export' action only. This causes the gif to be downloaded in the browser."),
    filename: z.string().optional().describe("Optional filename for exported GIF (default: 'recording-[timestamp].gif'). For 'export' action only."),
    options: z.object({
      showClickIndicators: z.boolean().optional().describe("Show orange circles at click locations (default: true)"),
      showDragPaths: z.boolean().optional().describe("Show red arrows for drag actions (default: true)"),
      showActionLabels: z.boolean().optional().describe("Show black labels describing actions (default: true)"),
      showProgressBar: z.boolean().optional().describe("Show orange progress bar at bottom (default: true)"),
      showWatermark: z.boolean().optional().describe("Show Claude logo watermark (default: true)"),
      quality: z.number().optional().describe("GIF compression quality, 1-30 (lower = better quality, slower encoding). Default: 10"),
    }).optional().describe("Optional GIF enhancement options for 'export' action. Properties: showClickIndicators (bool), showDragPaths (bool), showActionLabels (bool), showProgressBar (bool), showWatermark (bool), quality (number 1-30). All default to true except quality (default: 10)."),
  },
  async (args) => callTool("gif_creator", args)
);

// 9. javascript_tool
server.tool(
  "javascript_tool",
  "Execute JavaScript code in the context of the current page. The code runs in the page's context and can interact with the DOM, window object, and page variables. Returns the result of the last expression (or of `return`) or any thrown errors. Top-level `await` works. Cookie strings, tokens and values stored under names like password, token, secret or session are hidden from the result. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
  {
    action: z.literal("javascript_exec").describe("Must be set to 'javascript_exec'"),
    text: z.string().describe("The JavaScript code to execute. The code will be evaluated in the page context. The result of the last expression will be returned automatically (e.g., 'window.myData.value'); 'return' and top-level 'await' also work. You can access and modify the DOM, call page functions, and interact with page variables."),
    tabId: z.number().describe("Tab ID to execute the code in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
    timeout: z.number().optional().describe("Seconds to wait for the result (default 30, max 50). A script still running after that is reported as timed out."),
  },
  async (args) => callTool("javascript_tool", args)
);

// 10. read_console_messages
server.tool(
  "read_console_messages",
  "Read browser console messages (console.log, console.error, console.warn, etc.), uncaught errors and unhandled promise rejections from a specific tab. Useful for debugging JavaScript errors, viewing application logs, or understanding what's happening in the browser console. Returns console messages from the current page only, recorded since you started using the tab. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs. IMPORTANT: Always provide a pattern to filter messages - without a pattern, you may get too many irrelevant messages.",
  {
    tabId: z.number().describe("Tab ID to read console messages from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
    pattern: z.string().optional().describe("Regex pattern to filter console messages. Only messages matching this pattern will be returned (e.g., 'error|warning' to find errors and warnings, 'MyApp' to filter app-specific logs). You should always provide a pattern to avoid getting too many irrelevant messages."),
    limit: z.number().optional().describe("Maximum number of messages to return. Defaults to 100. Increase only if you need more results."),
    onlyErrors: z.boolean().optional().describe("If true, only return error and exception messages. Default is false (return all message types)."),
    clear: z.boolean().optional().describe("If true, clear the console messages after reading to avoid duplicates on subsequent calls. Default is false."),
  },
  async (args) => callTool("read_console_messages", args)
);

// 11. read_network_requests
server.tool(
  "read_network_requests",
  "Read HTTP network requests (XHR, Fetch, documents, images, etc.) from a specific tab. Useful for debugging API calls, monitoring network activity, or understanding what requests a page is making. Returns all network requests made by the current page, including cross-origin requests. Requests are automatically cleared when the page navigates to a different domain. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
  {
    tabId: z.number().describe("Tab ID to read network requests from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
    urlPattern: z.string().optional().describe("Optional URL pattern to filter requests. Only requests whose URL contains this string will be returned (e.g., '/api/' to filter API calls, 'example.com' to filter by domain)."),
    limit: z.number().optional().describe("Maximum number of requests to return. Defaults to 100. Increase only if you need more results."),
    clear: z.boolean().optional().describe("If true, clear the network requests after reading to avoid duplicates on subsequent calls. Default is false."),
  },
  async (args) => callTool("read_network_requests", args)
);

// 12. read_page
server.tool(
  "read_page",
  "Get an accessibility tree representation of elements on the page. By default returns all elements including non-visible ones. Output is limited to 50000 characters by default. If the output exceeds this limit, you will receive an error asking you to specify a smaller depth or focus on a specific element using ref_id. Optionally filter for only interactive elements. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
  {
    tabId: z.number().describe("Tab ID to read from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
    filter: z.enum(["interactive", "all"]).optional().describe('Filter elements: "interactive" for buttons/links/inputs only, "all" for all elements including non-visible ones (default: all elements)'),
    depth: z.number().optional().describe("Maximum depth of the tree to traverse (default: 15). Use a smaller depth if output is too large."),
    ref_id: z.string().optional().describe("Reference ID of a parent element to read. Will return the specified element and all its children. Use this to focus on a specific part of the page when output is too large."),
    max_chars: z.number().optional().describe("Maximum characters for output (default: 50000). Set to a higher value if your client can handle large outputs."),
  },
  async (args) => callTool("read_page", args)
);

// 13. resize_window
server.tool(
  "resize_window",
  "Resize the current browser window to specified dimensions. Useful for testing responsive designs or setting up specific screen sizes. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
  {
    width: z.number().describe("Target window width in pixels"),
    height: z.number().describe("Target window height in pixels"),
    tabId: z.number().describe("Tab ID to get the window for. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
  },
  async (args) => callTool("resize_window", args)
);

// 14. shortcuts_list
server.tool(
  "shortcuts_list",
  "List all available shortcuts and workflows (shortcuts and workflows are interchangeable). Returns shortcuts with their commands, descriptions, and whether they are workflows. Use shortcuts_execute to run a shortcut or workflow.",
  {
    tabId: z.number().describe("Tab ID to list shortcuts from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
  },
  async (args) => callTool("shortcuts_list", args)
);

// 15. shortcuts_execute
server.tool(
  "shortcuts_execute",
  "Execute a shortcut or workflow by running it in a new sidepanel window using the current tab (shortcuts and workflows are interchangeable). Use shortcuts_list first to see available shortcuts. This starts the execution and returns immediately - it does not wait for completion.",
  {
    tabId: z.number().describe("Tab ID to execute the shortcut on. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
    shortcutId: z.string().optional().describe("The ID of the shortcut to execute"),
    command: z.string().optional().describe("The command name of the shortcut to execute (e.g., 'debug', 'summarize'). Do not include the leading slash."),
  },
  async (args) => callTool("shortcuts_execute", args)
);

// 16. switch_browser
server.tool(
  "switch_browser",
  "Switch which Firefox browser is used for browser automation. Call this when the user wants to connect to a different Firefox browser.",
  {},
  async (args) => callTool("switch_browser", args)
);

// 17. update_plan
server.tool(
  "update_plan",
  "Present a plan to the user for approval before taking actions. The user will see the domains you intend to visit and your approach. Once approved, you can proceed with actions on the approved domains without additional permission prompts.",
  {
    domains: z.array(z.string()).describe("List of domains you will visit (e.g., ['github.com', 'stackoverflow.com']). These domains will be approved for the session when the user accepts the plan."),
    approach: z.array(z.string()).describe("High-level description of what you will do. Focus on outcomes and key actions, not implementation details. Be concise - aim for 3-7 items."),
  },
  async (args) => callTool("update_plan", args)
);

// 18. upload_image
server.tool(
  "upload_image",
  "Upload a previously captured screenshot or user-uploaded image to a file input or drag & drop target. Supports two approaches: (1) ref - for targeting specific elements, especially hidden file inputs, (2) coordinate - for drag & drop to visible locations like Google Docs. Provide either ref or coordinate, not both.",
  {
    imageId: z.string().describe("ID of a previously captured screenshot (from the computer tool's screenshot action) or a user-uploaded image"),
    tabId: z.number().describe("Tab ID where the target element is located. This is where the image will be uploaded to."),
    ref: z.string().optional().describe('Element reference ID from read_page or find tools (e.g., "ref_1", "ref_2"). Use this for file inputs (especially hidden ones) or specific elements. Provide either ref or coordinate, not both.'),
    coordinate: z.array(z.number()).optional().describe("Viewport coordinates [x, y] for drag & drop to a visible location. Use this for drag & drop targets like Google Docs. Provide either ref or coordinate, not both."),
    filename: z.string().optional().describe('Optional filename for the uploaded file (default: "image.png")'),
  },
  async (args) => callTool("upload_image", args)
);

// --- Start MCP server ---

const transport = new StdioServerTransport();
await server.connect(transport);
