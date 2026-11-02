// Tests console messages against the pattern given to read_console_messages.
// A regular expression can take forever to match, and nothing can interrupt
// one, so it runs in a worker of its own, which the background stops when it
// takes too long (see filterByPattern).
//
// A pattern that isn't a valid regular expression is searched for as text.

self.onmessage = ({ data: { pattern, messages } }) => {
  let matches;
  try {
    const re = new RegExp(pattern, "i");
    matches = (text) => re.test(text);
  } catch {
    matches = (text) => text.includes(pattern);
  }
  self.postMessage(messages.map(({ text, level }) => matches(text) || matches(level)));
};
