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

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ADDON_ID = "open-claude-in-fayarkitsune@anthropic";
const RELEASES = "https://github.com/xiangyann/open-claude-in-fayarkitsune/releases/download";
const MANIFEST = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "updates.json");

const xpi = process.argv[2];
if (!xpi) {
  console.error("usage: node scripts/add-update.mjs path/to/signed.xpi");
  process.exit(1);
}

// The .xpi is a zip; read its manifest.json with the unzip on the PATH.
const extManifest = JSON.parse(execFileSync("unzip", ["-p", xpi, "manifest.json"], { encoding: "utf-8" }));
const gecko = extManifest.browser_specific_settings?.gecko || {};
if (gecko.id !== ADDON_ID) throw new Error(`${xpi} is ${gecko.id}, not ${ADDON_ID}`);
const version = extManifest.version;
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
