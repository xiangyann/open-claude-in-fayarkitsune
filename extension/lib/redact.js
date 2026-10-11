// Hides credentials in javascript_tool results before they reach Claude:
// cookie strings (what document.cookie returns), JSON Web Tokens, bearer
// tokens, and strings stored under names like "password" or "sessionToken".
// It keeps Claude from reading them by accident; it is not a security
// boundary, since a script can still send them wherever the page can.

const SECRET_NAME_WORDS = new Set([
  "password", "passwd", "passphrase", "pwd", "secret", "token", "cookie", "cookies",
  "credential", "credentials", "auth", "authorization", "bearer", "jwt", "csrf", "xsrf",
  "session", "sessionid", "sid", "apikey", "otp",
]);
const SECRET_NAME_PAIRS = [
  ["api", "key"], ["private", "key"], ["access", "key"], ["secret", "key"],
  ["client", "secret"], ["refresh", "token"],
];

// Whether a property name says its value is a secret. Names are compared
// word by word ("sessionToken" -> session, token), so "author" or
// "tokenizer" don't count.
function isSecretName(name) {
  const words = String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.some((w) => SECRET_NAME_WORDS.has(w))) return true;
  return SECRET_NAME_PAIRS.some(([a, b]) => words.some((w, i) => w === a && words[i + 1] === b));
}

// A cookie name is an HTTP token; a value has no spaces, quotes, commas,
// semicolons or backslashes unless it's quoted.
const COOKIE_PAIR = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+=(?:"[^"]*"|[^\s",;\\]*)$/;
const JWT_ANYWHERE = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g;
const BEARER_ANYWHERE = /\b(Bearer)\s+[A-Za-z0-9\-._~+/]{12,}=*/gi;

// The whole string is a Cookie header / document.cookie: "a=1; b=2".
function looksLikeCookieString(s) {
  const parts = s.split(";").map((p) => p.trim());
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.length > 0 && parts.every((p) => COOKIE_PAIR.test(p));
}

function redactString(s) {
  if (looksLikeCookieString(s)) return "[hidden: cookie string]";
  // A JSON document: hide secrets inside it by structure.
  if (/^\s*[[{]/.test(s) && s.length < 2000000) {
    try {
      const parsed = JSON.parse(s);
      const redacted = redactValue(parsed);
      if (JSON.stringify(redacted) !== JSON.stringify(parsed)) return JSON.stringify(redacted);
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

// Tokens embedded in longer text, e.g. a page's HTML.
function redactTokens(s) {
  return String(s)
    .replace(JWT_ANYWHERE, "[hidden: token]")
    .replace(BEARER_ANYWHERE, "$1 [hidden: token]");
}

function redactValue(value, depth = 0) {
  if (typeof value === "string") return redactString(value);
  if (!value || typeof value !== "object" || depth > 32) return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  const out = {};
  for (const [name, item] of Object.entries(value)) {
    // Hide the secret itself; objects under such names are searched instead,
    // so { session: { user, token } } still shows the user.
    const secret = isSecretName(name) &&
      ((typeof item === "string" && item !== "") || typeof item === "number");
    out[name] = secret ? `[hidden: value of "${name}"]` : redactValue(item, depth + 1);
  }
  return out;
}
