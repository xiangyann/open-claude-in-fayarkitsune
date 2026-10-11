// Source building for javascript_tool.
//
// Code first runs as is, so the value of its last statement comes back as in
// a console. Top-level `await` and `return` only parse inside a function, so
// for code that uses them we try function bodies that return the last
// expression: `return (` is inserted at each place a statement could start,
// earliest first, and the first body that parses is the one that runs. A body
// that doesn't parse never runs, so trying several has no side effects.

// Each candidate is a full copy of the code, so the search is bounded: only
// code up to AUTO_RETURN_MAX_LENGTH gets one, and only the last
// MAX_CANDIDATES places within LAST_STATEMENT_WINDOW characters of the end
// are tried (the last statement sits at the end). Candidates are built one
// at a time, never all at once. Code whose last statement doesn't fit runs as
// a plain function body.
const AUTO_RETURN_MAX_LENGTH = 100000;
const LAST_STATEMENT_WINDOW = 4000;
const MAX_CANDIDATES = 60;

// Error messages Firefox gives for `await` and `return` outside a function.
function needsFunctionBody(message) {
  return /await is only valid in async functions|return not in function/i.test(String(message));
}

// Offsets where the last statement could begin, earliest first: the start of
// a line, or after a semicolon (most of these won't parse, which is fine).
function statementStarts(code) {
  if (code.length > AUTO_RETURN_MAX_LENGTH) return [];
  const from = Math.max(0, code.length - LAST_STATEMENT_WINDOW);
  const starts = from === 0 ? [0] : [];
  for (let i = from; i < code.length; i++) {
    if (code[i] === "\n" || code[i] === ";") starts.push(i + 1);
  }
  return starts.slice(-MAX_CANDIDATES);
}

// The async function body that returns the expression starting at `at`, or
// null when nothing follows. Self-contained: its source is also sent to
// pages, which build the candidates themselves.
function returnBodyAt(code, at) {
  const last = code.slice(at).replace(/[\s;]+$/, "");
  if (!last.trim()) return null;
  // Newlines around the expression keep a trailing // comment from
  // swallowing the closing parenthesis.
  return `${code.slice(0, at)}\nreturn (\n${last}\n);`;
}

// Async function bodies to try for `code`, in order, one at a time. The last
// one is the code unchanged, for code whose last statement isn't an
// expression.
function* functionBodies(code) {
  for (const at of statementStarts(code)) {
    const body = returnBodyAt(code, at);
    if (body !== null) yield body;
  }
  yield code;
}

// Turns a script result into something that survives structured cloning and
// JSON: DOM nodes and functions become short descriptions, cycles and very
// deep or long structures are cut. Self-contained, because its source is also
// injected into pages as text (see userScriptSource).
//
// The work is bounded for the whole result, not per object: an object
// reached along many paths is packed once per path (only true cycles are
// caught), so without a shared budget a modest graph could expand to
// millions of values and freeze the page. { cut: true } says it ran out.
function packValue(result) {
  const MAX_DEPTH = 8;
  const MAX_ITEMS = 200;
  const MAX_VALUES = 20000; // values packed in total
  const MAX_STRING = 100000; // characters per string; the tool shows 50,000 at most
  const seen = new WeakSet();
  let valuesLeft = MAX_VALUES;
  let cut = false;

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
    if (--valuesLeft < 0) {
      cut = true;
      return "…";
    }
    switch (typeof v) {
      case "string":
        if (v.length <= MAX_STRING) return v;
        cut = true;
        return `${v.slice(0, MAX_STRING)}…`;
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

  if (result === undefined) return { undefined: true };
  const value = walk(result, 0);
  return cut ? { value, cut } : { value };
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
