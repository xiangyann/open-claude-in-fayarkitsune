// Source building for javascript_tool.
//
// Code first runs as is, so the value of its last statement comes back as in
// a console. Top-level `await` and `return` only parse inside a function, so
// code that doesn't parse as a script is tried as function bodies that return
// the last expression: `return (` is inserted at each place a statement could
// start, earliest first, and the first body that parses is the one that runs.
// A body that doesn't parse never runs, so trying several has no side effects.

// Each candidate is a full copy of the code, so the search is bounded: only
// code up to AUTO_RETURN_MAX_LENGTH gets one, and only the last
// MAX_CANDIDATES places within LAST_STATEMENT_WINDOW characters of the end
// are tried (the last statement sits at the end). Candidates are built one
// at a time, never all at once. Code whose last statement doesn't fit runs as
// a plain function body.
const AUTO_RETURN_MAX_LENGTH = 100000;
const LAST_STATEMENT_WINDOW = 4000;
const MAX_CANDIDATES = 60;

// Offsets where the last statement could begin, earliest first: the start of
// a line, or after a semicolon, outside any brackets. Comments, strings,
// template literals and regular expressions are skipped: a `;` in a comment
// isn't a statement boundary, and starting a candidate there would turn
// commented-out code into code that runs. `end` is where the code ends, before
// any comments after it.
function statementStarts(code) {
  if (code.length > AUTO_RETURN_MAX_LENGTH) return { starts: [], end: code.length };
  const from = Math.max(0, code.length - LAST_STATEMENT_WINDOW);
  const starts = from === 0 ? [0] : [];
  const { boundaries, end } = scanCode(code);
  for (const at of boundaries) {
    if (at >= from) starts.push(at);
  }
  return { starts: starts.slice(-MAX_CANDIDATES), end };
}

// Whether the code has an `await (x)`, `await [x]`, await and a line break, …
// outside any function. Those parse as a script too, with `await` as a plain
// name, and would fail when they run, so they don't show up as code that
// needs a function body.
function awaitsAtTopLevel(code) {
  return code.length <= AUTO_RETURN_MAX_LENGTH && scanCode(code).bareAwait;
}

