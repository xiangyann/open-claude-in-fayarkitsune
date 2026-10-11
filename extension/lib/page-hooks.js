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
// installPageHooks is injected with scripting.executeScript, so it must be
// self-contained. Calling it again updates the settings and returns the
// dialogs recorded since the last call.

function installPageHooks(settings) {
  const STATE = Symbol.for("claude-mcp-fayarkitsune.hooks");
  let hooks = window[STATE];

  if (!hooks) {
    hooks = { logs: [], dialogs: [], answerUntil: 0, nextAnswer: null };
    Object.defineProperty(window, STATE, { value: hooks });

    const MAX_LOGS = 1000;
    const record = (level, text) => {
      hooks.logs.push({ level, text, url: location.href, timestamp: Date.now() });
      if (hooks.logs.length > MAX_LOGS) hooks.logs.splice(0, hooks.logs.length - MAX_LOGS);
    };
    const show = (arg) => {
      if (arg instanceof Error) return arg.stack ? `${arg.name}: ${arg.message}\n${arg.stack}` : `${arg.name}: ${arg.message}`;
      if (typeof arg === "string") return arg;
      if (typeof arg !== "object" || arg === null) return String(arg);
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    };

    for (const level of ["log", "info", "warn", "error", "debug"]) {
      const original = console[level];
      console[level] = function (...args) {
        try {
          record(level, args.map(show).join(" "));
        } catch {}
        return original.apply(this, args);
      };
    }

    window.addEventListener("error", (event) => {
      if (!(event instanceof ErrorEvent)) return; // resource load failures
      const where = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : "";
      record("exception", `Uncaught ${event.error ? show(event.error) : event.message}${where}`);
    });
    window.addEventListener("unhandledrejection", (event) => {
      record("exception", `Unhandled promise rejection: ${show(event.reason)}`);
    });

    const native = { alert: window.alert, confirm: window.confirm, prompt: window.prompt };
    const handle = (type, message, defaultText) => {
      const note = { type, message: String(message ?? "").slice(0, 500) };
      hooks.dialogs.push(note);
      if (Date.now() > hooks.answerUntil) {
        note.answer = "left open for the user";
        return { native: true };
      }
      const chosen = hooks.nextAnswer;
      hooks.nextAnswer = null;
      if (type === "alert") {
        note.answer = "OK";
        return { value: undefined };
      }
      const accept = chosen ? chosen.accept : false;
      if (type === "confirm") {
        note.answer = accept ? "OK" : "Cancel";
        return { value: accept };
      }
      const text = accept ? String(chosen.promptText ?? defaultText ?? "") : null;
      note.answer = accept ? `OK with "${text}"` : "Cancel";
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
  }
  const action = settings && settings.read;
  if (action === "logs") {
    const logs = hooks.logs.slice();
    if (settings.clear) hooks.logs.length = 0;
    return { logs };
  }
  return { dialogs: hooks.dialogs.splice(0) };
}
