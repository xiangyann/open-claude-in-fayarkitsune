// The window Claude opens with tabs_request_access: the user picks which of
// their tabs to share. The list of tabs stays here; Claude only learns about
// the ones that are shared.

const requestId = location.hash.slice(1);
const list = document.getElementById("tabs");
const shareButton = document.getElementById("share");

// "mail.example.com" for display; file: URLs keep their path.
const siteName = (url) => (URL.canParse(url) && new URL(url).hostname) || url;

function render({ reason, query, tabs }) {
  if (reason) {
    const el = document.getElementById("reason");
    el.textContent = reason;
    el.hidden = false;
  }

  // Tabs that match what Claude asked for come first, highlighted, but none
  // are selected for the user.
  const q = (query || "").toLowerCase();
  const matches = (t) => q !== "" && `${t.title} ${t.url}`.toLowerCase().includes(q);
  tabs.sort((a, b) => matches(b) - matches(a));

  if (!tabs.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "None of your open tabs can be shared (only web pages can).";
    list.append(li);
    return;
  }

  for (const tab of tabs) {
    const li = document.createElement("li");
    if (matches(tab)) li.className = "match";
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = tab.id;
    box.addEventListener("change", () => {
      shareButton.disabled = !list.querySelector("input:checked");
    });
    const icon = document.createElement("img");
    icon.alt = "";
    icon.src = tab.favIconUrl && /^(https?|data):/.test(tab.favIconUrl) ? tab.favIconUrl : "icons/icon16.png";
    const text = document.createElement("div");
    text.className = "tab-text";
    const title = document.createElement("div");
    title.className = "tab-title";
    title.textContent = tab.title || siteName(tab.url);
    const url = document.createElement("div");
    url.className = "tab-url";
    url.textContent = siteName(tab.url);
    text.append(title, url);
    label.append(box, icon, text);
    li.append(label);
    list.append(li);
  }
}

async function decide(tabIds) {
  let answer = null;
  try {
    answer = await chrome.runtime.sendMessage({ type: "shareDecision", requestId, tabIds });
  } catch {}
  if (answer?.ok || !tabIds.length) {
    window.close();
    return;
  }
  // The request is gone (the extension restarted, say): say so rather than
  // closing as if the tabs were shared.
  document.querySelector("header p").textContent =
    "This request has expired, so nothing was shared. To share a tab, right-click it and choose Share Tab with Claude.";
  shareButton.hidden = true;
}

shareButton.addEventListener("click", () => {
  const ids = [...list.querySelectorAll("input:checked")].map((box) => Number(box.value));
  decide(ids);
});
document.getElementById("decline").addEventListener("click", () => decide([]));

chrome.runtime.sendMessage({ type: "getShareRequest", requestId }).then((request) => {
  if (!request || request.missing) {
    document.querySelector("header p").textContent = "This request has expired.";
    shareButton.hidden = true;
    return;
  }
  render(request);
});