// A small scanner, enough to tell code from comments, strings, template
// literals and regular expressions. boundaries: the offsets just after each
// newline or semicolon that sits in code outside any (), [] or {}. end: just
// after the last character of code. bareAwait: see awaitsAtTopLevel. A `/`
// starts a regular expression unless it follows something a value ends
// with (an identifier, a number, `)` or `]`); keywords like `return` are
// the usual exception, and so is the `)` of an `if (…)`.
//
// A newline is only a boundary where JavaScript would end the statement
// too: not after a loop or `if` header without braces (`for (…)`, `else`),
// not after an operator, and not before a line that starts with one (or
// with `(`, `[` or a template, which continue the line before). Starting a
// candidate there would put `return (` inside the statement: a loop would
// stop after its first round, `a\n- b` would become `return -b`. (The `while`
// that ends a `do` statement is the end of it, not a header.)
function scanCode(code) {
  const out = [];
  const closers = []; // expected closing characters; "`" marks a template's ${ }
  // Alongside closers: the keyword if that "(" opens a header (for, while, …),
  // "body" if that "{" opens a function's body.
  const headers = [];
  let lastSignificant = ""; // the last code character that isn't whitespace
  let lastWord = "";
  let afterHeader = false; // just after the ")" of such a header, outside any brackets
  let afterAnyHeader = false; // the same, inside brackets too
  let end = 0; // just after the last character of code
  let functionDepth = 0; // function bodies around this point
  let openDos = 0; // `do` statements still waiting for their `while`
  let bareAwait = false;
  const regexCanFollowWord = /^(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

  // Whether the statement goes on past the newline at i.
  let skipFrom = -1; // the last run of whitespace and comments looked past
  let skipTo = -1;
  const continues = (i) => {
    if (afterHeader) return true;
    if (/^(else|do)$/.test(lastWord) && /[\w$]/.test(lastSignificant)) return true;
    if (/[=+\-*/%&|^!~<>?:,.]/.test(lastSignificant)) {
      // i++ and i-- end a value.
      const before = code.slice(Math.max(0, i - 8), i).trimEnd();
      if (!/(\+\+|--)$/.test(before)) return true;
    }
    // The next token, past blank lines and comments: an operator after them
    // still continues the statement. The newlines in a run of blank lines
    // and comments share one next token, found once: otherwise each would
    // scan the rest of the run again.
    let j = i + 1;
    if (j >= skipFrom && j <= skipTo) {
      j = skipTo;
    } else {
      for (;;) {
        while (j < code.length && /\s/.test(code[j])) j++;
        if (code.startsWith("//", j)) {
          while (j < code.length && code[j] !== "\n") j++;
        } else if (code.startsWith("/*", j)) {
          const end = code.indexOf("*/", j + 2);
          j = end === -1 ? code.length : end + 2;
        } else {
          break;
        }
      }
      skipFrom = i + 1;
      skipTo = j;
    }
    const next = code.slice(j, j + 2);
    if (/^(\+\+|--)/.test(next)) return false;
    // After a block (`if (…) {}`), a line starting with ( [ or ` is a new
    // statement.
    if (lastSignificant === "}" && /^[([`]/.test(next)) return false;
    return /^[.+\-*/%&|^?:,=<>)\]([`]/.test(next);
  };

  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    const next = code[i + 1];

    // (`<!--` and, first on a line, `-->` are comments too in a script.)
    const htmlComment = (ch === "<" && code.startsWith("<!--", i)) ||
      (ch === "-" && code.startsWith("-->", i) && /(?:^|\n)[ \t]*$/.test(code.slice(Math.max(0, i - 80), i)));
    if (htmlComment || (ch === "/" && next === "/")) {
      while (i < code.length && code[i] !== "\n") i++;
      i--; // the newline is handled as code, so it can be a boundary
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end === -1 ? code.length : end + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      for (i++; i < code.length && code[i] !== ch && code[i] !== "\n"; i++) {
        if (code[i] === "\\") i++;
      }
      lastSignificant = ch;
      lastWord = "";
      afterHeader = afterAnyHeader = false;
      end = Math.min(i + 1, code.length);
      continue;
    }
    if (ch === "`" || (ch === "}" && closers[closers.length - 1] === "`")) {
      // A template literal, or the rest of one after a ${ } expression.
      if (ch === "}") {
        closers.pop();
        headers.pop();
      }
      for (i++; i < code.length; i++) {
        if (code[i] === "\\") {
          i++;
        } else if (code[i] === "`") {
          break;
        } else if (code[i] === "$" && code[i + 1] === "{") {
          closers.push("`");
          headers.push(false);
          i++;
          break;
        }
      }
      lastSignificant = "`";
      lastWord = "";
      afterHeader = afterAnyHeader = false;
      end = Math.min(i + 1, code.length);
      continue;
    }
    if (ch === "/") {
      const valueEnds = /[\w$)\]]/.test(lastSignificant) && !regexCanFollowWord.test(lastWord) && !afterAnyHeader;
      if (!valueEnds) {
        let inClass = false;
        for (i++; i < code.length && code[i] !== "\n"; i++) {
          if (code[i] === "\\") i++;
          else if (code[i] === "[") inClass = true;
          else if (code[i] === "]") inClass = false;
          else if (code[i] === "/" && !inClass) break;
        }
        while (/[a-z]/i.test(code[i + 1] || "")) i++; // flags
        lastSignificant = ")"; // a regular expression ends a value
        lastWord = "";
        afterHeader = afterAnyHeader = false;
        end = Math.min(i + 1, code.length);
        continue;
      }
    }

    let closedHeader = false;
    let closedAnyHeader = false;
    if (ch === "(" || ch === "[" || ch === "{") {
      // (`for await (` too: its last word is `await`.)
      const header = ch === "(" && /(?:^|[^\w$.])(for(?:\s+await)?|while|if|with|catch|switch)\s*$/.exec(code.slice(Math.max(0, i - 24), i));
      // A `{` after `=>`, or after a `)` that closed no header, is a function's.
      const body = ch === "{" && ((lastSignificant === ")" && !afterAnyHeader) || (lastSignificant === ">" && code[end - 2] === "="));
      if (body) functionDepth++;
      headers.push(body ? "body" : header ? header[1] : false);
      closers.push({ "(": ")", "[": "]", "{": "}" }[ch]);
    } else if (ch === ")" || ch === "]" || ch === "}") {
      if (closers[closers.length - 1] === ch) {
        closers.pop();
        const header = headers.pop();
        if (header === "body") {
          functionDepth--;
        } else if (header) {
          closedAnyHeader = true;
          closedHeader = closers.length === 0;
          if (closedHeader && header === "while" && openDos > 0) {
            openDos--;
            closedHeader = false;
          }
        }
      }
    } else if (ch === ";" && closers.length === 0) {
      out.push(i + 1);
    } else if (ch === "\n" && closers.length === 0 && !continues(i)) {
      out.push(i + 1);
    }

    if (/[\w$]/.test(ch)) {
      lastWord = /[\w$]/.test(lastSignificant) && code[i - 1] && /[\w$]/.test(code[i - 1]) ? lastWord + ch : ch;
      if (!/[\w$]/.test(next || "") && code[i - lastWord.length] !== ".") {
        if (lastWord === "do" && closers.length === 0) openDos++;
        // `await x` doesn't parse as a script; these do.
        if (lastWord === "await" && functionDepth === 0 && /^(?:\s*[([`]|[ \t]*\r?\n)/.test(code.slice(i + 1, i + 200))) {
          bareAwait = true;
        }
      }
    } else if (!/\s/.test(ch)) {
      lastWord = "";
    }
    if (!/\s/.test(ch)) {
      lastSignificant = ch;
      afterHeader = closedHeader;
      afterAnyHeader = closedAnyHeader;
      end = i + 1;
    }
  }
  return { boundaries: out, end, bareAwait };
}

// The async function body that returns the expression starting at `at` and
// ending at `end`, or null when there's none: nothing follows, or it's a
// function declaration, which `return (` would turn into an expression that
// code above it can't call. Self-contained: its source is also sent to pages,
// which build the candidates themselves.
function returnBodyAt(code, at, end = code.length) {
  const last = code.slice(at, end).replace(/[\s;]+$/, "");
  if (!last.trim() || /^\s*(?:async\s+)?function\b/.test(last)) return null;
  // Newlines around the expression keep a trailing // comment from
  // swallowing the closing parenthesis.
  return `${code.slice(0, at)}\nreturn (\n${last}\n);`;
}

// Async function bodies to try for `code`, in order, one at a time. The last
// one is the code unchanged, for code whose last statement isn't an
// expression.
function* functionBodies(code) {
  const { starts, end } = statementStarts(code);
  for (const at of starts) {
    const body = returnBodyAt(code, at, end);
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
