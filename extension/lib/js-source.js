// Source building for javascript_tool.
//
// Code first runs as is, so the value of its last statement comes back as in
// a console. Top-level `await` and `return` only parse inside a function, so
// for code that uses them we try function bodies that return the last
// expression: `return (` is inserted at each place a statement could start,
// earliest first, and the first body that parses is the one that runs. A body
// that doesn't parse never runs, so trying several has no side effects.

const AUTO_RETURN_MAX_LENGTH = 100000;

// Error messages Firefox gives for `await` and `return` outside a function.
function needsFunctionBody(message) {
  return /await is only valid in async functions|return not in function/i.test(String(message));
}

// Offsets where the last statement could begin: the start of the code, each
// line, and after each semicolon (most of these won't parse, which is fine).
function statementStarts(code) {
  const starts = new Set([0]);
  for (let i = 0; i < code.length; i++) {
    if (code[i] === "\n" || code[i] === ";") starts.add(i + 1);
  }
  return [...starts].sort((a, b) => a - b);
}

// Async function bodies to try for `code`, in order. The last one is the code
// unchanged, for code whose last statement isn't an expression.
function functionBodies(code) {
  const bodies = [];
  if (code.length <= AUTO_RETURN_MAX_LENGTH) {
    for (const at of statementStarts(code)) {
      const last = code.slice(at).replace(/[\s;]+$/, "");
      if (!last.trim()) continue;
      // Newlines around the expression keep a trailing // comment from
      // swallowing the closing parenthesis.
      bodies.push(`${code.slice(0, at)}\nreturn (\n${last}\n);`);
    }
  }
  bodies.push(code);
  return bodies;
}

// Turns a script result into something that survives structured cloning and
// JSON: DOM nodes and functions become short descriptions, cycles and very
// deep or long structures are cut. Self-contained, because its source is also
// injected into pages as text (see userScriptSource).
function packValue(result) {
  const MAX_DEPTH = 8;
  const MAX_ITEMS = 200;
  const seen = new WeakSet();

  const describeNode = (node) => {
    if (node.nodeType === 9) return `[document ${node.URL || ""}]`.trim();
    if (node.nodeType === 3) return `[text "${node.textContent.trim().slice(0, 80)}"]`;
    if (node.nodeType !== 1) return `[${node.nodeName}]`;
    const selector = node.localName + (node.id ? `#${node.id}` : "") +
      Array.from(node.classList, (c) => `.${c}`).slice(0, 3).join("");
    const text = (node.innerText || node.textContent || "").trim().replace(/\s+/g, " ");
    return text ? `<${selector}> "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"` : `<${selector}>`;
  };

  const listOf = (items, depth) => {
    const out = [];
    let i = 0;
    for (const item of items) {
      if (i++ === MAX_ITEMS) {
        out.push(`… ${items.length - MAX_ITEMS} more`);
        break;
      }
      out.push(walk(item, depth + 1));
    }
    return out;
  };

  const walk = (v, depth) => {
    switch (typeof v) {
      case "string":
      case "boolean":
      case "undefined":
        return v;
      case "number":
        return Number.isFinite(v) ? v : String(v);
      case "bigint":
        return `${v}n`;
      case "symbol":
        return v.toString();
      case "function":
        return `[function ${v.name || "(anonymous)"}]`;
    }
    if (v === null) return null;
    if (typeof Node === "function" && v instanceof Node) return describeNode(v);
    if (typeof Window === "function" && v instanceof Window) return "[window]";
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    if (v instanceof Date) return isNaN(v) ? "Invalid Date" : v.toISOString();
    if (v instanceof RegExp) return String(v);
    if (typeof v.then === "function") return "[promise]";
    if (seen.has(v)) return "[circular]";
    if (depth >= MAX_DEPTH) return Array.isArray(v) ? "[array]" : "[object]";
    seen.add(v);
    try {
      if (Array.isArray(v)) return listOf(v, depth);
      if (v instanceof Map) return { [`Map(${v.size})`]: listOf([...v.entries()], depth) };
      if (v instanceof Set) return { [`Set(${v.size})`]: listOf([...v], depth) };
      if (typeof NodeList === "function" && (v instanceof NodeList || v instanceof HTMLCollection)) {
        return listOf([...v], depth);
      }
      const out = {};
      const keys = Object.keys(v);
      for (const key of keys.slice(0, MAX_ITEMS)) {
        try {
          out[key] = walk(v[key], depth + 1);
        } catch (e) {
          out[key] = `[unreadable: ${e && e.message}]`;
        }
      }
      if (keys.length > MAX_ITEMS) out["…"] = `${keys.length - MAX_ITEMS} more keys`;
      return out;
    } finally {
      seen.delete(v);
    }
  };

  return result === undefined ? { undefined: true } : { value: walk(result, 0) };
}

// A user script that runs `body` as an async function and evaluates to a
// promise of { ok: packed result } or { thrown: error text }. Firefox waits
// for the promise; a body that doesn't parse makes the whole script fail to
// parse, which userScripts.execute reports as an error without running it.
function userScriptSource(body) {
  return `(async () => {
  try {
    const result = await (async () => {
${body}
    })();
    return { ok: (${packValue})(result) };
  } catch (e) {
    return { thrown: e && e.name ? e.name + ": " + e.message : String(e) };
  }
})()`;
}
