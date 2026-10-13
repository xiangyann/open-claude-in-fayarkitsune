// Sets the version everywhere it's written down:
//
//   node scripts/set-version.mjs 2.0.0-dev.1    (a development build)
//   node scripts/set-version.mjs 2.0.0-rc.1     (a release candidate)
//   node scripts/set-version.mjs 2.0.0          (the release)
//
// The server (host/package.json, its lockfile, and the .mcpb manifest) takes
// the version as is: semver, so Claude Desktop sees 2.0.0-dev.1 <
// 2.0.0-dev.2 < ... < 2.0.0-rc.1 < ... < 2.0.0 and offers to update each
// time. ("dev.10" sorts after "dev.9"; "dev10" wouldn't.)
//
// Firefox wants an add-on's version to be 1 to 4 plain numbers, so the
// extension's manifest gets the X.Y.Z part. The full string goes in
// extension/lib/version.js, which the extension shows and compares with the
// server's version. (Firefox has no version_name: it warns about the key.)
// Dev builds and release candidates are only loaded as temporary add-ons,
// and Firefox doesn't compare versions for those, so they don't need a lower
// number than the release.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];
const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:dev|rc)\.[1-9]\d*)?$/.exec(version || "");
if (!match) {
  console.error("usage: node scripts/set-version.mjs X.Y.Z[-dev.N|-rc.N]");
  process.exit(1);
}
const [x, y, z] = match.slice(1, 4).map(Number);
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
// "version" is the first key of that name.
{
  const full = path.join(ROOT, "extension/manifest.json");
  let text = fs.readFileSync(full, "utf-8");
  text = text.replace(/^ *"version_name": "[^"]*",\r?\n/m, ""); // 2.0.0-dev.1 had one
  text = text.replace(/^( *"version": )"[^"]*"/m, `$1"${firefoxVersion()}"`);
  JSON.parse(text); // still valid
  fs.writeFileSync(full, text);
}

// The constant's line in extension/lib/version.js.
{
  const full = path.join(ROOT, "extension/lib/version.js");
  const line = /^const EXTENSION_VERSION = "[^"]*";/m;
  const text = fs.readFileSync(full, "utf-8");
  if (!line.test(text)) {
    console.error("extension/lib/version.js has no EXTENSION_VERSION line");
    process.exit(1);
  }
  fs.writeFileSync(full, text.replace(line, `const EXTENSION_VERSION = "${version}";`));
}

console.log(`server, .mcpb and extension: ${version}\nextension manifest: ${firefoxVersion()}`);
