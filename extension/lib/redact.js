// Hides credentials in javascript_tool results before they reach Claude:
// cookie strings (what document.cookie returns), JSON Web Tokens, bearer
// tokens, and strings stored under names like "password" or "sessionToken".
// It keeps Claude from reading them by accident; it is not a security
// boundary, since a script can still send them wherever the page can.

const SECRET_NAME_WORDS = new Set([
  "password", "passwords", "passwd", "passphrase", "pwd", "secret", "secrets",
  "token", "tokens", "cookie", "cookies", "credential", "credentials", "auth",
  "authorization", "bearer", "jwt", "csrf", "xsrf", "session", "sessionid", "sid",
  "apikey", "apikeys", "otp",
  // Common session and anti-forgery cookie names, written as one word.
  "sessid", "phpsessid", "jsessionid", "csrftoken", "xsrftoken",
]);
const SECRET_NAME_PAIRS = [
  ["api", "key"], ["private", "key"], ["access", "key"], ["secret", "key"],
  ["api", "keys"], ["private", "keys"], ["access", "keys"], ["secret", "keys"],
  ["client", "secret"], ["refresh", "token"],
];
// A number under a secret name is only hidden when it isn't about the
// secret: tokenCount or sessionTimeout are not secrets, sessionId or otp are.
const COUNTING_WORDS = new Set([
  "count", "length", "size", "total", "index", "max", "min", "limit", "ttl", "age",
  "timeout", "expires", "expiry", "at", "time", "version",
]);

function nameWords(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Whether a property name says its value is a secret. Names are compared
// word by word ("sessionToken" -> session, token), so "author" or
// "tokenizer" don't count.
function isSecretName(name) {
  const words = nameWords(name);
  if (words.some((w) => SECRET_NAME_WORDS.has(w))) return true;
  return SECRET_NAME_PAIRS.some(([a, b]) => words.some((w, i) => w === a && words[i + 1] === b));
}

// Whether the value stored under `name` is to be hidden: a non-empty string,
// or a number that isn't a count or a time.
function isSecretValue(name, value) {
  if (!isSecretName(name)) return false;
  if (typeof value === "string") return value !== "" && !value.startsWith("[hidden");
  if (typeof value !== "number") return false;
  return !COUNTING_WORDS.has(nameWords(name).pop());
}

// A cookie name is an HTTP token; a value has no spaces, quotes, commas,
// semicolons or backslashes unless it's quoted.
const COOKIE_PAIR = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+=(?:"[^"]*"|[^\s",;\\]*)$/;
const JWT_ANYWHERE = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g;
const BEARER_ANYWHERE = /\b(Bearer)\s+[A-Za-z0-9\-._~+/]{12,}=*/gi;

// Any value up to the next ";": browsers accept spaces, commas, quotes and
// JSON in cookie values, and one such cookie mustn't expose all the others.
const LOOSE_COOKIE_PAIR = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+=[^;]*$/;

// The whole string is a Cookie header / document.cookie: "a=1; b=2". With
// two or more pairs, values may be anything, and at most half the parts may
// look otherwise: an odd cookie (a bracket or space in its name, one without
// a name) or a label in front mustn't expose all the others. A single pair
// has to look like a real cookie value, so text like "width=device-width,
// initial-scale=1" or a query string isn't taken for one, and like a secret
// one: a session-like name, or a value that looks like a token (16+
// characters, letters and digits mixed). "q=foo" or
// "#section=introduction-to-things" stay readable.
function looksLikeCookieString(s) {
  const parts = s.split(";").map((p) => p.trim());
  if (parts[parts.length - 1] === "") parts.pop();
  if (parts.length === 0) return false;
  if (parts.length === 1) {
    if (!COOKIE_PAIR.test(parts[0]) || parts[0].includes("&")) return false;
    const at = parts[0].indexOf("=");
    const name = parts[0].slice(0, at);
    const value = parts[0].slice(at + 1);
    return isSecretName(name) || (value.length >= 16 && /\d/.test(value) && /[A-Za-z]/.test(value));
  }
  const pairs = parts.filter((p) => LOOSE_COOKIE_PAIR.test(p)).length;
  return pairs >= 2 && pairs * 2 >= parts.length;
}

