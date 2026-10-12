// Keyboard data for synthetic key events (US layout, Firefox's legacy
// keyCode values). Synthetic events don't type, move focus or submit forms
// by themselves; they let pages that listen for keys see them.

// Modifiers by the names the `key` and `modifiers` arguments accept:
// [the modifier's bit in input messages, its own key, code, keyCode].
const MODIFIERS = {};
for (const [names, bit, key, code, keyCode] of [
  [["alt"], 1, "Alt", "AltLeft", 18],
  [["ctrl", "control"], 2, "Control", "ControlLeft", 17],
  [["meta", "cmd", "command", "win", "windows"], 4, "Meta", "MetaLeft", 91],
  [["shift"], 8, "Shift", "ShiftLeft", 16],
]) {
  for (const name of names) MODIFIERS[name] = { bit, key, code, keyCode };
}
const SHIFT_BIT = 8;

// Non-character keys, looked up case-insensitively. For all of these but
// Space, KeyboardEvent.code is the same as .key; the number is the keyCode.
const KEY_NUMBERS = {
  Backspace: 8, Tab: 9, Enter: 13, Escape: 27, " ": 32,
  PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Insert: 45, Delete: 46,
};
for (let n = 1; n <= 12; n++) KEY_NUMBERS["F" + n] = 111 + n;

const KEY_NAMES = new Map(Object.keys(KEY_NUMBERS).map((k) => [k.toLowerCase(), k]));
for (const [alias, key] of Object.entries({
  space: " ", return: "Enter", esc: "Escape", del: "Delete",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  pgup: "PageUp", pgdn: "PageDown",
})) {
  KEY_NAMES.set(alias, key);
}

function namedKey(name) {
  const key = KEY_NAMES.get(name.toLowerCase());
  if (key === undefined) return null;
  return { key, code: key === " " ? "Space" : key, keyCode: KEY_NUMBERS[key] };
}

// [plain, with shift, code, keyCode]. Firefox's keyCodes for ; = - differ
// from Chrome's (59, 61, 173 rather than 186, 187, 189).
const SYMBOL_KEYS = [
  ["`", "~", "Backquote", 192],
  ["-", "_", "Minus", 173],
  ["=", "+", "Equal", 61],
  ["[", "{", "BracketLeft", 219],
  ["]", "}", "BracketRight", 221],
  ["\\", "|", "Backslash", 220],
  [";", ":", "Semicolon", 59],
  ["'", '"', "Quote", 222],
  [",", "<", "Comma", 188],
  [".", ">", "Period", 190],
  ["/", "?", "Slash", 191],
];
const SHIFTED_DIGITS = ")!@#$%^&*("; // index = the digit key they share

// The key that types `ch` on a US keyboard: { key, code, keyCode, shift },
// or null for characters without one (emoji, CJK, accented letters).
function keyForChar(ch) {
  if (ch === "\n" || ch === "\r") return { ...namedKey("enter"), shift: false };
  if (ch === "\t") return { ...namedKey("tab"), shift: false };
  if (ch === " ") return { ...namedKey("space"), shift: false };
  if (/^[a-z]$/.test(ch)) return { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), shift: false };
  if (/^[A-Z]$/.test(ch)) return { key: ch, code: `Key${ch}`, keyCode: ch.charCodeAt(0), shift: true };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), shift: false };
  const shiftedDigit = SHIFTED_DIGITS.indexOf(ch);
  if (shiftedDigit !== -1) return { key: ch, code: `Digit${shiftedDigit}`, keyCode: 48 + shiftedDigit, shift: true };
  for (const [plain, shifted, code, keyCode] of SYMBOL_KEYS) {
    if (ch === plain) return { key: ch, code, keyCode, shift: false };
    if (ch === shifted) return { key: ch, code, keyCode, shift: true };
  }
  return null;
}

// The character a key gives with shift held (US layout); others unchanged.
function shiftedChar(ch) {
  if (/^[a-z]$/.test(ch)) return ch.toUpperCase();
  if (/^[0-9]$/.test(ch)) return SHIFTED_DIGITS[Number(ch)];
  const symbol = SYMBOL_KEYS.find(([plain]) => plain === ch);
  return symbol ? symbol[1] : ch;
}

// Parses one entry of the `key` action, e.g. "Enter", "ctrl+a", "shift+Tab".
// Returns { key, code, keyCode, modifiers }.
function parseKeyCombo(combo) {
  let modifiers = 0;
  let lastModifier = null;
  let main = null;
  // "+" is both the separator and a key: "+" alone or a trailing "++"
  // ("ctrl++") means the + key.
  let text = combo;
  if (text === "+" || text.endsWith("++")) {
    main = "+";
    text = text.slice(0, -2);
  }
  for (const raw of text.split("+")) {
    const part = raw.trim();
    if (!part) continue;
    const modifier = MODIFIERS[part.toLowerCase()];
    if (modifier) {
      modifiers |= modifier.bit;
      lastModifier = modifier;
    } else {
      main = part;
    }
  }

  if (main === null) {
    // Only modifiers, e.g. "shift": press the (last) modifier key itself.
    if (!lastModifier) return { key: "", code: "", keyCode: 0, modifiers };
    const { key, code, keyCode } = lastModifier;
    return { key, code, keyCode, modifiers };
  }

  const named = namedKey(main);
  if (named) return { ...named, modifiers };

  if ([...main].length === 1) {
    // shift+a means "A", shift+1 "!" and shift+/ "?", as on a real keyboard.
    const ch = modifiers & SHIFT_BIT ? shiftedChar(main) : main;
    const info = keyForChar(ch);
    // A character typed with shift ("+", "!", "A") reports shift as held.
    if (info) return { key: info.key, code: info.code, keyCode: info.keyCode, modifiers: info.shift ? modifiers | SHIFT_BIT : modifiers };
    return { key: ch, code: "", keyCode: 0, modifiers };
  }

  // Unknown name: pass it through as the key value (e.g. "MediaPlayPause").
  return { key: main, code: main, keyCode: 0, modifiers };
}

// The `modifiers` argument of clicks, e.g. "ctrl+shift", as bits.
function modifierBits(modStr) {
  return String(modStr || "")
    .split("+")
    .reduce((bits, part) => bits | (MODIFIERS[part.trim().toLowerCase()]?.bit || 0), 0);
}
