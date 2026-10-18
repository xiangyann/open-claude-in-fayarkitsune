// Content script for Claude MCP in Fayar kitsune extension.
// Injected into every page at document_start. Provides:
// - Accessibility tree generation (read_page)
// - Element ref mapping with WeakRef (persistent across calls)
// - Form input handling
// - Page text extraction
// - Element finding by text/attributes
// - Synthetic mouse, keyboard and scroll input
// - The glow shown while Claude works in the tab

(function () {
  if (window.__openClaudeInFirefoxLoaded) return;
  window.__openClaudeInFirefoxLoaded = true;

  // --- Element reference map ---
  // Persistent ref IDs stored as WeakRefs so GC still works
  let refCounter = 0;
  const elementMap = {}; // refId -> WeakRef<Element>
  const reverseMap = new WeakMap(); // Element -> refId

  function getOrAssignRef(el) {
    const existing = reverseMap.get(el);
    if (existing && elementMap[existing]?.deref() === el) return existing;
    const ref = `ref_${++refCounter}`;
    elementMap[ref] = new WeakRef(el);
    reverseMap.set(el, ref);
    return ref;
  }

  function resolveRef(refId) {
    const wr = elementMap[refId];
    if (!wr) return null;
    const el = wr.deref();
    if (!el) {
      delete elementMap[refId];
      return null;
    }
    return el;
  }

  // --- ARIA role mapping ---
  const TAG_TO_ROLE = {
    a: "link",
    button: "button",
    input: "textbox",
    textarea: "textbox",
    select: "combobox",
    img: "img",
    h1: "heading",
    h2: "heading",
    h3: "heading",
    h4: "heading",
    h5: "heading",
    h6: "heading",
    nav: "navigation",
    main: "main",
    header: "banner",
    footer: "contentinfo",
    aside: "complementary",
    form: "form",
    table: "table",
    tr: "row",
    th: "columnheader",
    td: "cell",
    ul: "list",
    ol: "list",
    li: "listitem",
    dialog: "dialog",
    details: "group",
    summary: "button",
    progress: "progressbar",
    meter: "meter",
    video: "video",
    audio: "audio",
    section: "region",
    article: "article",
  };

  function getRole(el) {
    if (el.getAttribute("role")) return el.getAttribute("role");
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const type = (el.type || "text").toLowerCase();
      const typeRoles = {
        checkbox: "checkbox",
        radio: "radio",
        range: "slider",
        button: "button",
        submit: "button",
        reset: "button",
        search: "searchbox",
        number: "spinbutton",
      };
      return typeRoles[type] || "textbox";
    }
    return TAG_TO_ROLE[tag] || null;
  }

  // --- Accessible name ---
  // On one line: text from the page keeps its source's newlines and
  // indentation.
  function getAccessibleName(el) {
    return nameFromPage(el).replace(/\s+/g, " ").trim();
  }

  function nameFromPage(el) {
    // Priority: aria-label > aria-labelledby > placeholder > title > alt > label > text
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim();

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const names = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean);
      if (names.length) return names.join(" ");
    }

    // Attributes, not properties: on a <form>, el.title or el.placeholder is
    // the form control *named* "title" or "placeholder", if there is one.
    for (const attr of ["placeholder", "title", "alt"]) {
      const value = el.getAttribute(attr)?.trim();
      if (value) return value;
    }

    // Associated <label>
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.textContent.trim();
    }
    if (el.closest("label")) {
      const labelText = el.closest("label").textContent.trim();
      if (labelText) return labelText;
    }

    // Direct text content (only for leaf-ish elements)
    const tag = el.tagName.toLowerCase();
    if (["a", "button", "h1", "h2", "h3", "h4", "h5", "h6", "li", "summary", "label", "th", "td", "span"].includes(tag)) {
      const text = el.textContent?.trim();
      if (text && text.length < 200) return text;
    }

    return "";
  }

  // --- Interactivity check ---
  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (["a", "button", "input", "textarea", "select", "summary", "details"].includes(tag)) return true;
    if (el.getAttribute("role") && ["button", "link", "textbox", "checkbox", "radio", "tab", "menuitem", "switch", "combobox", "slider", "spinbutton", "searchbox", "option"].includes(el.getAttribute("role"))) return true;
    if (el.tabIndex >= 0) return true;
    if (el.onclick || el.getAttribute("onclick")) return true;
    if (el.contentEditable === "true") return true;
    return false;
  }

  // --- Visibility check ---
  function isVisible(el) {
    if (el.offsetParent === null && el.tagName.toLowerCase() !== "body" && getComputedStyle(el).position !== "fixed") return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return true;
  }

  // --- Accessibility tree generation ---
  function generateAccessibilityTree(options = {}) {
    const filter = options.filter || "all";
    const maxDepth = options.depth || 15;
    const maxChars = options.max_chars || 50000;
    const startRefId = options.ref_id || null;

    let output = "";
    let charCount = 0;
    let truncated = false;

    function append(text) {
      if (truncated) return false;
      if (charCount + text.length > maxChars) {
        output += text.substring(0, maxChars - charCount);
        output += "\n... (truncated)";
        truncated = true;
        return false;
      }
      output += text;
      charCount += text.length;
      return true;
    }

    function walk(el, depth, indent) {
      if (truncated) return;
      if (depth > maxDepth) return;
      if (!el || el.nodeType !== 1) return;

      const tag = el.tagName.toLowerCase();
      // Skip invisible, script, style, svg internals
      if (["script", "style", "noscript", "template"].includes(tag)) return;

      const role = getRole(el);
      const name = getAccessibleName(el);
      const interactive = isInteractive(el);
      const visible = isVisible(el);

      // Filter: if interactive-only mode, skip non-interactive non-container elements
      const isContainer = el.children.length > 0;
      if (filter === "interactive" && !interactive && !isContainer) return;

      const shouldShow =
        (filter === "all" && (role || name)) ||
        (filter === "interactive" && interactive);

      if (shouldShow && visible) {
        const ref = getOrAssignRef(el);
        let line = `${indent}`;

        if (role) line += `${role}`;
        if (name) line += ` "${name.substring(0, 100)}"`;
        line += ` [${ref}]`;

        // Extra info for specific elements
        if (tag === "a" && el.href) line += ` href="${el.href}"`;
        if (tag === "img" && el.src) line += ` src="${el.src.substring(0, 100)}"`;
        if (["input", "textarea"].includes(tag) && el.value) {
          // A password (often filled in by Firefox) isn't shown, only that
          // there is one; nor are card numbers and one-time codes.
          const secret = el.type === "password" ||
            /^(cc-number|cc-csc|one-time-code|current-password|new-password)$/.test(el.getAttribute("autocomplete") || "");
          line += secret ? ` value="[hidden]"` : ` value="${el.value.substring(0, 100)}"`;
        }
        if (tag === "input") line += ` type="${el.type || "text"}"`;
        if (el.getAttribute("aria-expanded")) line += ` expanded=${el.getAttribute("aria-expanded")}`;
        if (el.getAttribute("aria-checked")) line += ` checked=${el.getAttribute("aria-checked")}`;
        if (el.getAttribute("aria-selected")) line += ` selected=${el.getAttribute("aria-selected")}`;
        if (el.disabled === true) line += " disabled";

        // Select options
        if (tag === "select") {
          const opts = Array.from(el.options).map(
            (o) => `${o.selected ? "*" : " "}${o.value}="${o.textContent.trim()}"`
          );
          if (opts.length) line += ` options=[${opts.join(", ")}]`;
        }

        if (!append(line + "\n")) return;
      }

      // Recurse children (including shadow DOM)
      const nextIndent = shouldShow && visible ? indent + "  " : indent;
      if (el.shadowRoot) {
        for (const child of el.shadowRoot.children) {
          walk(child, depth + 1, nextIndent);
        }
      }
      for (const child of el.children) {
        walk(child, depth + 1, nextIndent);
      }
    }

    let root = document.body;
    if (startRefId) {
      const el = resolveRef(startRefId);
      if (el) root = el;
      else return `Error: ref_id "${startRefId}" not found or element was garbage collected.`;
    }

    walk(root, 0, "");
    return output;
  }

  // --- Page text extraction ---
  function getPageText() {
    const selectors = [
      "article",
      "main",
      '[class*="articleBody"]',
      '[class*="post-content"]',
      '[class*="entry-content"]',
      '[role="main"]',
      ".content",
      "#content",
    ];
    // A selector can match several elements. When the others are all inside
    // the first one (comments in a post, say), that's the content; when
    // they're side by side (a feed of <article>s), none of them is, and the
    // next selector is tried.
    let source = null;
    for (const sel of selectors) {
      const [first, ...rest] = document.querySelectorAll(sel);
      if (first && rest.every((el) => first.contains(el))) {
        source = first;
        break;
      }
    }
    if (!source) source = document.body;

    const title = document.title || "";
    const url = location.href;
    const tag = source.tagName.toLowerCase();

    // Clean text: remove script/style content, collapse whitespace
    const clone = source.cloneNode(true);
    clone.querySelectorAll("script, style, noscript, template, svg").forEach((el) => el.remove());
    const text = clone.textContent.replace(/\s+/g, " ").trim();

    return JSON.stringify({ title, url, sourceTag: tag, text: text.substring(0, 100000) });
  }

  // --- Element finding ---
  function findElements(query) {
    const q = query.toLowerCase();
    const results = [];

    // Collect all elements including those inside shadow roots
    function collectAll(root) {
      const elements = [];
      for (const el of root.querySelectorAll("*")) {
        if (el === glowHost) continue; // the extension's own overlay
        elements.push(el);
        if (el.shadowRoot) {
          elements.push(...collectAll(el.shadowRoot));
        }
      }
      return elements;
    }

    const all = collectAll(document);

    for (const el of all) {
      if (results.length >= 20) break;
      if (!isVisible(el)) continue;

      const tag = el.tagName.toLowerCase();
      if (["script", "style", "noscript", "template"].includes(tag)) continue;

      const role = getRole(el) || "";
      const name = getAccessibleName(el) || "";
      const text = el.textContent?.trim()?.substring(0, 200) || "";
      // Attributes, not properties (see getAccessibleName).
      const attrs = ["placeholder", "aria-label", "title", "type"].map((a) => el.getAttribute(a) || "");

      const searchable = `${role} ${name} ${text} ${attrs.join(" ")} ${tag}`.toLowerCase();

      if (searchable.includes(q)) {
        const ref = getOrAssignRef(el);
        const rect = el.getBoundingClientRect();
        const center = [Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2)];
        results.push({
          ref,
          role: role || tag,
          name: name || text.substring(0, 80),
          coordinates: center,
          offscreen: !inViewport(...center),
        });
      }
    }
    return results;
  }

  // --- Form input ---

  // Find the actual input/textarea/select inside an element, traversing shadow DOM
  function findInputInside(el) {
    const tag = el.tagName.toLowerCase();
    if (["input", "textarea", "select"].includes(tag)) return el;

    // Check shadow DOM first
    const root = el.shadowRoot || el;
    const inner = root.querySelector("input, textarea, select");
    if (inner) return inner;

    // Recurse into shadow roots of children
    for (const child of root.querySelectorAll("*")) {
      if (child.shadowRoot) {
        const deep = child.shadowRoot.querySelector("input, textarea, select");
        if (deep) return deep;
      }
    }
    return null;
  }

  function setFormValue(refId, value) {
    const el = resolveRef(refId);
    if (!el) return { error: `Element ${refId} not found or was garbage collected.` };

    el.scrollIntoView({ block: "center", behavior: "instant" });

    // Resolve the actual form element (may be inside shadow DOM)
    const target = findInputInside(el) || el;
    const tag = target.tagName.toLowerCase();
    const type = (target.type || "").toLowerCase();

    if (tag === "select") {
      const opt = Array.from(target.options).find(
        (o) => o.value === String(value) || o.textContent.trim() === String(value)
      );
      if (opt) {
        target.value = opt.value;
      } else {
        target.value = String(value);
      }
    } else if (type === "checkbox" || type === "radio") {
      const shouldCheck = typeof value === "boolean" ? value : value === "true";
      if (target.checked !== shouldCheck) target.click();
      return { success: true, checked: target.checked };
    } else if (target.contentEditable === "true") {
      target.textContent = String(value);
    } else if (["input", "textarea"].includes(tag)) {
      // Use the native setter for actual input/textarea elements
      const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) {
        setter.call(target, String(value));
      } else {
        target.value = String(value);
      }
    } else {
      // Fallback for unknown elements — try direct assignment
      try {
        target.value = String(value);
      } catch {
        return { error: `Cannot set value on <${tag}> element. No input found inside.` };
      }
    }

    // Dispatch events on the target (bubbles up through shadow DOM)
    target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    return { success: true, value: target.value };
  }

  // --- Where to click an element given by ref ---

  // The element at a viewport point, looking inside open shadow roots (the
  // document only reports the shadow host). null outside the viewport.
  function elementAtPoint(x, y) {
    let hit = null;
    for (let scope = document; scope; ) {
      const found = scope.elementFromPoint(x, y);
      if (!found || found === hit) break;
      hit = found;
      scope = found.shadowRoot;
    }
    return hit;
  }

  function inViewport(x, y) {
    return 0 <= x && x < window.innerWidth && 0 <= y && y < window.innerHeight;
  }

  // Whether `node` is `el` or inside it, crossing shadow DOM boundaries.
  function isWithin(node, el) {
    for (let n = node; n; n = n.parentNode || n.host) {
      if (n === el) return true;
    }
    return false;
  }

  function describeElement(el) {
    if (!el) return "nothing";
    const selector = el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") +
      [...el.classList].slice(0, 2).map((c) => `.${c}`).join("");
    const name = getAccessibleName(el);
    return name ? `<${selector}> "${name.slice(0, 60)}"` : `<${selector}>`;
  }

  // A viewport point that hits the element: { x, y, scrolled, coveredBy? },
  // or { error }. Coordinates only reach what's on screen, so an element
  // outside the viewport is scrolled into view first, and the point is
  // re-measured afterwards. If something else is on top at every point tried,
  // the center is returned with what covers it: that's what a real click
  // there would hit.
  function locateRef(refId) {
    const el = resolveRef(refId);
    if (!el || !el.isConnected) return { error: `Element ${refId} is no longer on the page. Use read_page or find again.` };

    let rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return { error: `Element ${refId} has no size (it's hidden or empty).` };

    // Fully visible already? Then leave the page where it is.
    let scrolled = false;
    if (!(inViewport(rect.left, rect.top) && inViewport(rect.right - 1, rect.bottom - 1))) {
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      rect = el.getBoundingClientRect();
      scrolled = true;
    }

    // Points spread over the part of the element inside the viewport, and
    // the first that hits it (null if none does).
    const tryPoints = () => {
      const left = Math.max(rect.left, 0);
      const right = Math.min(rect.right, window.innerWidth);
      const top = Math.max(rect.top, 0);
      const bottom = Math.min(rect.bottom, window.innerHeight);
      if (right - left < 1 || bottom - top < 1) return { points: [], hit: null };
      const at = (fx, fy) => ({ x: Math.round(left + (right - left) * fx), y: Math.round(top + (bottom - top) * fy) });
      const points = [at(0.5, 0.5), at(0.25, 0.5), at(0.75, 0.5), at(0.5, 0.25), at(0.5, 0.75)];
      return { points, hit: points.find((p) => isWithin(elementAtPoint(p.x, p.y), el)) || null };
    };

    let { points, hit } = tryPoints();
    // Inside the viewport but hidden by a scrolling container (a long list,
    // a modal): scrollIntoView scrolls those too.
    if (!hit && !scrolled) {
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      rect = el.getBoundingClientRect();
      scrolled = true;
      ({ points, hit } = tryPoints());
    }
    if (hit) return { ...hit, scrolled };
    if (!points.length) {
      return { error: `Element ${refId} can't be brought into view (it may be inside a hidden or clipped container).` };
    }
    const center = points[0];
    return { ...center, scrolled, coveredBy: describeElement(elementAtPoint(center.x, center.y)) };
  }

  // --- Helper for synthetic events ---
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // --- Links that open a new tab ---
  // Firefox's popup blocker silently drops a new tab opened by a synthetic
  // click, so a target=_blank link (or a ctrl/cmd/shift-click on any link)
  // would do nothing. While a click is dispatched, this notices such a link
  // being followed. If the page didn't handle the click itself, it cancels
  // the browser's own attempt and reports the URL, for the background to
  // open in a tab of its own.
  function watchForNewTabLink() {
    let url = null;
    const onClick = (event) => {
      if (event.defaultPrevented || url) return;
      const link = event.composedPath().find(
        (node) => (node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement) && node.href
      );
      if (!link || link.hasAttribute("download") || !/^(https?|file):/i.test(link.href)) return;
      const target = (link.getAttribute("target") || "").trim().toLowerCase();
      const sameTab = ["", "_self", "_top", "_parent"].includes(target);
      if (sameTab && !event.ctrlKey && !event.metaKey && !event.shiftKey) return;
      event.preventDefault();
      url = link.href;
    };
    // Added last, so the page's own click handlers on window have run.
    window.addEventListener("click", onClick);
    return {
      stop() {
        window.removeEventListener("click", onClick);
        return url;
      },
    };
  }

  // --- Keyboard ---

  // What a real mousedown focuses: the nearest focusable element at or above
  // the one clicked (crossing shadow DOM), or nothing, which takes the focus
  // away from where it was.
  const FOCUSABLE = 'a[href], area[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable]:not([contenteditable="false"])';
  function focusForClick(el) {
    for (let node = el; node; node = node.parentElement || node.getRootNode().host) {
      if (node.matches?.(FOCUSABLE) && !node.disabled) {
        node.focus({ preventScroll: true });
        return;
      }
    }
    const current = focusedElement();
    if (current && current !== document.body) current.blur?.();
  }

  // The focused element, looking inside open shadow roots.
  function focusedElement() {
    let el = document.activeElement || document.body;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el || document.documentElement;
  }

  // Returns false if a handler canceled the event.
  function dispatchKey(el, type, { key, code, keyCode, charCode }, modifiers = 0) {
    const legacy = type === "keypress" ? { charCode, keyCode: charCode, which: charCode } : { keyCode, which: keyCode };
    return el.dispatchEvent(new KeyboardEvent(type, {
      bubbles: true, cancelable: true, composed: true, view: window,
      key, code: code || "", repeat: false, ...legacy,
      ctrlKey: !!(modifiers & 2), altKey: !!(modifiers & 1),
      shiftKey: !!(modifiers & 8), metaKey: !!(modifiers & 4),
    }));
  }

  // Fields the browser cleans up as you go (a number field turns "-" or
  // "1." into "", since they aren't numbers yet) would lose characters when
  // typed one at a time. What was typed is kept here, so the next character
  // continues from it rather than from the cleaned-up value, while the page
  // hasn't changed the field in between.
  const typedAhead = new WeakMap(); // field -> { text, shown }
  let lastTypedField = null; // gets one change event when typing ends

  // Inserts text at the caret of a text field or editable element. Returns
  // whether there was somewhere to put it.
  function insertText(el, text) {
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      const ahead = typedAhead.get(el);
      const current = ahead && el.value === ahead.shown ? ahead.text : el.value;
      // selectionStart is null on types like email and number: append.
      const caretKnown = current === el.value && el.selectionStart !== null;
      const start = caretKnown ? el.selectionStart : current.length;
      const end = caretKnown ? el.selectionEnd : current.length;
      const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      const newVal = current.slice(0, start) + text + current.slice(end);
      if (setter) setter.call(el, newVal); else el.value = newVal;
      if (el.value === newVal) {
        typedAhead.delete(el);
        try {
          el.selectionStart = el.selectionEnd = start + text.length;
        } catch {
          // Those types throw on setting it; the value is right regardless.
        }
      } else {
        typedAhead.set(el, { text: newVal, shown: el.value });
      }
      el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
      lastTypedField = el;
      return true;
    }
    if (el.isContentEditable) {
      return document.execCommand("insertText", false, text);
    }
    return false;
  }

  // Whether a user-scrollable element can still move by (dx, dy).
  function canScroll(node, dx, dy) {
    const style = getComputedStyle(node);
    const canY = dy !== 0 && /auto|scroll|overlay/.test(style.overflowY) &&
      (dy > 0 ? node.scrollTop + node.clientHeight < node.scrollHeight - 1 : node.scrollTop > 0);
    const canX = dx !== 0 && /auto|scroll|overlay/.test(style.overflowX) &&
      (dx > 0 ? node.scrollLeft + node.clientWidth < node.scrollWidth - 1 : node.scrollLeft > 0);
    return canY || canX;
  }

  // Nearest element (from el upwards, body included) that can still scroll by
  // (dx, dy); null means the page itself should scroll.
  function findScrollableAncestor(el, dx, dy) {
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      if (canScroll(node, dx, dy)) return node;
    }
    return null;
  }

  // Scroll target (an element or window) instantly; true if it actually moved.
  function scrollMoves(target, dx, dy) {
    const pos = () => (target === window ? [window.scrollX, window.scrollY] : [target.scrollLeft, target.scrollTop]);
    const [x0, y0] = pos();
    target.scrollBy({ left: dx, top: dy, behavior: "instant" });
    const [x1, y1] = pos();
    return x0 !== x1 || y0 !== y1;
  }

  // html or body hides overflow in this direction *and* has content cut off.
  // Apps that hide overflow by design (an inner pane scrolls) don't count.
  function isScrollLocked(dx, dy) {
    return [document.documentElement, document.body].some((node) => {
      if (!node) return false;
      const style = getComputedStyle(node);
      const lockedY = dy !== 0 && /hidden|clip/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
      const lockedX = dx !== 0 && /hidden|clip/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1;
      return lockedY || lockedX;
    });
  }

  // Inline !important beats the page's stylesheet !important, and setting it
  // through the CSSOM isn't blocked by the page's CSP (a <style> tag can be).
  function unlockScroll() {
    for (const node of [document.documentElement, document.body]) {
      if (node) node.style.setProperty("overflow", "auto", "important");
    }
  }

  // --- Glow while Claude is working in this tab ---
  // A pulsing border and a small label. It ignores the mouse (and
  // elementFromPoint), lives in a closed shadow root so page styles can't
  // reach it, and removes itself a few seconds after the last refresh, so it
  // can't get stuck if the extension or Claude goes away mid-task.

  const GLOW_LINGER_MS = 4000;
  let glowHost = null;
  let glowTimer = null;

  function buildGlow() {
    const host = document.createElement("claude-mcp-glow");
    host.style.cssText =
      "all: initial !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; pointer-events: none !important; display: block !important;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        :host { --glow: 217, 119, 87; }
        .frame {
          position: fixed; inset: 0; pointer-events: none;
          box-shadow: inset 0 0 0 2px rgba(var(--glow), 0.9), inset 0 0 28px 4px rgba(var(--glow), 0.45);
          animation: breathe 2.4s ease-in-out infinite;
        }
        .label {
          position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%);
          pointer-events: none; white-space: nowrap;
          font: 600 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
          color: #fff; background: rgba(var(--glow), 0.92);
          padding: 6px 11px; border-radius: 99px;
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25);
        }
        @keyframes breathe { 50% { box-shadow: inset 0 0 0 2px rgba(var(--glow), 0.55), inset 0 0 14px 2px rgba(var(--glow), 0.25); } }
        @media (prefers-reduced-motion: reduce) { .frame { animation: none; } }
      </style>
      <div class="frame"></div>
      <div class="label">Claude is using this tab</div>`;
    return host;
  }

  function showGlow() {
    if (!glowHost) glowHost = buildGlow();
    if (!glowHost.isConnected) document.documentElement.appendChild(glowHost);
    glowHost.style.setProperty("visibility", "visible", "important");
    clearTimeout(glowTimer);
    glowTimer = setTimeout(removeGlow, GLOW_LINGER_MS);
  }

  function removeGlow() {
    clearTimeout(glowTimer);
    glowHost?.remove();
  }

  // Hidden (not removed) while a screenshot is taken; resolves once the page
  // has painted without it.
  function hideGlowForCapture() {
    if (!glowHost?.isConnected) return Promise.resolve();
    glowHost.style.setProperty("visibility", "hidden", "important");
    return new Promise((resolve) => {
      const done = () => resolve();
      requestAnimationFrame(() => requestAnimationFrame(done));
      setTimeout(done, 150); // rAF doesn't run in background tabs
    });
  }

  // --- Message handler ---
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Arrived after the background stopped waiting (the page was busy): the
    // tool already reported it as not done, so it mustn't happen now.
    if (typeof msg.deadline === "number" && Date.now() > msg.deadline) {
      sendResponse({ error: "expired" });
      return;
    }
    if (msg.type === "glow") {
      if (msg.mode === "show") showGlow();
      else if (msg.mode === "remove") removeGlow();
      else if (msg.mode === "hide") {
        hideGlowForCapture().then(() => sendResponse({}));
        return true;
      }
      sendResponse({});
      return true;
    }

    if (msg.type === "generateAccessibilityTree") {
      const result = generateAccessibilityTree(msg.options || {});
      sendResponse({ result });
      return true;
    }

    if (msg.type === "getPageText") {
      const result = getPageText();
      sendResponse({ result });
      return true;
    }

    if (msg.type === "findElements") {
      const result = findElements(msg.query);
      sendResponse({ result });
      return true;
    }

    if (msg.type === "setFormValue") {
      const result = setFormValue(msg.ref, msg.value);
      sendResponse({ result });
      return true;
    }

    if (msg.type === "locateRef") {
      sendResponse({ result: locateRef(msg.ref) });
      return true;
    }

    // --- Input event dispatchers (Firefox replacement for CDP Input.*) ---

    if (msg.type === "dispatchMouseClick") {
      const { x, y, button, clickCount, modifiers } = msg;
      const el = elementAtPoint(x, y);
      if (!el) {
        // Off-screen coordinates hit nothing; don't pretend the page got a click.
        sendResponse({
          error: `(${x}, ${y}) is outside the visible area of the page (${window.innerWidth}x${window.innerHeight}). Scroll first, or click by ref.`,
        });
        return true;
      }
      const buttonMap = { left: 0, middle: 1, right: 2 };
      const btn = buttonMap[button ?? "left"] ?? 0;
      const btns = btn === 0 ? 1 : btn === 1 ? 4 : 2;
      const shared = {
        // composed: real clicks cross shadow DOM boundaries, and el may be
        // inside a shadow root.
        bubbles: true, cancelable: true, composed: true, view: window,
        clientX: x, clientY: y, button: btn,
        ctrlKey: !!(modifiers & 2), altKey: !!(modifiers & 1),
        shiftKey: !!(modifiers & 8), metaKey: !!(modifiers & 4),
      };
      el.dispatchEvent(new MouseEvent("mousemove", { ...shared, buttons: 0, detail: 0 }));
      const pressed = el.dispatchEvent(new MouseEvent("mousedown", { ...shared, buttons: btns, detail: 1 }));
      // A page that cancels mousedown (an editor's toolbar button) keeps the
      // focus where it was, as with a real click.
      if (pressed) focusForClick(el);
      el.dispatchEvent(new MouseEvent("mouseup", { ...shared, buttons: 0, detail: 1 }));
      if (button === "right") {
        el.dispatchEvent(new MouseEvent("contextmenu", { ...shared, buttons: 0, detail: 0 }));
      } else if (button !== "middle") {
        const newTab = watchForNewTabLink();
        for (let i = 0; i < (clickCount || 1); i++) {
          el.dispatchEvent(new MouseEvent("click", { ...shared, buttons: 0, detail: i + 1 }));
        }
        if ((clickCount || 1) >= 2) {
          el.dispatchEvent(new MouseEvent("dblclick", { ...shared, buttons: 0, detail: 2 }));
        }
        const url = newTab.stop();
        if (url) {
          sendResponse({ openInNewTab: url });
          return true;
        }
      }
      sendResponse({});
      return true;
    }

    if (msg.type === "dispatchMouseMove") {
      const el = document.elementFromPoint(msg.x, msg.y) || document.body;
      el.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true, cancelable: true, view: window,
        clientX: msg.x, clientY: msg.y, buttons: 0,
        ctrlKey: !!(msg.modifiers & 2), altKey: !!(msg.modifiers & 1),
        shiftKey: !!(msg.modifiers & 8), metaKey: !!(msg.modifiers & 4),
      }));
      sendResponse({});
      return true;
    }

    if (msg.type === "dispatchKeyEvent") {
      const keyType = msg.eventType === "keyDown" ? "keydown" : "keyup";
      const notCanceled = dispatchKey(focusedElement(), keyType, msg, msg.modifiers);
      // keypress follows keydown for Enter and keys that type a character
      // (not with ctrl, alt or meta held), as in a browser.
      const typing = msg.key === "Enter" || (msg.key?.length === 1 && !(msg.modifiers & 7));
      if (keyType === "keydown" && notCanceled && typing) {
        const charCode = msg.key === "Enter" ? 13 : msg.key.charCodeAt(0);
        dispatchKey(focusedElement(), "keypress", { ...msg, charCode }, msg.modifiers);
      }
      sendResponse({});
      return true;
    }

    // The end of a `type` action: the field gets one change event, as when
    // the user is done editing it.
    if (msg.type === "endTyping") {
      if (lastTypedField?.isConnected) lastTypedField.dispatchEvent(new Event("change", { bubbles: true }));
      lastTypedField = null;
      sendResponse({});
      return true;
    }

    // One character of the `type` action. Pages see the key going down and
    // up around the text, like real typing; if a keydown or keypress handler
    // cancels the event, the character isn't inserted, as in a browser.
    if (msg.type === "typeChar") {
      const { text, key } = msg;
      let insert = true;
      if (key) {
        const modifiers = key.shift ? 8 : 0;
        insert = dispatchKey(focusedElement(), "keydown", key, modifiers);
        // keypress is deprecated but still fired for keys that produce text
        // (Enter included), and older sites listen for it.
        if (insert && (key.key.length === 1 || key.key === "Enter")) {
          const charCode = key.key === "Enter" ? 13 : key.key.charCodeAt(0);
          insert = dispatchKey(focusedElement(), "keypress", { ...key, charCode }, modifiers);
        }
      }
      // inserted: the text went into a field, or the page took the key
      // itself (an editor that cancels keydown and inserts on its own).
      const inserted = insert ? insertText(focusedElement(), text) : true;
      if (key) dispatchKey(focusedElement(), "keyup", key, key.shift ? 8 : 0);
      sendResponse({ inserted });
      return true;
    }

    if (msg.type === "dispatchScroll") {
      const dx = msg.deltaX || 0;
      const dy = msg.deltaY || 0;
      const el = document.elementFromPoint(msg.x, msg.y) || document.documentElement;
      const notCanceled = el.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true, cancelable: true, view: window,
        clientX: msg.x, clientY: msg.y,
        deltaX: dx, deltaY: dy,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        ctrlKey: !!(msg.modifiers & 2), altKey: !!(msg.modifiers & 1),
        shiftKey: !!(msg.modifiers & 8), metaKey: !!(msg.modifiers & 4),
      }));
      // A synthetic wheel event never scrolls by itself, so scroll what a real
      // wheel would: the nearest ancestor that can still move that way, else
      // the page.
      const scrollNearest = () => {
        const target = findScrollableAncestor(el, dx, dy);
        if (target && scrollMoves(target, dx, dy)) return true;
        if (scrollMoves(window, dx, dy)) return true;
        // When html isn't overflow:visible, body is its own scroller, even
        // if the point isn't over it.
        const body = document.body;
        return !!body && canScroll(body, dx, dy) && scrollMoves(body, dx, dy);
      };
      let moved = false;
      let unlocked = false;
      // preventDefault means the page used the wheel itself (a map, a carousel)...
      if (notCanceled) moved = scrollNearest();
      // ...unless it's a scroll lock (cookie walls, modals): force html/body
      // back to overflow:auto, like the usual "unlock scroll" bookmarklet.
      if (!moved && isScrollLocked(dx, dy)) {
        unlockScroll();
        unlocked = true;
        moved = scrollNearest();
      }
      sendResponse({ moved, unlocked, handledByPage: !notCanceled && !unlocked });
      return true;
    }

    if (msg.type === "scrollToRef") {
      const el = resolveRef(msg.ref);
      if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
      sendResponse({});
      return true;
    }

    if (msg.type === "scrollToPosition") {
      window.scrollTo(msg.x, msg.y);
      sendResponse({});
      return true;
    }

    if (msg.type === "dispatchDrag") {
      (async () => {
        const { startX, startY, endX, endY, modifiers } = msg;
        const getEl = (x, y) => document.elementFromPoint(x, y) || document.body;
        const dispatch = (el, type, x, y, buttons) => {
          el.dispatchEvent(new MouseEvent(type, {
            bubbles: true, cancelable: true, view: window,
            clientX: x, clientY: y, button: 0, buttons,
            ctrlKey: !!(modifiers & 2), altKey: !!(modifiers & 1),
            shiftKey: !!(modifiers & 8), metaKey: !!(modifiers & 4),
          }));
        };
        dispatch(getEl(startX, startY), "mousemove", startX, startY, 0);
        await sleep(50);
        dispatch(getEl(startX, startY), "mousedown", startX, startY, 1);
        await sleep(50);
        const steps = 10;
        for (let i = 1; i <= steps; i++) {
          const mx = startX + ((endX - startX) * i) / steps;
          const my = startY + ((endY - startY) * i) / steps;
          dispatch(getEl(mx, my), "mousemove", mx, my, 1);
          await sleep(20);
        }
        dispatch(getEl(endX, endY), "mouseup", endX, endY, 0);
        sendResponse({});
      })();
      return true;
    }

    return false;
  });

  // Expose globally for executeScript (scripting.executeScript MAIN world access)
  window.__openClaudeInFirefox = {
    generateAccessibilityTree,
    getPageText,
    findElements,
    setFormValue,
    locateRef,
    resolveRef,
    elementMap,
  };

  // This script runs at document_start: tell the background a new page has
  // started, so it can hook console and dialogs early if Claude controls
  // this tab.
  chrome.runtime.sendMessage({ type: "pageStarted" }).catch(() => {});
})();