function redactString(s) {
  if (looksLikeCookieString(s)) return "[hidden: cookie string]";
  // A JSON document: hide secrets inside it by structure.
  if (/^\s*[[{]/.test(s) && s.length < 2000000) {
    try {
      const parsed = JSON.parse(s);
      const redacted = redactValue(parsed);
      if (JSON.stringify(redacted) !== JSON.stringify(parsed)) {
        // Rewritten, the text would lose its formatting and the precision of
        // large numbers (IDs, say). Replacing values in the text keeps both;
        // only when that can't hide everything the structure did is it
        // rewritten.
        const inPlace = redactTokens(s);
        try {
          const again = JSON.parse(inPlace);
          if (JSON.stringify(redactValue(again)) === JSON.stringify(again)) return inPlace;
        } catch {}
        return JSON.stringify(redacted);
      }
    } catch {}
  }
  return redactTokens(s);
}

// A thrown error's text: "TypeError: message", or the thrown value itself
// (a script can `throw document.cookie`). The message gets the same checks
// as a returned string.
function redactErrorText(text) {
  const named = /^((?:[A-Za-z$_][\w$]*)?(?:Error|Exception)): ([\s\S]*)$/.exec(String(text));
  return named ? `${named[1]}: ${redactString(named[2])}` : redactString(String(text));
}

// "name": "value" and "name": 123 in JSON that didn't parse (cut short, or
// inside other text): the value may run to the end of the text.
const JSON_STRING_PAIR = /"((?:[^"\\\n]|\\.){1,200})"(\s*:\s*)"((?:[^"\\]|\\.)*)(?:"|$)/g;
const JSON_NUMBER_PAIR = /"((?:[^"\\\n]|\\.){1,200})"(\s*:\s*)(-?\d+(?:\.\d+)?)(?![\d.])/g;
// name=value in a URL's query, fragment or path parameters (;jsessionid=),
// in a cookie string, or in text (API_KEY=…). A value stops at the next
// separator, so a secret after a nested "?" is found too.
const NAME_VALUE = /(^|[?&#;,\s])([^=&#?;,\s"'<>]{1,200})=([^&#?;,\s"'<>]+)/g;
// A "name: value" header line: Authorization, Set-Cookie, X-CSRF-Token, …
const HEADER_LINE = /^([ \t]*)([A-Za-z][\w-]{0,100})(:[ \t]*)(\S[^\r\n]*)$/gm;

// Secrets embedded in longer text, e.g. a page's HTML, a console message, a
// URL, or JSON too long to have reached here whole.
function redactTokens(s) {
  return String(s)
    .replace(JWT_ANYWHERE, "[hidden: token]")
    .replace(BEARER_ANYWHERE, "$1 [hidden: token]")
    .replace(JSON_STRING_PAIR, (pair, name, colon, value) =>
      isSecretValue(name, value) ? `"${name}"${colon}"[hidden: value of ${name}]"` : pair
    )
    .replace(JSON_NUMBER_PAIR, (pair, name, colon, number) =>
      isSecretValue(name, Number(number)) ? `"${name}"${colon}"[hidden: value of ${name}]"` : pair
    )
    .replace(HEADER_LINE, (line, indent, name, colon, value) =>
      isSecretName(name) && !value.startsWith("[hidden") ? `${indent}${name}${colon}[hidden]` : line
    )
    .replace(NAME_VALUE, (pair, sep, name, value) =>
      isSecretName(name) && value !== "[hidden]" ? `${sep}${name}=[hidden]` : pair
    );
}

function hidden(name) {
  return `[hidden: value of "${name}"]`;
}

// Set as an own property: a key like "__proto__" mustn't become a prototype.
function setProperty(out, name, value) {
  Object.defineProperty(out, name, { value, enumerable: true, writable: true, configurable: true });
}

function redactValue(value, depth = 0) {
  if (typeof value === "string") return redactString(value);
  if (!value || typeof value !== "object" || depth > 32) return value;
  if (Array.isArray(value)) {
    // [name, value] pairs, as from Object.entries(localStorage), a Map,
    // FormData or a split cookie string. Only in a list of such pairs: a
    // two-item list of names (Object.keys) isn't one.
    const pairs = value.length > 0 &&
      value.every((item) => Array.isArray(item) && item.length === 2 && typeof item[0] === "string");
    if (pairs) {
      return value.map(([name, item]) =>
        isSecretValue(name, item) ? [name, hidden(name)] : [name, redactValue(item, depth + 1)]
      );
    }
    return value.map((item) => redactValue(item, depth + 1));
  }
  // { name: "sessionid", value: "…" }, as from cookieStore.getAll().
  const label = typeof value.name === "string" ? value.name : typeof value.key === "string" ? value.key : null;
  const out = {};
  for (const [name, item] of Object.entries(value)) {
    // Hide the secret itself; objects under such names are searched instead,
    // so { session: { user, token } } still shows the user.
    const secret = isSecretValue(name, item) || (name === "value" && label !== null && isSecretValue(label, item));
    setProperty(out, name, secret ? hidden(name === "value" ? label : name) : redactValue(item, depth + 1));
  }
  return out;
}
