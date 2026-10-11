<p align="center">
  <img src="extension/icons/icon128.png" width="96" alt="Claude MCP in Fayar kitsune">
</p>

<h1 align="center">Claude MCP in Fayar kitsune</h1>

<p align="center">
  <em>Official Claude in Chrome gives you 58 blocked domains and two browsers.<br/>
  <strong>Claude MCP in Fayar kitsune gives you the whole web — in Firefox.</strong></em>
  <br/>
  <sub>Firefox port of the open-source Claude browser automation extension. No blocklist. Full MCP tool parity.</sub>
</p>

<p align="center">
  <a href="#whats-different">What's different</a> ·
  <a href="#installation">Install</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#firefox-notes">Firefox notes</a>
</p>

---

This is a Firefox port of [open-claude-in-chrome](https://github.com/noemica-io/open-claude-in-chrome), a clean-room reimplementation of Anthropic's [Claude in Chrome](https://code.claude.com/docs/en/chrome) extension, forked from [beto621/open-claude-in-firefox](https://github.com/beto621/open-claude-in-firefox). It gives Claude Code (and Claude Desktop) full browser automation via 18 MCP tools, without any domain restrictions, running in Firefox instead of Chromium.

## What's Different

| | Claude in Chrome (official) | Claude MCP in Fayar kitsune |
|---|---|---|
| **Domain blocklist** | 58 blocked domains across 11 categories | No blocklist. Navigate anywhere. |
| **Browser** | Chrome and Edge only | Firefox |
| **Source code** | Closed source | Open source (MIT) |
| **Tools** | 18 MCP tools | Same 18 MCP tools |
| **Automation method** | Chrome DevTools Protocol (CDP) | Firefox WebExtension APIs |

### Blocked Domains in the Official Extension

| Category | Blocked Sites |
|----------|--------------|
| Banking | Chase, BofA, Wells Fargo, Citibank |
| Investing/Brokerage | Schwab, Fidelity, Robinhood, E-Trade, Wealthfront, Betterment |
| Payments/Transfers | PayPal, Venmo, Cash App, Zelle, Stripe, Square, Wise, Western Union, MoneyGram, Adyen, Checkout.com |
| BNPL | Klarna, Affirm, Afterpay |
| Neobanks/Fintech | SoFi, Chime, Mercury, Brex, Ramp |
| Crypto | Coinbase, Binance, Kraken, MetaMask |
| Gambling | DraftKings, FanDuel, Bet365, Bovada, PokerStars, BetMGM, Caesars |
| Dating | Tinder, Bumble, Hinge, Match, OKCupid |
| Adult | Pornhub, XVideos, XNXX |
| News/Media | NYT, WSJ, Barron's, MarketWatch, Bloomberg, Reuters, Economist, Wired, Vogue |
| Social Media | Reddit |

Claude MCP in Fayar kitsune has **none of these restrictions**.

## Architecture

```
Claude Code / Claude Desktop <--stdio MCP--> mcp-server.js <--WebSocket 127.0.0.1:18765--> Extension <--> Firefox
```

Two components:
1. **Extension** — Manifest V3 using Firefox WebExtension APIs (screenshots via `captureVisibleTab`, input via content script synthetic events, JS eval via `scripting.executeScript`). Connects to the MCP server over a localhost WebSocket.
2. **MCP Server** — Node.js process started by Claude Code or Claude Desktop, exposes tools via MCP. Only accepts WebSocket connections from `moz-extension://` origins, so web pages can't drive it.

No native messaging host, registry keys or install script: the extension finds the server by its fixed port.

### Security

- **Web pages can't connect.** The server only accepts WebSocket connections whose origin is `moz-extension://`, and pages can't fake that header.
- **Other Firefox add-ons can.** Every add-on has a `moz-extension://` origin, and the server doesn't check which add-on is connecting. If another add-on in the same Firefox profile connects first, it takes the server's single browser slot. It would then see the tool requests Claude sends (URLs, text to type, JavaScript to run) and could send fake results back to Claude. It can't use that connection to control the browser. Use a Firefox profile with only add-ons you trust.
- **Programs on your computer can.** Anything running as your user can connect to `127.0.0.1:18765` and send tool requests, the same way a second Claude session does. Such a program already has your user's access to the machine, so this adds little, but it's worth knowing.

## Installation

### Prerequisites

- **Firefox** 142+
- **Claude Desktop** and/or **Claude Code** v2.0.73+
- **Node.js** v18+, only for installing from source or using Claude Code (Claude Desktop runs the `.mcpb` with its own built-in Node.js)

There are two parts to install: the **Firefox extension** and the **MCP server** that Claude talks to. Get both from Releases, or build them from source.

### 1. From Releases

Signed builds are on the [Releases](https://github.com/xiangyann/open-claude-in-fayarkitsune/releases) page. There are no automatic updates, so check there for new versions.

#### Firefox extension (`.xpi`)

Download the `.xpi` from the [latest release](https://github.com/xiangyann/open-claude-in-fayarkitsune/releases/latest). GitHub only downloads the file, so install it yourself: drag it onto a Firefox window, or `about:addons` → gear icon → **Install Add-on From File...**

#### Claude Desktop (`.mcpb`)

1. Download the `.mcpb` from the [latest release](https://github.com/xiangyann/open-claude-in-fayarkitsune/releases/latest).
2. In Claude Desktop, click your profile in the bottom-left corner → **Settings** → **Extensions**.
3. Drag the `.mcpb` file onto the drop area there and confirm the install.

Double-clicking the file usually doesn't work, because Claude Desktop often doesn't register the `.mcpb` file type. The bundle carries its own dependencies and runs on Claude Desktop's built-in Node.js, so nothing else needs installing.

Releases have nothing to install for Claude Code: follow [From source → Claude Code](#claude-code) for the server.

### 2. From source

Clone the repo first:

```bash
git clone https://github.com/xiangyann/open-claude-in-fayarkitsune
cd open-claude-in-fayarkitsune
```

#### Firefox extension

Pick one of these.

##### Temporary (any Firefox)

`about:debugging` → **This Firefox** → **Load Temporary Add-on...** → select `extension/manifest.json`. Firefox removes temporary add-ons when it restarts, so you'll repeat this after each restart.

##### Permanent: sign your own copy

Release Firefox only installs add-ons signed by Mozilla. Signing as **unlisted** is free, automated, and doesn't publish anything on addons.mozilla.org:

1. Change `browser_specific_settings.gecko.id` in `extension/manifest.json` to an ID of your own, e.g. `claude-mcp@yourname`. Add-on IDs are unique on AMO, and the current one belongs to the maintainer's account.
2. Create API credentials at [addons.mozilla.org/developers/addon/api/key](https://addons.mozilla.org/developers/addon/api/key/).
3. Sign:
   ```bash
   npx web-ext sign -s extension --channel=unlisted --api-key=YOUR_JWT_ISSUER --api-secret=YOUR_JWT_SECRET
   ```
4. Install the `.xpi` it saves in `web-ext-artifacts/`: `about:addons` → gear icon → **Install Add-on From File...**

##### Permanent: unsigned, on Firefox Developer Edition, Nightly or ESR

Those builds can turn off the signature check (release and beta Firefox ignore it):

1. In `about:config`, set `xpinstall.signatures.required` to `false`.
2. Build: `npx web-ext build -s extension`
3. Install the `.zip` from `web-ext-artifacts/`: `about:addons` → gear icon → **Install Add-on From File...**

#### Claude Desktop (`.mcpb`)

Build the bundle:

```bash
cd host
npm install
npx @anthropic-ai/mcpb pack . ../open-claude-in-fayarkitsune.mcpb
```

This writes `open-claude-in-fayarkitsune.mcpb` to the repo root. Install it like the release file: Claude Desktop → your profile in the bottom-left corner → **Settings** → **Extensions**, then drag the file onto the drop area.

#### Claude Code

```bash
cd host
npm install
claude mcp add open-claude-in-fayarkitsune -- node "$(pwd)/mcp-server.js"
```

On Windows PowerShell, use `"$PWD\mcp-server.js"` for the path.

### Permissions

However you installed the extension, a setup page opens with its permissions. You can reopen it any time from the toolbar button, which shows a red **!** while website access is missing:

- **Access to all websites** (required): read pages, take screenshots, click and type. It's in Firefox's install prompt, but you can revoke it later.
- **User scripts** (optional, Firefox 153+): lets `javascript_tool` run on sites whose Content Security Policy blocks `eval()`, such as reddit.com. Firefox only allows this permission to be granted from a click, so it can't be part of the install prompt.

That's it. The extension connects to the server on its own whenever Claude is running.

### Upgrading from extension 1.0.0

1.1.0 has a different add-on ID (`open-claude-in-fayarkitsune@anthropic`) from the original 1.0.0 (`open-claude-in-firefox@anthropic`), so Firefox installs it alongside 1.0.0 instead of updating it. **Remove 1.0.0 in `about:addons` before starting 1.1.0.** The server takes one browser at a time, so if both are enabled, whichever connects first wins and the other is refused.

Extension 1.0.0 reached the server through a native messaging host (`host/native-host.js`, registered by `install.sh` or the registry). 1.1.0 connects directly, so the host is no longer used. Once you've removed 1.0.0, also remove the old host registration:

- **Windows**: `reg delete HKCU\Software\Mozilla\NativeMessagingHosts\com.anthropic.open_claude_in_firefox /f`
- **macOS**: `rm ~/Library/Application\ Support/Mozilla/NativeMessagingHosts/com.anthropic.open_claude_in_firefox.json`
- **Linux**: `rm ~/.mozilla/native-messaging-hosts/com.anthropic.open_claude_in_firefox.json`

## Verification

Start a new Claude Code (or Claude Desktop) session and test:

```
Navigate to reddit.com and take a screenshot
```

Reddit loads. No domain restriction.

## Available Tools

All 18 tools, matching the Claude in Chrome interface:

| Tool | Description |
|------|-------------|
| `tabs_context_mcp` | Get MCP window tab context |
| `tabs_create_mcp` | Create new tab in MCP window |
| `navigate` | Navigate to URL, back, forward |
| `computer` | Mouse, keyboard, screenshots (13 actions) |
| `read_page` | Accessibility tree with element refs |
| `get_page_text` | Extract article/main text |
| `find` | Find elements by text/purpose |
| `form_input` | Set form values by ref |
| `javascript_tool` | Execute JS in page context |
| `read_console_messages` | Console output (filtered) |
| `read_network_requests` | Network activity |
| `resize_window` | Resize browser window |
| `upload_image` | Not supported in Firefox WebExtensions |
| `gif_creator` | GIF recording (stub) |
| `shortcuts_list` | List shortcuts (stub) |
| `shortcuts_execute` | Run shortcut (stub) |
| `switch_browser` | Switch browser (stub) |
| `update_plan` | Present plan (auto-approved) |

## Firefox Notes

### Tab groups → MCP window

The Chrome version uses tab groups to track Claude's tabs. Firefox has no tab groups API, so this extension instead opens a dedicated **MCP window**. All tabs Claude creates live in that window. The window ID is saved to extension storage and recovered automatically after Firefox restarts or the service worker is reloaded.

### Synthetic events

Firefox WebExtensions cannot use the Chrome DevTools Protocol. Mouse clicks, keyboard input, and scrolling are dispatched as synthetic DOM events from a content script. These events have `isTrusted: false`, which means:

- Most web apps work fine — synthetic events are standard practice for testing frameworks
- A small number of hardened apps check `event.isTrusted` and ignore synthetic events; those interactions will fail silently

### Screenshots

`tabs.captureVisibleTab()` can only capture the active tab in a window. The extension automatically activates the target tab before each screenshot. If the MCP window is in the background, the tab switch is invisible since Firefox doesn't require the window to be focused.

### Content security policy

The manifest sets the `extension_pages` CSP to `script-src 'self'`. This drops Firefox's Manifest V3 default `upgrade-insecure-requests`, so the `ws://127.0.0.1` connection isn't upgraded to `wss://`.

### Console monitoring

Console messages are captured via a MAIN-world interceptor injected into the page. Messages logged **before** `read_console_messages` is first called on a tab are not captured. Call `read_console_messages` early in a session to start capturing.

## Updating After Code Changes

No build step. All files are plain JavaScript. After pulling or editing:

| What changed | What to do |
|---|---|
| `extension/background.js`, `content.js`, or `manifest.json` | Reload: `about:debugging` → click the reload icon next to the extension |
| `host/mcp-server.js` (Claude Code) | Kill stale servers and reconnect: `pkill -f "node.*mcp-server"` then `/mcp` in Claude Code |
| `host/mcp-server.js` (Claude Desktop) | Rebuild the `.mcpb` (bump `version` in `host/manifest.json`) and install it again |

### Quick reset

If things are broken and you're not sure why:

```bash
# 1. Kill all MCP servers
pkill -f "node.*mcp-server"

# 2. Reload extension in about:debugging

# 3. Reconnect in Claude Code
# /mcp
```

## Multiple Sessions

Multiple Claude Code sessions can share the same browser extension. The first session becomes the "primary" (owns the TCP port), and subsequent sessions connect as clients through the primary.

If a session disconnects, kill stale servers and reconnect:

```bash
pkill -f "node.*mcp-server"
# then /mcp in each Claude Code session
```

## Troubleshooting

### MCP server not found

Use an absolute path:
```bash
claude mcp add open-claude-in-fayarkitsune -- node /absolute/path/to/host/mcp-server.js
```

### "Browser extension is not connected"

The MCP server is running but the extension hasn't connected. The extension retries with a backoff of up to 10 seconds, so wait a moment first. Then:
1. Verify the extension is installed and enabled in `about:addons`
2. Check the extension's logs: `about:debugging` → **This Firefox** → **Inspect** next to the extension. Connection errors for `ws://127.0.0.1:18765` show up in its console.
3. Make sure no older server (from 1.0.0) is holding the port: `pkill -f "node.*mcp-server"`, then reconnect

### Tools fail immediately after reconnect

Stale MCP server processes from previous sessions may be holding the port:

```bash
pkill -f "node.*mcp-server"
```

Then `/mcp` in Claude Code to reconnect.

### Port conflict

Default port is 18765. To change:
1. Create `~/.config/open-claude-in-firefox/config.json`:
   ```json
   { "port": 19000 }
   ```
2. Change `SERVER_URL` in `extension/background.js` to match, and reload (or re-sign) the extension
3. Restart Claude

## License

MIT
