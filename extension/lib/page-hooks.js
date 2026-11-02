// Hooks installed into the page's own JavaScript world (MAIN) of tabs Claude
// controls, once per document:
// - console messages, uncaught errors and unhandled promise rejections, for
//   read_console_messages;
// - alert/confirm/prompt. A real dialog would freeze the page without showing
//   up in screenshots, so while Claude is working in the tab they're answered
//   right away (OK for alert, Cancel for confirm, no input for prompt, unless
//   Claude chose an answer with handle_dialog) and reported in the next tool
//   result. Outside that window the page gets the normal dialog.
//
// While Claude doesn't control the tab (released, or shared and then taken
// back), nothing is recorded: what happens then is the user's alone, and
// isn't shown to Claude if the tab is shared again.
//
// installPageHooks is injected with scripting.executeScript, so it must be
// self-contained. Calling it again updates the settings and returns the
// dialogs recorded since the last call.

function installPageHooks(settings) {
  // (The frames of a page are asked apart from the page itself: see
  // callPageHooks.)
  if (settings && settings.subframes && window === window.top) return {};
  const STATE = Symbol.for("claude-mcp-fayarkitsune.hooks");
  let hooks = window[STATE];

  if (!hooks) {
    hooks = { logs: [], dialogs: [], droppedDialogs: 0, answerUntil: 0, nextAnswer: null, recording: true };
    Object.defineProperty(window, STATE, { value: hooks });

    // A page back from the back/forward cache: it may have been left there
    // while Claude could use the tab, and only Claude's next call for it knows
    // whether it still can. Until then its dialogs are the user's.
    window.addEventListener("pageshow", (event) => {
      if (!event.persisted) return;
      hooks.answerUntil = 0;
      hooks.nextAnswer = null;
      hooks.recording = false;
    });

    const MAX_LOGS = 1000;
    // A page can open dialogs in a loop; only the first ones since the last
    // report are kept, and the rest are counted.
    const MAX_DIALOGS = 50;
    // Messages are cut to a sane size. Bundlers can put a whole list of chunks
    // in a script's query string, so each stack frame may be kilobytes long:
    // long query strings are left out, and only the first frames are kept.
    const MAX_TEXT = 4000;
    const MAX_FRAMES = 10;
    const MAX_FRAME = 300;
    const cut = (text, max) => (text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text);
    const shortUrl = (text) => text.replace(/\?[^\s()]{40,}?(?=:\d+:\d+\)?$|$)/, "?…");
    const showStack = (stack) => {
      const frames = stack.split("\n").filter((frame) => frame.trim());
      const shown = frames.slice(0, MAX_FRAMES).map((frame) => cut(shortUrl(frame), MAX_FRAME));
      if (frames.length > MAX_FRAMES) shown.push(`… ${frames.length - MAX_FRAMES} more frames`);
      return shown.join("\n");
    };
    // Told apart across frames (a call to clear them names them).
    const frameTag = Math.random().toString(36).slice(2, 8);
    let logCounter = 0;
    const record = (level, text) => {
      if (!hooks.recording) return;
      hooks.logs.push({ id: `${frameTag}${++logCounter}`, level, text: cut(text, MAX_TEXT), url: location.href, timestamp: Date.now() });
      if (hooks.logs.length > MAX_LOGS) hooks.logs.splice(0, hooks.logs.length - MAX_LOGS);
    };
    // Objects are shown as JSON, but only so much of them: a page logging a
    // huge object, or one whose parts are shared many times over, mustn't
    // pay for all of it. Getters aren't run: the console doesn't either.
    const MAX_ITEMS = 300;
    const MAX_DEPTH = 6;
    const sample = (v, depth, budget) => {
      if (budget.items-- <= 0) return "…";
      if (typeof v === "string") return v.length > MAX_TEXT ? `${v.slice(0, MAX_TEXT)}…` : v;
      if (typeof v === "bigint") return `${v}n`;
      if (typeof v === "function") return `[function ${v.name || "anonymous"}]`;
      if (typeof v === "symbol" || typeof v === "undefined") return String(v);
      if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
      if (v === null || typeof v !== "object") return v;
      if (v instanceof Date) return isNaN(v) ? "Invalid Date" : v.toISOString();
      if (v instanceof Error) return `${v.name}: ${v.message}`;
      if (v instanceof RegExp) return String(v);
      if (ArrayBuffer.isView(v)) return `[${v.constructor.name}(${v.length ?? v.byteLength})]`;
      if (budget.seen.has(v)) return "[circular]";
      if (depth >= MAX_DEPTH) return Array.isArray(v) ? "[…]" : "{…}";
      budget.seen.add(v);
      try {
        if (Array.isArray(v)) return v.slice(0, 100).map((item) => sample(item, depth + 1, budget));
        const list = (items) => items.slice(0, 100).map((item) => sample(item, depth + 1, budget));
        if (v instanceof Map) return { [`Map(${v.size})`]: list([...v]) };
        if (v instanceof Set) return { [`Set(${v.size})`]: list([...v]) };
        const out = {};
        for (const key of Object.keys(v).slice(0, 100)) {
          if (budget.items <= 0) break;
          const property = Object.getOwnPropertyDescriptor(v, key);
          out[key] = property && "value" in property ? sample(property.value, depth + 1, budget) : "[getter]";
        }
        return out;
      } finally {
        budget.seen.delete(v);
      }
    };
    const show = (arg) => {
      if (arg instanceof Error) return arg.stack ? `${arg.name}: ${arg.message}\n${showStack(arg.stack)}` : `${arg.name}: ${arg.message}`;
      if (typeof arg === "string") return arg;
      if (typeof arg !== "object" || arg === null) return String(arg);
      try {
        return JSON.stringify(sample(arg, 0, { items: MAX_ITEMS, seen: new Set() }));
      } catch {
        return String(arg);
      }
    };

    for (const level of ["log", "info", "warn", "error", "debug"]) {
      const original = console[level];
      console[level] = function (...args) {
        // (Nothing is shown or kept while Claude doesn't control the tab.)
        if (hooks.recording) {
          try {
            record(level, args.map(show).join(" "));
          } catch {}
        }
        return original.apply(this, args);
      };
    }

    window.addEventListener("error", (event) => {
      if (!(event instanceof ErrorEvent)) return; // resource load failures
      const where = event.filename ? ` (${shortUrl(event.filename)}:${event.lineno}:${event.colno})` : "";
      record("exception", `Uncaught ${event.error ? show(event.error) : event.message}${where}`);
    });
    window.addEventListener("unhandledrejection", (event) => {
      record("exception", `Unhandled promise rejection: ${show(event.reason)}`);
    });

    const native = { alert: window.alert, confirm: window.confirm, prompt: window.prompt };
    const handle = (type, message, defaultText) => {
      if (!hooks.recording) return { native: true };
      const note = { type, message: String(message ?? "").slice(0, 500) };
      if (hooks.dialogs.length < MAX_DIALOGS) hooks.dialogs.push(note);
      else hooks.droppedDialogs++;
      if (Date.now() > hooks.answerUntil) {
        note.answer = "left open for the user";
        return { native: true };
      }
      if (type === "alert") {
        // Leaves an answer chosen with handle_dialog for the next confirm/prompt.
        note.answer = "OK";
        return { value: undefined };
      }
      const chosen = hooks.nextAnswer;
      hooks.nextAnswer = null;
      const accept = chosen ? chosen.accept : false;
      if (type === "confirm") {
        note.answer = accept ? "OK" : "Cancel";
        return { value: accept };
      }
      const text = accept ? String(chosen.promptText ?? defaultText ?? "") : null;
      // Not the text itself: it can be a password, and this goes on disk with
      // the tool's result for a moment (see keptOutcome). Claude chose it.
      note.answer = !accept ? "Cancel" : chosen.promptText != null ? "OK with your text" : "OK with its default text";
      return { value: text };
    };
    window.alert = function alert(message) {
      const r = handle("alert", message);
      return r.native ? native.alert.apply(window, arguments) : r.value;
    };
    window.confirm = function confirm(message) {
      const r = handle("confirm", message);
      return r.native ? native.confirm.apply(window, arguments) : r.value;
    };
    window.prompt = function prompt(message, defaultText) {
      const r = handle("prompt", message, defaultText);
      return r.native ? native.prompt.apply(window, arguments) : r.value;
    };
  }

  if (settings) {
    if (typeof settings.answerUntil === "number") hooks.answerUntil = settings.answerUntil;
    if ("nextAnswer" in settings) hooks.nextAnswer = settings.nextAnswer;
    if (typeof settings.recording === "boolean") hooks.recording = settings.recording;
    if (settings.forget) {
      hooks.logs.length = 0;
      hooks.dialogs.length = 0;
      hooks.droppedDialogs = 0;
    }
  }
  // read_console_messages filters what it reads itself, and then has what it
  // returned cleared: nothing else is lost.
  if (settings && settings.clearLogs) {
    const returned = new Set(settings.clearLogs);
    hooks.logs = hooks.logs.filter((m) => !returned.has(m.id));
  }
  if (settings && settings.read === "logs") return { logs: hooks.logs.slice() };
  // Only a tool's own before and after calls take the dialogs, to report
  // them; other calls leave them for those.
  if (settings && settings.report === false) return {};
  const dropped = hooks.droppedDialogs;
  hooks.droppedDialogs = 0;
  return { dialogs: hooks.dialogs.splice(0), dropped };
}
