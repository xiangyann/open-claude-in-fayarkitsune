// Sets the version everywhere it's written down:
//
//   node scripts/set-version.mjs 2.0.0-dev.1    (a development build)
//   node scripts/set-version.mjs 2.0.0          (the release)
//
// The server (host/package.json, its lockfile, and the .mcpb manifest) takes
// the version as is: semver, so Claude Desktop sees 2.0.0-dev.1 <
// 2.0.0-dev.2 < ... < 2.0.0 and offers to update each time. ("dev.10" sorts
// after "dev.9"; "dev10" wouldn't.)
//
// Firefox wants an add-on's version to be 1 to 4 plain numbers, so the
// extension gets the X.Y.Z part as its version and shows the full string as
// version_name (which is also what it compares with the server's version).
// Dev builds are only loaded as temporary add-ons, and Firefox doesn't
// compare versions for those, so they don't need a lower number than the
// release.

import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const version = process.argv[2];
const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-dev\.([1-9]\d*))?$/.exec(version || "");
if (!match) {
  console.error("usage: node scripts/set-version.mjs X.Y.Z[-dev.N]");
  process.exit(1);
}
const [x, y, z, dev] = match.slice(1).map((n) => (n === undefined ? undefined : Number(n)));
const firefoxVersion = () => `${x}.${y}.${z}`;

// Rewrites a JSON file, keeping its line endings.
function updateJson(file, change) {
  const full = path.join(ROOT, file);
  const text = fs.readFileSync(full, "utf-8");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const data = JSON.parse(text);
  change(data);
  fs.writeFileSync(full, JSON.stringify(data, null, 2).replace(/\n/g, eol) + eol);
}

updateJson("host/package.json", (p) => (p.version = version));
updateJson("host/package-lock.json", (l) => {
  l.version = version;
  l.packages[""].version = version;
});
updateJson("host/manifest.json", (m) => (m.version = version));

// The extension's manifest is edited as text, to keep its compact layout:
// "version" is the first key of that name, and version_name goes right after.
{
  const full = path.join(ROOT, "extension/manifest.json");
  let text = fs.readFileSync(full, "utf-8");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  text = text.replace(/^ *"version_name": "[^"]*",\r?\n/m, "");
  text = text.replace(/^( *)"version": "[^"]*",\r?\n/m, (line, indent) =>
    `${indent}"version": "${firefoxVersion()}",${eol}` +
    (dev === undefined ? "" : `${indent}"version_name": "${version}",${eol}`)
  );
  JSON.parse(text); // still valid
  fs.writeFileSync(full, text);
}

console.log(`server and .mcpb: ${version}\nextension: version ${firefoxVersion()}${dev === undefined ? "" : `, version_name ${version}`}`);
