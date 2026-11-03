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

  // See the message listener: a message is only acted on this long before
  // the background stops waiting for its answer.
  const CONTENT_DEADLINE_MARGIN_MS = 1000;

  // --- Element reference map ---
  // Persistent ref IDs stored as WeakRefs so GC still works. A ref names its
  // document, so one from before a navigation can't mean an element of the
  // next page, and its frame, for the background to send messages about it
  // to (ref_f<frame id>_…).
  let refCounter = 0;
  const frameId = chrome.runtime.getFrameId(window);
  const refPrefix = `ref_${frameId > 0 ? `f${frameId}_` : ""}${Math.random().toString(36).slice(2, 6)}_`;
  const elementMap = {}; // refId -> WeakRef<Element>
  const reverseMap = new WeakMap(); // Element -> refId

  function getOrAssignRef(el) {
    const existing = reverseMap.get(el);
    if (existing && elementMap[existing]?.deref() === el) return existing;
    const ref = `${refPrefix}${++refCounter}`;
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
    iframe: "iframe",
    frame: "iframe",
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
  let labelIndex = null; // id -> its <label>, while every element gets a name
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
      const label = labelIndex ? labelIndex.get(el.id) : document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
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

  // A file input is often hidden behind a styled button; it's still listed,
  // for upload_image and file_upload.
  const isFileInput = (el) => el.localName === "input" && el.type === "file";

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
    let tooDeep = false;

    function append(text) {
      if (truncated) return false;
      if (charCount + text.length > maxChars) {
        output += text.substring(0, maxChars - charCount);
        output += "\n... (truncated: use a smaller depth, or ref_id to read one part of the page)";
        truncated = true;
        return false;
      }
      output += text;
      charCount += text.length;
      return true;
    }

    // depth counts the levels shown, not the elements around them: pages nest
    // their content in rows of unnamed <div>s.
    function walk(el, depth, indent) {
      if (truncated) return;
      if (!el || el.nodeType !== 1) return;

      const tag = el.tagName.toLowerCase();
      // Skip invisible, script, style, svg internals
      if (["script", "style", "noscript", "template"].includes(tag)) return;

      const role = getRole(el);
      const name = getAccessibleName(el);
      const interactive = isInteractive(el);
      const visible = isVisible(el);

      // Filter: if interactive-only mode, skip non-interactive non-container elements
      const isContainer = el.children.length > 0 || !!el.shadowRoot;
      if (filter === "interactive" && !interactive && !isContainer) return;

      const shouldShow =
        (filter === "all" && (role || name)) ||
        (filter === "interactive" && interactive);

      const shown = shouldShow && (visible || isFileInput(el));
      if (shown && depth > maxDepth) {
        tooDeep = true;
        return;
      }
      if (shown) {
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
            /(?:^|\s)(?:cc-number|cc-csc|one-time-code|current-password|new-password)(?:\s|$)/i.test(el.getAttribute("autocomplete") || "");
          line += secret ? ` value="[hidden]"` : ` value="${el.value.substring(0, 100)}"`;
        }
        if (tag === "input") line += ` type="${el.type || "text"}"`;
        if (el.getAttribute("aria-expanded")) line += ` expanded=${el.getAttribute("aria-expanded")}`;
        if (el.getAttribute("aria-checked")) line += ` checked=${el.getAttribute("aria-checked")}`;
        if (el.getAttribute("aria-selected")) line += ` selected=${el.getAttribute("aria-selected")}`;
        if (el.disabled === true) line += " disabled";
        if (!visible) line += " hidden";

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
      const nextIndent = shown ? indent + "  " : indent;
      const nextDepth = shown ? depth + 1 : depth;
      if (el.shadowRoot) {
        for (const child of el.shadowRoot.children) {
          walk(child, nextDepth, nextIndent);
        }
      }
      for (const child of el.children) {
        walk(child, nextDepth, nextIndent);
      }
    }

    let root = document.body;
    if (startRefId) {
      const el = resolveRef(startRefId);
      if (!el || !el.isConnected) return { error: `ref_id "${startRefId}" is no longer on the page. Use read_page or find again.` };
      root = el;
    }

    walk(root, 0, "");
    if (tooDeep && !truncated) output += "... (deeper elements left out: use a larger depth, or ref_id to read one part of the page)\n";
    return output;
  }

  // --- Page text extraction ---
  const TEXT_LIMIT = 100000;
  const SKIPPED_TEXT = new Set(["script", "style", "noscript", "template", "svg"]);
  const BLOCK_TAG = /^(?:address|article|aside|blockquote|br|dd|details|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|option|p|pre|section|summary|table|td|th|tr|ul)$/;

  // The text under a node, into `parts`: elements that are blocks are kept
  // apart, and open shadow roots are read too.
  function collectText(node, parts) {
    if (node.nodeType === 3) {
      parts.push(node.data);
      return;
    }
    const tag = node.localName || "";
    if (SKIPPED_TEXT.has(tag) || node === glowHost) return;
    const block = BLOCK_TAG.test(tag);
    if (block) parts.push(" ");
    const assigned = tag === "slot" ? node.assignedNodes() : [];
    const children = node.shadowRoot?.childNodes ?? (assigned.length ? assigned : node.childNodes);
    for (const child of children) collectText(child, parts);
    if (block) parts.push(" ");
  }

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

    // Clean text: without script/style content, whitespace collapsed
    const parts = [];
    collectText(source, parts);
    const text = parts.join("").replace(/\s+/g, " ").trim();

    return JSON.stringify({
      title, url, sourceTag: tag,
      text: text.substring(0, TEXT_LIMIT),
      fullLength: text.length,
    });
  }

  // --- Element finding ---
  const MAX_FOUND = 20;
  // Words that only join a description ("add to cart button").
  const FILLER_WORDS = new Set(["a", "an", "and", "called", "containing", "for", "in", "named", "of", "on", "or", "says", "that", "the", "to", "with"]);
  // Words for the kind of thing wanted: they rank results, but a search box
  // needn't contain "bar" to be the "search bar".
  const KIND_WORDS = new Set(["area", "bar", "box", "btn", "button", "element", "field", "icon", "input", "link", "section"]);

  // The element's own text, not its children's: asking every element on a page
  // for all the text under it takes long, and matches what's around a result.
  function ownText(el) {
    let text = "";
    for (const node of el.childNodes) {
      if (node.nodeType === 3) text += node.data;
    }
    return text.trim().substring(0, 200);
  }

  // Elements described by the query, best first. Each word of it is looked for
  // at the start of a word in an element's role, name, text and attributes
  // ("search" finds "searchbox", "me" doesn't find "frame"). The elements with
  // all of them are the results, or else those with the most of them: tier
  // says how many, for the background to rank results from frames.
  function findElements(query) {
    const lower = query.toLowerCase();
    const words = lower.split(/\s+/).filter((w) => w && !FILLER_WORDS.has(w));
    if (!words.length) words.push(lower.trim());
    const needed = words.filter((w) => !KIND_WORDS.has(w));
    if (!needed.length) needed.push(...words);
    const startsWord = new Map(words.map((w) => [w, new RegExp(`(?:^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u")]));
    const has = (text, w) => startsWord.get(w).test(text);

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

    labelIndex = new Map();
    for (const label of document.querySelectorAll("label[for]")) {
      if (!labelIndex.has(label.htmlFor)) labelIndex.set(label.htmlFor, label);
    }
    const matches = [];
    let lastInteractive = null;
    try {
      for (const el of collectAll(document)) {
        const tag = el.tagName.toLowerCase();
        if (["script", "style", "noscript", "template"].includes(tag)) continue;

        const role = getRole(el) || "";
        const name = getAccessibleName(el) || "";
        const text = ownText(el);
        // Attributes, not properties (see getAccessibleName).
        const attrs = ["placeholder", "aria-label", "title", "type"].map((a) => el.getAttribute(a) || "");
        const hiddenFile = isFileInput(el) && !isVisible(el) ? " hidden" : "";
        const searchable = `${role} ${name} ${text} ${attrs.join(" ")} ${tag}${hiddenFile}`.toLowerCase();

        const hasNeeded = needed.filter((w) => has(searchable, w)).length;
        if (!hasNeeded) continue;
        // The text inside a button or link is that button or link.
        const interactive = isInteractive(el);
        if (!interactive && lastInteractive && isWithin(el, lastInteractive)) continue;
        if (interactive) lastInteractive = el;
        matches.push({
          el, role, name, text, tag, interactive, hasNeeded,
          score: words.filter((w) => has(searchable, w)).length,
        });
      }
    } finally {
      labelIndex = null;
    }

    const best = matches.reduce((most, m) => Math.max(most, m.hasNeeded), 0);
    const ranked = matches
      .filter((m) => m.hasNeeded === best)
      .sort((a, b) => b.score - a.score || b.interactive - a.interactive);

    const found = [];
    for (const { el, role, name, text, tag, interactive, score } of ranked) {
      const hidden = !isVisible(el);
      if (hidden && !isFileInput(el)) continue;
      if (found.length === MAX_FOUND) return { found, more: true, tier: best };
      const ref = getOrAssignRef(el);
      const rect = el.getBoundingClientRect();
      const center = [Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2)];
      found.push({
        ref,
        role: role || tag,
        name: name || text.substring(0, 80),
        coordinates: center,
        offscreen: !hidden && !inViewport(...center),
        hidden,
        score,
        interactive,
      });
    }
    return { found, more: false, tier: best };
  }

  // --- Form input ---

  // Input types that don't take typed text.
  const NOT_TYPED = /^(?:button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/;
  function isTextField(el) {
    const tag = el.localName;
    return tag === "textarea" || (tag === "input" && !NOT_TYPED.test(el.type));
  }

  // Sets a field's value through the browser's own setter, not one a page
  // framework put on the element.
  function setNativeValue(el, value) {
    const proto = el.localName === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  }

  // Find the actual input/textarea/select inside an element: in its shadow
  // root, among its own children (which may be slotted into that root), or in
  // the shadow roots of those.
  function findInputInside(el, selector = "input, textarea, select") {
    if (el.matches(selector)) return el;
    for (const root of [el.shadowRoot, el]) {
      if (!root) continue;
      const inner = root.querySelector(selector);
      if (inner) return inner;
      for (const child of root.querySelectorAll("*")) {
        const deep = child.shadowRoot?.querySelector(selector);
        if (deep) return deep;
      }
    }
    return null;
  }

  const BOOLEAN_WORDS = {
    true: true, on: true, yes: true, 1: true,
    false: false, off: false, no: false, 0: false,
  };
  const FIELD_FORMATS = {
    date: "yyyy-mm-dd", month: "yyyy-mm", week: "yyyy-Www", time: "hh:mm",
    "datetime-local": "yyyy-mm-ddThh:mm", number: "a number",
  };

  // Sets a form field and checks it took the value; anything else is an error.
  function setFormValue(refId, value) {
    const el = resolveRef(refId);
    if (!el || !el.isConnected) return { error: `Element ${refId} is no longer on the page. Use read_page or find again.` };

    el.scrollIntoView({ block: "center", behavior: "instant" });

    // Resolve the actual form element (may be inside shadow DOM)
    const target = findInputInside(el) || el;
    const tag = target.localName;
    const type = String(target.type || "").toLowerCase();
    const wanted = String(value);
    const field = ["input", "textarea", "select"].includes(tag);

    if (field && target.matches(":disabled")) return { error: `This <${tag}> is disabled.` };

    if (tag === "select") {
      const options = Array.from(target.options);
      const opt = options.find((o) => o.value === wanted) || options.find((o) => o.textContent.trim() === wanted);
      if (!opt) {
        const names = options.slice(0, 50).map((o) => `"${o.textContent.trim() || o.value}"`).join(", ");
        return { error: `This <select> has no option "${wanted}", and it was left as it was. Its options: ${names}.` };
      }
      if (opt.disabled) return { error: `Option "${wanted}" is disabled.` };
      opt.selected = true;
    } else if (type === "checkbox" || type === "radio") {
      const shouldCheck = BOOLEAN_WORDS[wanted.trim().toLowerCase()];
      if (shouldCheck === undefined) return { error: `Use true or false for a ${type}, not "${wanted}".` };
      if (type === "radio" && target.checked && !shouldCheck) {
        return { error: "A radio button can't be unchecked: choose another one of its group." };
      }
      if (target.checked !== shouldCheck) target.click();
      if (target.checked !== shouldCheck) return { error: `The page kept this ${type} ${target.checked ? "checked" : "unchecked"}.` };
      return { success: true, checked: target.checked };
    } else if (tag === "input" || tag === "textarea") {
      if (type === "file") return { error: "A file input takes files from file_upload (files on this computer) or upload_image (a screenshot), not form_input." };
      if (target.readOnly) return { error: `This <${tag}> is read-only.` };
      const before = target.value;
      setNativeValue(target, wanted);
      // The browser empties a value this kind of field can't hold.
      if (wanted && !target.value) {
        setNativeValue(target, before);
        const format = FIELD_FORMATS[type];
        return { error: `This ${type} field didn't accept "${wanted}"${format ? ` (it takes ${format})` : ""}, and it was left as it was.` };
      }
    } else if (target.isContentEditable) {
      target.textContent = wanted;
    } else {
      return { error: `<${tag}> isn't a form field, and has none inside: click it and use type, if it takes text.` };
    }

    // Dispatch events on the target (bubbles up through shadow DOM)
    target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    if (tag === "select") {
      return { success: true, value: Array.from(target.selectedOptions, (o) => o.value).join(", ") };
    }
    return { success: true, value: target.isContentEditable ? target.textContent : target.value };
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

  // The element above `el` as the page shows it: past the <slot> it's in, and
  // out of a shadow root to its host.
  function parentOf(el) {
    return el.assignedSlot || el.parentElement || el.getRootNode().host || null;
  }

  // Whether `node` is `el` or inside it, crossing shadow DOM boundaries.
  function isWithin(node, el) {
    for (let n = node; n; n = parentOf(n)) {
      if (n === el) return true;
    }
    return false;
  }

  // --- Frames ---
  // This script normally runs only in the page itself; a frame gets it when
  // Claude first reaches into that frame. What's asked for a point over a
  // frame is for that frame's document: the answer here says so
  // ({ intoFrame }) and the background sends the message on, with the point in
  // that frame's own coordinates.

  // The frame's id if `el` is a frame this extension can address.
  function frameOf(el) {
    if (el.localName !== "iframe" && el.localName !== "frame") return null;
    const id = chrome.runtime.getFrameId(el);
    return id > 0 ? id : null;
  }

  // A point of this document in the coordinates of the frame's document.
  function pointInFrame(frame, x, y) {
    const rect = frame.getBoundingClientRect();
    const style = getComputedStyle(frame);
    const scaleX = frame.offsetWidth ? rect.width / frame.offsetWidth : 1;
    const scaleY = frame.offsetHeight ? rect.height / frame.offsetHeight : 1;
    return {
      x: (x - rect.left) / scaleX - frame.clientLeft - parseFloat(style.paddingLeft),
      y: (y - rect.top) / scaleY - frame.clientTop - parseFloat(style.paddingTop),
    };
  }

  // The frames shown in this document, with where each one's top left corner is.
  function listFrames() {
    const frames = [];
    for (const frame of document.querySelectorAll("iframe, frame")) {
      const id = frameOf(frame);
      if (id === null) continue;
      const rect = frame.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2 || !isVisible(frame)) continue;
      const { x, y } = pointInFrame(frame, 0, 0);
      frames.push({ frameId: id, x: -x, y: -y });
    }
    return frames;
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
  // The short waits between events. In a tab the user isn't looking at,
  // Firefox runs a page's timers about once a second, which would stretch a
  // drag or a humanized move to many seconds; there, the wait is counted out
  // on a message channel instead (keeping the page responsive, but a core
  // busy while it lasts).
  function sleep(ms) {
    if (!document.hidden) return new Promise((r) => setTimeout(r, ms));
    const until = performance.now() + ms;
    return new Promise((resolve) => {
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = () => {
        if (performance.now() < until) return port2.postMessage(null);
        port1.close();
        resolve();
      };
      port2.postMessage(null);
    });
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
      // Web pages only: navigate can't open local files either.
      if (!link || link.hasAttribute("download") || !/^https?:/i.test(link.href)) return;
      // Its own target, or the page's <base target>. A name can be a frame's.
      const named = (link.getAttribute("target") ?? document.querySelector("base[target]")?.getAttribute("target") ?? "").trim();
      const target = named.toLowerCase();
      const sameTab = ["", "_self", "_top", "_parent"].includes(target) ||
        document.querySelector(`iframe[name="${CSS.escape(named)}"], frame[name="${CSS.escape(named)}"]`);
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
    for (let node = el; node; node = parentOf(node)) {
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
  // Fields like email and number have no caret or selection a script can
  // read: these are the ones whose whole value is selected, and typing there
  // replaces it.
  const allSelected = new WeakSet();

  // Inserts text at the caret of a text field or editable element. Returns
  // whether there was somewhere to put it.
  function insertText(el, text) {
    if (isTextField(el)) {
      if (el.readOnly || el.matches(":disabled")) return false;
      const replacing = allSelected.delete(el);
      const ahead = typedAhead.get(el);
      const current = replacing ? "" : ahead && el.value === ahead.shown ? ahead.text : el.value;
      // selectionStart is null on types like email and number: append.
      const caretKnown = !replacing && current === el.value && el.selectionStart !== null;
      const start = caretKnown ? el.selectionStart : current.length;
      const end = caretKnown ? el.selectionEnd : current.length;
      const newVal = current.slice(0, start) + text + current.slice(end);
      setNativeValue(el, newVal);
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

  function isEditable(el) {
    return isTextField(el) || el.isContentEditable;
  }

  // --- What the browser does for a key ---
  // A synthetic key reaches the page's handlers and does nothing else: no
  // text changes, the focus stays, no form is submitted. So what a key does in
  // a browser, unless a handler cancelled it, is done here.

  function selectAll(el) {
    if (isTextField(el)) {
      el.select();
      if (el.selectionStart === null) allSelected.add(el);
    } else if (el.isContentEditable) {
      document.execCommand("selectAll");
    } else {
      window.getSelection().selectAllChildren(document.body);
    }
  }

  // The button Enter presses in a form, if it has one.
  function defaultButton(form) {
    const isSubmit = (el) => el.matches?.('button:not([type]), button[type="submit" i], input[type="submit" i], input[type="image" i]');
    return [...form.elements].find(isSubmit) || form.querySelector('input[type="image" i]');
  }

  // Enter. Returns whether it submitted a form.
  function pressEnter(el) {
    if (el.localName === "textarea") {
      insertText(el, "\n");
    } else if (el.isContentEditable) {
      document.execCommand("insertParagraph");
    } else if (el.localName === "input" && !/^(?:button|image|reset|submit)$/.test(el.type)) {
      // A real field gets its change event before the form is submitted.
      if (lastTypedField === el) {
        el.dispatchEvent(new Event("change", { bubbles: true }));
        lastTypedField = null;
      }
      const form = el.form;
      if (!form) return false;
      const button = defaultButton(form);
      if (button) {
        if (button.matches(":disabled")) return false;
        button.click();
      } else {
        // Without a button, only a form with one field is submitted.
        if ([...form.elements].filter((f) => isTextField(f) && f.type !== "hidden").length > 1) return false;
        form.requestSubmit();
      }
      return true;
    } else if (el.matches?.("a[href], area[href], button, input, summary")) {
      el.click();
    }
    return false;
  }

  // The elements Tab goes through, in order.
  function tabStops() {
    const stops = [];
    const visit = (root) => {
      for (const el of root.querySelectorAll("*")) {
        if (el === glowHost) continue;
        if (el.matches(FOCUSABLE) && el.tabIndex >= 0 && el.type !== "hidden" && !el.matches(":disabled") && isVisible(el)) {
          stops.push(el);
        }
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(document);
    const positive = stops.filter((el) => el.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex);
    return [...positive, ...stops.filter((el) => el.tabIndex === 0)];
  }

  function moveFocus(backwards) {
    const stops = tabStops();
    if (!stops.length) return;
    const at = stops.indexOf(focusedElement());
    const next = at === -1 ? (backwards ? stops[stops.length - 1] : stops[0])
      : stops[(at + (backwards ? -1 : 1) + stops.length) % stops.length];
    next.focus({ preventScroll: false });
    if (isTextField(next)) selectAll(next); // Tab selects what's in a field
  }

  // Backspace, or Delete with `forward`.
  function deleteText(el, forward) {
    if (isTextField(el)) {
      if (el.readOnly || el.matches(":disabled")) return true;
      const value = el.value;
      const noCaret = el.selectionStart === null;
      let start = noCaret ? value.length : el.selectionStart;
      let end = noCaret ? value.length : el.selectionEnd;
      if (allSelected.delete(el)) {
        start = 0;
      } else if (start === end) {
        if (forward) end += /[\uD800-\uDBFF]/.test(value[end] || "") ? 2 : 1;
        else start -= /[\uDC00-\uDFFF]/.test(value[start - 1] || "") ? 2 : 1;
        start = Math.max(0, start);
        end = Math.min(value.length, end);
      }
      if (start === end) return true;
      setNativeValue(el, value.slice(0, start) + value.slice(end));
      if (!noCaret) el.setSelectionRange(start, start);
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true, composed: true, inputType: forward ? "deleteContentForward" : "deleteContentBackward",
      }));
      lastTypedField = el;
      return true;
    }
    if (el.isContentEditable) {
      document.execCommand(forward ? "forwardDelete" : "delete");
      return true;
    }
    return false;
  }

  // An arrow key, Home or End in a text field; `extend` (shift) moves only
  // one end of the selection.
  function moveCaret(el, key, extend) {
    if (el.selectionStart === null) return;
    const value = el.value;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const backwards = key === "ArrowLeft" || key === "ArrowUp" || key === "Home";
    const reversed = el.selectionDirection === "backward";
    const anchor = reversed ? end : start;
    let at = extend ? (reversed ? start : end) : (backwards ? start : end);
    const lineStart = (p) => (p === 0 ? 0 : value.lastIndexOf("\n", p - 1) + 1);
    const lineEnd = (p) => (value.indexOf("\n", p) === -1 ? value.length : value.indexOf("\n", p));
    if (key === "ArrowLeft" || key === "ArrowRight") {
      if (extend || start === end) at = Math.min(value.length, Math.max(0, at + (backwards ? -1 : 1)));
    } else if (key === "Home") {
      at = lineStart(at);
    } else if (key === "End") {
      at = lineEnd(at);
    } else if (el.localName === "textarea") {
      const column = at - lineStart(at);
      if (key === "ArrowUp") {
        const here = lineStart(at);
        at = here === 0 ? 0 : Math.min(lineStart(here - 1) + column, here - 1);
      } else {
        const stop = lineEnd(at);
        at = stop === value.length ? stop : Math.min(stop + 1 + column, lineEnd(stop + 1));
      }
    } else {
      return;
    }
    if (extend) el.setSelectionRange(Math.min(anchor, at), Math.max(anchor, at), at < anchor ? "backward" : "forward");
    else el.setSelectionRange(at, at);
  }

  const CARET_MOVES = {
    ArrowLeft: ["backward", "character"], ArrowRight: ["forward", "character"],
    ArrowUp: ["backward", "line"], ArrowDown: ["forward", "line"],
    Home: ["backward", "lineboundary"], End: ["forward", "lineboundary"],
  };

  // An arrow key on a <select>: the next option that can be chosen.
  function stepSelect(el, key) {
    const step = key === "ArrowUp" || key === "ArrowLeft" ? -1 : 1;
    let at = el.selectedIndex + step;
    while (el.options[at]?.disabled) at += step;
    if (!el.options[at]) return;
    el.selectedIndex = at;
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  // A key that scrolls: what's around the focus if that can move, else the page.
  function scrollForKey(key, shift) {
    const line = 40;
    const screenful = window.innerHeight * 0.9;
    const dy = { ArrowDown: line, ArrowUp: -line, PageDown: screenful, PageUp: -screenful, " ": shift ? -screenful : screenful, End: 1e9, Home: -1e9 }[key] || 0;
    const dx = { ArrowRight: line, ArrowLeft: -line }[key] || 0;
    scrollMoves(findScrollableAncestor(focusedElement(), dx, dy) || window, dx, dy);
  }

  // Does what the browser does for a key (given that no handler cancelled
  // it). Returns { noDefault } if it does something this can't do (ctrl+c, a
  // function key), { submitted } if a form was submitted.
  function keyDefault(key, modifiers) {
    const el = focusedElement();
    const shift = !!(modifiers & 8);
    if (modifiers & 7) {
      // ctrl or cmd+a; other shortcuts are the browser's own.
      if (!(modifiers & 1) && (modifiers & 6) && key.toLowerCase() === "a") {
        selectAll(el);
        return {};
      }
      return /^(?:Alt|Control|Meta|Shift)$/.test(key) ? {} : { noDefault: true };
    }
    switch (key) {
      case "Enter":
        return { submitted: pressEnter(el) };
      case "Tab":
        moveFocus(shift);
        return {};
      case "Backspace":
      case "Delete":
        deleteText(el, key === "Delete");
        return {};
      case "ArrowLeft":
      case "ArrowRight":
      case "ArrowUp":
      case "ArrowDown":
      case "Home":
      case "End":
        if (el.localName === "select") {
          if (key.startsWith("Arrow")) stepSelect(el, key);
        } else if (el.localName === "input" && el.type === "number" && (key === "ArrowUp" || key === "ArrowDown")) {
          if (key === "ArrowUp") el.stepUp();
          else el.stepDown();
          el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
          lastTypedField = el;
        } else if (isTextField(el)) {
          moveCaret(el, key, shift);
        } else if (el.isContentEditable) {
          window.getSelection().modify(shift ? "extend" : "move", ...CARET_MOVES[key]);
        } else {
          scrollForKey(key, shift);
        }
        return {};
      case "PageUp":
      case "PageDown":
        if (!isEditable(el)) scrollForKey(key, shift);
        return {};
      case " ":
        if (isEditable(el)) insertText(el, " ");
        else if (el.matches?.('button, input, summary, [role="button"], [role="checkbox"], [role="switch"]')) el.click();
        else scrollForKey(key, shift);
        return {};
      case "Escape":
      case "Shift":
      case "Alt":
      case "Control":
      case "Meta":
        return {};
      default:
        if ([...key].length === 1) {
          insertText(el, key);
          return {};
        }
        return { noDefault: true };
    }
  }

  // --- Selection by clicking ---
  // Synthetic clicks don't move the caret or select anything: done here, so
  // what's typed next lands where it would.

  function isWordCharacter(ch) {
    return /[\p{L}\p{N}_]/u.test(ch || "");
  }

  function wordAt(text, at) {
    let start = Math.min(at, text.length);
    if (!isWordCharacter(text[start]) && isWordCharacter(text[start - 1])) start--;
    if (!isWordCharacter(text[start])) return [start, start];
    let end = start;
    while (start > 0 && isWordCharacter(text[start - 1])) start--;
    while (end < text.length && isWordCharacter(text[end])) end++;
    return [start, end];
  }

  // detail: how many clicks in a row. One places the caret, two select a word,
  // three a line (or paragraph, in page text).
  function selectForClick(el, x, y, detail) {
    const point = document.caretPositionFromPoint(x, y);
    if (isTextField(el)) {
      if (el.selectionStart === null) {
        // No caret to place here: two clicks or more select all of it.
        if (detail >= 2) selectAll(el);
        else allSelected.delete(el);
        return;
      }
      allSelected.delete(el);
      const value = el.value;
      const at = point?.offsetNode === el ? point.offset : el.selectionStart;
      if (detail === 1) {
        if (point?.offsetNode === el) el.setSelectionRange(at, at);
      } else if (detail === 2) {
        el.setSelectionRange(...wordAt(value, at));
      } else if (el.localName === "textarea") {
        const start = at === 0 ? 0 : value.lastIndexOf("\n", at - 1) + 1;
        const stop = value.indexOf("\n", at);
        el.setSelectionRange(start, stop === -1 ? value.length : stop);
      } else {
        el.select();
      }
      return;
    }
    if (!point?.offsetNode) return;
    const selection = window.getSelection();
    const { offsetNode: node, offset } = point;
    if (detail === 1) {
      selection.collapse(node, offset);
    } else if (detail === 2) {
      if (node.nodeType !== 3) return;
      const [start, end] = wordAt(node.data, offset);
      selection.setBaseAndExtent(node, start, node, end);
    } else {
      let block = node.nodeType === 3 ? node.parentElement : node;
      while (block && parentOf(block) && getComputedStyle(block).display.startsWith("inline")) block = parentOf(block);
      if (block) selection.selectAllChildren(block);
    }
  }

  // --- Mouse ---
  // Pages listen for pointer events as much as for mouse events, and for the
  // ones sent when the mouse gets to an element: mouseover, mouseenter. A page's
  // CSS :hover stays as it is: only the real mouse sets that.
  let hovered = null; // the element the synthetic mouse is over

  function mouseInit(x, y, modifiers, extra = {}) {
    return {
      // composed: real events cross shadow DOM boundaries, and the element
      // may be inside a shadow root.
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, button: 0, buttons: 0, detail: 0,
      ctrlKey: !!(modifiers & 2), altKey: !!(modifiers & 1),
      shiftKey: !!(modifiers & 8), metaKey: !!(modifiers & 4),
      ...extra,
    };
  }

  function firePointer(el, type, init) {
    return el.dispatchEvent(new PointerEvent(type, {
      ...init, pointerId: 1, pointerType: "mouse", isPrimary: true, width: 1, height: 1,
      pressure: init.buttons ? 0.5 : 0,
    }));
  }

  // pointer<name>, then mouse<name>.
  function fireBoth(el, name, init) {
    firePointer(el, `pointer${name}`, init);
    return el.dispatchEvent(new MouseEvent(`mouse${name}`, init));
  }

  function moveMouseTo(el, init) {
    if (el !== hovered) {
      const from = hovered?.isConnected ? hovered : null;
      const chain = (node) => {
        const nodes = [];
        for (let n = node; n; n = parentOf(n)) nodes.push(n);
        return nodes;
      };
      const left = from ? chain(from) : [];
      const entered = chain(el);
      const edge = { bubbles: false, cancelable: false, composed: false };
      if (from) {
        fireBoth(from, "out", { ...init, relatedTarget: el });
        for (const node of left) {
          if (!entered.includes(node)) fireBoth(node, "leave", { ...init, ...edge, relatedTarget: el });
        }
      }
      fireBoth(el, "over", { ...init, relatedTarget: from });
      for (const node of [...entered].reverse()) {
        if (!left.includes(node)) fireBoth(node, "enter", { ...init, ...edge, relatedTarget: from });
      }
      hovered = el;
    }
    fireBoth(el, "move", init);
  }

  // A press of the button; whether the page let it go ahead. A page that
  // cancels pointerdown gets no mousedown, as with a real mouse, but the press
  // still counts.
  function pressMouse(el, init) {
    if (!firePointer(el, "pointerdown", init)) return true;
    return el.dispatchEvent(new MouseEvent("mousedown", init));
  }

  function releaseMouse(el, init) {
    fireBoth(el, "up", init);
  }

  // --- Human-like mouse movement (the humanize setting) ---
  // The mouse goes to its point along a curve, slowing near the end, taking
  // longer the farther it goes (Fitts's law), and waits a moment before it
  // presses. Where it acts doesn't change, only the way there.
  let mouseAt = null; // where the synthetic mouse last was in this document
  const HUMAN_PACE = { fast: 0.6, natural: 1, relaxed: 1.6 };

  function randomBetween(low, high) {
    return low + Math.random() * (high - low);
  }

  function humanPause(speed, low, high) {
    return sleep(randomBetween(low, high) * (HUMAN_PACE[speed] || 1));
  }

  // Humanized input takes time after its message arrived. It's planned to be
  // done, and answered, before the background stops waiting (msg.deadline,
  // less the margin), and it stops before pressing anything once that's too
  // late, or once Claude no longer has this tab (its glow was removed).
  let releasedAt = 0;
  class InputStopped extends Error {}
  function timeFor(msg) {
    return typeof msg?.deadline === "number" ? msg.deadline - CONTENT_DEADLINE_MARGIN_MS - Date.now() : Infinity;
  }
  function goOn(msg, since, needs = 0) {
    if (releasedAt >= since || timeFor(msg) < needs) throw new InputStopped();
  }
  const failure = (e) => (e instanceof InputStopped ? { error: "expired" } : { error: `${e?.name || "Error"}: ${e?.message || e}` });

  // `within`: how long the way there may take at most; `since`: when the
  // action began (it stops if the tab was lost since).
  async function travelTo(x, y, modifiers, speed, buttons = 0, within = Infinity, since = Date.now()) {
    const pace = HUMAN_PACE[speed] || 1;
    const from = mouseAt || { x: x + randomBetween(-300, 300), y: y + randomBetween(-200, 200) };
    mouseAt = { x, y };
    const dx = x - from.x;
    const dy = y - from.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 3) return;
    const duration = Math.min(Math.min(900, 120 + 110 * Math.log2(1 + distance / 20)) * pace, Math.max(0, within));
    // Two control points off the straight line, on the same side.
    const bend = randomBetween(-0.25, 0.25) * Math.min(distance, 400);
    const [nx, ny] = [-dy / distance, dx / distance];
    const c1 = [from.x + dx * 0.3 + nx * bend, from.y + dy * 0.3 + ny * bend];
    const c2 = [from.x + dx * 0.75 + nx * bend * 0.4, from.y + dy * 0.75 + ny * bend * 0.4];
    // Timed by the clock, not by a count of steps: in a tab the user isn't
    // looking at, Firefox runs a page's timers at most once a second, so the
    // way there has fewer points but takes as long.
    const start = performance.now();
    for (let s = 0; s < 1; ) {
      await sleep(16);
      if (releasedAt >= since) throw new InputStopped();
      s = duration ? Math.min(1, (performance.now() - start) / duration) : 1;
      const t = s < 0.5 ? 2 * s * s : 1 - (2 - 2 * s) ** 2 / 2;
      const u = 1 - t;
      const px = u ** 3 * from.x + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t ** 3 * x;
      const py = u ** 3 * from.y + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t ** 3 * y;
      moveMouseTo(elementAtPoint(px, py) || document.documentElement, mouseInit(px, py, modifiers, { buttons }));
      pointAt(px, py);
    }
  }

  // --- Files (upload_image, file_upload) ---
  // Files given as { name, type, data (base64) }, in a DataTransfer: what a
  // file input takes. (Not for a drop: a page doesn't see the files of a
  // DataTransfer this script made, only of one it made itself.)
  function filesTransfer(files) {
    const transfer = new DataTransfer();
    for (const { name, type, data } of files) {
      const binary = atob(data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      transfer.items.add(new File([bytes], name, { type }));
    }
    return transfer;
  }

  // A drag of an element with draggable=true: the browser's own drag events.
  // `points` are the steps of the way. Returns whether the drop was accepted.
  async function dragAndDrop(source, points, modifiers) {
    const dataTransfer = new DataTransfer();
    const fire = (el, type, [x, y]) => el.dispatchEvent(new DragEvent(type, { ...mouseInit(x, y, modifiers), dataTransfer }));
    if (!fire(source, "dragstart", points[0])) return false;
    let over = null;
    let accepted = false;
    for (const point of points) {
      const target = elementAtPoint(...point) || document.documentElement;
      if (target !== over) {
        if (over) fire(over, "dragleave", point);
        fire(target, "dragenter", point);
        over = target;
      }
      fire(source, "drag", point);
      accepted = !fire(over, "dragover", point);
      pointAt(...point);
      await sleep(20);
    }
    const last = points[points.length - 1];
    if (accepted) fire(over, "drop", last);
    fire(source, "dragend", last);
    return accepted;
  }

  // --- Scrolling ---

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
    for (let node = el; node && node !== document.documentElement; node = parentOf(node)) {
      if (canScroll(node, dx, dy)) return node;
    }
    return null;
  }

  // Whether el is inside a part of the page that scrolls by itself, even if
  // it's at its end: a modal's list, say.
  function inScrollingPart(el) {
    for (let node = el; node && node !== document.body && node !== document.documentElement; node = parentOf(node)) {
      const style = getComputedStyle(node);
      const scrollsY = /auto|scroll|overlay/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
      const scrollsX = /auto|scroll|overlay/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1;
      if (scrollsY || scrollsX) return true;
    }
    return false;
  }

  // Whether el is inside a fixed layer over most of the window, as a cookie
  // wall or a modal is.
  function inOverlay(el) {
    for (let node = el; node; node = parentOf(node)) {
      if (getComputedStyle(node).position !== "fixed") continue;
      const rect = node.getBoundingClientRect();
      if (rect.width * rect.height > window.innerWidth * window.innerHeight * 0.5) return true;
    }
    return false;
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
  // One left by this script before the extension was updated or reloaded:
  // its timers are gone, so it would never fade.
  for (const stale of document.querySelectorAll("claude-mcp-glow")) stale.remove();
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
        .cursor {
          position: fixed; left: 0; top: 0; width: 22px; height: 22px; display: none; pointer-events: none;
          filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.45));
          transition: left 0.18s ease-out, top 0.18s ease-out;
        }
        @keyframes breathe { 50% { box-shadow: inset 0 0 0 2px rgba(var(--glow), 0.55), inset 0 0 14px 2px rgba(var(--glow), 0.25); } }
        @media (prefers-reduced-motion: reduce) { .frame { animation: none; } .cursor { transition: none; } }
      </style>
      <div class="frame"></div>
      <svg class="cursor" viewBox="0 0 22 22"><path d="M2 2 L2 18 L6.5 13.8 L9.6 20.6 L12.6 19.2 L9.6 12.6 L15.6 12.6 Z" fill="rgb(217, 119, 87)" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>
      <div class="label">Claude is using this tab</div>`;
    glowCursor = root.querySelector(".cursor");
    return host;
  }

  // Shows where Claude's mouse is, for the user watching: a pointer with its
  // tip at the point, which fades with the glow and is hidden in screenshots
  // like it. (Only the page itself shows it: a frame's points are passed down
  // from the page, which shows them where they are.)
  let glowCursor = null;
  function pointAt(x, y) {
    if (window !== window.top) return;
    showGlow();
    glowCursor.style.display = "block";
    glowCursor.style.left = `${x - 2}px`;
    glowCursor.style.top = `${y - 2}px`;
  }

  // Until when a screenshot keeps it hidden: a mouse still on its way (or a
  // click) doesn't show it in the picture. Ends when the screenshot's done.
  let hiddenForCaptureUntil = 0;

  function showGlow() {
    if (!glowHost) glowHost = buildGlow();
    if (!glowHost.isConnected) document.documentElement.appendChild(glowHost);
    if (Date.now() >= hiddenForCaptureUntil) glowHost.style.setProperty("visibility", "visible", "important");
    clearTimeout(glowTimer);
    glowTimer = setTimeout(removeGlow, GLOW_LINGER_MS);
  }

  function removeGlow() {
    clearTimeout(glowTimer);
    glowHost?.remove();
  }

  // Hidden (not removed) while a screenshot is taken; resolves once the page
  // has painted without it. A tab the user isn't looking at isn't painted
  // until it's captured, so there's nothing to wait for.
  function hideGlowForCapture() {
    hiddenForCaptureUntil = Date.now() + 10000;
    if (!glowHost?.isConnected) return Promise.resolve();
    glowHost.style.setProperty("visibility", "hidden", "important");
    if (document.hidden) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => resolve();
      requestAnimationFrame(() => requestAnimationFrame(done));
      setTimeout(done, 150); // rAF doesn't run in background tabs
    });
  }

  // --- Message handler ---
  chrome.runtime.onMessage.addListener(function listener(msg, sender, sendResponse) {
    // Arrived after the background stopped waiting (the page was busy): the
    // tool already reported it as not done, so it mustn't happen now. A
    // second's margin, so that what's done here is answered before then.
    if (typeof msg.deadline === "number" && Date.now() > msg.deadline - CONTENT_DEADLINE_MARGIN_MS) {
      sendResponse({ error: "expired" });
      return;
    }
    if (msg.type === "released") {
      releasedAt = Date.now();
      sendResponse({});
      return;
    }
    if (msg.type === "glow") {
      if (msg.mode !== "hide") hiddenForCaptureUntil = 0;
      if (msg.mode === "remove") releasedAt = Date.now();
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
      const tree = generateAccessibilityTree(msg.options || {});
      sendResponse(typeof tree === "string" ? { result: tree } : tree);
      return true;
    }

    if (msg.type === "listFrames") {
      sendResponse({ result: listFrames() });
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
      // A field can refuse a value (a file input throws): say so, rather
      // than leaving the answer empty.
      let result;
      try {
        result = setFormValue(msg.ref, msg.value);
      } catch (e) {
        result = { error: `${e?.name || "Error"}: ${e?.message || e}` };
      }
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
        sendResponse({ outside: true });
        return true;
      }
      const frame = frameOf(el);
      // Humanized, the pointer travels there (travelTo) instead of appearing
      // at once, unless the point is in a frame, whose page can't show it.
      if (!msg.humanize || frame !== null) pointAt(x, y);
      if (frame !== null) {
        sendResponse({ intoFrame: { frameId: frame, ...pointInFrame(el, x, y) } });
        return true;
      }
      const buttonMap = { left: 0, middle: 1, right: 2 };
      const btn = buttonMap[button ?? "left"] ?? 0;
      const btns = btn === 0 ? 1 : btn === 1 ? 4 : 2;
      const speed = msg.humanize;
      const presses = button === "left" || button === undefined ? clickCount || 1 : 1;
      (async () => {
        let target = el;
        if (speed) {
          const since = Date.now();
          // Time kept for the pauses around the presses, at their longest.
          const pauses = (120 + presses * 240) * (HUMAN_PACE[speed] || 1);
          await travelTo(x, y, modifiers, speed, 0, timeFor(msg) - pauses, since);
          await humanPause(speed, 40, 120);
          goOn(msg, since, presses * 240 * (HUMAN_PACE[speed] || 1));
          // What's there now: the page may have changed under the mouse.
          target = elementAtPoint(x, y) || el;
        } else {
          moveMouseTo(el, mouseInit(x, y, modifiers));
          mouseAt = { x, y };
        }
        const newTab = watchForNewTabLink();
        for (let press = 1; press <= presses; press++) {
          const init = mouseInit(x, y, modifiers, { button: btn, detail: press });
          const pressed = pressMouse(target, { ...init, buttons: btns });
          // A page that cancels mousedown (an editor's toolbar button) keeps
          // the focus and the selection as they were, as with a real click.
          if (pressed && press === 1) focusForClick(target);
          if (pressed && btn === 0) {
            try {
              selectForClick(target, x, y, press);
            } catch {
              // Only a detail of the click: not on every kind of element.
            }
          }
          if (speed) await humanPause(speed, 50, 110);
          releaseMouse(target, init);
          if (btn === 0) target.dispatchEvent(new MouseEvent("click", init));
          if (speed && press < presses) await humanPause(speed, 60, 130);
        }
        const init = mouseInit(x, y, modifiers, { button: btn });
        if (presses >= 2) target.dispatchEvent(new MouseEvent("dblclick", { ...init, detail: 2 }));
        if (btn === 2) target.dispatchEvent(new MouseEvent("contextmenu", init));
        if (btn === 1) target.dispatchEvent(new MouseEvent("auxclick", { ...init, detail: 1 }));
        const url = newTab.stop();
        // Nothing under the point but the page itself: likely not what was
        // meant, though the page did get a click.
        const missed = target === document.documentElement || target === document.body;
        sendResponse({
          hit: describeElement(target),
          ...(url ? { openInNewTab: url } : {}),
          ...(missed ? { missed: target.localName } : {}),
        });
      })().catch((e) => sendResponse(failure(e)));
      return true;
    }

    if (msg.type === "dispatchMouseMove") {
      const el = elementAtPoint(msg.x, msg.y);
      if (!el) {
        sendResponse({ outside: true });
        return true;
      }
      const frame = frameOf(el);
      if (!msg.humanize || frame !== null) pointAt(msg.x, msg.y);
      if (frame !== null) {
        sendResponse({ intoFrame: { frameId: frame, ...pointInFrame(el, msg.x, msg.y) } });
        return true;
      }
      if (msg.humanize) {
        travelTo(msg.x, msg.y, msg.modifiers, msg.humanize, 0, timeFor(msg) - 100)
          .then(() => sendResponse({ hit: describeElement(elementAtPoint(msg.x, msg.y) || el) }))
          .catch((e) => sendResponse(failure(e)));
        return true;
      }
      moveMouseTo(el, mouseInit(msg.x, msg.y, msg.modifiers));
      mouseAt = { x: msg.x, y: msg.y };
      sendResponse({ hit: describeElement(el) });
      return true;
    }

    // upload_image and file_upload: files for a file input.
    if (msg.type === "setFiles") {
      const el = resolveRef(msg.ref);
      if (!el || !el.isConnected) {
        sendResponse({ error: `Element ${msg.ref} is no longer on the page. Use read_page or find again.` });
        return true;
      }
      const input = findInputInside(el, 'input[type="file"]');
      if (!input) {
        sendResponse({ error: `${msg.ref} isn't a file input (<input type="file">), and has none inside.` });
        return true;
      }
      if (input.matches(":disabled")) {
        sendResponse({ error: "This file input is disabled." });
        return true;
      }
      if ((msg.check ? msg.count : msg.files.length) > 1 && !input.multiple) {
        sendResponse({ error: "This file input takes one file only." });
        return true;
      }
      // file_upload checks the input before the user is asked.
      if (msg.check) {
        sendResponse({ result: { ok: true, origin: location.origin } });
        return true;
      }
      try {
        input.files = filesTransfer(msg.files).files;
      } catch (e) {
        sendResponse({ error: `${e?.name || "Error"}: ${e?.message || e}` });
        return true;
      }
      input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      sendResponse({ result: { names: Array.from(input.files, (file) => file.name) } });
      return true;
    }

    // upload_image with a point: where files are to be dropped, as from the
    // desktop. The drop itself is made in the page's own world (dropInPage).
    if (msg.type === "dropFiles") {
      const el = elementAtPoint(msg.x, msg.y);
      if (!el) {
        sendResponse({ outside: true });
        return true;
      }
      pointAt(msg.x, msg.y);
      const frame = frameOf(el);
      if (frame !== null) {
        sendResponse({ intoFrame: { frameId: frame, ...pointInFrame(el, msg.x, msg.y) } });
        return true;
      }
      sendResponse({ x: msg.x, y: msg.y, hit: describeElement(el) });
      return true;
    }

    if (msg.type === "dispatchKeyEvent") {
      const keyType = msg.eventType === "keyDown" ? "keydown" : "keyup";
      const notCanceled = dispatchKey(focusedElement(), keyType, msg, msg.modifiers);
      // keypress follows keydown for Enter and keys that type a character
      // (not with ctrl, alt or meta held), as in a browser.
      const typing = msg.key === "Enter" || (msg.key?.length === 1 && !(msg.modifiers & 7));
      let allowed = notCanceled;
      if (keyType === "keydown" && notCanceled && typing) {
        const charCode = msg.key === "Enter" ? 13 : msg.key.charCodeAt(0);
        allowed = dispatchKey(focusedElement(), "keypress", { ...msg, charCode }, msg.modifiers);
      }
      sendResponse(keyType === "keydown" && allowed ? keyDefault(msg.key, msg.modifiers) : {});
      return true;
    }

    // The end of a `type` action: the field gets one change event, as when
    // the user is done editing it.
    if (msg.type === "endTyping") {
      if (lastTypedField?.isConnected) lastTypedField.dispatchEvent(new Event("change", { bubbles: true }));
      // (What a field refused isn't for the next call to continue from.)
      if (lastTypedField) typedAhead.delete(lastTypedField);
      lastTypedField = null;
      sendResponse({});
      return true;
    }

    // One character of the `type` action. Pages see the key going down and
    // up around the text, like real typing; if a keydown or keypress handler
    // cancels the event, the character isn't inserted, as in a browser.
    // Answers whether it went somewhere (inserted), and whether typing can't
    // go on: Enter submitted a form, or the focus left the field.
    if (msg.type === "typeChar") {
      const { text, key } = msg;
      const field = focusedElement();
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
      // itself in one (an editor that cancels keydown and inserts on its
      // own). handled: the page took it with no text field focused (an app
      // that takes keys itself, or a shortcut).
      let inserted = insert || isEditable(field);
      let submitted = false;
      if (insert) {
        const target = focusedElement();
        if (text === "\n" || text === "\r") {
          inserted = isEditable(target);
          submitted = pressEnter(target);
          inserted ||= submitted;
        } else if (text === "\t" && target.localName === "input") {
          // Between form fields, as on a keyboard. In a text area or an editor
          // it's part of the text.
          moveFocus(false);
        } else {
          inserted = insertText(target, text);
        }
      }
      if (key) dispatchKey(focusedElement(), "keyup", key, key.shift ? 8 : 0);
      const left = text !== "\t" && isEditable(field) && !isEditable(focusedElement());
      sendResponse({ inserted, submitted, left, handled: !inserted && !insert, editable: isEditable(focusedElement()) });
      return true;
    }

    if (msg.type === "dispatchScroll") {
      const dx = msg.deltaX || 0;
      const dy = msg.deltaY || 0;
      // The element under the point, also inside shadow DOM (a list in a
      // web component scrolls, not the page around it); the event crosses
      // shadow boundaries, as a real one does.
      const el = elementAtPoint(msg.x, msg.y) || document.documentElement;
      const frame = frameOf(el);
      if (frame !== null) {
        sendResponse({ intoFrame: { frameId: frame, ...pointInFrame(el, msg.x, msg.y) } });
        return true;
      }
      if (msg.humanize && !msg.travelled) {
        // The mouse goes there first; then this message is handled again.
        travelTo(msg.x, msg.y, msg.modifiers, msg.humanize, 0, timeFor(msg) - 200)
          .then(() => listener({ ...msg, travelled: true }, sender, sendResponse))
          .catch((e) => sendResponse(failure(e)));
        return true;
      }
      mouseAt = { x: msg.x, y: msg.y };
      const notCanceled = el.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true, cancelable: true, composed: true, view: window,
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
      // Not when a modal's own list has reached its end, nor in an app that
      // uses the wheel and keeps its layout to the window on purpose.
      if (!moved && isScrollLocked(dx, dy) && !inScrollingPart(el) && (notCanceled || inOverlay(el))) {
        unlockScroll();
        unlocked = true;
        moved = scrollNearest();
      }
      sendResponse({ moved, unlocked, handledByPage: !notCanceled && !unlocked, hit: describeElement(el) });
      return true;
    }

    if (msg.type === "scrollToRef") {
      const el = resolveRef(msg.ref);
      if (!el || !el.isConnected) {
        sendResponse({ error: `Element ${msg.ref} is no longer on the page. Use read_page or find again.` });
        return true;
      }
      el.scrollIntoView({ block: "center", behavior: "instant" });
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
        const start = elementAtPoint(startX, startY);
        if (!start) {
          sendResponse({ outside: true });
          return;
        }
        if (!msg.humanize) pointAt(startX, startY);
        // All of it inside one frame: for that frame. (Across frames, it stays
        // here: this document's <iframe> element gets the events.)
        const frame = frameOf(start);
        if (frame !== null && elementAtPoint(endX, endY) === start) {
          const from = pointInFrame(start, startX, startY);
          const to = pointInFrame(start, endX, endY);
          sendResponse({ intoFrame: { frameId: frame, startX: from.x, startY: from.y, endX: to.x, endY: to.y } });
          return;
        }
        const getEl = (x, y) => elementAtPoint(x, y) || document.documentElement;
        const init = (x, y, buttons, extra) => mouseInit(x, y, modifiers, { buttons, ...extra });
        const speed = msg.humanize;
        const since = Date.now();
        if (speed) {
          // Half the time left to get to the start, the rest for the drag.
          await travelTo(startX, startY, modifiers, speed, 0, (timeFor(msg) - 600) / 2, since);
        } else {
          moveMouseTo(start, init(startX, startY, 0));
        }
        await sleep(50);
        // Once pressed, the drag goes to its end (and the button up).
        if (speed) goOn(msg, since, 400);
        const pressed = pressMouse(start, init(startX, startY, 1, { detail: 1 }));
        await sleep(50);
        const steps = 10;
        const points = [];
        for (let i = 1; i <= steps; i++) {
          points.push([startX + ((endX - startX) * i) / steps, startY + ((endY - startY) * i) / steps]);
        }
        const source = pressed ? start.closest?.('[draggable="true"]') : null;
        let dropped = null;
        if (source) {
          dropped = await dragAndDrop(source, points, modifiers);
        } else if (speed) {
          await travelTo(endX, endY, modifiers, speed, 1, timeFor(msg) - 300, Infinity);
          await humanPause(speed, 40, 100);
        } else {
          for (const [mx, my] of points) {
            moveMouseTo(getEl(mx, my), init(mx, my, 1));
            pointAt(mx, my);
            await sleep(20);
          }
        }
        mouseAt = { x: endX, y: endY };
        // (After a browser drag, dragend is the end of it.)
        if (!source) {
          const end = getEl(endX, endY);
          releaseMouse(end, init(endX, endY, 0, { detail: 1 }));
          if (end === start) end.dispatchEvent(new MouseEvent("click", init(endX, endY, 0, { detail: 1 })));
        }
        sendResponse({ dropped, hit: `${describeElement(start)} to ${describeElement(getEl(endX, endY))}` });
      })().catch((e) => sendResponse(failure(e)));
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
  // this tab. A page coming back from the back/forward cache starts again in
  // the same way (see lib/page-hooks.js).
  chrome.runtime.sendMessage({ type: "pageStarted" }).catch(() => {});
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) chrome.runtime.sendMessage({ type: "pageStarted" }).catch(() => {});
  });
})();
