// Adds a signed release to updates.json, the manifest Firefox reads to update
// the extension by itself (browser_specific_settings.gecko.update_url).
//
//   node scripts/add-update.mjs path/to/signed.xpi
//
// The version comes from the .xpi's manifest. The entry points at the file
// as it's attached to the GitHub release v<version>, named
// claude-mcp-in-fayar-kitsune-<version>.xpi, with its sha256, so upload it
// under that name. Commit updates.json to main once the release is out:
// Firefox only offers an update whose file it can download.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const ADDON_ID = "open-claude-in-fayarkitsune@anthropic";
const RELEASES = "https://github.com/xiangyann/open-claude-in-fayarkitsune/releases/download";
const MANIFEST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "updates.json");

const xpi = process.argv[2];
if (!xpi) {
  console.error("usage: node scripts/add-update.mjs path/to/signed.xpi");
  process.exit(1);
}

// The .xpi is a zip. Its entries are read here, through the zip's central
// directory, so no unzip program is needed (Windows has none outside Git
// Bash). Returns the names of all entries, and the content of `wanted`.
function readZip(file, wanted) {
  const buf = fs.readFileSync(file);
  // The end of central directory record, in the last 64 KB (a comment can
  // follow it).
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error(`${file} isn't a zip file`);
  const entries = buf.readUInt16LE(end + 10);
  const directory = buf.readUInt32LE(end + 16);
  if (entries === 0xffff || directory === 0xffffffff) throw new Error(`${file} is a zip64 file, which this doesn't read`);
  const names = [];
  let content = null;
  let at = directory;
  for (let n = entries; n > 0; n--) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error(`${file}: damaged zip directory`);
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20); // compressed
    const nameLength = buf.readUInt16LE(at + 28);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLength);
    names.push(name);
    if (name === wanted) {
      const local = buf.readUInt32LE(at + 42);
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      content = method === 8 ? zlib.inflateRawSync(data) : data;
    }
    at += 46 + nameLength + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return { names, content };
}

const { names, content } = readZip(xpi, "manifest.json");
if (!content) throw new Error(`${xpi} has no manifest.json`);
// Only a file Mozilla signed installs on release Firefox.
if (!names.includes("META-INF/mozilla.rsa") && !names.includes("META-INF/cose.sig")) {
  throw new Error(`${xpi} isn't signed: sign it on addons.mozilla.org first`);
}
const extManifest = JSON.parse(content.toString("utf8"));
const gecko = extManifest.browser_specific_settings?.gecko || {};
if (gecko.id !== ADDON_ID) throw new Error(`${xpi} is ${gecko.id}, not ${ADDON_ID}`);
const version = extManifest.version;
if (typeof version !== "string" || !/^\d+(\.\d+)*$/.test(version)) {
  throw new Error(`${xpi} has no usable version in its manifest (${JSON.stringify(version)})`);
}
const sha256 = createHash("sha256").update(fs.readFileSync(xpi)).digest("hex");

const updates = JSON.parse(fs.readFileSync(MANIFEST, "utf-8"));
const list = updates.addons[ADDON_ID].updates;
const entry = {
  version,
  update_link: `${RELEASES}/v${version}/claude-mcp-in-fayar-kitsune-${version}.xpi`,
  update_hash: `sha256:${sha256}`,
  applications: { gecko: { strict_min_version: gecko.strict_min_version } },
};
const at = list.findIndex((u) => u.version === version);
if (at >= 0) list[at] = entry;
else list.push(entry);
fs.writeFileSync(MANIFEST, JSON.stringify(updates, null, 2) + "\n");
console.log(`updates.json: ${version} -> ${entry.update_link}\n  ${entry.update_hash}`);
